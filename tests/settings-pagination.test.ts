import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { cleanupDatabase, request, resetDatabase, setupUser, sql } =
  await import("./support.js");
const { credentialActor } =
  await import("../apps/api/src/external/credentials.js");

beforeEach(resetDatabase);
after(cleanupDatabase);

async function json(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function join(
  cookie: string,
  email: string,
  role: "admin" | "member" = "member",
) {
  const invitation = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email, role },
    }),
    201,
  );
  const response = await request("/api/auth/accept-invitation", {
    body: {
      token: invitation.token,
      name: "Another person",
      password: "Secure test passphrase 42!",
    },
  });
  const identity = await json(response, 201);
  return {
    user: identity.user,
    cookie: response.headers.get("set-cookie")!.split(";")[0],
  };
}

async function credential(cookie: string, name = "Older active access") {
  return json(
    await request("/api/credentials", {
      cookie,
      body: {
        name,
        access: "edit",
        includeAdmin: false,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
    }),
    201,
  );
}

type Page = {
  items: { id: string }[];
  hasMore: boolean;
  nextCursor: string | null;
};

async function remaining(path: string, cookie: string, first: Page) {
  const ids = first.items.map((item) => item.id);
  let page = first;
  while (page.hasMore) {
    assert.ok(page.nextCursor);
    page = await json(
      await request(`${path}&cursor=${page.nextCursor}`, { cookie }),
    );
    ids.push(...page.items.map((item) => item.id));
  }
  assert.equal(page.nextCursor, null);
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}

test("credential pages exclude revoked rows before pagination and retain expired access", async () => {
  const { cookie, user } = await setupUser();
  const older = await credential(cookie);
  const expired = await credential(cookie, "Expired access");
  await sql`UPDATE credentials SET created_at='2020-01-01T00:00:00Z' WHERE id=${older.credential.id}`;
  await sql`UPDATE credentials SET created_at='2024-01-01T00:00:00Z',expires_at=now()-interval '1 day' WHERE id=${expired.credential.id}`;
  await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at) SELECT ${user.id},'Active '||sequence,gen_random_uuid()::text,'mill_fixture','{}'::text[],timestamptz '2025-01-01T00:00:00Z'+(sequence/3)*interval '1 microsecond',now()+interval '1 day' FROM generate_series(1,207) sequence`;
  await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at,revoked_at) SELECT ${user.id},'Revoked '||sequence,gen_random_uuid()::text,'mill_fixture','{}'::text[],timestamptz '2026-01-01T00:00:00Z'+(sequence/3)*interval '1 microsecond',now()+interval '1 day',now() FROM generate_series(1,417) sequence`;
  const expected = (
    await sql`SELECT id FROM credentials WHERE user_id=${user.id} AND revoked_at IS NULL ORDER BY created_at DESC,id DESC`
  ).map((row) => row.id);
  assert.equal(expected.length, 209);
  assert.ok(expected.includes(expired.credential.id));
  const first: Page = await json(await request("/api/credentials", { cookie }));
  assert.equal(first.items.length, 200);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, first.items.at(-1)!.id);
  assert.deepEqual(
    first.items.map((item) => item.id),
    expected.slice(0, 200),
  );
  assert.equal(
    first.items.some((item) => item.id === older.credential.id),
    false,
  );
  assert.equal(JSON.stringify(first).includes("tokenHash"), false);
  await credential(cookie, "Created between pages");
  assert.deepEqual(
    await remaining("/api/credentials?limit=200", cookie, first),
    expected,
  );
  const smallFirst = await json(
    await request("/api/credentials?limit=53", { cookie }),
  );
  const currentExpected = (
    await sql`SELECT id FROM credentials WHERE user_id=${user.id} AND revoked_at IS NULL ORDER BY created_at DESC,id DESC`
  ).map((row) => row.id);
  assert.deepEqual(
    await remaining("/api/credentials?limit=53", cookie, smallFirst),
    currentExpected,
  );
  const resource = new URL("/api/boards", process.env.MILL_API_URL!);
  const authorization = { authorization: `Bearer ${older.token}` };
  assert.equal(
    (await credentialActor(new Request(resource, { headers: authorization })))
      ?.kind,
    "human",
  );
  await json(
    await request(`/api/credentials/${older.credential.id}`, {
      cookie,
      method: "DELETE",
    }),
  );
  assert.equal(
    await credentialActor(new Request(resource, { headers: authorization })),
    null,
  );
  const [revoked] =
    await sql`SELECT revoked_at FROM credentials WHERE id=${older.credential.id}`;
  assert.ok(revoked.revokedAt);
  const reloaded = await json(
    await request("/api/credentials?limit=53", { cookie }),
  );
  assert.deepEqual(
    await remaining("/api/credentials?limit=53", cookie, reloaded),
    currentExpected.filter((id) => id !== older.credential.id),
  );
});

