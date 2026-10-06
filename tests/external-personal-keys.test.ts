import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import assert from "node:assert/strict";
import test from "node:test";

type CredentialResult = {
  token: string;
  credential: {
    id: string;
    boardIds: null;
    scopes: string[];
    expiresAt: string;
  };
};
async function body<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status);
  return response.json() as Promise<T>;
}

test("personal REST keys inherit human permissions without granting session or MCP access", async (t) => {
  await resetDatabase();
  try {
    const admin = await setupUser();
    const invited = await body<{ token: string }>(
      await request("/api/auth/invitations", {
        cookie: admin.cookie,
        body: { email: "personal-key-viewer@example.test", role: "viewer" },
      }),
      201,
    );
    const accepted = await request("/api/auth/accept-invitation", {
      body: {
        token: invited.token,
        name: "Personal key owner",
        password: "Personal key test passphrase 42!",
      },
    });
    const owner = await body<{ user: { id: string } }>(accepted, 201);
    const ownerCookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
    const makeKey = (cookie: string, name: string, expiresInDays = 30) =>
      request("/api/credentials", { cookie, body: { name, expiresInDays } });
    const board = await body<{ board: { id: string; version: number } }>(
      await request("/api/boards", {
        cookie: admin.cookie,
        body: { name: "Personal REST permissions", prefix: "REST" },
      }),
      201,
    );
    const viewerKey = await body<CredentialResult>(
      await makeKey(ownerCookie, "Role-following key"),
      201,
    );
    const changeRole = async (role: "viewer" | "member" | "admin") =>
      body(
        await request(`/api/auth/members/${owner.user.id}`, {
          cookie: admin.cookie,
          method: "PATCH",
          body: { role },
        }),
      );

    await t.test(
      "expiry presets create unbound keys and settings remain session-only",
      async () => {
        for (const days of [30, 60, 90, 365]) {
          const before = Date.now();
          const issued = await body<CredentialResult>(
            await makeKey(admin.cookie, `Expiry ${days}`, days),
            201,
          );
          assert.equal("agentId" in issued.credential, false);
          assert.equal("agentName" in issued.credential, false);
          assert.equal(issued.credential.boardIds, null);
          assert.deepEqual(issued.credential.scopes, []);
          const lifetime =
            new Date(issued.credential.expiresAt).getTime() - before;
          assert(
            lifetime >= days * 86400000 && lifetime < days * 86400000 + 10000,
          );
        }
        for (const days of [0, 31, 61, 91, 366, "30"])
          assert.equal(
            (await makeKey(admin.cookie, "Invalid expiry", days as number))
              .status,
            400,
          );
        for (const extra of [
          { agentId: admin.user.id },
          { scopes: ["read"] },
          { boardIds: [] },
        ])
          assert.equal(
            (
              await request("/api/credentials", {
                cookie: admin.cookie,
                body: { name: "No permission selectors", ...extra },
              })
            ).status,
            400,
          );
        for (const path of [
          "/api/auth/me",
          "/api/auth/members",
          "/api/auth/sessions",
          "/api/credentials",
          "/api/workspace",
          "/oauth/register",
        ])
          assert.equal(
            (await request(path, { token: viewerKey.token })).status,
            403,
            path,
          );
        assert.equal(
          (await request("/mcp", { token: viewerKey.token, body: {} })).status,
          403,
        );
      },
    );

    await t.test(
      "current role controls task and board writes while Viewers can mark their own notifications",
      async () => {
        const assigned = await body<{ task: { id: string } }>(
          await request(`/api/boards/${board.board.id}/tasks`, {
            cookie: admin.cookie,
            body: { title: "Viewer notification", assigneeId: owner.user.id },
          }),
          201,
        );
        const notifications = await body<{
          items: { id: string; taskId: string }[];
        }>(await request("/api/notifications", { token: viewerKey.token }));
        const notification = notifications.items.find(
          (item) => item.taskId === assigned.task.id,
        )!;
        assert(
          notification,
          "A real assignment creates the owner's notification",
        );
        const mark = () =>
          request("/api/notifications", {
            token: viewerKey.token,
            method: "PATCH",
            headers: { "Idempotency-Key": "viewer-notification-read" },
            body: { ids: [notification.id], read: true },
          });
        assert.equal((await mark()).status, 200);
        assert.equal(
          (await mark()).headers.get("Idempotency-Replayed"),
          "true",
        );
        const taskBody = { title: "Current role REST task" };
        const createTask = () =>
          request(`/api/boards/${board.board.id}/tasks`, {
            token: viewerKey.token,
            body: taskBody,
            headers: { "Idempotency-Key": "role-following-create-task" },
          });
        assert.equal((await createTask()).status, 403);
        await changeRole("member");
        const created = await body<{ task: { id: string } }>(
          await createTask(),
          201,
        );
        const replay = await createTask();
        assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
        assert.equal(
          (await body<typeof created>(replay, 201)).task.id,
          created.task.id,
        );
        const activity = await body<{
          items: { actorKind: string; actorName: string }[];
        }>(
          await request(`/api/tasks/${created.task.id}/activity`, {
            token: viewerKey.token,
          }),
        );
        assert(
          activity.items.some(
            (item) =>
              item.actorKind === "human" &&
              item.actorName === "Personal key owner",
          ),
        );
        await body(
          await request(`/api/boards/${board.board.id}/tasks`, {
            token: viewerKey.token,
            body: {
              title: "Another person's notification",
              assigneeId: admin.user.id,
            },
          }),
          201,
        );
        const foreign = await body<typeof notifications>(
          await request("/api/notifications", { cookie: admin.cookie }),
        );
        assert(foreign.items.length > 0);
        assert.equal(
          (
            await request("/api/notifications", {
              token: viewerKey.token,
              method: "PATCH",
              body: { ids: [foreign.items[0]!.id] },
            })
          ).status,
          403,
        );
        const removeBoard = () =>
          request(`/api/boards/${board.board.id}`, {
            token: viewerKey.token,
            method: "DELETE",
            body: { version: board.board.version },
            headers: { "Idempotency-Key": "personal-admin-delete-board" },
          });
        assert.equal((await removeBoard()).status, 403);
        await changeRole("admin");
        assert.equal((await removeBoard()).status, 200);
        assert.equal(
          (await removeBoard()).headers.get("Idempotency-Replayed"),
          "true",
        );
        await changeRole("member");
        assert.equal(
          (await removeBoard()).status,
          403,
          "A downgraded owner cannot replay an administrator action",
        );
        await changeRole("viewer");
        assert.equal(
          (await createTask()).status,
          403,
          "A downgraded owner cannot replay a Member action",
        );
      },
    );

    await t.test(
      "one-time issuance replays encrypted tokens and key identity remains isolated from sessions and other keys",
      async () => {
        const input = { name: "Response-loss retry", expiresInDays: 60 };
        const retryKey = "personal-credential-response-loss";
        const issue = () =>
          request("/api/credentials", {
            cookie: admin.cookie,
            body: input,
            headers: { "Idempotency-Key": retryKey },
          });
        const first = await body<CredentialResult>(await issue(), 201);
        const replayResponse = await issue();
        assert.equal(
          replayResponse.headers.get("Idempotency-Replayed"),
          "true",
        );
        const replay = await body<CredentialResult>(replayResponse, 201);
        assert(
          first.token === replay.token,
          "An unchanged retry returns the original one-time token",
        );
        assert.equal(first.credential.id, replay.credential.id);
        const [cache] =
          await sql`SELECT response FROM api_idempotency WHERE actor_key=${admin.user.id} AND key=${retryKey}`;
        assert(
          !JSON.stringify(cache.response).includes(first.token),
          "The retry record never stores a plaintext token",
        );
        const [{ count }] =
          await sql`SELECT count(*)::int AS count FROM credentials WHERE name=${input.name}`;
        assert.equal(count, 1);
        const otherKey = await body<CredentialResult>(
          await makeKey(admin.cookie, "Other personal key"),
          201,
        );
        const retryBoard = await body<{ board: { id: string } }>(
          await request("/api/boards", {
            cookie: admin.cookie,
            body: { name: "Separate retry actors", prefix: "IDENT" },
          }),
          201,
        );
        const createTask = (options: { token?: string; cookie?: string }) =>
          request(`/api/boards/${retryBoard.board.id}/tasks`, {
            ...options,
            body: { title: "Separate retry actors" },
            headers: { "Idempotency-Key": "same-key-separate-principals" },
          });
        const own = await body<{ task: { id: string } }>(
          await createTask({ token: first.token }),
          201,
        );
        const other = await body<typeof own>(
          await createTask({ token: otherKey.token }),
          201,
        );
        const session = await body<typeof own>(
          await createTask({ cookie: admin.cookie }),
          201,
        );
        assert.equal(
          new Set([own.task.id, other.task.id, session.task.id]).size,
          3,
        );
        assert.equal(
          (
            await request(`/api/credentials/${first.credential.id}`, {
              cookie: admin.cookie,
              method: "DELETE",
            })
          ).status,
          200,
        );
        assert.equal((await createTask({ token: first.token })).status, 401);
        await sql`UPDATE credentials SET expires_at=now()-interval '1 second' WHERE id=${otherKey.credential.id}`;
        assert.equal(
          (await request("/api/boards", { token: otherKey.token })).status,
          401,
        );
      },
    );
  } finally {
    await cleanupDatabase();
  }
});
