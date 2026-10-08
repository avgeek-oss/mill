import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, responseError } from "../apps/web/src/api.js";
afterEach(() => mock.restoreAll());
Object.assign(globalThis, {
  window: {
    __MILL_RUNTIME_CONFIG__: { apiOrigin: "https://mill-api.example" },
  },
});

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

test("browser requests use the runtime public API origin and include its session", async () => {
  const requests: { url: unknown; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json({ items: [] });
  });
  await api("/boards");
  assert.equal(requests[0]?.url, "https://mill-api.example/api/boards");
  assert.equal(requests[0]?.init.credentials, "include");
});

import { readStartup, isBackendUnavailable } from "../apps/web/src/startup.js";

test("startup distinguishes an expired session from an unreachable backend", async () => {
  let status = 401;
  mock.method(globalThis, "fetch", async (path: string) =>
    path.endsWith("/auth/status")
      ? Response.json({ setupRequired: false, emailDeliveryConfigured: true })
      : Response.json({ error: { message: "Request failed" } }, { status }),
  );
  const state = await readStartup(new AbortController().signal);
  assert.equal(state.session, null);
  assert.equal(state.status.setupRequired, false);
  status = 503;
  await assert.rejects(readStartup(new AbortController().signal), (error) =>
    isBackendUnavailable(error),
  );
  assert.equal(isBackendUnavailable(new ApiError(403, "No access")), false);
  assert.equal(
    isBackendUnavailable(new ApiError(500, "Application failure")),
    false,
  );
  assert.equal(
    isBackendUnavailable(new ApiError(200, "Invalid response")),
    false,
  );
});
