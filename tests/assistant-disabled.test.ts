import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
} from "./support.js";

after(cleanupDatabase);
test("assistant routes and UI capability stay absent without provider credentials", async () => {
  await resetDatabase();
  const { cookie } = await setupUser();
  const status = await request("/api/auth/status");
  assert.equal(
    ((await status.json()) as { assistantEnabled: boolean }).assistantEnabled,
    false,
  );
  assert.equal((await request("/agent/conversations", { cookie })).status, 404);
});
