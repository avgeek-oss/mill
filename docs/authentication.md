# Accounts and team access

Mill has one workspace per installation. The first person to open it creates the workspace and an administrator account. There are no default accounts or passwords. Setup is protected by a database lock and a singleton constraint, so simultaneous setup requests cannot create separate workspaces.

Passwords require 15-1,024 characters. Mill stores them with scrypt using N=32768, r=8 and p=3, one of [OWASP's recommended scrypt configurations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt). Browser sessions last seven days. The session cookie is HttpOnly, SameSite=Lax, and Secure when `MILL_BASE_URL` uses HTTPS. Deploy behind HTTPS and configure `MILL_BASE_URL` as the public origin. Browser mutations require that origin.

## Join a team

An administrator opens **Team Settings → Members**, chooses **Create invitation**, enters an email address, and selects a role. With SMTP configured, Mill queues an invitation email. Without SMTP, copy the private invitation link and send it to that person. The invitation expires after seven days, can be revoked, and can be accepted once. Issuing another invitation to the same address invalidates the earlier link. The inviter must remain an active administrator; removal or demotion invalidates their pending invitations.

The invitation list shows relative expiry time, such as “Expires in 12 hours”. Expired invitations are hidden from the list.

The person following the link chooses their name and password. With SMTP configured, they first confirm the code sent to the invited address; verification alone does not create an account or session. Their account receives the role recorded on the invitation. A removed member loses browser and client access immediately. Inviting that email again restores the same member identifier so earlier task and comment attribution stays intact, while replacing their password and removing old authentication factors.

| Role   | Access                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Admin  | Everyday task work, boards, permanent board deletion, Team Settings, membership management.                                           |
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

## Account Settings

Open **Settings → Account Settings** in the primary sidebar, or use the account menu at the bottom left. The secondary sidebar separates your settings into focused pages:

- **Profile**: your profile image and name. Email changes are under Email & Password.
- **Preferences**: your date format, time format, time zone, and in-app assignment and mention notifications.
- **Email & Password**: your current email, verification state, pending email change, and password changes. Email changes require configured SMTP and recent identity confirmation.
- **Passkeys**: registered passkeys and their recovery codes.
- **Sessions**: active devices and individual sign-out actions.
- **API Keys**: your personal REST keys.
- **MCP Connections**: authorized OAuth apps, their approved access, and individual revocation.
- **MCP Guide**: your installation's server URL and OAuth connection steps.

The account menu also links to Mill's changelog, documentation, feedback, and contribution guide. Administrators use **Team Settings → General** for the team name and **Members** for invitations and roles. The primary navigation stays highlighted throughout each settings area.

Display preferences use the same IDs during setup and profile updates. `dateFormat` accepts `day-short-month-year` (16 Sept 2026), `short-month-day-year` (Sept 16, 2026), `year-month-day` (2026-09-16), `day-month-year` (16/09/2026), or `month-day-year` (09/16/2026). `timeFormat` accepts `24-hour` (14:30), `12-hour` (2:30 PM), `24-hour-seconds` (14:30:45), or `12-hour-seconds` (2:30:45 PM). Defaults are `day-short-month-year`, `24-hour`, and the `UTC` time zone. These choices change display labels; task calendar dates remain `YYYY-MM-DD`, and timestamp wire values retain their UTC/offset semantics. Updating other profile fields preserves stored display preferences.

## Email verification and changes

SMTP is optional. Configure it using [the email settings](configuration.md) to enable verification emails, password-reset emails, and invitation verification. Without it, account email remains read-only, invitations use private links, and operator account recovery remains available. Email verification does not replace a passkey and is not required for ordinary sign-in.

Verification and email-change links expire after one hour and can be used once. Opening a link shows a confirmation page; the change happens only after confirmation. A pending email change leaves the current sign-in address in place until the new address is confirmed. Confirming the new address ends every account session, invalidates pending security challenges, and revokes owned API keys and OAuth connections. Sign in with the new address afterward.

Public email requests acknowledge eligible and unknown addresses in the same way. A queued request is not proof of delivery. Request and resend limits apply to each address and client; an unavailable delivery service reports failure through a toast while retaining the form draft.

## Passkeys and recovery codes

Open **Account Settings → Passkeys** to add a passkey. Security changes require a sign-in or identity verification within the previous ten minutes. If verification has expired, enter your password again and complete your configured second factor.

A passkey requires device verification such as a fingerprint, face recognition or device PIN. Mill verifies the public-key signature, the browser origin, the relying-party identifier and the single-use challenge. Passkey setup is bound to the session that requested it. You can name and remove each registered passkey. Use **Sign in with a passkey** for passwordless sign-in.

Use `localhost` for local browser passkeys and an HTTPS DNS hostname in production. Browsers do not support an IP address as the passkey relying-party domain, even though loopback IPs work for ordinary password sign-in and API tests.

Passkeys are the only second factor. Password sign-in automatically requests your registered passkey. Mill does not provide authenticator-app setup or TOTP verification.

Registering your first passkey creates ten recovery codes. Save them somewhere private. When a passkey is unavailable, enter your password first and choose **Use a recovery code** from the passkey verification screen. Each code is accepted once. Recovery access allows ordinary account use, but security changes still require a fresh passkey proof. Replace recovery codes from the Passkeys page after confirming your identity with a passkey; replacement invalidates the previous set.

Adding or removing a factor ends other browser sessions and invalidates pending authentication challenges. The initiating session stays signed in. Creating an API key or approving an OAuth connection also requires recent identity verification. Recovery-code access cannot grant those credentials until a passkey verifies the session. Credential revocation and OAuth denial remain available. Password changes revoke other browser sessions and all owned API keys and OAuth connections. Review devices under **Account Settings → Sessions** to revoke a device individually, or use **Sign out** to end the current session.

## Recover an account

With SMTP configured, use **Forgot password** to request a one-time reset link. The public acknowledgement does not disclose whether an address belongs to an account. Password recovery leaves registered passkeys in place; a reset link is not a substitute for a lost passkey.

Operator account recovery also works without an email provider. Contact the person operating your Mill installation. They run this command inside the installed application directory, with the same database and secret configuration as the server:

```sh
pnpm recover-account --email person@example.com
```

For the production Compose installation:

```sh
docker compose --project-name mill --env-file .env exec -T mill node dist/apps/api/src/auth/recovery-cli.js --email person@example.com
```

The command prints a private, single-use link valid for thirty minutes. Share it privately with the account owner. The link grants password-reset access, so keep it out of tickets, screenshots, shared terminal recordings and ordinary logs. Mill stores only a hash of the link token.

When passkeys and their recovery codes have been lost, the operator can explicitly remove those factors:

```sh
pnpm recover-account --email person@example.com --reset-mfa
```

The owner follows the link, chooses a new password and signs in again. Completing recovery ends all browser sessions, invalidates pending challenges and recovery links, and revokes the owner's API keys and OAuth connections. `--reset-mfa` also removes passkeys and their recovery codes. Add new passkeys and issue new credentials afterward. Issuing a link alone does not change the account.

Full database backups contain the complete identity state and private credentials. Mill v1 has no portable export/import feature. Keep `MILL_SECRET` with your installation backup; preserve it when restoring your installation. See [backup and restore](backup.md) for the full recovery procedure.

Before converting an older prelaunch schema, members with a verified authenticator must add a passkey through the older installation while they can still verify their identity. The converter refuses accounts whose verified authenticator would otherwise become password-only. If a factor is already lost, use the older installation's explicit operator recovery first. Conversion retains the complete source archive, removes the active authenticator table, retires its recovery codes and requires fresh identity confirmation for retained sessions. Members with passkeys can then generate new passkey recovery codes after verifying with a passkey.

## Identity API

All endpoints are under `/api/auth`, return JSON and enforce the same access rules as the interface. Successful sign-in sets the session cookie. Send that cookie with subsequent requests, and the configured public origin on mutations. Errors return `{ "error": { "code": "STABLE_CODE", "message": "A readable message", "requestId": "correlation-id" } }`. Stale identity confirmation returns `403 REAUTHENTICATION_REQUIRED`; a busy password queue returns `503 AUTHENTICATION_BUSY`. Login, verification, invitations and recovery use persistent database rate limits with `Retry-After` on throttling. Successful complete sign-in clears the account bucket; a pending second-factor challenge does not. Address throttling remains in place.

| Method and path                         | Request or result                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /status`                           | `{setupRequired,emailDeliveryConfigured}`.                                                                                                                                              |
| `POST /setup`                           | `{workspaceName,name,email,password,timeZone?,dateFormat?,timeFormat?}` → `{user,workspace}` and cookie.                                                                                |
| `POST /login`                           | `{email,password}` → `{user,workspace}` or `{requiresSecondFactor,challengeId,methods:["passkey"],preferredMethod:"passkey",recoveryAvailable}`.                                        |
| `POST /logout`                          | Ends the current session.                                                                                                                                                               |
| `GET /me`                               | `{user,workspace}`; no password hashes or authentication secrets.                                                                                                                       |
| `PATCH /profile`                        | Optional `{name,timeZone,dateFormat,timeFormat,notificationPreferences:{assignments,mentions}}` → `{user,workspace}`.                                                                   |
| `POST /reauth`                          | `{password}` → `{ok:true}` or a second-factor challenge tied to the current session.                                                                                                    |
| `POST /password`                        | `{currentPassword,password}`; requires recent authentication.                                                                                                                           |
| `GET /sessions`                         | `{items:[{id,userAgent,createdAt,lastSeenAt,expiresAt,current}]}`.                                                                                                                      |
| `DELETE /sessions/:id`                  | Revokes one of the signed-in person's sessions.                                                                                                                                         |
| `GET /passkeys`                         | `{items:[{id,name,createdAt}],recoveryCodeCount}`.                                                                                                                                      |
| `POST /passkeys/recovery/verify`        | `{challengeId,code}` verifies a single-use passkey recovery code after password verification. Recovery access cannot authorize security changes.                                        |
| `POST /passkeys/recovery-codes`         | `{}` replaces recovery codes after a recent passkey verification.                                                                                                                       |
| `POST /passkeys/register/options`       | `{}` → `{challengeId,options}`; recent human session required.                                                                                                                          |
| `POST /passkeys/register/verify`        | `{challengeId,name,response}`; browser WebAuthn registration response; returns ten recovery codes for the first passkey.                                                                |
| `DELETE /passkeys/:id`                  | Removes the person's passkey; recent authentication required.                                                                                                                           |
| `POST /passkeys/authenticate/options`   | `{challengeId?}` → `{challengeId,options}`; omit the identifier for discoverable passkey sign-in or to confirm the current signed-in session.                                           |
| `POST /passkeys/authenticate/verify`    | `{challengeId,response}` → account and cookie, or reauthentication success.                                                                                                             |
| `GET /members`                          | Active team members' basic metadata and `passkeyEnabled`, derived from their registered passkeys.                                                                                       |
| `GET /invitations`                      | Admin-only invitation metadata; optional `limit=1..100`, UUID `cursor`; returns `{items,hasMore,nextCursor}`; excludes expired invitations before pagination and never includes tokens. |
| `POST /invitations`                     | Admin-only `{email,role}` → `{invitation,token,inviteUrl,emailDelivery}`; delivery is `"queued"` or `"unavailable"`. Save the link at creation.                                         |
| `DELETE /invitations/:id`               | Admin-only revocation.                                                                                                                                                                  |
| `GET /invitation?token=…`               | Public `{invitation,verificationRequired}` for a valid token; invitation includes email, role and workspace name.                                                                       |
| `POST /accept-invitation`               | `{token,name,password,verificationToken?}` → account and cookie; SMTP invitations require a valid name-bound verification proof.                                                        |
| `PATCH /members/:id`                    | Admin-only `{role}`; last-admin protection.                                                                                                                                             |
| `DELETE /members/:id`                   | Admin-only reversible membership removal through a subsequent invitation.                                                                                                               |
| `POST /recovery/reset`                  | `{token,password}`; completes an email or operator-issued recovery link.                                                                                                                |
| `POST /email-verification/request`      | Browser-only `{}` → `{status:true,resendAvailableAt}`; queues verification for the signed-in account.                                                                                   |
| `POST /verification-email`              | Public `{email}` → neutral `{status:true}`; queues verification when eligible.                                                                                                          |
| `POST /email-verification/confirm`      | Public `{id,token}` → `{ok:true}`; consumes a valid verification link.                                                                                                                  |
| `GET /email-change`                     | Browser-only pending `{email,expiresAt}` metadata or `null`.                                                                                                                            |
| `POST /email-change`                    | Browser-only `{email}` → pending metadata; requires recent identity confirmation.                                                                                                       |
| `DELETE /email-change`                  | Browser-only `{}` → `{ok:true}`; cancels the pending change.                                                                                                                            |
| `POST /email-change/confirm`            | Public `{id,token}` → `{ok:true}`; changes the address and revokes account credentials.                                                                                                 |
| `POST /password-reset/request`          | Public `{email}` → neutral `{status:true}`; queues a reset link when eligible.                                                                                                          |
| `POST /invitation/verification/request` | Public `{token}` → `{status:true,resendAvailableAt,expiresAt}`; queues an invitation code.                                                                                              |
| `POST /invitation/verification/confirm` | Public `{token,name,code}` → `{verificationToken}`; binds the proof to the invitation and verified name.                                                                                |

`user` contains `id`, `name`, `email`, `role`, `timeZone`, `dateFormat`, `timeFormat`, `notificationPreferences`, `passkeyCount`, `emailVerified`. Authentication challenges expire after five minutes. Password proofs and factor challenges bind to the current account security version, so a concurrent password reset cannot issue a session from an old proof.

The PostgreSQL integration tests in `tests/auth.test.ts`, `tests/email-parity.test.ts`, and `tests/invitation-authority.test.ts` verify setup and last-admin races, invitation lifecycle, cross-role and external-client restrictions, session/password/recovery revocation, real signed passkey ceremonies and origin verification, session-bound identity confirmation, concurrent one-use recovery redemption, refusal to authorize security changes through recovery access, a blocked old-password login racing a security reset, purpose-bound email proofs, invitation authority, encrypted SMTP delivery and cancellation, and account availability during delivery.

Account actions report success and errors through toast alerts. Failed changes retain their drafts and retry controls. Required-field validation also uses a toast and focuses the first invalid field.
