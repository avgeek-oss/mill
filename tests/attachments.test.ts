import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  cleanupDatabase,
  resetDatabase,
  setupUser,
  setupOAuth,
  callMcpTool,
  request,
  sql,
} from "./support.js";
import { cleanupAttachmentBatch } from "../apps/api/src/attachments/cleanup.js";
import { attachmentStorage } from "../apps/api/src/attachments/storage.js";
import type {
  AttachmentUpload,
  Attachment,
  AttachmentPage,
  AttachmentDownload,
} from "../packages/contracts/src/index.js";

const exec = promisify(execFile);
const previous = { ...process.env };
const bucket = `mill-attachments-${randomUUID()}`;
let ownedContainer: string | undefined;
let client: S3Client;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X8AAAAASUVORK5CYII=",
  "base64",
);
async function json<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}
before(async () => {
  let endpoint = process.env.MILL_ATTACHMENT_TEST_ENDPOINT;
  if (!endpoint) {
    ownedContainer = `mill-attachments-${randomUUID()}`;
    await exec("docker", [
      "run",
      "--detach",
      "--name",
      ownedContainer,
      "--publish",
      "127.0.0.1::9000",
      "--env",
      "RUSTFS_ACCESS_KEY=mill-attachment-tests",
      "--env",
      "RUSTFS_SECRET_KEY=mill-attachment-tests-disposable",
      "--env",
      "RUSTFS_CONSOLE_ENABLE=false",
      "rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff",
    ]);
    const { stdout } = await exec("docker", [
      "port",
      ownedContainer,
      "9000/tcp",
    ]);
    endpoint = `http://${stdout.trim()}`;
  }
  Object.assign(process.env, {
    MILL_S3_ENDPOINT: endpoint,
    MILL_S3_REGION: "us-east-1",
    MILL_S3_BUCKET: bucket,
    MILL_S3_ACCESS_KEY_ID:
      process.env.MILL_ATTACHMENT_TEST_ACCESS_KEY ?? "mill-attachment-tests",
    MILL_S3_SECRET_ACCESS_KEY:
      process.env.MILL_ATTACHMENT_TEST_SECRET_KEY ??
      "mill-attachment-tests-disposable",
  });
  client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MILL_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.MILL_S3_SECRET_ACCESS_KEY!,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
});
beforeEach(resetDatabase);
after(async () => {
  try {
    if (client) {
      const rows = await client.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      for (const item of rows.Contents ?? [])
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }),
        );
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    }
  } finally {
    if (ownedContainer) await exec("docker", ["rm", "--force", ownedContainer]);
    process.env = previous;
    await cleanupDatabase();
  }
});
async function fixture() {
  const admin = await setupUser();
  const { board } = await json<{ board: { id: string; version: number } }>(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Attachments", prefix: "ATT" },
    }),
    201,
  );
  const { task } = await json<{ task: { id: string; version: number } }>(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie: admin.cookie,
      body: { title: "Share a screenshot" },
    }),
    201,
  );
  return { ...admin, board, task, path: `/api/tasks/${task.id}/attachments` };
}
async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { sha256?: string; fileName?: string } = {},
  key?: string,
) {
  return json<AttachmentUpload>(
    await request(`${f.path}/uploads`, {
      cookie: f.cookie,
      headers: key ? { "Idempotency-Key": key } : {},
      body: {
        fileName: options.fileName ?? "screenshot.png",
        contentType: "image/png",
        sizeBytes: png.length,
        ...(options.sha256 ? { sha256: options.sha256 } : {}),
      },
    }),
    201,
  );
}
async function put(upload: AttachmentUpload, bytes = png) {
  const response = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: upload.headers,
    body: bytes,
  });
  assert.equal(
    response.status,
    200,
    "Private signed PUT must accept the declared image",
  );
}
async function withPausedVerification(
  run: (controls: {
    entered: Promise<void>;
    release: () => void;
  }) => Promise<void>,
) {
  const storage = attachmentStorage()!;
  const complete = storage.complete;
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  storage.complete = async (row, verifiedKey) => {
    signalEntered();
    await held;
    return complete.call(storage, row, verifiedKey);
  };
  try {
    await run({ entered, release });
  } finally {
    release();
    storage.complete = complete;
  }
}
async function waitForVerification(
  entered: Promise<void>,
  completion: Promise<Response>,
) {
  await Promise.race([
    entered,
    completion.then((response) => {
      throw new Error(
        `Completion returned ${response.status} before storage verification`,
      );
    }),
  ]);
}
test("a paused completion does not hold up authenticated reads or unrelated writes", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  await withPausedVerification(async ({ entered, release }) => {
    const completion = request(`${f.path}/${upload.attachmentId}/complete`, {
      cookie: f.cookie,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    try {
      await waitForVerification(entered, completion);
      const registered = await sql<
        { objectKey: string; deferred: boolean; recheckAt: Date | null }[]
      >`SELECT object_key,available_at>now() AS deferred,recheck_at FROM attachment_cleanup
        WHERE object_key LIKE ${`mill/objects/${upload.attachmentId}/%`}`;
      assert.equal(registered.length, 1);
      assert.equal(registered[0].deferred, true);
      assert.ok(registered[0].recheckAt);
      const otherRequests = Promise.all([
        request(`/api/tasks/${f.task.id}`, { cookie: f.cookie }),
        request("/api/boards", {
          cookie: f.cookie,
          body: { name: "Independent board", prefix: "IND" },
        }),
      ]);
      let finished = false;
      void otherRequests.then(() => {
        finished = true;
      });
      await Promise.race([
        otherRequests,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      assert.equal(
        finished,
        true,
        "S3 verification must not hold the workspace lock",
      );
      const [read, mutation] = await otherRequests;
      assert.equal(read.status, 200);
      assert.equal(mutation.status, 201);
    } finally {
      release();
    }
    assert.equal((await completion).status, 200);
    assert.equal(
      (
        await sql`SELECT object_key FROM attachment_cleanup WHERE object_key LIKE ${`mill/objects/${upload.attachmentId}/%`}`
      ).length,
      0,
      "Publishing a verified copy must remove its cleanup job",
    );
  });
});
test("many in-flight completions leave database connections available", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  const storage = attachmentStorage()!;
  const complete = storage.complete;
  let release!: () => void;
  let allEntered!: () => void;
  let entered = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reachedStorage = new Promise<void>((resolve) => {
    allEntered = resolve;
  });
  storage.complete = async (row, verifiedKey) => {
    entered++;
    if (entered === 12) allEntered();
    await held;
    return complete.call(storage, row, verifiedKey);
  };
  const completions = Array.from({ length: 12 }, () =>
    request(`${f.path}/${upload.attachmentId}/complete`, {
      cookie: f.cookie,
      body: {},
    }),
  );
  try {
    const reached = await Promise.race([
      reachedStorage.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    assert.equal(
      reached,
      true,
      "Completion requests must not queue on database locks",
    );
    const independent = await Promise.race([
      request(`/api/tasks/${f.task.id}`, { cookie: f.cookie }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    assert.equal(independent?.status, 200);
  } finally {
    release();
    storage.complete = complete;
  }
  const responses = await Promise.all(completions);
  assert.ok(responses.some((response) => response.status === 200));
  assert.ok(
    responses.every((response) => [200, 429].includes(response.status)),
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM activity WHERE action='attachment.added' AND task_id=${f.task.id}`
    )[0].count,
    1,
  );
});
test("revocation during verification prevents publication and queues copied bytes for cleanup", async () => {
  const f = await fixture();
  const issued = await json<{ token: string; credential: { id: string } }>(
    await request("/api/credentials", {
      cookie: f.cookie,
      body: {
        name: "Attachment writer",
        access: "edit",
        includeAdmin: false,
        expiresAt: null,
      },
    }),
    201,
  );
  const upload = await reserve(f);
  await put(upload);
  await withPausedVerification(async ({ entered, release }) => {
    const completion = request(`${f.path}/${upload.attachmentId}/complete`, {
      token: issued.token,
      body: {},
    });
    try {
      await waitForVerification(entered, completion);
      await sql`UPDATE credentials SET revoked_at=now() WHERE id=${issued.credential.id}`;
    } finally {
      release();
    }
    assert.equal((await completion).status, 401);
  });
  assert.equal(
    (
      await sql`SELECT id FROM task_attachments WHERE id=${upload.attachmentId} AND state='ready'`
    ).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT object_key FROM attachment_cleanup WHERE object_key LIKE ${`mill/objects/${upload.attachmentId}/%`}`
    ).length,
    1,
  );
  const [cleanup] = await sql<{ availableAt: Date; due: boolean }[]>`
    SELECT available_at,available_at<=now() AS due FROM attachment_cleanup
    WHERE object_key LIKE ${`mill/objects/${upload.attachmentId}/%`}`;
  assert.equal(cleanup.due, true, cleanup.availableAt.toISOString());
});
test("task deletion during verification leaves no published attachment or copied object", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  const completionKey = randomUUID();
  await withPausedVerification(async ({ entered, release }) => {
    const completion = request(`${f.path}/${upload.attachmentId}/complete`, {
      cookie: f.cookie,
      headers: { "Idempotency-Key": completionKey },
      body: {},
    });
    try {
      await waitForVerification(entered, completion);
      assert.equal(
        (
          await request(`/api/tasks/${f.task.id}`, {
            cookie: f.cookie,
            method: "DELETE",
            body: { version: f.task.version },
          })
        ).status,
        200,
      );
    } finally {
      release();
    }
    assert.equal((await completion).status, 404);
  });
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/complete`, {
        cookie: f.cookie,
        headers: { "Idempotency-Key": completionKey },
        body: {},
      })
    ).status,
    410,
  );
  const [copy] = await sql<{ objectKey: string }[]>`
    SELECT object_key FROM attachment_cleanup WHERE object_key LIKE ${`mill/objects/${upload.attachmentId}/%`}`;
  assert.ok(copy);
  await cleanupAttachmentBatch();
  await assert.rejects(
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: copy.objectKey })),
  );
});
test("an upload that expires during verification is not published", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  await withPausedVerification(async ({ entered, release }) => {
    const completion = request(`${f.path}/${upload.attachmentId}/complete`, {
      cookie: f.cookie,
      body: {},
    });
    try {
      await waitForVerification(entered, completion);
      await sql`UPDATE task_attachments SET upload_expires_at=now()-interval '1 second' WHERE id=${upload.attachmentId}`;
    } finally {
      release();
    }
    assert.equal((await completion).status, 410);
  });
  assert.equal(
    (
      await sql`SELECT id FROM task_attachments WHERE id=${upload.attachmentId} AND state='ready'`
    ).length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT object_key FROM attachment_cleanup WHERE object_key LIKE ${`mill/objects/${upload.attachmentId}/%`}`
    ).length,
    1,
  );
});
test("an abandoned completion claim recovers with the same retry key", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  const path = `${f.path}/${upload.attachmentId}/complete`;
  const key = randomUUID();
  const hash = createHash("sha256").update(`POST\n${path}\n{}`).digest("hex");
  await sql`INSERT INTO api_idempotency(actor_key,key,request_hash,response,task_ids,attachment_ids)
    VALUES(${f.user.id},${key},${hash},${sql.json({ lease: "abandoned" })},ARRAY[${f.task.id}::uuid],ARRAY[${upload.attachmentId}::uuid])`;
  const options = {
    cookie: f.cookie,
    headers: { "Idempotency-Key": key },
    body: {},
  };
  assert.equal((await request(path, options)).status, 409);
  assert.equal(
    (await request(path, { ...options, body: { changed: true } })).status,
    409,
  );
  await sql`UPDATE api_idempotency SET created_at=now()-interval '3 minutes' WHERE actor_key=${f.user.id} AND key=${key}`;
  const completed = await json<{ attachment: Attachment }>(
    await request(path, options),
  );
  assert.equal(completed.attachment.id, upload.attachmentId);
  const replay = await request(path, options);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(await replay.json(), completed);
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM activity WHERE action='attachment.added' AND task_id=${f.task.id}`
    )[0].count,
    1,
  );
});
test("completion replay respects a narrowed OAuth board grant", async () => {
  const f = await fixture();
  const otherBoard = await json<{ board: { id: string } }>(
    await request("/api/boards", {
      cookie: f.cookie,
      body: { name: "Other board", prefix: "OTH" },
    }),
    201,
  );
  const oauth = await setupOAuth(f.cookie, {
    boardIds: [f.board.id, otherBoard.board.id],
  });
  const upload = await reserve(f);
  await put(upload);
  const key = randomUUID();
  const args = {
    taskId: f.task.id,
    attachmentId: upload.attachmentId,
    idempotencyKey: key,
  };
  const completed = await callMcpTool(oauth.token, "complete_attachment", args);
  assert.equal(completed.result?.isError, false);
  assert.equal(
    (completed.result?.structuredContent?.attachment as Attachment)?.id,
    upload.attachmentId,
  );
  const [saved] = await sql<{ boardIds: string[] }[]>`
    SELECT board_ids FROM api_idempotency WHERE actor_key=${oauth.credential.id} AND key=${key}`;
  assert.deepEqual(saved.boardIds, [f.board.id]);
  await sql`UPDATE credentials SET board_ids=ARRAY[${otherBoard.board.id}::uuid] WHERE id=${oauth.credential.id}`;
  const replay = await callMcpTool(oauth.token, "complete_attachment", args);
  assert.equal(replay.result?.isError, true);
  const error = replay.result?.structuredContent?.error as
    { code: string } | undefined;
  assert.equal(error?.code, "retry_invalidated");
  assert.ok(!JSON.stringify(replay.result).includes(upload.attachmentId));
});
test("optional capability hides storage secrets; disabled storage leaves ordinary tasks usable", async () => {
  const f = await fixture();
  assert.equal((await request("/api/attachments/config")).status, 401);
  const configured = await json<{
    enabled: boolean;
    maxBytes: number;
    contentTypes: string[];
  }>(await request("/api/attachments/config", { cookie: f.cookie }));
  assert.equal(configured.enabled, true);
  assert.equal(configured.maxBytes, 20971520);
  assert.ok(
    !JSON.stringify(configured).includes(
      process.env.MILL_S3_SECRET_ACCESS_KEY!,
    ),
  );
  const storage = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("MILL_S3_")),
  );
  try {
    for (const key of Object.keys(storage)) delete process.env[key];
    assert.equal(
      (
        await json<{ enabled: boolean }>(
          await request("/api/attachments/config", { cookie: f.cookie }),
        )
      ).enabled,
      false,
    );
    assert.equal(
      (await request(`/api/tasks/${f.task.id}`, { cookie: f.cookie })).status,
      200,
    );
    assert.equal(
      (
        await request(`${f.path}/uploads`, {
          cookie: f.cookie,
          body: {
            fileName: "a.png",
            contentType: "image/png",
            sizeBytes: png.length,
          },
        })
      ).status,
      503,
    );
  } finally {
    Object.assign(process.env, storage);
  }
});
test("real signed upload verifies bytes, completes once and preserves immutable final data after stale uploads", async () => {
  const f = await fixture();
  const key = randomUUID();
  const upload = await reserve(
    f,
    {
      sha256: createHash("sha256").update(png).digest("hex").toUpperCase(),
      fileName: "évidence.png",
    },
    key,
  );
  assert.deepEqual(
    await reserve(
      f,
      {
        sha256: createHash("sha256").update(png).digest("hex").toUpperCase(),
        fileName: "évidence.png",
      },
      key,
    ),
    upload,
  );
  const signed = new URL(upload.uploadUrl);
  assert.ok(
    signed.searchParams.get("X-Amz-SignedHeaders")?.includes("content-length"),
  );
  assert.ok(
    signed.searchParams.get("X-Amz-SignedHeaders")?.includes("content-type"),
  );
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/complete`, {
        cookie: f.cookie,
        body: {},
      })
    ).status,
    422,
  );
  await put(upload);
  const completed = await Promise.all(
    [0, 1].map(() =>
      request(`${f.path}/${upload.attachmentId}/complete`, {
        cookie: f.cookie,
        body: {},
      }),
    ),
  );
  const first = await json<{ attachment: Attachment }>(completed[0]);
  assert.deepEqual(await json(completed[1]), first);
  const [activity] =
    await sql`SELECT count(*)::int AS count FROM activity WHERE task_id=${f.task.id} AND action='attachment.added'`;
  assert.equal(activity.count, 1);
  assert.equal(first.attachment.fileName, "évidence.png");
  assert.equal(
    (await json<AttachmentPage>(await request(f.path, { cookie: f.cookie })))
      .items.length,
    1,
  );
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/download?preview=bad`, {
        cookie: f.cookie,
      })
    ).status,
    400,
  );
  const download = await json<AttachmentDownload>(
    await request(`${f.path}/${upload.attachmentId}/download`, {
      cookie: f.cookie,
    }),
  );
  const downloaded = await fetch(download.url);
  assert.ok(
    downloaded.headers.get("content-disposition")?.startsWith("attachment;"),
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  const altered = Buffer.from(png);
  altered[45] ^= 1;
  await put(upload, altered);
  const stable = await fetch(download.url);
  assert.deepEqual(Buffer.from(await stable.arrayBuffer()), png);
  const preview = await json<AttachmentDownload>(
    await request(`${f.path}/${upload.attachmentId}/download?preview=true`, {
      cookie: f.cookie,
    }),
  );
  assert.ok(
    (await fetch(preview.url)).headers
      .get("content-disposition")
      ?.startsWith("inline;"),
  );
});
test("forged MIME, mismatched size/hash and cross-task attachment IDs are rejected", async () => {
  const f = await fixture();
  for (const input of [
    { fileName: "unsafe.svg", contentType: "image/svg+xml", sizeBytes: 30 },
    { fileName: "../a.png", contentType: "image/png", sizeBytes: 30 },
    { fileName: "a\r\nb.png", contentType: "image/png", sizeBytes: 30 },
    { fileName: "a.png", contentType: "image/png", sizeBytes: 20971521 },
  ])
    assert.equal(
      (await request(`${f.path}/uploads`, { cookie: f.cookie, body: input }))
        .status,
      400,
    );
  const upload = await reserve(f);
  const [stored] = await sql<
    { uploadKey: string }[]
  >`SELECT upload_key FROM task_attachments WHERE id=${upload.attachmentId}`;
  for (const [bytes, type] of [
    [Buffer.alloc(png.length, 65), "image/png"],
    [png, "text/html"],
    [png.subarray(0, 10), "image/png"],
  ] as const) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: stored.uploadKey,
        Body: bytes,
        ContentType: type,
      }),
    );
    assert.equal(
      (
        await request(`${f.path}/${upload.attachmentId}/complete`, {
          cookie: f.cookie,
          body: {},
        })
      ).status,
      422,
    );
  }
  const hashMismatch = await reserve(f, { sha256: "0".repeat(64) });
  await put(hashMismatch);
  assert.equal(
    (
      await request(`${f.path}/${hashMismatch.attachmentId}/complete`, {
        cookie: f.cookie,
        body: {},
      })
    ).status,
    422,
  );
  const other = await json<{ task: { id: string } }>(
    await request(`/api/boards/${f.board.id}/tasks`, {
      cookie: f.cookie,
      body: { title: "Other task" },
    }),
    201,
  );
  assert.equal(
    (
      await request(
        `/api/tasks/${other.task.id}/attachments/${upload.attachmentId}/complete`,
        { cookie: f.cookie, body: {} },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/tasks/${other.task.id}/attachments/${upload.attachmentId}`,
        { method: "DELETE", cookie: f.cookie },
      )
    ).status,
    404,
  );
  assert.equal(
    (await json<AttachmentPage>(await request(f.path, { cookie: f.cookie })))
      .items.length,
    0,
  );
});
test("REST and MCP grants, viewer role, board limits and revocation apply to attachments", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  await json(
    await request(`${f.path}/${upload.attachmentId}/complete`, {
      cookie: f.cookie,
      body: {},
    }),
  );
  const invitation = await json<{ token: string }>(
    await request("/api/auth/invitations", {
      cookie: f.cookie,
      body: { email: "viewer@example.test", role: "viewer" },
    }),
    201,
  );
  const viewerResponse = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Viewer",
      password: "Secure viewer passphrase 42!",
    },
  });
  await json(viewerResponse, 201);
  const viewer = viewerResponse.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await request(f.path, { cookie: viewer })).status, 200);
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/download`, {
        cookie: viewer,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}`, {
        cookie: viewer,
        method: "DELETE",
      })
    ).status,
    403,
  );
  const issued = await json<{ token: string }>(
    await request("/api/credentials", {
      cookie: f.cookie,
      body: {
        name: "Read attachments",
        access: "read",
        includeAdmin: false,
        expiresAt: null,
      },
    }),
    201,
  );
  assert.equal((await request(f.path, { token: issued.token })).status, 200);
  assert.equal(
    (
      await request(`${f.path}/uploads`, {
        token: issued.token,
        body: {
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: png.length,
        },
      })
    ).status,
    403,
  );
  const oauth = await setupOAuth(f.cookie, {
    scopes: ["viewer"],
    boardIds: [f.board.id],
  });
  const listed = await callMcpTool(oauth.token, "list_attachments", {
    taskId: f.task.id,
  });
  assert.equal(listed.result?.isError, false);
  assert.equal(
    (listed.result?.structuredContent?.items as Attachment[])?.length,
    1,
  );
  const denied = await callMcpTool(oauth.token, "delete_attachment", {
    taskId: f.task.id,
    attachmentId: upload.attachmentId,
  });
  assert.ok(denied.result?.isError || denied.error);
  const restricted = await setupOAuth(f.cookie, {
    boardIds: [randomUUID()],
  }).catch(() => null);
  assert.equal(restricted, null, "Unknown board grants cannot be approved");
  const otherBoard = await json<{ board: { id: string } }>(
    await request("/api/boards", {
      cookie: f.cookie,
      body: { name: "Other board", prefix: "OTH" },
    }),
    201,
  );
  const otherGrant = await setupOAuth(f.cookie, {
    boardIds: [otherBoard.board.id],
  });
  assert.equal(
    (await request(f.path, { token: otherGrant.token })).status,
    403,
  );
  const write = await setupOAuth(f.cookie, { boardIds: [f.board.id] });
  const reserved = await callMcpTool(write.token, "create_attachment_upload", {
    taskId: f.task.id,
    fileName: "mcp.png",
    contentType: "image/png",
    sizeBytes: png.length,
    idempotencyKey: randomUUID(),
  });
  assert.equal(reserved.result?.isError, false);
  const pending = reserved.result!.structuredContent as AttachmentUpload;
  await put(pending);
  await sql`UPDATE credentials SET revoked_at=now() WHERE id=${write.credential.id}`;
  assert.equal(
    (
      await request(`${f.path}/${pending.attachmentId}/complete`, {
        token: write.token,
        body: {},
      })
    ).status,
    401,
  );
});
test("attachment/task/board deletion enqueues durable cleanup and invalidates completed retries", async () => {
  const f = await fixture();
  const uploadKey = randomUUID();
  const upload = await reserve(f, {}, uploadKey);
  await put(upload);
  const completionKey = randomUUID();
  await json(
    await request(`${f.path}/${upload.attachmentId}/complete`, {
      cookie: f.cookie,
      headers: { "Idempotency-Key": completionKey },
      body: {},
    }),
  );
  const completedReplay = await request(
    `${f.path}/${upload.attachmentId}/complete`,
    {
      cookie: f.cookie,
      headers: { "Idempotency-Key": completionKey },
      body: {},
    },
  );
  assert.equal(completedReplay.status, 200);
  assert.equal(completedReplay.headers.get("Idempotency-Replayed"), "true");
  const download = await json<AttachmentDownload>(
    await request(`${f.path}/${upload.attachmentId}/download`, {
      cookie: f.cookie,
    }),
  );
  const deleteKey = randomUUID();
  for (let n = 0; n < 2; n++)
    await json(
      await request(`${f.path}/${upload.attachmentId}`, {
        cookie: f.cookie,
        method: "DELETE",
        headers: { "Idempotency-Key": deleteKey },
      }),
    );
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/download`, {
        cookie: f.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/complete`, {
        cookie: f.cookie,
        headers: { "Idempotency-Key": completionKey },
        body: {},
      })
    ).status,
    410,
  );
  assert.equal(
    (
      await request(`${f.path}/uploads`, {
        cookie: f.cookie,
        headers: { "Idempotency-Key": uploadKey },
        body: {
          fileName: "screenshot.png",
          contentType: "image/png",
          sizeBytes: png.length,
        },
      })
    ).status,
    410,
  );
  assert.ok((await sql`SELECT object_key FROM attachment_cleanup`).length >= 2);
  await cleanupAttachmentBatch();
  assert.equal((await fetch(download.url)).status, 404);
  const pending = await reserve(f);
  await put(pending);
  await json(
    await request(`/api/tasks/${f.task.id}`, {
      cookie: f.cookie,
      method: "DELETE",
      body: { version: f.task.version },
    }),
  );
  assert.equal(
    (await sql`SELECT id FROM task_attachments WHERE task_id=${f.task.id}`)
      .length,
    0,
  );
  assert.ok(
    (
      await sql`SELECT object_key FROM attachment_cleanup WHERE object_key=${`mill/uploads/${pending.attachmentId}`}`
    ).length,
  );
  const second = await json<{ task: { id: string } }>(
    await request(`/api/boards/${f.board.id}/tasks`, {
      cookie: f.cookie,
      body: { title: "Board cleanup" },
    }),
    201,
  );
  const forBoard = await reserve({
    ...f,
    task: { id: second.task.id, version: 1 },
    path: `/api/tasks/${second.task.id}/attachments`,
  });
  await put(forBoard);
  await json(
    await request(`/api/boards/${f.board.id}`, {
      cookie: f.cookie,
      method: "DELETE",
      body: { version: f.board.version },
    }),
  );
  assert.equal((await sql`SELECT id FROM task_attachments`).length, 0);
  assert.ok(
    (
      await sql`SELECT object_key FROM attachment_cleanup WHERE object_key=${`mill/uploads/${forBoard.attachmentId}`}`
    ).length,
  );
  await sql`UPDATE attachment_cleanup SET available_at=now(),recheck_at=null`;
  await cleanupAttachmentBatch();
  for (const reserved of [pending, forBoard])
    await assert.rejects(
      client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: `mill/uploads/${reserved.attachmentId}`,
        }),
      ),
    );
});
test("PDFs work through MCP and attachment pagination preserves sub-millisecond timestamps", async () => {
  const f = await fixture();
  const oauth = await setupOAuth(f.cookie, { boardIds: [f.board.id] });
  const pdf = Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
  );
  const reserved = await callMcpTool(oauth.token, "create_attachment_upload", {
    taskId: f.task.id,
    fileName: "document.pdf",
    contentType: "application/pdf",
    sizeBytes: pdf.length,
    idempotencyKey: randomUUID(),
  });
  assert.equal(reserved.result?.isError, false);
  const upload = reserved.result!.structuredContent as AttachmentUpload;
  await put(upload, pdf);
  const completed = await callMcpTool(oauth.token, "complete_attachment", {
    taskId: f.task.id,
    attachmentId: upload.attachmentId,
    idempotencyKey: randomUUID(),
  });
  assert.equal(completed.result?.isError, false);
  const download = await callMcpTool(oauth.token, "get_attachment_download", {
    taskId: f.task.id,
    attachmentId: upload.attachmentId,
    preview: true,
  });
  assert.equal(download.result?.isError, false);
  assert.equal(
    (
      await fetch(
        (download.result!.structuredContent as AttachmentDownload).url,
      )
    ).headers.get("content-type"),
    "application/pdf",
  );
  const ids = [upload.attachmentId];
  for (let n = 0; n < 2; n++) {
    const image = await reserve(f);
    await put(image);
    await json(
      await request(`${f.path}/${image.attachmentId}/complete`, {
        cookie: f.cookie,
        body: {},
      }),
    );
    ids.push(image.attachmentId);
  }
  for (const [index, attachmentId] of ids.entries())
    await sql`UPDATE task_attachments SET created_at=${`2026-10-11T01:02:03.12300${index + 1}Z`}::text::timestamptz WHERE id=${attachmentId}`;
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const page: AttachmentPage = await json(
      await request(`${f.path}?limit=1${cursor ? `&cursor=${cursor}` : ""}`, {
        cookie: f.cookie,
      }),
    );
    assert.equal(page.items.length, 1);
    seen.push(page.items[0].id);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [...ids].reverse());
  const removed = await callMcpTool(oauth.token, "delete_attachment", {
    taskId: f.task.id,
    attachmentId: upload.attachmentId,
    idempotencyKey: randomUUID(),
  });
  assert.equal(removed.result?.isError, false);
});
test("pending uploads expire and cleanup retains jobs after storage failure", async () => {
  const f = await fixture();
  const upload = await reserve(f);
  await put(upload);
  await sql`UPDATE task_attachments SET upload_expires_at=now()-interval '2 minutes' WHERE id=${upload.attachmentId}`;
  assert.equal(
    (
      await request(`${f.path}/${upload.attachmentId}/complete`, {
        cookie: f.cookie,
        body: {},
      })
    ).status,
    410,
  );
  await cleanupAttachmentBatch();
  assert.equal((await sql`SELECT id FROM task_attachments`).length, 0);
  await assert.rejects(
    client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: `mill/uploads/${upload.attachmentId}`,
      }),
    ),
  );
  const rows = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const item of rows.Contents ?? [])
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }),
    );
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  await sql`INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key) VALUES(${new URL(process.env.MILL_S3_ENDPOINT!).origin},${bucket},'mill/objects/retry-cleanup')`;
  await cleanupAttachmentBatch();
  assert.equal(
    (
      await sql`SELECT object_key FROM attachment_cleanup WHERE object_key='mill/objects/retry-cleanup'`
    ).length,
    1,
  );
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  await sql`UPDATE attachment_cleanup SET available_at=now(),recheck_at=null`;
  await cleanupAttachmentBatch();
  assert.equal(
    (await sql`SELECT object_key FROM attachment_cleanup`).length,
    0,
  );
});
