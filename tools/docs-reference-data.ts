import { z } from "zod";
import {
  emailSchema,
  nameSchema,
  passwordSchema,
  dateFormatSchema,
  timeFormatSchema,
  timeZoneSchema,
} from "../apps/api/src/auth/model.js";
import {
  clientMetadataSchema,
  tokenLifetimeSeconds,
} from "../apps/api/src/external/protocol.js";

import type {
  BoardSummary,
  Task,
  Comment,
  Attachment,
} from "../packages/contracts/src/index.js";
import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "../packages/contracts/src/index.js";
import { taskFields as domainFields } from "../apps/api/src/domain/helpers.js";
export const ids = {
  board: "11111111-1111-4111-8111-111111111111",
  task: "22222222-2222-4222-8222-222222222222",
  comment: "33333333-3333-4333-8333-333333333333",
  attachment: "44444444-4444-4444-8444-444444444444",
  team: "55555555-5555-4555-8555-555555555555",
  user: "66666666-6666-4666-8666-666666666666",
  notification: "77777777-7777-4777-8777-777777777777",
};
const at = "2027-01-18T09:30:00.000Z";
const workspace = { id: ids.team, name: "Studio team", createdAt: at };
const member = {
  id: ids.user,
  name: "Alex Morgan",
  email: "alex@example.test",
  role: "member",
  timeZone: "UTC",
  passkeyEnabled: false,
};
const identity = {
  user: {
    id: ids.user,
    name: member.name,
    email: member.email,
    role: member.role,
    timeZone: member.timeZone,
    emailVerified: true,
    dateFormat: "day-short-month-year",
    timeFormat: "24-hour",
    notificationPreferences: { assignments: true, mentions: true },
    passkeyCount: 0,
  },
  workspace,
};
export type Endpoint = {
  method: string;
  path: string;
  title: string;
  group: string;
  auth:
    | "public"
    | "session"
    | "recent"
    | "admin-session"
    | "read"
    | "write"
    | "admin"
    | "oauth-client"
    | "mcp";
  description: string;
  body?: z.ZodType;
  query?: z.ZodObject;
  result?: Record<string, unknown>;
  status?: number;
  form?: boolean;
  inputExample?: Record<string, unknown>;
  mediaType?: string;
};
const str = z.string();
const email = emailSchema;
const name = nameSchema;
const password = passwordSchema;
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const challenge = token;
const empty = z.object({}).strict();
const confirmation = z.object({ id: z.uuid(), token }).strict();
const role = z.enum(["admin", "member", "viewer"]);
const ok = { ok: true };
const receipt = { status: true };
const pending = { pending: { email: "new@example.test", expiresAt: at } };
const challengeResult = {
  challengeId: "example-challenge-token",
  options: {
    challenge: "example-browser-challenge",
    rpId: "mill.example.test",
    userVerification: "required",
  },
};
const endpoint = (
  method: string,
  path: string,
  title: string,
  group: string,
  auth: Endpoint["auth"],
  description: string,
  options: Partial<Endpoint> = {},
): Endpoint => ({ method, path, title, group, auth, description, ...options });
export const supplementalEndpoints: Endpoint[] = [
  endpoint(
    "GET",
    "/health/live",
    "API liveness",
    "Health",
    "public",
    "Checks that the API process responds. It does not verify database readiness.",
    { result: { status: "ok" } },
  ),
  endpoint(
    "GET",
    "/health/ready",
    "API readiness",
    "Health",
    "public",
    "Checks PostgreSQL connectivity and returns the running API version. An unavailable database returns HTTP 503.",
    { result: { status: "ready", version: "1.0.6" } },
  ),
  endpoint(
    "GET",
    "/api/auth/status",
    "Read installation status",
    "Account and sessions",
    "public",
    "Reports whether first-administrator setup is required and whether account email delivery is configured.",
    { result: { setupRequired: false, emailDeliveryConfigured: true } },
  ),
  endpoint(
    "POST",
    "/api/auth/setup",
    "Create the first administrator",
    "Account and sessions",
    "public",
    "Requires the unused installation setup secret. Creates the team and verified first administrator, then sets a session cookie. A configured installation rejects another setup.",
    {
      body: z
        .object({
          setupSecret: str.min(1).max(1024),
          workspaceName: name,
          name,
          email,
          password,
          dateFormat: dateFormatSchema.optional(),
          timeFormat: timeFormatSchema.optional(),
          timeZone: timeZoneSchema.optional(),
        })
        .strict(),
      result: { ...identity, user: { ...identity.user, role: "admin" } },
      status: 201,
    },
  ),
  endpoint(
    "POST",
    "/api/auth/login",
    "Sign in with a password",
    "Account and sessions",
    "public",
    "Sets a session cookie after password verification, or returns requiresSecondFactor, challengeId, methods, preferredMethod and recoveryAvailable when a passkey is required.",
    {
      body: z.object({ email, password: str.min(1).max(1024) }).strict(),
      result: identity,
    },
  ),
  endpoint(
    "POST",
    "/api/auth/reauth",
    "Verify a recent session",
    "Account and sessions",
    "session",
    "Reauthenticates the current session. A passkey-protected account receives a second-factor challenge before recent authentication is renewed.",
    { body: z.object({ password: str.min(1).max(1024) }).strict(), result: ok },
  ),
  endpoint(
    "POST",
    "/api/auth/logout",
    "Sign out",
    "Account and sessions",
    "public",
    "Deletes the supplied session if present and clears its cookie. Browser mutations carrying cookies require the trusted UI Origin.",
    { result: ok },
  ),
  endpoint(
    "GET",
    "/api/auth/me",
    "Read the signed-in account",
    "Account and sessions",
    "session",
    "Reads the current user, preferences and team. API keys and MCP credentials cannot impersonate this human session.",
    { result: identity },
  ),
  endpoint(
    "PATCH",
    "/api/auth/profile",
    "Update account preferences",
    "Account and sessions",
    "session",
    "Changes only supplied profile fields and returns the updated identity.",
    {
      body: z
        .object({
          name: name.optional(),
          timeZone: timeZoneSchema.optional(),
          dateFormat: dateFormatSchema.optional(),
          timeFormat: timeFormatSchema.optional(),
          notificationPreferences: z
            .object({ assignments: z.boolean(), mentions: z.boolean() })
            .strict()
            .optional(),
        })
        .strict(),
      result: identity,
    },
  ),
  endpoint(
    "GET",
    "/api/auth/sessions",
    "List account sessions",
    "Account and sessions",
    "session",
    "Lists unexpired sessions belonging to the signed-in user, including whether each session is current.",
    {
      result: {
        items: [
          {
            id: ids.user,
            userAgent: "Example browser",
            createdAt: at,
            lastSeenAt: at,
            expiresAt: at,
            current: true,
          },
        ],
      },
    },
  ),
  endpoint(
    "DELETE",
    "/api/auth/sessions/:id",
    "Revoke an account session",
    "Account and sessions",
    "session",
    "Revokes an owned session. Revoking the current session also clears its cookie.",
    { result: ok },
  ),
  endpoint(
    "POST",
    "/api/auth/password",
    "Change account password",
    "Account and sessions",
    "recent",
    "Verifies the current password, replaces it, invalidates other sessions and revokes human-owned credentials and pending authorizations.",
    {
      body: z
        .object({ currentPassword: str.min(1).max(1024), password })
        .strict(),
      result: ok,
    },
  ),
  endpoint(
    "POST",
    "/api/auth/passkeys/recovery/verify",
    "Use a passkey recovery code",
    "Passkeys and recovery",
    "public",
    "Consumes one recovery code against an active password-login challenge and creates a recovery-authenticated session.",
    {
      body: z
        .object({ challengeId: challenge, code: str.trim().min(1).max(100) })
        .strict(),
      result: identity,
    },
  ),
  endpoint(
    "POST",
    "/api/auth/passkeys/recovery-codes",
    "Replace passkey recovery codes",
    "Passkeys and recovery",
    "recent",
    "Requires a passkey verification within the last ten minutes and an existing passkey. Returns newly generated one-time codes; retain them privately.",
    { body: empty, result: { recoveryCodes: ["example-one-time-code"] } },
  ),
  endpoint(
    "GET",
    "/api/auth/passkeys",
    "List passkeys",
    "Passkeys and recovery",
    "session",
    "Lists the user's passkeys and remaining recovery-code count.",
    {
      result: {
        items: [
          {
            id: "example-webauthn-credential-id",
            name: "Studio laptop",
            createdAt: at,
          },
        ],
        recoveryCodeCount: 8,
      },
    },
  ),
  endpoint(
    "POST",
    "/api/auth/passkeys/register/options",
    "Begin passkey registration",
    "Passkeys and recovery",
    "recent",
    "Returns challengeId and WebAuthn creation options for a discoverable credential with user verification. At most twenty passkeys are allowed.",
    {
      result: {
        challengeId: "example-challenge-token",
        options: {
          challenge: "example-browser-challenge",
          rp: { name: "Mill", id: "mill.example.test" },
          user: {
            id: "ZXhhbXBsZS11c2VyLWlk",
            name: "alex@example.test",
            displayName: "Alex Morgan",
          },
          pubKeyCredParams: [{ alg: -7, type: "public-key" }],
          timeout: 60000,
          attestation: "none",
          excludeCredentials: [],
          authenticatorSelection: {
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "required",
          },
        },
      },
    },
  ),
  endpoint(
    "POST",
    "/api/auth/passkeys/register/verify",
    "Complete passkey registration",
    "Passkeys and recovery",
    "recent",
    "Verifies the browser's RegistrationResponseJSON against the stored challenge, origin and RP ID. The first passkey also returns recoveryCodes.",
    {
      body: z
        .object({
          challengeId: challenge,
          response: z
            .record(str, z.unknown())
            .describe("WebAuthn RegistrationResponseJSON from the browser"),
          name,
        })
        .strict(),
      result: ok,
    },
  ),
  endpoint(
    "DELETE",
    "/api/auth/passkeys/:id",
    "Remove a passkey",
    "Passkeys and recovery",
    "recent",
    "Removes an owned WebAuthn credential. Removing the last passkey also removes its recovery codes. The path ID is the credential ID, not a UUID.",
    { result: ok },
  ),
  endpoint(
    "POST",
    "/api/auth/passkeys/authenticate/options",
    "Begin passkey authentication",
    "Passkeys and recovery",
    "public",
    "Returns challengeId and WebAuthn request options. Supply an active challengeId for password-login or reauthentication; a signed-in session without one starts reauthentication.",
    {
      body: z.object({ challengeId: challenge.optional() }).strict(),
      result: challengeResult,
    },
  ),
  endpoint(
    "POST",
    "/api/auth/passkeys/authenticate/verify",
    "Complete passkey authentication",
    "Passkeys and recovery",
    "public",
    "Verifies AuthenticationResponseJSON, consumes the challenge, and either creates a session or renews recent authentication.",
    {
      body: z
        .object({
          challengeId: challenge,
          response: z
            .record(str, z.unknown())
            .describe("WebAuthn AuthenticationResponseJSON from the browser"),
        })
        .strict(),
      result: identity,
    },
  ),
  endpoint(
    "POST",
    "/api/auth/recovery/reset",
    "Reset a password with a recovery token",
    "Passkeys and recovery",
    "public",
    "Consumes a valid email or operator recovery token and replaces the password. Existing sessions, human-owned credentials and pending authorizations are revoked. Operator recovery may also reset passkeys.",
    { body: z.object({ token, password }).strict(), result: ok },
  ),
  endpoint(
    "GET",
    "/api/auth/invitations",
    "List team invitations",
    "Members and invitations",
    "admin-session",
    "Lists unexpired invitations, including accepted or revoked entries, with cursor pagination. Use nextCursor unchanged; a cursor from another team is rejected.",
    {
      query: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.uuid().optional(),
      }),
      result: { items: [], hasMore: false, nextCursor: null },
    },
  ),
  endpoint(
    "POST",
    "/api/auth/invitations",
    "Invite a team member",
    "Members and invitations",
    "admin-session",
    "Creates an invitation and revokes older unused invitations for the same email. Returns its token and inviteUrl once, and queues email if SMTP is configured.",
    {
      body: z.object({ email, role }).strict(),
      result: {
        invitation: {
          id: ids.user,
          email: "sam@example.test",
          role: "member",
          createdAt: at,
          expiresAt: at,
        },
        token: "example-private-invitation-token",
        inviteUrl: "https://mill.example.test/invite?token=example",
        emailDelivery: "queued",
      },
      status: 201,
    },
  ),
  endpoint(
    "DELETE",
    "/api/auth/invitations/:id",
    "Revoke a team invitation",
    "Members and invitations",
    "admin-session",
    "Revokes an active unused invitation. The original inviter must still have administrator authority.",
    { result: ok },
  ),
  endpoint(
    "GET",
    "/api/auth/invitation",
    "Read an invitation",
    "Members and invitations",
    "public",
    "Looks up a valid invitation token without accepting it. Reports the team, invited email, role and whether email verification is required.",
    {
      query: z.object({ token }),
      result: {
        invitation: {
          email: "sam@example.test",
          role: "member",
          verificationRequired: true,
          workspaceName: "Studio team",
        },
        verificationRequired: true,
      },
    },
  ),
  endpoint(
    "POST",
    "/api/auth/accept-invitation",
    "Accept a team invitation",
    "Members and invitations",
    "public",
    "Creates or reactivates the invited account and sets its session. Supply verificationToken when this invitation requires email verification.",
    {
      body: z
        .object({ token, name, password, verificationToken: token.optional() })
        .strict(),
      result: identity,
      status: 201,
    },
  ),
  endpoint(
    "PATCH",
    "/api/auth/members/:id",
    "Change a member's role",
    "Members and invitations",
    "admin-session",
    "Changes the current role while protecting the last active administrator. A role change revokes that human's MCP grants.",
    { body: z.object({ role }).strict(), result: { member } },
  ),
  endpoint(
    "DELETE",
    "/api/auth/members/:id",
    "Remove a team member",
    "Members and invitations",
    "admin-session",
    "Disables the member, clears their task assignments with new versions and activity, and revokes sessions, human-owned credentials and pending authorizations. The last administrator is protected.",
    { result: ok },
  ),
  endpoint(
    "POST",
    "/api/auth/email-verification/request",
    "Send account verification email",
    "Account email",
    "session",
    "Queues verification for the signed-in account. Requires SMTP. resendAvailableAt is an epoch timestamp in milliseconds. X-Mill-User-Id can guard against a changed signed-in identity.",
    { body: empty, result: { status: true, resendAvailableAt: 1800264660000 } },
  ),
  endpoint(
    "POST",
    "/api/auth/verification-email",
    "Request verification email by address",
    "Account email",
    "public",
    "Requests verification without disclosing whether the email is registered. Requires SMTP and is rate limited.",
    { body: z.object({ email }).strict(), result: receipt },
  ),
  endpoint(
    "POST",
    "/api/auth/password-reset/request",
    "Request a password-reset email",
    "Account email",
    "public",
    "Queues a reset email for an eligible account and always returns a generic receipt. Requires SMTP.",
    { body: z.object({ email }).strict(), result: receipt },
  ),
  endpoint(
    "POST",
    "/api/auth/email-verification/confirm",
    "Confirm account email",
    "Account email",
    "public",
    "Consumes the id and token from a valid verification link.",
    { body: confirmation, result: ok },
  ),
  endpoint(
    "GET",
    "/api/auth/email-change",
    "Read pending email change",
    "Account email",
    "session",
    "Returns the current pending email change or pending null.",
    { result: pending },
  ),
  endpoint(
    "POST",
    "/api/auth/email-change",
    "Request an email change",
    "Account email",
    "recent",
    "Queues verification to a new email address and returns the pending request. The email must be available and SMTP configured.",
    { body: z.object({ email }).strict(), result: pending },
  ),
  endpoint(
    "DELETE",
    "/api/auth/email-change",
    "Cancel a pending email change",
    "Account email",
    "session",
    "Cancels pending email changes and their unsent account emails.",
    { body: empty, result: ok },
  ),
  endpoint(
    "POST",
    "/api/auth/email-change/confirm",
    "Confirm an email change",
    "Account email",
    "public",
    "Consumes the link, verifies the new email, and revokes sessions and human-owned credentials. Sign in again afterward.",
    { body: confirmation, result: ok },
  ),
  endpoint(
    "POST",
    "/api/auth/invitation/verification/request",
    "Send invitation verification code",
    "Account email",
    "public",
    "Sends a six-digit code for an invitation requiring verification. Returns expiry and the earliest resend time.",
    {
      body: z.object({ token }).strict(),
      result: { status: true, resendAvailableAt: 1800264660000, expiresAt: at },
    },
  ),
  endpoint(
    "POST",
    "/api/auth/invitation/verification/confirm",
    "Verify an invitation code",
    "Account email",
    "public",
    "Checks the code and binds the returned verificationToken to the exact invited name. Supply that proof when accepting the invitation.",
    {
      body: z.object({ token, name, code: str.regex(/^\d{6}$/) }).strict(),
      result: { verificationToken: "example-private-verification-token" },
    },
  ),
];
for (const scope of ["personal", "team"] as const) {
  const path =
    scope === "personal" ? "/api/credentials" : "/api/team-credentials";
  const auth = scope === "personal" ? "session" : "admin-session";
  supplementalEndpoints.push(
    endpoint(
      "GET",
      path,
      `List ${scope} API keys and MCP grants`,
      "API key management",
      auth,
      "Returns credential metadata without bearer secrets. Uses a UUID cursor and a maximum limit of 200.",
      {
        query: z.object({
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.uuid().optional(),
        }),
        result: { items: [], hasMore: false, nextCursor: null },
      },
    ),
    endpoint(
      "POST",
      path,
      `Create a ${scope} API key`,
      "API key management",
      scope === "personal" ? "recent" : auth,
      "Requires recent authentication. Returns the new bearer secret once. Read access cannot mutate; includeAdmin requests administrative operations within the actor's authority.",
      {
        body: z
          .object({
            name,
            access: z.enum(["read", "edit"]),
            includeAdmin: z.boolean(),
            expiresAt: z.iso.datetime().nullable(),
          })
          .strict(),
        result: {
          credential: {
            id: ids.user,
            name: "Studio assistant",
            accessLevel: "read",
            includeAdmin: false,
            tokenType: "api-key",
            tokenPrefix: "mill_example",
            createdAt: at,
            expiresAt: null,
            revokedAt: null,
          },
          token: "example-private-key-returned-once",
        },
        status: 201,
      },
    ),
    endpoint(
      "DELETE",
      `${path}/:id`,
      `Revoke a ${scope} API key or MCP grant`,
      "API key management",
      auth,
      "Revokes an owned credential. Team revocation also requires recent authentication; subsequent requests cannot use the revoked key or grant.",
      { result: { revoked: true } },
    ),
  );
}
const oauthForm = z.object({
  client_id: str.optional(),
  client_secret: str.optional(),
});
supplementalEndpoints.push(
  endpoint(
    "GET",
    "/.well-known/oauth-authorization-server",
    "OAuth authorization-server metadata",
    "OAuth and MCP transport",
    "public",
    "Advertises authorization, token, registration, revocation, S256 PKCE and viewer/member/admin OAuth scopes.",
    {
      result: {
        issuer: "https://mill-api.example.test",
        authorization_endpoint: "https://mill-api.example.test/oauth/authorize",
        token_endpoint: "https://mill-api.example.test/oauth/token",
      },
    },
  ),
  ...[
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ].map((path) =>
    endpoint(
      "GET",
      path,
      path.endsWith("/mcp")
        ? "MCP protected-resource metadata"
        : "Protected-resource metadata",
      "OAuth and MCP transport",
      "public",
      "Advertises the MCP resource and its authorization server. Use HTTPS for public installations.",
      {
        result: {
          resource: "https://mill-api.example.test/mcp",
          authorization_servers: ["https://mill-api.example.test"],
          scopes_supported: ["viewer", "member", "admin"],
          bearer_methods_supported: ["header"],
          resource_name: "Mill MCP",
        },
      },
    ),
  ),
  endpoint(
    "POST",
    "/oauth/register",
    "Register an OAuth client",
    "OAuth and MCP transport",
    "public",
    "Registers a client with validated redirect URIs. The returned client_secret is present only for a confidential client; retain it privately.",
    {
      body: clientMetadataSchema,
      result: {
        client_id: ids.user,
        client_name: "Studio assistant",
        redirect_uris: ["https://client.example.test/callback"],
        token_endpoint_auth_method: "none",
      },
      status: 201,
    },
  ),
  endpoint(
    "GET",
    "/oauth/authorize",
    "Begin MCP OAuth authorization",
    "OAuth and MCP transport",
    "public",
    "Validates the client, exact redirect URI, MCP resource and S256 PKCE challenge, then redirects to Mill's human consent flow. The human chooses the access level.",
    {
      query: z.object({
        response_type: z.literal("code"),
        client_id: str,
        redirect_uri: z.url(),
        code_challenge: str,
        code_challenge_method: z.literal("S256"),
        resource: z.url(),
        state: str.optional(),
        scope: str.optional(),
      }),
      status: 302,
    },
  ),
  endpoint(
    "GET",
    "/api/oauth/consent/:id",
    "Read an MCP consent request",
    "OAuth and MCP transport",
    "session",
    "Reads the client and requested authorization for the signed-in human's approval screen.",
    {
      result: {
        clientName: "Studio assistant",
        clientId: "example-client-id",
        clientTrust: "unverified",
        redirectUri: "https://client.example.test/callback",
        scope: "viewer",
        expiresIn: tokenLifetimeSeconds,
        user: { name: "Alex Morgan", role: "member" },
        availableAccessLevels: ["read", "write"],
        canApprove: true,
      },
    },
  ),
  endpoint(
    "POST",
    "/api/oauth/consent/:id",
    "Approve or deny MCP consent",
    "OAuth and MCP transport",
    "session",
    "The human selects accessLevel. Approval requires recent authentication. When allow is false, omit accessLevel. A client cannot select or approve its own permissions.",
    {
      body: z
        .object({
          allow: z.boolean(),
          accessLevel: z.enum(["read", "write", "admin"]).optional(),
        })
        .strict(),
      result: {
        redirectTo:
          "https://client.example.test/callback?code=example&state=example",
      },
    },
  ),
  endpoint(
    "POST",
    "/oauth/token",
    "Exchange an OAuth authorization code",
    "OAuth and MCP transport",
    "oauth-client",
    "Uses an authorization code once with the original redirect URI, MCP resource and PKCE verifier. This server does not issue refresh tokens. Client authentication follows the registered method.",
    {
      body: oauthForm.extend({
        grant_type: z.literal("authorization_code"),
        code: str,
        redirect_uri: z.url(),
        code_verifier: str,
        resource: z.url(),
      }),
      form: true,
      result: {
        access_token: "example-private-oauth-token",
        token_type: "Bearer",
        expires_in: tokenLifetimeSeconds,
        scope: "viewer",
      },
    },
  ),
  endpoint(
    "POST",
    "/oauth/revoke",
    "Revoke an OAuth token",
    "OAuth and MCP transport",
    "oauth-client",
    "Revokes a token for the authenticated OAuth client. A successful response has an empty body.",
    {
      body: oauthForm.extend({ token: str, token_type_hint: str.optional() }),
      form: true,
    },
  ),
  endpoint(
    "POST",
    "/mcp",
    "Call the MCP transport",
    "OAuth and MCP transport",
    "mcp",
    "Streamable HTTP JSON-RPC endpoint. Use an MCP SDK for initialization, tools/list and tools/call. A static REST API key cannot authorize this transport.",
    {
      body: z.object({
        jsonrpc: z.literal("2.0"),
        id: z.union([str, z.number()]).optional(),
        method: str,
        params: z.record(str, z.unknown()).optional(),
      }),
      result: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
    },
  ),
  endpoint(
    "GET",
    "/mcp",
    "MCP streaming request",
    "OAuth and MCP transport",
    "mcp",
    "The SDK accepts a GET with Accept: text/event-stream. Mill closes the per-request server after the response is created and does not provide a persistent event session. Use POST JSON-RPC for normal tool calls. Missing the SSE Accept type returns HTTP 406.",
    {},
  ),
  endpoint(
    "DELETE",
    "/mcp",
    "MCP session termination request",
    "OAuth and MCP transport",
    "mcp",
    "Accepts transport termination with an empty HTTP 200 response. Mill allocates no persistent MCP session, so this does not revoke the OAuth grant. Revoke the grant in account settings or through the OAuth revocation endpoint.",
    {},
  ),
);

