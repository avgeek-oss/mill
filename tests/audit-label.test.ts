import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { auditActionLabel } from "../apps/web/src/audit-label.js";
import { activityLabel } from "../apps/web/src/activity-label.js";

test("every emitted audit action has plain workspace wording without task-detail references", async () => {
  const owners = [
    "auth.ts",
    "domain.ts",
    "domain/portable.ts",
    "auth/recovery.ts",
    "auth/factors.ts",
    "auth/team.ts",
    "external/credentials.ts",
    "external/oauth.ts",
  ];
  const actions = new Set<string>();
  for (const owner of owners) {
    const source = await readFile(
      new URL(`../apps/api/src/${owner}`, import.meta.url),
      "utf8",
    );
    for (const match of source.matchAll(
      /["']((?:board|column|task|comment|workspace|account|session|member|credential|oauth)\.[a-z.-]+)["']/g,
    ))
      actions.add(match[1]);
  }
  assert.equal(actions.size, 39);
  assert.ok(!actions.has("board.restored"));
  assert.ok(!actions.has("task.restored"));
  for (const action of actions) {
    const label = auditActionLabel({ action, detail: {} });
    assert.notEqual(label, "Recorded workspace activity", action);
    assert.doesNotMatch(label, /\bthis\b|made a change/, action);
    assert.ok(!label.includes(action), action);
  }
  assert.equal(activityLabel("task.created"), "created this task");
  assert.equal(activityLabel("board.created"), "created this board");
});

test("safe event targets are used while absent historical targets remain generic", () => {
  const label = (action: string, detail: unknown) =>
    auditActionLabel({ action, detail });
  assert.equal(
    label("task.created", {
      identifier: "MILL-42",
      title: "Verify audit history",
    }),
    "Created task MILL-42 · Verify audit history",
  );
  assert.equal(
    label("task.created", { title: "Verify audit history" }),
    "Created task “Verify audit history”",
  );
  assert.equal(label("task.updated", { fields: ["title"] }), "Updated a task");
  assert.equal(
    label("task.moved", {
      fromColumnId: "old-id",
      columnId: "new-id",
      status: "Done",
    }),
    "Moved a task to “Done”",
  );
  assert.equal(
    label("board.created", { name: "Release plans" }),
    "Created board “Release plans”",
  );
  assert.equal(label("board.deleted", {}), "Deleted a board");
  assert.equal(
    label("column.updated", { name: "In progress", reordered: true }),
    "Updated status “In progress”",
  );
  assert.equal(
    label("workspace.updated", { name: "Avgeek" }),
    "Updated workspace “Avgeek”",
  );
  assert.equal(
    label("workspace.imported", {
      sourceWorkspace: "Previous workspace",
      boards: 2,
    }),
    "Imported workspace data from “Previous workspace”",
  );
  assert.equal(
    label("workspace.exported", { boards: 2, tasks: 15 }),
    "Exported workspace data",
  );
  assert.equal(
    label("member.invited", { email: "person@example.test", role: "member" }),
    "Invited person@example.test",
  );
  assert.equal(
    label("member.invitation-revoked", { email: "person@example.test" }),
    "Revoked the invitation for person@example.test",
  );
  assert.equal(
    label("member.role-changed", {
      memberId: "private-member-id",
      role: "viewer",
    }),
    "Changed a person's role to Viewer",
  );
  assert.equal(
    label("credential.revoked", {
      name: "Release assistant",
      credentialId: "private-id",
    }),
    "Revoked agent credential “Release assistant”",
  );
});

test("security material, raw IDs, malformed details and unknown actions do not become labels", () => {
  const secret = "mill_" + "secret".repeat(8);
  const rawId = "deadbeef-dead-4eef-8eed-deadbeef1234";
  const privateDetail = {
    token: secret,
    credentialId: rawId,
    userId: rawId,
    requestId: rawId,
    password: "password value",
    publicKey: "security material",
    recoveryCodes: ["private code"],
  };
  for (const action of [
    "account.operator-recovery-issued",
    "account.operator-recovered",
    "account.passkey-added",
    "account.recovery-codes-replaced",
    "oauth.token-issued",
    "oauth.code-replay-revoked",
    "comment.created",
  ]) {
    const label = auditActionLabel({ action, detail: privateDetail });
    for (const value of [
      secret,
      rawId,
      "password value",
      "security material",
      "private code",
    ])
      assert.ok(!label.includes(value), action);
  }
  for (const detail of [
    null,
    [],
    42,
    JSON.stringify(privateDetail),
    { title: privateDetail },
    { identifier: rawId },
    { title: secret },
    { title: rawId },
    { title: "https://example.test/invite?token=private" },
    { title: "line\nbreak" },
    { title: "x".repeat(301) },
  ]) {
    assert.equal(
      auditActionLabel({ action: "task.created", detail }),
      "Created a task",
    );
  }
  assert.equal(
    auditActionLabel({
      action: "member.role-changed",
      detail: { role: "constructor" },
    }),
    "Changed a person's role",
  );
  assert.equal(
    auditActionLabel({ action: "member.role-changed", detail: { role: {} } }),
    "Changed a person's role",
  );
  for (const action of ["future.internal-action", "__proto__", "constructor"])
    assert.equal(
      auditActionLabel({ action, detail: privateDetail }),
      "Recorded workspace activity",
    );
});
