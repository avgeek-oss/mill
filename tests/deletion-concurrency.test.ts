import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupUser,
  sql,
} from "./support.js";
import type { Tx } from "../apps/api/src/domain/helpers.js";
import { app } from "../apps/api/src/app.js";
import { digest, secret } from "../apps/api/src/external/protocol.js";

beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function fixture() {
  const admin = await setupUser();
  const { board } = await json(
    await request("/api/boards", {
      cookie: admin.cookie,
      body: { name: "Concurrency", prefix: "RACE" },
    }),
    201,
  );
  const { task } = await json(
    await request(`/api/boards/${board.id}/tasks`, {
      cookie: admin.cookie,
      body: { title: "Concurrent work" },
    }),
    201,
  );
  return { ...admin, board, task };
}
async function barrier(lock: (tx: Tx) => Promise<unknown>) {
  let release!: () => void;
  let ready!: () => void;
  let fail!: (error: unknown) => void;
  let pid = 0;
  const locked = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = sql.begin(async (tx) => {
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    pid = backend.pid;
    await lock(tx);
    ready();
    await released;
  });
  void holder.catch(fail);
  await locked;
  return {
    pid,
    async release() {
      release();
      await holder;
    },
  };
}
async function waitForBlocked(pid: number, expected = 1) {
  const deadline = Date.now() + 5000;
  do {
    const [row] = await sql`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))
      UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))
    ) SELECT count(DISTINCT pid)::int AS total FROM blocked`;
    if (row.total >= expected) return;
  } while (Date.now() < deadline);
  assert.fail(
    `Expected ${expected} database operations waiting on barrier ${pid}`,
  );
}

for (const action of ["edit", "comment"] as const) {
  for (const winner of ["delete", "mutation"] as const) {
    test(`task ${action} and permanent delete serialize when ${winner} acquires the board first`, async () => {
      const { cookie, board, task } = await fixture();
      const gate = await barrier(
        (tx) => tx`SELECT id FROM boards WHERE id=${board.id} FOR UPDATE`,
      );
      const deletion = () =>
        request(`/api/tasks/${task.id}`, {
          cookie,
          method: "DELETE",
          body: { version: task.version },
        });
      const mutation = () =>
        action === "edit"
          ? request(`/api/tasks/${task.id}`, {
              cookie,
              method: "PATCH",
              body: { version: task.version, title: "Concurrent edit" },
            })
          : request(`/api/tasks/${task.id}/comments`, {
              cookie,
              body: { body: "Concurrent comment" },
            });
      let first: Promise<Response>;
      let second: Promise<Response>;
      try {
        first = winner === "delete" ? deletion() : mutation();
        await waitForBlocked(gate.pid);
        second = winner === "delete" ? mutation() : deletion();
        await waitForBlocked(gate.pid, 2);
      } finally {
        await gate.release();
      }
      const firstResponse = await first!;
      const secondResponse = await second!;
      assert.equal(
        firstResponse.status,
        winner === "mutation" && action === "comment" ? 201 : 200,
        await firstResponse.clone().text(),
      );
      assert.equal(
        secondResponse.status,
        winner === "delete" ? 404 : action === "edit" ? 409 : 200,
        await secondResponse.clone().text(),
      );
      const exists = winner === "mutation" && action === "edit";
      assert.equal(
        (await sql`SELECT id FROM tasks WHERE id=${task.id}`).length,
        exists ? 1 : 0,
      );
      assert.equal(
        (await sql`SELECT id FROM comments WHERE task_id=${task.id}`).length,
        0,
      );
      assert.equal(
        (await sql`SELECT id FROM notifications WHERE task_id=${task.id}`)
          .length,
        0,
      );
      if (!exists)
        assert.equal(
          (await sql`SELECT id FROM activity WHERE task_id=${task.id}`).length,
          0,
        );
      if (exists)
        assert.equal(
          (await sql`SELECT title FROM tasks WHERE id=${task.id}`)[0].title,
          "Concurrent edit",
        );
    });
  }
}