test("credential pagination continues after its owned cursor is revoked", async () => {
  const { cookie, user } = await setupUser();
  await sql`INSERT INTO credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at) SELECT ${user.id},'Active '||sequence,gen_random_uuid()::text,'mill_fixture','{}'::text[],timestamptz '2025-01-01T00:00:00Z'+sequence*interval '1 microsecond',now()+interval '1 day' FROM generate_series(1,5) sequence`;
  const expected = (
    await sql`SELECT id FROM credentials WHERE user_id=${user.id} ORDER BY created_at DESC,id DESC`
  ).map((row) => row.id);
  const first: Page = await json(
    await request("/api/credentials?limit=2", { cookie }),
  );
  assert.deepEqual(
    first.items.map((item) => item.id),
    expected.slice(0, 2),
  );
  assert.equal(first.nextCursor, expected[1]);
  await json(
    await request(`/api/credentials/${first.nextCursor}`, {
      cookie,
      method: "DELETE",
    }),
  );
  assert.deepEqual(
    await remaining("/api/credentials?limit=2", cookie, first),
    expected,
  );
  const reloaded = await json(
    await request("/api/credentials?limit=2", { cookie }),
  );
  assert.deepEqual(
    await remaining("/api/credentials?limit=2", cookie, reloaded),
    expected.filter((id) => id !== first.nextCursor),
  );
});

