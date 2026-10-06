# Accounts and team access

Mill has one workspace per installation. The first person to open it creates the workspace and an administrator account. There are no default accounts or passwords. Setup is protected by a database lock and a singleton constraint, so simultaneous setup requests cannot create separate workspaces.

Passwords require 15-1,024 characters. Mill stores them with scrypt using N=32768, r=8 and p=3, one of [OWASP's recommended scrypt configurations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt). Browser sessions last seven days. The session cookie is HttpOnly, SameSite=Lax, and Secure when `MILL_BASE_URL` uses HTTPS. Deploy behind HTTPS and configure `MILL_BASE_URL` as the public origin. Browser mutations require that origin.

## Join a team

An administrator opens **Team settings → Members**, chooses **Invite a person**, enters an email address, and selects a role. Copy the private invitation link and send it to that person. Mill does not send email. The invitation expires after seven days, can be revoked, and can be accepted once. Issuing another invitation to the same address invalidates the earlier link.

The invitation list shows relative expiry time, such as “Expires in 12 hours”. Expired invitations are hidden from the list.

The person following the link chooses their name and password. Their account receives the role recorded on the invitation. A removed member loses browser and client access immediately. Inviting that email again restores the same member identifier so earlier task and comment attribution stays intact, while replacing their password and removing old authentication factors.

| Role   | Access                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Admin  | Everyday task work, boards, permanent board deletion, Team settings, membership management.                                           |
| Member | Read boards, create and edit tasks, add and delete their own comments, assign work, and use credentials within their own permissions. |
| Viewer | Read boards, tasks, comments and activity; manage their own profile and security settings.                                            |

Mill always keeps at least one active administrator. Role changes and removals use a workspace lock so concurrent requests cannot remove the final administrator. Personal API keys inherit their human owner's current role and cannot access identity routes, including the team directory. MCP OAuth inherits the owner's role within its granted scopes and boards; unscoped OAuth may read basic member metadata through MCP for assignments and mentions. Membership, sessions, security settings, and other human administration require a browser session.

People are human accounts. **API keys** belong to their human creator, use REST with current permissions, and have only Name and Expiry settings. MCP OAuth creates a connection owned by the person approving it, with requested scopes and optional approved boards. See [the client guide](clients.md) for connection rules.

## External credential boundaries

A browser session, personal API key, and MCP OAuth connection have different authority. Hiding a UI action does not enforce permissions; the server checks current owner membership and role, and rechecks authority before a waiting mutation commits.

| Authentication   | Domain access                                                                       | Human management                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Browser session  | Current person's role across accessible boards                                      | Own account/security; Admin-only team/workspace actions; credential management within permissions               |
| Personal API key | REST as the human owner, across all accessible boards, with current role            | Denied: all identity routes, team directory, workspace administration, credential management, and OAuth consent |
| MCP OAuth        | Human owner's current role, granted read/write scopes, and optional approved boards | Denied; an unscoped connection may resolve basic members through MCP for assignments and mentions               |

Personal keys accept only Name and Expiry of 30, 60, 90, or 365 days. They have no scope or board selection and cannot use MCP. An API key is personal even when its owner is an administrator; another administrator does not gain ownership of it. Task activity identifies the human owner.

OAuth belongs to the person approving consent and cannot use public REST. Its effective access comes from that person's current membership and role, the granted scopes and optional approved boards. The server rechecks authority at consent, token exchange and every authenticated request. Task activity identifies the person responsible for OAuth actions.

Store one-time tokens in the external client's secret store. Mill stores hashes and returns later metadata without tokens or hashes. Expiry, explicit revocation, account disablement, password changes and recovery end credential access. Approving a new connection does not reactivate a revoked one. See [upgrades](upgrades.md) before changing a private pre-launch installation.

See [connection steps](clients.md), [the API reference](api.md), and [private vulnerability reporting](../SECURITY.md). Configuration and database backups remain private. The repository and artifacts stay private during v1 review; merging, deployment, release publication, and visibility changes need the applicable owner authorization.

## Account settings

Open **Settings → Account settings** in the primary sidebar, or use the account menu at the bottom left. The secondary sidebar separates your settings into focused pages:

- **Profile**: your name, account email, and Gravatar preview. Email is read-only.
- **Preferences**: your date format, time format, time zone, and in-app assignment and mention notifications.
- **Email & Password**: your current email and password changes.
- **Two-factor Auth**: passkeys, an authenticator app, and recovery codes.
- **Sessions**: active devices and individual sign-out actions.
- **API Keys**: your personal REST keys and authorized OAuth connections.
- **MCP Guide**: your installation's server URL and OAuth connection steps.

The account menu also links to Mill's changelog, documentation, feedback, and contribution guide. Administrators use **Team settings → General** for the team name and **Members** for invitations and roles. The primary navigation stays highlighted throughout each settings area.

Display preferences use the same IDs during setup and profile updates. `dateFormat` accepts `day-short-month-year` (16 Sept 2026), `short-month-day-year` (Sept 16, 2026), `year-month-day` (2026-09-16), `day-month-year` (16/09/2026), or `month-day-year` (09/16/2026). `timeFormat` accepts `24-hour` (14:30), `12-hour` (2:30 PM), `24-hour-seconds` (14:30:45), or `12-hour-seconds` (2:30:45 PM). Defaults are `day-short-month-year`, `24-hour`, and the `UTC` time zone. These choices change display labels; task calendar dates remain `YYYY-MM-DD`, and timestamp wire values retain their UTC/offset semantics. Updating other profile fields preserves stored display preferences.

## Passkeys and authenticator apps

Open **Account settings → Two-factor Auth** to add a passkey or authenticator app. Security changes require a sign-in or identity verification within the previous ten minutes. If verification has expired, enter your password again and complete your configured second factor.

A passkey requires device verification such as a fingerprint, face recognition or device PIN. Mill verifies the public-key signature, the browser origin, the relying-party identifier and the single-use challenge. Passkey setup is bound to the session that requested it. You can name and remove each registered passkey. Use **Sign in with a passkey** for passwordless sign-in.

Use `localhost` for local browser passkeys and an HTTPS DNS hostname in production. Browsers do not support an IP address as the passkey relying-party domain, even though loopback IPs work for ordinary password sign-in and API tests.

When password sign-in finds both a passkey and an authenticator app, it automatically prefers the passkey. **Use an authenticator code** remains available when the browser or device cannot use that passkey. An authenticator-only account uses a six-digit app code. A code is accepted once in its time window; wait for the next code if you already used it to enable the app or change a setting.

Authenticator setup shows an `otpauth` URI and a secret to add to your app. Confirm a generated code to enable it. Mill encrypts the stored secret using `MILL_SECRET`. After confirmation, save the ten recovery codes somewhere private. Each code can be used once after password verification. Replacing recovery codes invalidates the previous set. Removing the authenticator requires a fresh app code; use operator recovery if the app is lost.

Adding or removing a factor ends other browser sessions and invalidates pending authentication challenges. The initiating session stays signed in. Password changes also revoke other browser sessions and all owned API keys and OAuth connections. Review devices under **Account settings → Sessions** to revoke a device individually, or use **Sign out** to end the current session.

## Recover an account

Account recovery works without an email provider. Contact the person operating your Mill installation. They run this command inside the installed application directory, with the same database and secret configuration as the server:

```sh
pnpm recover-account --email person@example.com
```

For the production Compose installation:

```sh
docker compose --project-name mill --env-file .env exec -T mill node dist/apps/api/src/auth/recovery-cli.js --email person@example.com
```

The command prints a private, single-use link valid for thirty minutes. Share it privately with the account owner. The link grants password-reset access, so keep it out of tickets, screenshots, shared terminal recordings and ordinary logs. Mill stores only a hash of the link token.

When both the passkeys and authenticator app have been lost, the operator can explicitly remove those factors:

```sh
pnpm recover-account --email person@example.com --reset-mfa
```

The owner follows the link, chooses a new password and signs in again. Completing recovery ends all browser sessions, invalidates pending challenges and recovery links, and revokes the owner's API keys and OAuth connections. `--reset-mfa` also removes passkeys, authenticator setup and recovery codes. Re-enroll factors and issue new credentials afterward. Issuing a link alone does not change the account.

Full database backups contain the complete identity state and private credentials. Mill v1 has no portable export/import feature. Keep `MILL_SECRET` with your installation backup; changing it makes encrypted authenticator secrets unreadable. See [backup and restore](backup.md) for the full recovery procedure.

## Identity API

All endpoints are under `/api/auth`, return JSON and enforce the same access rules as the interface. Successful sign-in sets the session cookie. Send that cookie with subsequent requests, and the configured public origin on mutations. Errors return `{ "error": { "code": "STABLE_CODE", "message": "A readable message", "requestId": "correlation-id" } }`. Stale identity confirmation returns `403 REAUTHENTICATION_REQUIRED`; a busy password queue returns `503 AUTHENTICATION_BUSY`. Login, verification, invitations and recovery use persistent database rate limits with `Retry-After` on throttling. Successful complete sign-in clears the account bucket; a pending second-factor challenge does not. Address throttling remains in place.

| Method and path                       | Request or result                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /status`                         | `{setupRequired}`.                                                                                                                                                                      |
| `POST /setup`                         | `{workspaceName,name,email,password}` → `{user,workspace}` and cookie.                                                                                                                  |
| `POST /login`                         | `{email,password}` → `{user,workspace}` or `{requiresSecondFactor,challengeId,methods,preferredMethod}`.                                                                                |
| `POST /second-factor`                 | `{challengeId,method:"totp"\|"recovery",code}` → account and cookie, or `{ok:true}` for reauthentication.                                                                               |
| `POST /logout`                        | Ends the current session.                                                                                                                                                               |
| `GET /me`                             | `{user,workspace}`; no password hashes or authentication secrets.                                                                                                                       |
| `PATCH /profile`                      | Optional `{name,timeZone,dateFormat,timeFormat,notificationPreferences:{assignments,mentions}}` → `{user,workspace}`.                                                                   |
| `POST /reauth`                        | `{password}` → `{ok:true}` or a second-factor challenge tied to the current session.                                                                                                    |
| `POST /password`                      | `{currentPassword,password}`; requires recent authentication.                                                                                                                           |
| `GET /sessions`                       | `{items:[{id,userAgent,createdAt,lastSeenAt,expiresAt,current}]}`.                                                                                                                      |
| `DELETE /sessions/:id`                | Revokes one of the signed-in person's sessions.                                                                                                                                         |
| `GET /passkeys`                       | `{items:[{id,name,createdAt}]}`.                                                                                                                                                        |
| `POST /passkeys/register/options`     | `{}` → `{challengeId,options}`; recent human session required.                                                                                                                          |
| `POST /passkeys/register/verify`      | `{challengeId,name,response}`; browser WebAuthn registration response.                                                                                                                  |
| `DELETE /passkeys/:id`                | Removes the person's passkey; recent authentication required.                                                                                                                           |
| `POST /passkeys/authenticate/options` | `{challengeId?}` → `{challengeId,options}`; omit the identifier for discoverable passkey sign-in.                                                                                       |
| `POST /passkeys/authenticate/verify`  | `{challengeId,response}` → account and cookie, or reauthentication success.                                                                                                             |
| `POST /totp/setup`                    | `{}` → `{secret,uri}`; no enabled factor is replaced.                                                                                                                                   |
| `POST /totp/verify`                   | `{code}` → `{recoveryCodes}` and enables the pending authenticator.                                                                                                                     |
| `POST /totp/disable`                  | `{code}`; removes the authenticator and recovery codes.                                                                                                                                 |
| `POST /totp/recovery-codes`           | `{code}` → a new `{recoveryCodes}` set.                                                                                                                                                 |
| `GET /members`                        | Active team members' basic metadata.                                                                                                                                                    |
| `GET /invitations`                    | Admin-only invitation metadata; optional `limit=1..100`, UUID `cursor`; returns `{items,hasMore,nextCursor}`; excludes expired invitations before pagination and never includes tokens. |
| `POST /invitations`                   | Admin-only `{email,role}` → `{invitation,token,inviteUrl,emailDelivery:"unavailable"}`; save the link at creation.                                                                      |
| `DELETE /invitations/:id`             | Admin-only revocation.                                                                                                                                                                  |
| `GET /invitation?token=…`             | Public invitation context for a valid token; email, role and workspace name.                                                                                                            |
| `POST /accept-invitation`             | `{token,name,password}` → account and cookie.                                                                                                                                           |
| `PATCH /members/:id`                  | Admin-only `{role}`; last-admin protection.                                                                                                                                             |
| `DELETE /members/:id`                 | Admin-only reversible membership removal through a subsequent invitation.                                                                                                               |
| `POST /recovery/reset`                | `{token,password}`; completes an operator-issued recovery link.                                                                                                                         |

`user` contains `id`, `name`, `email`, `role`, `timeZone`, `dateFormat`, `timeFormat`, `notificationPreferences`, `totpEnabled` and `passkeyCount`. Authentication challenges expire after five minutes. Password proofs and factor challenges bind to the current account security version, so a concurrent password reset cannot issue a session from an old proof.

The PostgreSQL integration tests in `tests/auth.test.ts` verify setup and last-admin races, invitation lifecycle, cross-role and external-client restrictions, session/password/recovery revocation, encrypted authenticator storage, replay protections, real signed passkey ceremonies and origin verification, passkey preference with successful authenticator fallback, and a blocked old-password login racing a security reset.

Account actions report success and errors through toast alerts. Failed changes retain their drafts and retry controls. Required-field validation also uses a toast and focuses the first invalid field.
