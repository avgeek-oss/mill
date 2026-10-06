import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import { virtualPasskey } from "./passkey-support.js";
beforeEach(resetDatabase);
after(cleanupDatabase);
async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("common account/team names accept exactly120 and reject121 before mutation across setup, profile and invitations", async () => {
  const long = "N".repeat(120),
    tooLong = long + "X";
  for (const fields of [
    { name: tooLong, workspaceName: "Team" },
    { name: "Owner", workspaceName: tooLong },
  ]) {
    assert.equal(
      (
        await request("/api/auth/setup", {
          body: {
            ...fields,
            email: "owner@example.test",
            password: "Secure name-boundary passphrase42!",
          },
        })
      ).status,
      400,
    );
    assert.equal((await sql`SELECT id FROM users`).length, 0);
    assert.equal((await sql`SELECT id FROM workspace`).length, 0);
  }
  const u = await setupUser({ name: long, workspaceName: long });
  assert.equal(u.user.name, long);
  assert.equal(u.body.workspace.name, long);
  await json(
    await request("/api/auth/profile", {
      cookie: u.cookie,
      method: "PATCH",
      body: { name: long },
    }),
  );
  assert.equal(
    (
      await request("/api/auth/profile", {
        cookie: u.cookie,
        method: "PATCH",
        body: { name: tooLong },
      })
    ).status,
    400,
  );
  await json(
    await request("/api/workspace", {
      cookie: u.cookie,
      method: "PATCH",
      body: { name: long },
    }),
  );
  assert.equal(
    (
      await request("/api/workspace", {
        cookie: u.cookie,
        method: "PATCH",
        body: { name: tooLong },
      })
    ).status,
    400,
  );
  const i = await json(
    await request("/api/auth/invitations", {
      cookie: u.cookie,
      body: { email: "named-invitee@example.test", role: "member" },
    }),
    201,
  );
  const accepted = { token: i.token, password: "Secure invited passphrase42!" };
  assert.equal(
    (
      await request("/api/auth/accept-invitation", {
        body: { ...accepted, name: tooLong },
      })
    ).status,
    400,
  );
  assert.equal(
    (await sql`SELECT id FROM users WHERE email='named-invitee@example.test'`)
      .length,
    0,
  );
  assert.equal(
    (
      await json(
        await request("/api/auth/accept-invitation", {
          body: { ...accepted, name: long },
        }),
        201,
      )
    ).user.name,
    long,
  );
  assert.equal(
    (await sql`SELECT name FROM users WHERE id=${u.user.id}`)[0].name,
    long,
  );
  assert.equal((await sql`SELECT name FROM workspace`)[0].name, long);
  await assert.rejects(
    sql`UPDATE users SET name=${tooLong} WHERE id=${u.user.id}`,
    { code: "23514" },
  );
  await assert.rejects(sql`UPDATE workspace SET name=${tooLong}`, {
    code: "23514",
  });
});

test("passkey names accept exactly120 in a real registration and SQL, while independent board names remain100", async () => {
  const u = await setupUser(),
    key = virtualPasskey(u.user.id),
    name = "P".repeat(120);
  const options = await json(
    await request("/api/auth/passkeys/register/options", {
      cookie: u.cookie,
      body: {},
    }),
  );
  const registration = {
    challengeId: options.challengeId,
    response: key.registration(options.options.challenge),
  };
  assert.equal(
    (
      await request("/api/auth/passkeys/register/verify", {
        cookie: u.cookie,
        body: { ...registration, name: name + "X" },
      })
    ).status,
    400,
  );
  assert.equal((await sql`SELECT id FROM passkeys`).length, 0);
  await json(
    await request("/api/auth/passkeys/register/verify", {
      cookie: u.cookie,
      body: { ...registration, name },
    }),
  );
  assert.equal((await sql`SELECT name FROM passkeys`)[0].name, name);
  await assert.rejects(sql`UPDATE passkeys SET name=${name + "X"}`, {
    code: "23514",
  });
  const boardName = "B".repeat(100);
  assert.equal(
    (
      await request("/api/boards", {
        cookie: u.cookie,
        body: { name: boardName + "X", prefix: "MAX" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await json(
        await request("/api/boards", {
          cookie: u.cookie,
          body: { name: boardName, prefix: "MAX" },
        }),
        201,
      )
    ).board.name,
    boardName,
  );
  await assert.rejects(sql`UPDATE boards SET name=${boardName + "X"}`, {
    code: "23514",
  });
});