export const exampleBoard = {
  id: ids.board,
  name: "Engineering",
  prefix: "ENG",
  description: "Track delivery and reliability.",
  version: 1,
  createdBy: {
    id: ids.user,
    name: member.name,
    email: member.email,
    kind: "human",
  },
  lastActivityAt: at,
  backlogCount: 1,
  todoCount: 1,
  inProgressCount: 1,
  activeCount: 2,
} satisfies BoardSummary;
const boardRecord = {
  id: exampleBoard.id,
  workspaceId: ids.team,
  name: exampleBoard.name,
  prefix: exampleBoard.prefix,
  description: exampleBoard.description,
  version: 1,
  nextNumber: 2,
  createdAt: at,
  updatedAt: at,
  createdByUserId: ids.user,
  createdByName: member.name,
  createdByKind: "human",
  lastActivityAt: at,
};
export const exampleTask = {
  id: ids.task,
  boardId: ids.board,
  identifier: "ENG-1",
  title: "Verify database restore",
  description: "Restore a recent backup into an isolated database.",
  acceptanceCriteria:
    "- Confirm task and comment counts match\n- Record the result",
  type: "task",
  status: "todo",
  priority: "high",
  assigneeId: ids.user,
  startDate: "2027-01-18",
  dueDate: "2027-01-20",
  version: 1,
  statusChangedAt: at,
  createdAt: at,
  updatedAt: at,
  createdBy: ids.user,
} satisfies Task & { createdBy: string };
export const exampleComment = {
  id: ids.comment,
  taskId: ids.task,
  parentId: null,
  replyCount: 0,
  authorId: ids.user,
  authorKind: "human",
  authorName: member.name,
  body: "The restore check passed.",
  version: 1,
  createdAt: at,
  updatedAt: at,
} satisfies Comment;
const attachment = {
  id: ids.attachment,
  taskId: ids.task,
  fileName: "restore-report.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  createdBy: ids.user,
  createdAt: at,
} satisfies Attachment;
const page = (item: unknown) => ({
  items: [item],
  hasMore: false,
  nextCursor: null,
});
const taskPage = {
  ...page(exampleTask),
  total: 1,
  page: 1,
  revision: "0123456789abcdef0123456789abcdef",
};
const configuration = {
  enabled: true,
  maxBytes: MAX_ATTACHMENT_BYTES,
  contentTypes: [...ATTACHMENT_CONTENT_TYPES],
};
const taskInput = {
  boardId: ids.board,
  title: exampleTask.title,
  description: exampleTask.description,
  acceptanceCriteria: exampleTask.acceptanceCriteria,
  type: "task",
  priority: "high",
  status: "todo",
  assigneeId: ids.user,
  startDate: exampleTask.startDate,
  dueDate: exampleTask.dueDate,
  idempotencyKey: "restore-check-create-001",
};
type Illustration = {
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  workflow: string[];
  note: string;
};
export const illustrations: Record<string, Illustration> = {
  get_attachment_config: {
    title: "Read attachment configuration",
    input: {},
    result: configuration,
    workflow: [
      "Check enabled",
      "Inspect MIME types and byte limit",
      "Choose an allowed file",
    ],
    note: "Storage is optional. When disabled, this operation still returns configuration with enabled:false; other attachment operations are unavailable.",
  },
  list_attachments: {
    title: "List task attachments",
    input: { taskId: ids.task, limit: 50 },
    result: page(attachment),
    workflow: [
      "Resolve the task UUID",
      "List completed files",
      "Continue with nextCursor",
    ],
    note: "Pending uploads are not listed. Metadata never contains permanent public URLs.",
  },
  create_attachment_upload: {
    title: "Reserve an attachment upload",
    input: {
      taskId: ids.task,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      idempotencyKey: "restore-report-upload-001",
    },
    result: {
      attachmentId: ids.attachment,
      uploadUrl:
        "https://storage.example.test/private-upload?signature=example",
      headers: { "Content-Type": "application/pdf", "Content-Length": "2048" },
      expiresAt: at,
    },
    workflow: [
      "Reserve upload",
      "PUT exact bytes to signed URL",
      "Complete attachment",
    ],
    note: "The signed PUT URL lasts five minutes. Upload directly using the returned headers; never forward a Mill cookie or bearer token to storage. Browsers set Content-Type and derive Content-Length from the file body.",
  },
  complete_attachment: {
    title: "Complete an attachment upload",
    input: {
      taskId: ids.task,
      attachmentId: ids.attachment,
      idempotencyKey: "restore-report-complete-001",
    },
    result: { attachment },
    workflow: [
      "Upload the bytes",
      "Verify and complete",
      "List or download the ready file",
    ],
    note: "Checks byte length, detected MIME/signature and optional SHA-256. Mill copies verified bytes to a final object. An expired upload returns 410 UPLOAD_EXPIRED; start a new upload.",
  },
  get_attachment_download: {
    title: "Get a private download URL",
    input: { taskId: ids.task, attachmentId: ids.attachment, preview: true },
    result: {
      url: "https://storage.example.test/private-download?signature=example",
      expiresAt: at,
    },
    workflow: [
      "Check current task access",
      "Request a signed URL",
      "Read before expiry",
    ],
    note: "URLs expire after five minutes and are private capabilities. preview:true requests inline image/PDF display; otherwise the URL downloads the attachment.",
  },
  delete_attachment: {
    title: "Delete an attachment",
    input: {
      taskId: ids.task,
      attachmentId: ids.attachment,
      idempotencyKey: "restore-report-delete-001",
    },
    result: ok,
    workflow: [
      "Identify the exact file",
      "Confirm deletion",
      "Remove and queue object cleanup",
    ],
    note: "Removes the attachment immediately and queues private object deletion with durable retries. There is no attachment trash or restore endpoint.",
  },
  list_boards: {
    title: "List boards",
    input: { limit: 100 },
    result: page(exampleBoard),
    workflow: [
      "List accessible boards",
      "Follow nextCursor",
      "Choose a board UUID",
    ],
    note: "Boards sort by case-insensitive name, exact name and UUID. Cursors bind the accessible directory and revision; restart on 409 board_list_changed. Historical creators can be null.",
  },
  get_board: {
    title: "Read a board",
    input: { boardId: ids.board },
    result: { board: boardRecord },
    workflow: [
      "Choose a board UUID",
      "Read current settings",
      "Keep its version for edits",
    ],
    note: "Use the UUID in API paths. The task prefix is a human-readable identifier component, not the board ID. Creator presentation and task counts are supplied by list_boards.",
  },
  create_board: {
    title: "Create a board",
    input: {
      name: "Engineering",
      prefix: "ENG",
      description: exampleBoard.description,
      idempotencyKey: "engineering-board-create-001",
    },
    result: { board: { ...boardRecord, nextNumber: 1 } },
    workflow: [
      "Choose a unique prefix",
      "Create the board",
      "Create tasks in its UUID",
    ],
    note: "Requires workspace-wide write access. Prefixes use 2–10 uppercase letters/digits with a leading letter; omission derives an available prefix from the name. Every board uses the same six fixed statuses.",
  },
  update_board: {
    title: "Update a board",
    input: {
      boardId: ids.board,
      version: 1,
      prefix: "OPS",
      idempotencyKey: "engineering-prefix-edit-001",
    },
    result: { board: { ...boardRecord, prefix: "OPS", version: 2 } },
    workflow: [
      "Read current board version",
      "Choose an available prefix",
      "Save and refresh task identifiers",
    ],
    note: "A prefix change atomically renames existing task identifiers while preserving task numbers and UUID links. Existing task versions increase. Duplicate prefixes return 409 BOARD_PREFIX_TAKEN; stale versions conflict. Omitted fields remain unchanged.",
  },
  list_tasks: {
    title: "List and filter tasks",
    input: { boardId: ids.board, sort: "priority", page: 1, limit: 25 },
    result: taskPage,
    workflow: [
      "Choose board and filters",
      "Read a page",
      "Continue with revision or cursor",
    ],
    note: "Priority is the default: urgent, high, medium, low, none. Without an explicit status filter, done and wont_do tasks disappear from lists after 24 hours in that status but retain direct access. q searches title, description, acceptance criteria and identifier. assigneeId:unassigned finds tasks without an assignee.",
  },
  get_task: {
    title: "Read a task",
    input: { taskId: ids.task, commentLimit: 0, activityLimit: 0 },
    result: {
      task: exampleTask,
      comments: [],
      activity: [],
      commentsPage: { hasMore: false, nextCursor: null },
      activityPage: { hasMore: true, nextCursor: null },
    },
    workflow: [
      "Resolve a task UUID",
      "Read current fields and version",
      "Load discussion separately",
    ],
    note: "MCP defaults both preview limits to zero; REST defaults them to 100. Each accepts 0–100. Description and acceptance criteria are independent Markdown fields. A zero-sized preview has a null cursor; start the discussion endpoint without a cursor.",
  },
  create_task: {
    title: "Create a task",
    input: taskInput,
    result: { task: exampleTask },
    workflow: [
      "Resolve board and member UUIDs",
      "Set fields and criteria",
      "Create once with a retry key",
    ],
    note: "Creation requires title and defaults type to task, status to todo, priority to none, assignee and dates to null, and Markdown fields to empty. Active human assignees only. Mentions and assignments respect in-app notification preferences.",
  },
  update_task: {
    title: "Update a task",
    input: {
      taskId: ids.task,
      version: 1,
      status: "in_review",
      acceptanceCriteria: "- Restore completed\n- Counts match",
      idempotencyKey: "restore-check-edit-001",
    },
    result: {
      task: {
        ...exampleTask,
        status: "in_review",
        acceptanceCriteria: "- Restore completed\n- Counts match",
        version: 2,
      },
    },
    workflow: [
      "Read current version",
      "Send changed fields",
      "Refresh on conflict",
    ],
    note: "Fields save atomically. Pass null to clear assigneeId, startDate or dueDate. Actual status changes reset statusChangedAt; unrelated edits preserve it. A stale version returns 409 without applying the edit.",
  },
  delete_task: {
    title: "Delete a task",
    input: {
      taskId: ids.task,
      version: 1,
      idempotencyKey: "restore-check-delete-001",
    },
    result: ok,
    workflow: [
      "Read task and current version",
      "Confirm permanent deletion",
      "Delete task and discussion",
    ],
    note: "Permanently removes the task, discussion, activity and notifications, and queues attachment cleanup. Task numbers are not reused. Without the same retry key a repeated delete returns 404.",
  },
  list_comments: {
    title: "List comments and replies",
    input: { taskId: ids.task, parentId: "root", limit: 50 },
    result: page(exampleComment),
    workflow: [
      "Read root comments",
      "Inspect replyCount",
      "Load a comment's direct replies",
    ],
    note: "Omit parentId for a flat list, use root for top-level comments, or a same-task comment UUID for direct replies. Each thread has its own cursor. Replies collapse in the UI; the API returns parentId and direct replyCount.",
  },
  add_comment: {
    title: "Add a comment or reply",
    input: {
      taskId: ids.task,
      parentId: ids.comment,
      body: "The isolated restore passed.",
      idempotencyKey: "restore-check-reply-001",
    },
    result: {
      comment: {
        ...exampleComment,
        id: "88888888-8888-4888-8888-888888888888",
        parentId: ids.comment,
        body: "The isolated restore passed.",
      },
    },
    workflow: [
      "Choose root or parent comment",
      "Write Markdown",
      "Post within three reply levels",
    ],
    note: "Body is nonempty and at most 10,000 characters. Supports @email, user:UUID links and mentionIds. Root depth is zero; a fourth reply level returns 400 COMMENT_DEPTH_LIMIT. Comments advance board activity but do not produce activity-table rows.",
  },
  delete_comment: {
    title: "Delete a comment",
    input: {
      commentId: ids.comment,
      version: 1,
      idempotencyKey: "restore-check-comment-delete-001",
    },
    result: ok,
    workflow: [
      "Read comment version",
      "Confirm deletion",
      "Promote surviving replies",
    ],
    note: "Authors can delete their own comments. Human administrators can moderate with sufficient permission; OAuth clients can delete only their owner's comments. Children move to the deleted comment's parent, receive new versions, and retain their text. Comments cannot be edited.",
  },
  get_activity: {
    title: "Read task activity",
    input: { taskId: ids.task, limit: 50 },
    result: page({
      id: ids.notification,
      taskId: ids.task,
      boardId: ids.board,
      actorId: ids.user,
      actorName: member.name,
      actorKind: "human",
      action: "task.updated",
      detail: {
        fields: ["priority"],
        connection: { type: "session", requestId: "example-request-001" },
      },
      createdAt: at,
    }),
    workflow: [
      "Read recent changes",
      "Inspect actor and connection",
      "Continue older activity",
    ],
    note: "Task and attachment changes are recorded; comment and reply events are excluded, including historical comment rows. Activity identifies the responsible actor and, on new records, connection type and request ID.",
  },
  list_notifications: {
    title: "List personal notifications",
    input: { unread: true, limit: 50 },
    result: {
      ...page({
        id: ids.notification,
        userId: ids.user,
        taskId: ids.task,
        boardId: ids.board,
        kind: "assignment",
        actorName: "Sam Rivera",
        identifier: "ENG-1",
        title: exampleTask.title,
        readAt: null,
        createdAt: at,
      }),
      unreadCount: 1,
    },
    workflow: [
      "Read unread assignments and mentions",
      "Open the task",
      "Mark the notification",
    ],
    note: "Unread notifications remain visible; read notifications are retained in the list for 24 hours. unreadCount is independent of page size. These are personal notifications; team API keys cannot access them.",
  },
  mark_notifications: {
    title: "Mark personal notifications",
    input: {
      ids: [ids.notification],
      read: true,
      idempotencyKey: "notification-read-001",
    },
    result: { ok: true, updated: 1 },
    workflow: [
      "Choose IDs or all",
      "Set read state",
      "Preserve later arrivals",
    ],
    note: "Choose ids or all:true, never both. read defaults to true; false marks unread. All applies to the request snapshot, leaving later arrivals unread. Repeated read marks preserve the original receipt time. Team API keys cannot mutate personal notifications.",
  },
  list_members: {
    title: "List team members",
    input: { limit: 1000 },
    result: page(member),
    workflow: [
      "Read active members",
      "Continue the directory",
      "Resolve assignee and mention UUIDs",
    ],
    note: "Requires workspace-wide read access. A changed directory returns 409 member_list_changed; restart without a cursor. Disabled members are not returned.",
  },
};