test("credential page bounds and cursors cannot expose another owner's access", async () => {
  const { cookie } = await setupUser();
  const own = await credential(cookie);
  const member = await join(cookie, "member@example.test");
  const foreign = await credential(member.cookie, "Other owner's access");
  for (const cursor of ["not-a-uuid", "", randomUUID(), foreign.credential.id])
    assert.equal(
      (await request(`/api/credentials?cursor=${cursor}`, { cookie })).status,
      400,
    );
  for (const limit of ["0", "201", "-1", "1.5", "NaN", ""])
    assert.equal(
      (await request(`/api/credentials?limit=${limit}`, { cookie })).status,
      400,
    );
  const memberPage = await json(
    await request("/api/credentials?limit=1", { cookie: member.cookie }),
  );
  assert.deepEqual(
    memberPage.items.map((item: { id: string }) => item.id),
    [foreign.credential.id],
  );
  assert.equal(memberPage.hasMore, false);
  assert.equal(memberPage.nextCursor, null);
  assert.equal(
    (
      await request(`/api/credentials/${foreign.credential.id}`, {
        cookie,
        method: "DELETE",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/api/credentials?cursor=${own.credential.id}`, {
        token: own.token,
      })
    ).status,
    403,
  );
  await json(
    await request(`/api/auth/members/${member.user.id}`, {
      cookie,
      method: "PATCH",
      body: { role: "viewer" },
    }),
  );
  assert.equal(
    (await request("/api/boards", { token: foreign.token })).status,
    200,
  );
  assert.equal(
    (
      await request("/api/boards", {
        token: foreign.token,
        body: { name: "Viewer key cannot create", prefix: "VKR" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/credentials/${foreign.credential.id}`, {
        token: foreign.token,
        method: "DELETE",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/credentials/${own.credential.id}`, {
        cookie: member.cookie,
        method: "DELETE",
      })
    ).status,
    404,
  );
  assert.equal((await request("/api/credentials")).status, 401);
});

test("invitation pages retain stable workspace ordering and expose older active links for revocation", async () => {
  const { cookie } = await setupUser();
  const older = await json(
    await request("/api/auth/invitations", {
      cookie,
      body: { email: "older@example.test", role: "member" },
    }),
    201,
  );
  await sql`UPDATE invitations SET created_at='2020-01-01T00:00:00Z' WHERE id=${older.invitation.id}`;
  const anotherAdmin = await join(
    cookie,
    "another-admin@example.test",
    "admin",
  );
  await sql`INSERT INTO invitations(id,email,role,token_hash,invited_by,created_at,expires_at,revoked_at) SELECT gen_random_uuid(),'history-'||sequence||'@example.test','member',gen_random_uuid()::text,${anotherAdmin.user.id},timestamptz '2026-01-01T00:00:00Z'+(sequence/3)*interval '1 microsecond',now()+interval '1 day',now() FROM generate_series(1,115) sequence`;
  const expected = (
    await sql`SELECT id FROM invitations ORDER BY created_at DESC,id DESC`
  ).map((row) => row.id);
  const first: Page = await json(
    await request("/api/auth/invitations", { cookie }),
  );
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, first.items.at(-1)!.id);
  assert.deepEqual(
    first.items.map((item) => item.id),
    expected.slice(0, 100),
  );
  assert.equal(
    first.items.some((item) => item.id === older.invitation.id),
    false,
  );
  assert.equal(JSON.stringify(first).includes("tokenHash"), false);
  assert.equal(JSON.stringify(first).includes(older.token), false);
  await json(
    await request("/api/auth/invitations", {
      cookie: anotherAdmin.cookie,
      body: { email: "newer@example.test", role: "member" },
    }),
    201,
  );
  assert.deepEqual(
    await remaining("/api/auth/invitations?limit=100", cookie, first),
    expected,
  );
  const smallFirst = await json(
    await request("/api/auth/invitations?limit=17", {
      cookie: anotherAdmin.cookie,
    }),
  );
  const currentExpected = (
    await sql`SELECT id FROM invitations ORDER BY created_at DESC,id DESC`
  ).map((row) => row.id);
  assert.deepEqual(
    await remaining(
      "/api/auth/invitations?limit=17",
      anotherAdmin.cookie,
      smallFirst,
    ),
    currentExpected,
  );
  await json(
    await request(`/api/auth/invitations/${older.invitation.id}`, {
      cookie,
      method: "DELETE",
    }),
  );
  assert.equal(
    (await request(`/api/auth/invitation?token=${older.token}`)).status,
    400,
  );
  const [revoked] =
    await sql`SELECT revoked_at FROM invitations WHERE id=${older.invitation.id}`;
  assert.ok(revoked.revokedAt);
});

test("invitation cursor validation preserves administrator and human authority", async () => {
  const { cookie } = await setupUser();
  const own = await credential(cookie);
  const member = await join(cookie, "member@example.test");
  const [invitation] = await sql`SELECT id FROM invitations LIMIT 1`;
  for (const cursor of ["not-a-uuid", "", randomUUID(), own.credential.id])
    assert.equal(
      (await request(`/api/auth/invitations?cursor=${cursor}`, { cookie }))
        .status,
      400,
    );
  for (const limit of ["0", "101", "-1", "1.5", "NaN", ""])
    assert.equal(
      (await request(`/api/auth/invitations?limit=${limit}`, { cookie }))
        .status,
      400,
    );
  assert.equal(
    (
      await request(`/api/auth/invitations?cursor=${invitation.id}`, {
        cookie: member.cookie,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/auth/invitations?cursor=${invitation.id}`, {
        token: own.token,
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/auth/invitations")).status, 401);
});
