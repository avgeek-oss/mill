import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
beforeEach(resetDatabase);
after(cleanupDatabase);
const password = "Another secure passphrase 42!";
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function fixture() {
  const owner = await setupUser();
  const invite = await json(
    await request("/api/auth/invitations", {
      cookie: owner.cookie,
      body: { email: "inviter@example.test", role: "admin" },
    }),
    201,
  );
  const accepted = await request("/api/auth/accept-invitation", {
    body: { token: invite.token, name: "Inviter", password },
  });
  const inviter = (await json(accepted, 201)).user;
  const cookie = accepted.headers.get("set-cookie")!.split(";")[0];
  const pending = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: "invitee@example.test", role: "member" },
    }),
    201,
  );
  return { owner, inviter, cookie, pending };
}
async function waitForBlocked(pid: number, expected: number) {
  const deadline = Date.now() + 5000;
  do {
    const [row] =
      await sql`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid)) UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid))) SELECT count(DISTINCT pid)::int AS total FROM blocked`;
    if (row.total >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("Invitation operation did not reach authority barrier");
}
for (const action of ["demotion", "removal"] as const) {
  test(`invitation preview and acceptance reject a ${action} of the inviter even for legacy pending links`, async () => {
    const { inviter, pending } = await fixture();
    // A previously issued link must be safe without relying on eager cancellation.
    await sql`UPDATE users SET role='member',disabled_at=${action === "removal" ? new Date() : null} WHERE id=${inviter.id}`;
    assert.equal(
      (await request(`/api/auth/invitation?token=${pending.token}`)).status,
      400,
    );
    assert.equal(
      (
        await request("/api/auth/accept-invitation", {
          body: { token: pending.token, name: "Invitee", password },
        })
      ).status,
      400,
    );
    assert.equal(
      (await sql`SELECT id FROM users WHERE email='invitee@example.test'`)
        .length,
      0,
    );
  });
  test(`queued invitation acceptance cannot bypass concurrent inviter ${action}`, async () => {
    const { owner, inviter, pending } = await fixture();
    let unlock!: () => void, ready!: (pid: number) => void;
    const started = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM workspace FOR UPDATE`;
      ready((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await release;
    });
    const pid = await started;
    let mutation!: Promise<Response>, accepting!: Promise<Response>;
    try {
      mutation = request(`/api/auth/members/${inviter.id}`, {
        cookie: owner.cookie,
        method: action === "demotion" ? "PATCH" : "DELETE",
        ...(action === "demotion" ? { body: { role: "member" } } : {}),
      });
      await waitForBlocked(pid, 1);
      accepting = request("/api/auth/accept-invitation", {
        body: { token: pending.token, name: "Invitee", password },
      });
      await waitForBlocked(pid, 2);
    } finally {
      unlock();
      await holder;
    }
    await json(await mutation);
    assert.equal((await accepting).status, 400);
    assert.equal(
      (
        await sql`SELECT revoked_at FROM invitations WHERE id=${pending.invitation.id}`
      )[0].revokedAt instanceof Date,
      true,
    );
    assert.equal(
      (await sql`SELECT id FROM users WHERE email='invitee@example.test'`)
        .length,
      0,
    );
  });
}
