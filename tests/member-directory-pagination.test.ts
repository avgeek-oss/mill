import assert from "node:assert/strict";
import test from "node:test";
import {
  callMcpTool,
  cleanupDatabase,
  request,
  resetDatabase,
  setupAgent,
  setupOAuthAgent,
  setupUser,
  sql,
} from "./support.js";

test("the member directory continues past 1000 people without hiding active accounts", async () => {
  await resetDatabase();
  try {
    const admin = await setupUser();
    const [owner] =
      await sql`SELECT workspace_id,password_hash FROM users WHERE id=${admin.user.id}`;
    await sql`INSERT INTO users(id,workspace_id,name,email,password_hash,role)
      SELECT gen_random_uuid(),${owner.workspaceId},'Member '||lpad(n::text,4,'0'),
        'member-'||n||'@example.test',${owner.passwordHash},'member'
      FROM generate_series(1,1005) AS n`;
    const collected = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await request(
        `/api/auth/members?limit=1000${cursor ? `&cursor=${cursor}` : ""}`,
        { cookie: admin.cookie },
      );
      assert.equal(response.status, 200);
      const page = (await response.json()) as {
        items: { id: string; name: string }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      for (const member of page.items) {
        assert.equal(collected.has(member.id), false);
        collected.add(member.id);
      }
      assert.equal(page.hasMore, page.nextCursor !== null);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 2);
    assert.equal(collected.size, 1006);

    const firstBeforeEdit = (await (
      await request("/api/auth/members?limit=10", { cookie: admin.cookie })
    ).json()) as { nextCursor: string };
    await sql`UPDATE users SET name='A moved member' WHERE email='member-1005@example.test'`;
    const stale = await request(
      `/api/auth/members?limit=10&cursor=${encodeURIComponent(firstBeforeEdit.nextCursor)}`,
      { cookie: admin.cookie },
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "member_list_changed");

    const agent = await setupAgent(admin.cookie);
    const oauth = await setupOAuthAgent(admin.cookie, { agentId: agent.id });
    const firstToolPage = await callMcpTool(oauth.token, "list_members", {
      limit: 1000,
    });
    assert.equal(firstToolPage.result?.isError, false);
    const toolPage = firstToolPage.result!.structuredContent as {
      items: { id: string }[];
      hasMore: boolean;
      nextCursor: string | null;
    };
    assert.equal(toolPage.items.length, 1000);
    assert.equal(toolPage.hasMore, true);
    const finalToolPage = await callMcpTool(oauth.token, "list_members", {
      limit: 1000,
      cursor: toolPage.nextCursor,
    });
    assert.equal(finalToolPage.result?.isError, false);
    assert.equal(
      (finalToolPage.result!.structuredContent as { items: unknown[] }).items
        .length,
      6,
    );

    const invalid = await request("/api/auth/members?cursor=invalid", {
      cookie: admin.cookie,
    });
    assert.equal(invalid.status, 400);
    const tooLarge = await request("/api/auth/members?limit=1001", {
      cookie: admin.cookie,
    });
    assert.equal(tooLarge.status, 400);
  } finally {
    await cleanupDatabase();
  }
});