const version = z.number().int().positive();
supplementalEndpoints.push(
  endpoint(
    "GET",
    "/brand/mill-favicon.png",
    "Read the API favicon",
    "Health",
    "public",
    "Returns the bundled Mill favicon as image/png.",
    { mediaType: "image/png" },
  ),
  endpoint(
    "GET",
    "/favicon.ico",
    "Redirect to the favicon",
    "Health",
    "public",
    "Redirects to /brand/mill-favicon.png.",
    { status: 308 },
  ),
  endpoint(
    "DELETE",
    "/api/boards/:id",
    "Delete a board",
    "Boards",
    "admin",
    "Permanently deletes the board, all its tasks and discussion. Requires write and administrator authority. Restricted grants lose the board. Confirm the exact board; there is no trash or restore endpoint.",
    { body: z.object({ version }).strict(), result: ok },
  ),
  endpoint(
    "GET",
    "/api/comments/:id",
    "Read a comment",
    "Comments and activity",
    "read",
    "Returns a same-task parent relationship, direct reply count, author, body and current version. Use this version when deleting a comment.",
    { result: { comment: exampleComment } },
  ),
  endpoint(
    "PATCH",
    "/api/boards/:id/tasks/bulk",
    "Update multiple tasks",
    "Tasks",
    "write",
    "Atomically updates 1–100 distinct tasks in this board. Every task needs its current version. Stale versions return 409; unavailable tasks return 404; either failure rolls back every selected change. Assignees must be active members, null unassigns. Dates accept null to clear. Actual status changes reset statusChangedAt; unrelated edits preserve it. Assignments respect notification preferences. Omitted fields are preserved.",
    {
      body: z
        .object({
          tasks: z
            .array(z.object({ id: z.uuid(), version }).strict())
            .min(1)
            .max(100),
          changes: z
            .object({
              status: domainFields.status,
              assigneeId: domainFields.assigneeId,
              priority: domainFields.priority,
              startDate: domainFields.startDate,
              dueDate: domainFields.dueDate,
            })
            .partial()
            .strict()
            .refine((v) => Object.keys(v).length > 0),
        })
        .strict(),
      inputExample: {
        tasks: [{ id: ids.task, version: 1 }],
        changes: { assigneeId: null },
      },
      result: { items: [{ ...exampleTask, assigneeId: null, version: 2 }] },
    },
  ),
  endpoint(
    "GET",
    "/api/workspace",
    "Read team settings",
    "Team",
    "session",
    "Reads the signed-in human's workspace. Static REST keys and MCP credentials cannot access this route.",
    { result: { workspace } },
  ),
  endpoint(
    "PATCH",
    "/api/workspace",
    "Update team settings",
    "Team",
    "admin-session",
    "Updates the team's name. Requires an active human administrator session.",
    { body: z.object({ name }).strict(), result: { workspace } },
  ),
);

for (const route of supplementalEndpoints) {
  route.path = route.path
    .replace("/api/boards/:id", "/api/boards/:boardId")
    .replace("/api/comments/:id", "/api/comments/:commentId");
}