for (const winner of ["delete", "issuance"] as const) {
  test(`no-key credential creation and board deletion retain scope locks when ${winner} goes first`, async () => {
    const { cookie, user, board } = await fixture();
    const agent = await setupAgent(cookie);
    const gate = await barrier((tx) =>
      winner === "delete"
        ? tx`SELECT id FROM boards WHERE id=${board.id} FOR UPDATE`
        : tx`SELECT id FROM users WHERE id=${user.id} FOR UPDATE`,
    );
    const deletion = () =>
      request(`/api/boards/${board.id}`, {
        cookie,
        method: "DELETE",
        body: { version: board.version },
      });
    const issuance = () =>
      request("/api/credentials", {
        cookie,
        body: {
          agentId: agent.id,
          name: "Concurrent scope",
          scopes: ["read", "write"],
          boardIds: [board.id],
        },
      });
    let first: Promise<Response>;
    let second: Promise<Response>;
    try {
      first = winner === "delete" ? deletion() : issuance();
      await waitForBlocked(gate.pid);
      second = winner === "delete" ? issuance() : deletion();
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    const issued = await (winner === "delete" ? second! : first!);
    const deleted = await (winner === "delete" ? first! : second!);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(
      issued.status,
      winner === "delete" ? 400 : 201,
      await issued.clone().text(),
    );
    assert.equal(
      (await sql`SELECT id FROM credentials WHERE ${board.id}=ANY(board_ids)`)
        .length,
      0,
    );
    if (winner === "issuance") {
      const { credential, token } = await issued.json();
      const [stored] =
        await sql`SELECT board_ids,revoked_at FROM credentials WHERE id=${credential.id}`;
      assert.deepEqual(stored.boardIds, []);
      assert.ok(stored.revokedAt);
      assert.equal((await request("/api/boards", { token })).status, 401);
    }
  });
}

async function oauth(cookie: string, boardId: string) {
  const agent = await setupAgent(cookie);
  const redirect = "http://127.0.0.1:4182/callback";
  const client = await json(
    await request("/oauth/register", {
      body: {
        client_name: "Concurrent OAuth",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      },
    }),
    201,
  );
  const verifier = secret();
  const response = await request(
    `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, resource: `${process.env.MILL_BASE_URL}/mcp`, scope: "read write", code_challenge: digest(verifier), code_challenge_method: "S256" })}`,
  );
  assert.equal(response.status, 302);
  const grantId = new URL(response.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const consent = () =>
    request(`/api/oauth/consent/${grantId}`, {
      cookie,
      body: { allow: true, agentId: agent.id, boardIds: [boardId] },
    });
  const exchange = async (code: string) =>
    app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirect,
        resource: `${process.env.MILL_BASE_URL}/mcp`,
        code,
        code_verifier: verifier,
      }),
    });
  return { grantId, consent, exchange };
}

