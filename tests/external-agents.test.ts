import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupOAuthAgent,
  setupUser,
  sql,
} from "./support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "../packages/contracts/src/index.js";
import { app } from "../apps/api/src/app.js";
import { credentialActor } from "../apps/api/src/external.js";
import { digest, secret } from "../apps/api/src/external/protocol.js";

async function body<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status);
  return response.json() as Promise<T>;
}
async function invite(
  cookie: string,
  role: "member" | "viewer",
  email: string,
) {
  const invitation = await body<{ token: string }>(
    await request("/api/auth/invitations", {
      cookie,
      body: { email, role },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: role === "member" ? "Assigned member" : "Assigned viewer",
      password: "A private integration passphrase 42!",
    },
  });
  const result = await body<{ user: { id: string } }>(accepted, 201);
  return {
    id: result.user.id,
    cookie: accepted.headers.get("set-cookie")!.split(";")[0]!,
  };
}
type Key = {
  token: string;
  credential: { id: string; agentId: string | null; agentName: string | null };
};

test("personal keys and Agent OAuth retain separate current human access boundaries", async (t) => {
  await resetDatabase();
  try {
    const { cookie, user } = await setupUser();
    const member = await invite(cookie, "member", "agent-member@example.test");
    const viewer = await invite(cookie, "viewer", "agent-viewer@example.test");
    const personal = await setupAgent(cookie, {
      name: "Personal release Agent",
    });
    let team = await setupAgent(cookie, {
      name: "Assigned team Agent",
      scope: "team",
      memberIds: [user.id, member.id, viewer.id],
    });
    const key = (ownerCookie: string) =>
      request("/api/credentials", {
        cookie: ownerCookie,
        body: { name: "Personal REST key", expiresInDays: 90 },
      });
    const personalKey = await body<Key>(await key(cookie), 201);

    await t.test(
      "personal keys inherit current human roles and cannot manage Agents or connect MCP",
      async () => {
        for (const extra of [
          { agentId: personal.id },
          { scopes: ["read"] },
          { boardIds: [] },
        ])
          assert.equal(
            (
              await request("/api/credentials", {
                cookie,
                body: { name: "No Agent or scope selector", ...extra },
              })
            ).status,
            400,
          );
        const read = await body<Key>(await key(viewer.cookie), 201);
        assert.equal(read.credential.agentId, null);
        assert.equal(read.credential.agentName, null);
        assert.equal(
          (
            await request("/api/boards", {
              token: read.token,
              body: { name: "Viewer cannot create" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(`/api/credentials/${personalKey.credential.id}`, {
              cookie: member.cookie,
              method: "DELETE",
            })
          ).status,
          404,
        );
        for (const method of ["POST", "PATCH", "DELETE"]) {
          const path =
            method === "POST" ? "/api/agents" : `/api/agents/${personal.id}`;
          assert.equal(
            (
              await request(path, {
                token: personalKey.token,
                method,
                body: {
                  name: "No implicit Agent",
                  scope: "personal",
                  version: personal.version,
                },
              })
            ).status,
            403,
          );
        }
        const actor = await credentialActor(
          new Request(`${process.env.MILL_BASE_URL}/api/boards`, {
            headers: { Authorization: `Bearer ${personalKey.token}` },
          }),
        );
        assert.equal(actor?.agentId, undefined);
        assert.equal(actor?.kind, "human");
        assert.equal(actor?.credentialType, "api-key");
        assert.equal(actor?.userId, user.id);
        assert.equal(actor?.name, user.name);
        assert.equal(
          (await request("/mcp", { token: personalKey.token, body: {} }))
            .status,
          403,
        );
      },
    );

    await t.test(
      "human and Agent task assignment are simultaneous, visible and access checked",
      async () => {
        const board = await body<{ board: { id: string } }>(
          await request("/api/boards", {
            cookie,
            body: { name: "Explicit Agent tasks", prefix: "EAT" },
          }),
          201,
        );
        const create = (input: Record<string, unknown>) =>
          request(`/api/boards/${board.board.id}/tasks`, {
            token: personalKey.token,
            body: { title: "Explicit assignment", ...input },
          });
        assert.equal((await create({ agentId: personal.id })).status, 400);
        assert.equal(
          (await create({ assigneeId: member.id, agentId: personal.id }))
            .status,
          403,
        );
        const assigned = await body<{
          task: {
            id: string;
            version: number;
            agentId: string | null;
            agentName: string | null;
            assigneeId: string | null;
          };
        }>(await create({ assigneeId: user.id, agentId: personal.id }), 201);
        assert.equal(assigned.task.assigneeId, user.id);
        assert.equal(assigned.task.agentId, personal.id);
        assert.equal(assigned.task.agentName, personal.name);
        const next = await body<typeof assigned>(
          await request(`/api/tasks/${assigned.task.id}`, {
            token: personalKey.token,
            method: "PATCH",
            body: {
              version: assigned.task.version,
              assigneeId: member.id,
              agentId: team.id,
            },
          }),
        );
        assert.equal(next.task.assigneeId, member.id);
        assert.equal(next.task.agentId, team.id);
        assert.equal(
          (
            await request(`/api/tasks/${next.task.id}`, {
              token: personalKey.token,
              method: "PATCH",
              body: { version: next.task.version, assigneeId: null },
            })
          ).status,
          400,
        );
        const listed = await body<{
          items: { id: string; agentId: string; agentName: string }[];
        }>(
          await request(
            `/api/boards/${board.board.id}/tasks?agentId=${team.id}`,
            { token: personalKey.token },
          ),
        );
        assert.equal(listed.items.length, 1);
        assert.equal(listed.items[0]!.agentName, team.name);
        assert.equal(
          (
            await body<{ items: unknown[] }>(
              await request(
                `/api/boards/${board.board.id}/tasks?agentId=unassigned`,
                { token: personalKey.token },
              ),
            )
          ).items.length,
          0,
        );
        const detail = await body<typeof assigned>(
          await request(`/api/tasks/${assigned.task.id}`, {
            token: personalKey.token,
          }),
        );
        assert.equal(detail.task.agentId, team.id);
      },
    );

    const redirect = "http://127.0.0.1:4182/explicit-agent-callback";
    const client = await body<{ client_id: string }>(
      await request("/oauth/register", {
        body: {
          client_name: "Explicit Agent OAuth",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        },
      }),
      201,
    );
    const resource = `${process.env.MILL_BASE_URL}/mcp`;
    async function start() {
      const verifier = secret();
      const response = await request(
        `/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, resource, response_type: "code", scope: "read", code_challenge_method: "S256", code_challenge: digest(verifier) })}`,
      );
      assert.equal(response.status, 302);
      return {
        id: new URL(response.headers.get("location")!).searchParams.get(
          "request",
        )!,
        verifier,
      };
    }
    async function approve(ownerCookie: string, selectedId: string) {
      const begun = await start();
      const decision = await body<{ redirectTo: string }>(
        await request(`/api/oauth/consent/${begun.id}`, {
          cookie: ownerCookie,
          body: { allow: true, agentId: selectedId },
        }),
      );
      return {
        ...begun,
        code: new URL(decision.redirectTo).searchParams.get("code")!,
      };
    }
    async function exchange(grant: { code: string; verifier: string }) {
      return app.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          resource,
          grant_type: "authorization_code",
          code: grant.code,
          code_verifier: grant.verifier,
        }),
      });
    }
    async function members(memberIds: string[]) {
      const result = await body<{ agent: Agent }>(
        await request(`/api/agents/${team.id}`, {
          cookie,
          method: "PATCH",
          body: { version: team.version, memberIds },
        }),
      );
      team = result.agent;
    }

    await t.test(
      "consent never creates an Agent and direct approval cannot bypass an empty eligible directory",
      async () => {
        const empty = await invite(cookie, "member", "no-agent@example.test");
        const begun = await start();
        const detail = await body<{
          agents: Agent[];
          requiresAgent: boolean;
          canApprove: boolean;
        }>(
          await request(`/api/oauth/consent/${begun.id}`, {
            cookie: empty.cookie,
          }),
        );
        assert.deepEqual(detail.agents, []);
        assert.equal(detail.requiresAgent, true);
        assert.equal(detail.canApprove, false);
        for (const input of [
          { allow: true },
          { allow: true, agentId: personal.id },
        ])
          assert.equal(
            (
              await request(`/api/oauth/consent/${begun.id}`, {
                cookie: empty.cookie,
                body: input,
              })
            ).status,
            403,
          );
        const [count] =
          await sql`SELECT count(*)::int AS count FROM agents WHERE creator_id=${empty.id}`;
        assert.equal(count.count, 0);
        const denied = await body<{ redirectTo: string }>(
          await request(`/api/oauth/consent/${begun.id}`, {
            cookie: empty.cookie,
            body: { allow: false },
          }),
        );
        assert.equal(
          new URL(denied.redirectTo).searchParams.get("error"),
          "access_denied",
        );
      },
    );

    await t.test(
      "team access is checked at approval, exchange and each request without resurrecting removed grants",
      async () => {
        const blocked = await start();
        const pending = await approve(member.cookie, team.id);
        const active = await body<{ access_token: string }>(
          await exchange(await approve(member.cookie, team.id)),
        );
        const memberKey = await setupOAuthAgent(member.cookie, {
          agentId: team.id,
        });
        const independent = await body<Key>(await key(member.cookie), 201);
        await members([user.id, viewer.id]);
        assert.equal(
          (
            await request(`/api/oauth/consent/${blocked.id}`, {
              cookie: member.cookie,
              body: { allow: true, agentId: team.id },
            })
          ).status,
          403,
        );
        assert.equal((await exchange(pending)).status, 400);
        assert.equal(
          await credentialActor(
            new Request(resource, {
              headers: { Authorization: `Bearer ${active.access_token}` },
            }),
          ),
          null,
        );
        assert.equal(
          (await request("/api/boards", { token: memberKey.token })).status,
          401,
        );
        const [stored] =
          await sql`SELECT agent_id,revoked_at FROM credentials WHERE id=${memberKey.credential.id}`;
        assert.equal(
          (await request("/api/boards", { token: independent.token })).status,
          200,
        );
        assert.equal(stored.agentId, team.id);
        assert(stored.revokedAt);
        await members([user.id, member.id, viewer.id]);
        assert.equal((await exchange(pending)).status, 400);
        assert.equal(
          (await request("/api/boards", { token: memberKey.token })).status,
          401,
        );
        assert.equal(
          await credentialActor(
            new Request(resource, {
              headers: { Authorization: `Bearer ${active.access_token}` },
            }),
          ),
          null,
        );
      },
    );
    await t.test(
      "queued Agent consent and OAuth exchange cannot cross a grant revocation",
      async () => {
        const pending = await approve(member.cookie, team.id);
        const approval = await start();
        const [before] =
          await sql`SELECT count(*)::int AS count FROM credentials WHERE user_id=${member.id}`;
        let release!: () => void;
        let ready!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const removal = sql.begin(async (tx) => {
          await tx`SELECT id FROM workspace FOR UPDATE`;
          await tx`DELETE FROM agent_members WHERE agent_id=${team.id} AND user_id=${member.id}`;
          ready();
          await gate;
        });
        await held;
        let creationFinished = false;
        let exchangeFinished = false;
        const creation = request(`/api/oauth/consent/${approval.id}`, {
          cookie: member.cookie,
          body: { allow: true, agentId: team.id },
        }).then((response) => {
          creationFinished = true;
          return response;
        });
        const codeExchange = exchange(pending).then((response) => {
          exchangeFinished = true;
          return response;
        });
        try {
          const deadline = Date.now() + 5000;
          let waiting = 0;
          while (Date.now() < deadline) {
            const [locks] =
              await sql`SELECT count(DISTINCT a.pid)::int AS count FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.wait_event_type='Lock' AND l.relation='workspace'::regclass`;
            waiting = locks.count;
            if (waiting >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert(
            waiting >= 2,
            "Both operations wait on the current Agent authority transaction",
          );
          assert.equal(creationFinished, false);
          assert.equal(exchangeFinished, false);
        } finally {
          release();
          await removal;
        }
        assert.equal((await creation).status, 403);
        assert.equal((await codeExchange).status, 400);
        const [after] =
          await sql`SELECT count(*)::int AS count FROM credentials WHERE user_id=${member.id}`;
        assert.equal(after.count, before.count);
      },
    );
    await t.test(
      "successful consent retries track selected resources and become terminal after deletion",
      async () => {
        for (const resourceKind of ["agent", "board"] as const) {
          const selected = await setupAgent(cookie, {
            name: `Consent retry ${resourceKind}`,
          });
          const selectedBoard = await body<{
            board: { id: string; version: number };
          }>(
            await request("/api/boards", {
              cookie,
              body: {
                name: `Consent retry ${resourceKind}`,
                prefix: resourceKind === "agent" ? "CRA" : "CRB",
              },
            }),
            201,
          );
          const begun = await start();
          const input = {
            allow: true,
            agentId: selected.id,
            boardIds: [selectedBoard.board.id],
          };
          const headers = {
            "Idempotency-Key": `consent-resources-${resourceKind}`,
          };
          const consentPath = `/api/oauth/consent/${begun.id}`;
          const decision = await body<{ redirectTo: string }>(
            await request(consentPath, { cookie, body: input, headers }),
          );
          const code = new URL(decision.redirectTo).searchParams.get("code");
          assert(code, "Successful consent returns an authorization code");
          const [cached] =
            await sql`SELECT request_hash,agent_ids,board_ids,response FROM api_idempotency WHERE actor_key=${user.id} AND key=${headers["Idempotency-Key"]}`;
          assert.deepEqual(cached.agentIds, [selected.id]);
          assert.deepEqual(cached.boardIds, [selectedBoard.board.id]);
          assert(
            cached.response,
            "The live consent result is encrypted for retry",
          );

          const denied = await start();
          const denyInput = { ...input, allow: false };
          const denyHeaders = {
            "Idempotency-Key": `consent-denial-${resourceKind}`,
          };
          const denyPath = `/api/oauth/consent/${denied.id}`;
          await body<{ redirectTo: string }>(
            await request(denyPath, {
              cookie,
              body: denyInput,
              headers: denyHeaders,
            }),
          );
          const [denial] =
            await sql`SELECT agent_ids,board_ids FROM api_idempotency WHERE actor_key=${user.id} AND key=${denyHeaders["Idempotency-Key"]}`;
          assert.deepEqual(denial.agentIds, []);
          assert.deepEqual(denial.boardIds, []);

          const deletionPath =
            resourceKind === "agent"
              ? `/api/agents/${selected.id}`
              : `/api/boards/${selectedBoard.board.id}`;
          const deletionInput = {
            version:
              resourceKind === "agent"
                ? selected.version
                : selectedBoard.board.version,
          };
          const deletionHeaders = {
            "Idempotency-Key": `consent-delete-${resourceKind}`,
          };
          await body(
            await request(deletionPath, {
              cookie,
              method: "DELETE",
              body: deletionInput,
              headers: deletionHeaders,
            }),
          );
          const repeatedDelete = await request(deletionPath, {
            cookie,
            method: "DELETE",
            body: deletionInput,
            headers: deletionHeaders,
          });
          assert.equal(repeatedDelete.status, 200);
          assert.equal(
            repeatedDelete.headers.get("Idempotency-Replayed"),
            "true",
          );

          const retry = await request(consentPath, {
            cookie,
            body: input,
            headers,
          });
          assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
          const invalidated = await body<{ code: string; redirectTo?: string }>(
            retry,
            410,
          );
          assert.equal(invalidated.code, "retry_invalidated");
          assert.equal("redirectTo" in invalidated, false);
          const [terminal] =
            await sql`SELECT request_hash,status,response,invalidation_reason FROM api_idempotency WHERE actor_key=${user.id} AND key=${headers["Idempotency-Key"]}`;
          assert.equal(terminal.requestHash, cached.requestHash);
          assert.equal(terminal.status, 410);
          assert.equal(terminal.response, null);
          assert.equal(terminal.invalidationReason, "deleted");
          assert.equal(
            (await exchange({ code, verifier: begun.verifier })).status,
            400,
          );

          const deniedRetry = await request(denyPath, {
            cookie,
            body: denyInput,
            headers: denyHeaders,
          });
          assert.equal(deniedRetry.status, 200);
          assert.equal(deniedRetry.headers.get("Idempotency-Replayed"), "true");
          const denyDecision = await body<{ redirectTo: string }>(deniedRetry);
          assert.equal(
            new URL(denyDecision.redirectTo).searchParams.get("error"),
            "access_denied",
          );
        }
      },
    );
  } finally {
    await cleanupDatabase();
  }
});
