import {
  cleanupDatabase,
  request,
  resetDatabase,
  setupUser,
  sql,
} from "./support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { app } from "../apps/api/src/app.js";
import { credentialActor } from "../apps/api/src/external.js";
import {
  metadataDocumentUrl,
  parseClientDocument,
  publicAddress,
} from "../apps/api/src/external/clients.js";
import {
  digest,
  secret,
  tokenLifetimeSeconds,
} from "../apps/api/src/external/protocol.js";
async function ok<T>(response: Response): Promise<T> {
  const body = await response.json();
  assert(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}
test("OAuth discovery, SDK flow, grant attacks and token lifecycle", async (t) => {
  await resetDatabase();
  const { cookie, user } = await setupUser();
  const redirect = "http://127.0.0.1:4182/callback";
  const register = async (extra: Record<string, unknown> = {}) =>
    ok<{ client_id: string; client_secret?: string }>(
      await request("/oauth/register", {
        body: {
          client_name: "External agent",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          ...extra,
        },
      }),
    );
  const client = await register();
  const resource = () => `${process.env.MILL_BASE_URL}/mcp`;
  const start = async (extra: Record<string, string> = {}) => {
    const verifier = secret(),
      params = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirect,
        resource: resource(),
        scope: "read",
        state: secret(),
        code_challenge: digest(verifier),
        code_challenge_method: "S256",
        ...extra,
      };
    const response = await request(
      `/oauth/authorize?${new URLSearchParams(params)}`,
    );
    return {
      response,
      params,
      verifier,
      id:
        response.status === 302
          ? new URL(response.headers.get("location")!).searchParams.get(
              "request",
            )!
          : "",
    };
  };
  const consent = async (
    extra: Record<string, string> = {},
    boardIds?: string[],
  ) => {
    const begun = await start(extra);
    assert.equal(begun.response.status, 302);
    const result = await ok<{ redirectTo: string }>(
      await request(`/api/oauth/consent/${begun.id}`, {
        cookie,
        body: { allow: true, ...(boardIds ? { boardIds } : {}) },
      }),
    );
    const callback = new URL(result.redirectTo);
    assert.equal(callback.searchParams.get("state"), begun.params.state);
    assert.equal(callback.searchParams.get("iss"), process.env.MILL_BASE_URL);
    return { ...begun, code: callback.searchParams.get("code")! };
  };
  const form = (
    path: string,
    params: Record<string, string>,
    authorization?: string,
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: new URLSearchParams(params),
    });
  const token = (
    grant: Awaited<ReturnType<typeof consent>>,
    extra: Record<string, string> = {},
    authorization?: string,
  ) =>
    form(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        client_id: grant.params.client_id,
        redirect_uri: redirect,
        resource: resource(),
        code: grant.code,
        code_verifier: grant.verifier,
        ...extra,
      },
      authorization,
    );
  const issue = async (extra: Record<string, string> = {}) => {
    const grant = await consent(extra);
    const issued = await ok<{
      access_token: string;
      expires_in: number;
      scope: string;
    }>(await token(grant));
    return { ...issued, grant };
  };
  try {
    await t.test(
      "discovery is canonical, external transport demands TLS, and metadata fetch rejects private targets",
      async () => {
        const discovery = await ok<Record<string, unknown>>(
          await request("/.well-known/oauth-authorization-server"),
        );
        assert.equal(discovery.issuer, process.env.MILL_BASE_URL);
        assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
        assert.deepEqual(discovery.grant_types_supported, [
          "authorization_code",
        ]);
        assert.equal(discovery.client_id_metadata_document_supported, true);
        for (const path of [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ])
          assert.equal(
            (await ok<{ resource: string }>(await request(path))).resource,
            resource(),
          );
        const challenge = await request("/mcp");
        assert.equal(challenge.status, 401);
        assert.match(
          challenge.headers.get("www-authenticate")!,
          /oauth-protected-resource\/mcp/,
        );
        const previous = process.env.ALLOW_INSECURE_LOCALHOST;
        process.env.ALLOW_INSECURE_LOCALHOST = "false";
        assert.equal(
          (await request("/.well-known/oauth-authorization-server")).status,
          403,
        );
        process.env.ALLOW_INSECURE_LOCALHOST = previous;
        for (const address of [
          "127.0.0.1",
          "10.0.0.1",
          "172.16.0.1",
          "192.168.0.1",
          "100.64.0.1",
          "169.254.169.254",
          "0.0.0.0",
          "198.19.1.1",
          "192.0.2.1",
          "203.0.113.1",
          "::1",
          "::ffff:127.0.0.1",
          "fe80::1",
          "fc00::1",
          "2001:0db8::1",
          "2001:0000::1",
          "2002:7f00::1",
          "3fff::1",
        ])
          assert.equal(publicAddress(address), false, address);
        for (const address of [
          "8.8.8.8",
          "1.1.1.1",
          "2001:4860:4860::8888",
          "2606:4700::1111",
        ])
          assert.equal(publicAddress(address), true, address);
        for (const url of [
          "http://example.com/client.json",
          "https://127.0.0.1/client.json",
          "https://[::1]/client.json",
          "https://user:pass@example.com/client.json",
          "https://example.com/",
          "https://example.com/client.json#fragment",
        ])
          assert.throws(() => metadataDocumentUrl(url));
        assert.throws(() =>
          parseClientDocument("https://example.com/client.json", {
            client_id: "https://attacker.com/client.json",
            client_name: "Bad client",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
          }),
        );
        assert.throws(() =>
          parseClientDocument("https://example.com/client.json", {
            client_id: "https://example.com/client.json",
            client_name: "Bad client",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "client_secret_basic",
          }),
        );
        const privateClient = await start({
          client_id: "https://localhost/client.json",
        });
        assert.equal(privateClient.response.status, 400);
        assert.match(
          (
            (await privateClient.response.json()) as {
              error_description: string;
            }
          ).error_description,
          /public network/,
        );
        assert.equal(
          (
            await request("/oauth/register", {
              body: { redirect_uris: ["javascript:alert(1)"] },
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "rejects callback substitution, resource confusion, scope escalation, PKCE downgrade and duplicate parameters",
      async () => {
        for (const extra of [
          { redirect_uri: "https://attacker.example/cb" },
          { resource: "https://other.example/mcp" },
          { scope: "admin" },
          { code_challenge_method: "plain" },
          { code_challenge: "short" },
        ] as Record<string, string>[]) {
          const begun = await start(extra);
          if (extra.redirect_uri) {
            assert.equal(begun.response.status, 400);
            assert.equal(begun.response.headers.get("location"), null);
          } else {
            assert.equal(begun.response.status, 302);
            const callback = new URL(begun.response.headers.get("location")!);
            assert(callback.searchParams.get("error"));
            assert.equal(callback.origin, new URL(redirect).origin);
          }
        }
        const begun = await start();
        assert.equal(
          (
            await request(
              `/oauth/authorize?${new URLSearchParams(begun.params)}&client_id=other`,
            )
          ).status,
          400,
        );
        assert.equal(
          (await request(`/api/oauth/consent/${begun.id}`)).status,
          401,
        );
        assert.equal(
          (
            await request(`/api/oauth/consent/${begun.id}`, {
              cookie,
              body: { allow: true },
              headers: { Origin: "https://attacker.example" },
            })
          ).status,
          403,
        );
        const details = await ok<{ clientName: string; clientTrust: string }>(
          await request(`/api/oauth/consent/${begun.id}`, { cookie }),
        );
        assert.equal(details.clientName, "External agent");
        assert.equal(details.clientTrust, "unverified");
        const denied = await ok<{ redirectTo: string }>(
          await request(`/api/oauth/consent/${begun.id}`, {
            cookie,
            body: { allow: false },
          }),
        );
        assert.equal(
          new URL(denied.redirectTo).searchParams.get("error"),
          "access_denied",
        );
        assert.equal(
          (
            await request(`/api/oauth/consent/${begun.id}`, {
              cookie,
              body: { allow: true },
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "code is bound to PKCE, client, callback and resource; expiry/replay revoke issued grant",
      async () => {
        const grant = await consent();
        for (const extra of [
          { code_verifier: secret() },
          { redirect_uri: "http://127.0.0.1:4182/other" },
          { resource: "https://other.example/mcp" },
          { client_id: (await register()).client_id },
        ] as Record<string, string>[])
          assert.equal((await token(grant, extra)).status, 400);
        const issued = await ok<{ access_token: string; expires_in: number }>(
          await token(grant),
        );
        assert.equal(issued.expires_in, tokenLifetimeSeconds);
        const req = () =>
          new Request(resource(), {
            headers: { Authorization: `Bearer ${issued.access_token}` },
          });
        assert(await credentialActor(req()));
        assert.equal(
          (await request("/api/boards", { token: issued.access_token })).status,
          401,
          "OAuth token is MCP resource-bound",
        );
        const canonical = process.env.MILL_BASE_URL;
        process.env.MILL_BASE_URL = "http://localhost:4322";
        assert.equal(
          await credentialActor(
            new Request(`${process.env.MILL_BASE_URL}/mcp`, {
              headers: { Authorization: `Bearer ${issued.access_token}` },
            }),
          ),
          null,
          "Old audience token cannot authorize a new resource",
        );
        process.env.MILL_BASE_URL = canonical;
        assert.equal((await token(grant)).status, 400);
        assert.equal(
          await credentialActor(req()),
          null,
          "Replayed code revokes its token",
        );
        const expired = await consent();
        await sql`UPDATE oauth_requests SET expires_at=now()-interval '1 second' WHERE id=${expired.id}`;
        assert.equal((await token(expired)).status, 400);
        const parallel = await consent();
        const responses = await Promise.all([token(parallel), token(parallel)]);
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [200, 400],
        );
      },
    );
    await t.test(
      "confidential clients require correct auth; revocation cannot revoke another client grant",
      async () => {
        const confidential = await register({
          token_endpoint_auth_method: "client_secret_basic",
        });
        assert(confidential.client_secret);
        const grant = await consent({ client_id: confidential.client_id });
        assert.equal((await token(grant)).status, 401);
        const basic = `Basic ${Buffer.from(`${confidential.client_id}:${confidential.client_secret}`).toString("base64")}`;
        const issued = await ok<{ access_token: string }>(
          await token(grant, {}, basic),
        );
        assert.equal(
          (
            await form("/oauth/revoke", {
              client_id: client.client_id,
              token: issued.access_token,
            })
          ).status,
          200,
        );
        assert(
          await credentialActor(
            new Request(resource(), {
              headers: { Authorization: `Bearer ${issued.access_token}` },
            }),
          ),
        );
        assert.equal(
          (
            await form(
              "/oauth/revoke",
              { client_id: confidential.client_id, token: issued.access_token },
              basic,
            )
          ).status,
          200,
        );
        assert.equal(
          await credentialActor(
            new Request(resource(), {
              headers: { Authorization: `Bearer ${issued.access_token}` },
            }),
          ),
          null,
        );
        assert.equal(
          (
            await form(
              "/oauth/revoke",
              { client_id: confidential.client_id, token: issued.access_token },
              basic,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await form("/oauth/token", {
              grant_type: "refresh_token",
              client_id: client.client_id,
              resource: resource(),
              refresh_token: "unsupported",
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "current membership caps consent/exchange; expiring and disabled tokens stop immediately",
      async () => {
        const pending = await consent({ scope: "read write" });
        await sql`UPDATE users SET role='viewer' WHERE id=${user.id}`;
        assert.equal((await token(pending)).status, 400);
        const begun = await start({ scope: "read write" });
        assert.equal(
          (
            await request(`/api/oauth/consent/${begun.id}`, {
              cookie,
              body: { allow: true },
            })
          ).status,
          403,
        );
        await sql`UPDATE users SET role='admin' WHERE id=${user.id}`;
        const issued = await issue();
        await sql`UPDATE credentials SET expires_at=now()-interval '1 second' WHERE token_hash=${digest(issued.access_token)}`;
        assert.equal(
          await credentialActor(
            new Request(resource(), {
              headers: { Authorization: `Bearer ${issued.access_token}` },
            }),
          ),
          null,
        );
        const active = await issue();
        await sql`UPDATE users SET disabled_at=now() WHERE id=${user.id}`;
        assert.equal(
          await credentialActor(
            new Request(resource(), {
              headers: { Authorization: `Bearer ${active.access_token}` },
            }),
          ),
          null,
        );
        await sql`UPDATE users SET disabled_at=NULL WHERE id=${user.id}`;
        const events =
          await sql`SELECT detail FROM activity WHERE action LIKE 'oauth.%'`;
        assert(!JSON.stringify(events).includes(active.access_token));
      },
    );
    await t.test(
      "consent stores board restrictions without granting workspace administration",
      async () => {
        const created = await ok<{ board: { id: string } }>(
          await request("/api/boards", {
            cookie,
            body: { name: "OAuth restricted board", prefix: "LIMITED" },
          }),
        );
        const grant = await consent({ scope: "read write" }, [
          created.board.id,
        ]);
        const issued = await ok<{ access_token: string }>(await token(grant));
        const principal = await credentialActor(
          new Request(resource(), {
            headers: { Authorization: `Bearer ${issued.access_token}` },
          }),
        );
        assert(principal);
        assert.deepEqual(principal.boardIds, [created.board.id]);
        assert.deepEqual(principal.scopes, ["read", "write"]);
        assert.equal(
          (
            await request("/api/oauth/consent/" + (await start()).id, {
              token: issued.access_token,
              body: { allow: true },
            })
          ).status,
          401,
          "An OAuth token cannot consent for another client",
        );
      },
    );
    await t.test(
      "installed SDK discovers OAuth, registers, completes PKCE/consent and calls MCP through live HTTP",
      async () => {
        const server = serve({
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: 0,
        });
        await new Promise<void>((resolve) => server.on("listening", resolve));
        const address = server.address();
        assert(address && typeof address !== "string");
        const previous = process.env.MILL_BASE_URL;
        process.env.MILL_BASE_URL = `http://127.0.0.1:${address.port}`;
        let information: OAuthClientInformationMixed | undefined,
          tokens: OAuthTokens | undefined,
          authorizationUrl: URL | undefined,
          verifier = "";
        const provider: OAuthClientProvider = {
          redirectUrl: redirect,
          clientMetadata: {
            client_name: "Actual SDK client",
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
            scope: "read write",
          },
          clientInformation: () => information,
          saveClientInformation: (value) => {
            information = value;
          },
          tokens: () => tokens,
          saveTokens: (value) => {
            tokens = value;
          },
          redirectToAuthorization: (url) => {
            authorizationUrl = url;
          },
          saveCodeVerifier: (value) => {
            verifier = value;
          },
          codeVerifier: () => verifier,
        };
        const sdk = new Client({
          name: "mill-oauth-sdk-integration",
          version: "1.0.0",
        });
        try {
          const endpoint = new URL(resource());
          assert.equal(
            await auth(provider, { serverUrl: endpoint }),
            "REDIRECT",
          );
          assert(authorizationUrl);
          assert.equal(
            authorizationUrl.searchParams.get("resource"),
            resource(),
          );
          assert.equal(
            authorizationUrl.searchParams.get("code_challenge_method"),
            "S256",
          );
          const begun = await fetch(authorizationUrl, { redirect: "manual" });
          assert.equal(begun.status, 302);
          const id = new URL(begun.headers.get("location")!).searchParams.get(
            "request",
          )!;
          const decision = await ok<{ redirectTo: string }>(
            await fetch(
              `${process.env.MILL_BASE_URL}/api/oauth/consent/${id}`,
              {
                method: "POST",
                headers: {
                  Cookie: cookie,
                  Origin: process.env.MILL_BASE_URL!,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ allow: true }),
              },
            ),
          );
          const callback = new URL(decision.redirectTo);
          assert.equal(
            await auth(provider, {
              serverUrl: endpoint,
              authorizationCode: callback.searchParams.get("code")!,
            }),
            "AUTHORIZED",
          );
          assert(tokens);
          await sdk.connect(
            new StreamableHTTPClientTransport(endpoint, {
              authProvider: provider,
            }),
          );
          const listed = await sdk.listTools();
          assert(listed.tools.some((tool) => tool.name === "create_board"));
          const created = await sdk.callTool({
            name: "create_board",
            arguments: {
              name: "OAuth SDK board",
              prefix: "OAUTH",
              idempotencyKey: "oauth-sdk-board-0001",
            },
          });
          assert.equal(created.isError, false, JSON.stringify(created));
          const board = created.structuredContent as { board: { id: string } };
          const task = await sdk.callTool({
            name: "create_task",
            arguments: {
              boardId: board.board.id,
              title: "OAuth SDK task",
              idempotencyKey: "oauth-sdk-task-0001",
            },
          });
          assert.equal(task.isError, false, JSON.stringify(task));
          assert.equal(
            (
              await fetch(`${process.env.MILL_BASE_URL}/api/boards`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
              })
            ).status,
            401,
          );
        } finally {
          await sdk.close();
          process.env.MILL_BASE_URL = previous;
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  } finally {
    await cleanupDatabase();
  }
});
