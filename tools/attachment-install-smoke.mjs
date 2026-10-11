import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const origin = "http://127.0.0.1:4321";
const taskId = process.env.MILL_VERIFY_ATTACHMENT_TASK;
assert.ok(taskId && process.env.MILL_VERIFY_PASSWORD);
const client = new S3Client({
  endpoint: process.env.MILL_S3_ENDPOINT,
  region: process.env.MILL_S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MILL_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.MILL_S3_SECRET_ACCESS_KEY,
  },
});
let cookie = "";
async function request(path, method = "GET", body, status = 200) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      Origin: process.env.MILL_WEB_URL,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? cookie;
  return response.json();
}
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(
        new CreateBucketCommand({ Bucket: process.env.MILL_S3_BUCKET }),
      );
      break;
    } catch (error) {
      if (attempt === 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await request("/auth/login", "POST", {
    email: "install-verifier@example.invalid",
    password: process.env.MILL_VERIFY_PASSWORD,
  });
  assert.equal((await request("/attachments/config")).enabled, true);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X8AAAAASUVORK5CYII=",
    "base64",
  );
  const path = `/tasks/${taskId}/attachments`;
  const upload = await request(
    `${path}/uploads`,
    "POST",
    {
      fileName: "production-verification.png",
      contentType: "image/png",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    201,
  );
  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: upload.headers,
    body: bytes,
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(put.ok, true, "The built API signs a usable upload URL");
  const completed = await request(
    `${path}/${upload.attachmentId}/complete`,
    "POST",
    {},
  );
  assert.equal(completed.attachment.fileName, "production-verification.png");
  assert.ok(
    (await request(path)).items.some((item) => item.id === upload.attachmentId),
  );
  const download = await request(`${path}/${upload.attachmentId}/download`);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  assert.equal(
    (
      await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: upload.headers,
        body: changed,
        signal: AbortSignal.timeout(15_000),
      })
    ).ok,
    true,
    "The original upload URL can still write only the staging object",
  );
  const received = await fetch(download.url, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(received.ok, true);
  assert.match(
    received.headers.get("content-disposition"),
    /production-verification\.png/,
  );
  assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes);
  await request(`${path}/${upload.attachmentId}`, "DELETE", {});
  await request(
    `${path}/${upload.attachmentId}/download`,
    "GET",
    undefined,
    404,
  );
  assert.equal(
    (await request(path)).items.some((item) => item.id === upload.attachmentId),
    false,
  );
  const objectKey = decodeURIComponent(
    new URL(download.url).pathname.slice(
      `/${process.env.MILL_S3_BUCKET}/`.length,
    ),
  );
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: process.env.MILL_S3_BUCKET,
          Key: objectKey,
        }),
      );
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) break;
      throw error;
    }
    assert.ok(
      attempt < 30,
      "The built API cleanup loop deletes the completed object",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(
    "PASS built API signed upload, immutable bytes, download, metadata deletion and durable object cleanup",
  );
} finally {
  client.destroy();
}