for (const winner of ["delete", "issuance"] as const) {
  test(`no-key OAuth consent and board deletion serialize when ${winner} goes first`, async () => {
    const { cookie, board } = await fixture();
    const flow = await oauth(cookie, board.id);
    const gate = await barrier((tx) =>
      winner === "delete"
        ? tx`SELECT id FROM boards WHERE id=${board.id} FOR UPDATE`
        : tx`SELECT id FROM oauth_requests WHERE id=${flow.grantId} FOR UPDATE`,
    );
    const deletion = () =>
      request(`/api/boards/${board.id}`, {
        cookie,
        method: "DELETE",
        body: { version: board.version },
      });
    let first: Promise<Response>;
    let second: Promise<Response>;
    try {
      first = winner === "delete" ? deletion() : flow.consent();
      await waitForBlocked(gate.pid);
      second = winner === "delete" ? flow.consent() : deletion();
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    const consent = await (winner === "delete" ? second! : first!);
    const deleted = await (winner === "delete" ? first! : second!);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(
      consent.status,
      winner === "delete" ? 400 : 200,
      await consent.clone().text(),
    );
    assert.equal(
      (
        await sql`SELECT id FROM oauth_requests WHERE ${board.id}=ANY(board_ids)`
      ).length,
      0,
    );
    if (winner === "issuance") {
      const { redirectTo } = await consent.json();
      const code = new URL(redirectTo).searchParams.get("code")!;
      assert.equal((await flow.exchange(code)).status, 400);
      assert.equal(
        (await sql`SELECT id FROM oauth_requests WHERE id=${flow.grantId}`)
          .length,
        0,
      );
    }
  });
}

for (const winner of ["delete", "issuance"] as const) {
  test(`OAuth token exchange and board deletion serialize scope cleanup when ${winner} goes first`, async () => {
    const { cookie, board } = await fixture();
    const flow = await oauth(cookie, board.id);
    const { redirectTo } = await json(await flow.consent());
    const code = new URL(redirectTo).searchParams.get("code")!;
    const gate = await barrier(
      (tx) =>
        tx`SELECT id FROM oauth_requests WHERE id=${flow.grantId} FOR UPDATE`,
    );
    const deletion = () =>
      request(`/api/boards/${board.id}`, {
        cookie,
        method: "DELETE",
        body: { version: board.version },
      });
    const issuance = () => flow.exchange(code);
    let first: Promise<Response>;
    let second: Promise<Response>;
    try {
      first = winner === "delete" ? deletion() : issuance();
      await waitForBlocked(gate.pid);
      second = winner === "delete" ? issuance() : deletion();
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    const issued = await (winner === "delete" ? second! : first!);
    const deleted = await (winner === "delete" ? first! : second!);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(
      issued.status,
      winner === "delete" ? 400 : 200,
      await issued.clone().text(),
    );
    assert.equal(
      (
        await sql`SELECT id FROM oauth_requests WHERE ${board.id}=ANY(board_ids)`
      ).length,
      0,
    );
    assert.equal(
      (await sql`SELECT id FROM credentials WHERE ${board.id}=ANY(board_ids)`)
        .length,
      0,
    );
    if (winner === "issuance") {
      const { access_token } = await issued.json();
      const [credential] =
        await sql`SELECT board_ids,revoked_at FROM credentials WHERE token_hash=${digest(access_token)}`;
      assert.deepEqual(credential.boardIds, []);
      assert.ok(credential.revokedAt);
      const response = await app.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json,text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "deleted-scope-test", version: "1" },
          },
        }),
      });
      assert.equal(response.status, 401);
    }
  });
}

for (const change of ["role", "revoke"] as const) {
  test(`a task delete queued after ${change} rechecks workspace authority`, async () => {
    const { cookie, board, task } = await fixture();
    const invitation = await json(
      await request("/api/auth/invitations", {
        cookie,
        body: { email: "writer@example.test", role: "member" },
      }),
      201,
    );
    const accepted = await request("/api/auth/accept-invitation", {
      body: {
        token: invitation.token,
        name: "Writer",
        password: "Another secure passphrase 42!",
      },
    });
    const { user } = await json(accepted, 201);
    const memberCookie = accepted.headers.get("set-cookie")!.split(";")[0];
    const credential = await json(
      await request("/api/credentials", {
        cookie: memberCookie,
        body: {
          agentId: (await setupAgent(memberCookie)).id,
          name: "Pending delete",
          scopes: ["read", "write"],
          boardIds: [board.id],
        },
      }),
      201,
    );
    await json(await request("/api/boards", { token: credential.token }));
    const gate = await barrier((tx) => tx`SELECT id FROM workspace FOR UPDATE`);
    let pending!: Promise<Response>;
    let changed!: Promise<Response>;
    try {
      changed =
        change === "role"
          ? request(`/api/auth/members/${user.id}`, {
              cookie,
              method: "PATCH",
              body: { role: "viewer" },
            })
          : request(`/api/credentials/${credential.credential.id}`, {
              cookie: memberCookie,
              method: "DELETE",
            });
      await waitForBlocked(gate.pid);
      pending = request(`/api/tasks/${task.id}`, {
        token: credential.token,
        method: "DELETE",
        body: { version: task.version },
      });
      await waitForBlocked(gate.pid, 2);
    } finally {
      await gate.release();
    }
    const changedResponse = await changed;
    assert.equal(
      changedResponse.status,
      200,
      await changedResponse.clone().text(),
    );
    const result = await pending;
    assert.ok([401, 403].includes(result.status), await result.clone().text());
    assert.equal(
      (await sql`SELECT id FROM tasks WHERE id=${task.id}`).length,
      1,
    );
    assert.equal(
      (await sql`SELECT id FROM activity WHERE action='task.deleted'`).length,
      0,
    );
  });
}
