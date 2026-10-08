import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, responseError } from "../apps/web/src/api.js";
afterEach(() => mock.restoreAll());

test("browser client decodes the typed error envelope and retains compatible legacy and OAuth failures", () => {
  const typed = responseError(409, {
    error: { code: "CONFLICT", message: "Reload task", requestId: "request-1" },
  });
  assert.ok(typed instanceof ApiError);
  assert.equal(typed.message, "Reload task");
  assert.equal(typed.code, "CONFLICT");
  assert.equal(typed.requestId, "request-1");
  assert.equal(
    responseError(400, { error: "Legacy failure", code: "old_code" }).message,
    "Legacy failure",
  );
  const oauth = responseError(403, {
    error: "access_denied",
    error_description: "Not permitted",
  });
  assert.equal(oauth.message, "Not permitted");
  assert.equal(oauth.code, "access_denied");
  assert.equal(
    responseError(500, { error: {} }, "header-id").requestId,
    "header-id",
  );
  assert.equal(
    responseError(500, null).message,
    "Unable to complete this request.",
  );
});

test("only a successful requested identity confirmation retries once and preserves mutation and retry identity", async () => {
  const requests: RequestInit[] = [];
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    return Response.json(
      {
        error: {
          code: "REAUTHENTICATION_REQUIRED",
          message: "Verify identity",
          requestId: "reauth-1",
        },
      },
      { status: 403 },
    );
  });
  let confirmations = 0;
  await assert.rejects(
    api("/auth/password", { password: "private draft" }, "POST", {
      headers: { "Idempotency-Key": "retry-identity-1" },
      onReauthenticationRequired: async () => {
        confirmations++;
        return true;
      },
    }),
    { code: "REAUTHENTICATION_REQUIRED", requestId: "reauth-1" },
  );
  assert.equal(confirmations, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  requests.length = 0;
  await assert.rejects(
    api("/auth/password", {}, "POST", {
      onReauthenticationRequired: async () => false,
    }),
    { code: "REAUTHENTICATION_REQUIRED" },
  );
  assert.equal(requests.length, 1);
});

test("an ordinary permission denial never invokes identity confirmation", async () => {
  mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { code: "FORBIDDEN", message: "No access" } },
      { status: 403 },
    ),
  );
  let confirmations = 0;
  await assert.rejects(
    api("/boards", {}, "POST", {
      onReauthenticationRequired: async () => {
        confirmations++;
        return true;
      },
    }),
    { code: "FORBIDDEN" },
  );
  assert.equal(confirmations, 0);
});
