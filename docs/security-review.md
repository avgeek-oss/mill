# B1 security review

## Current explicit-Agent review

The independent backend review accepted the explicit-Agent boundaries after rechecking the two final findings below. Personal Agents are available only to their creator; team Agents require explicit grants to active people, without an implicit Admin or creator grant. Personal API keys and OAuth bind an eligible existing Agent. Empty eligibility prevents approval, OAuth creates no Agent, and external credentials cannot manage Agent identities.

Task Agent attribution remains separate from the human assignee and requires an active eligible person. Changes to either effective binding check both actor and assignee access; unchanged valid bindings survive unrelated edits. The reviewed boundary includes role and board scope, personal key ownership, grant removal/deletion, revoked credentials and pending OAuth, current authority during writes, version conflicts, and absence of execution side effects. Migration 008 revokes legacy unbound credentials, creates no Agents and preserves work, human sessions and recorded history while earlier migration checksums remain unchanged.

| Finding                                                                                 | Corrected behavior                                                                                                                  | Independent recheck                                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A completed OAuth approval could remain replayable after its selected Agent was deleted | Agent references are retained in the retry identity; deletion clears encrypted response content and makes the old approval terminal | Exact approval replay returns `410`, its cached response is null, and the real code exchange is denied with `400` |
| Disabling a granted member changed directory content without changing the Agent version | The eligible directory revision includes current membership/grant state                                                             | Continuation returns `409 agent_list_changed`; a clean restart returns the complete current directory             |

The original independent recheck is retained in `tmp/security-agents-boundary-probes-fixed.log`. It confirms both corrected boundaries and removal of its isolated namespace. Root's complete source verification now passes **146 real PostgreSQL API/security tests, 14 tooling tests and 28 documentation checks**, formatting, lint, type checks, dependency audit and the production build.

This is accepted local backend review, not a production or publication claim. The complete nine-installation browser run passed all 76 cases on `index-D0aEy3Kr.js`; independent desktop/phone review in both themes accepted the current Agent/API-key captures. Their exact local receipts are recorded in [B1 verification](b1-verification.md). Exact-commit packaged migration/restore and hosted CI results are tracked separately on the private PR. Physical authenticators and the operator's HTTPS/proxy environment require their own deployment checks. Earlier review receipts below are historical through `7fc132`.

## Historical fixed-status review through 7fc132

The independent backend review passed 71 focused PostgreSQL/API/security checks for the reduced model. A separate prior-schema upgrade probe verified preserved task content, former subtasks as independent tasks, unchanged historical activity details, retained sessions and retry identities, and removal of obsolete storage and API/tool surfaces. Existing completed retry responses become content-free terminal records after the upgrade.

The reviewer independently reproduced and then rechecked a task-pagination omission when an unseen task moved across a title cursor. Continuation now returns `409 task_list_changed`; a fresh traversal returns every task exactly once. [Task-pagination regressions](../tests/task-pagination.test.ts) cover inserts, deletions, status-filter changes, updated-time changes, unaffected other boards, and invalid cursors.

The complete local source gate passes 115 database/API/security tests, 14 tooling tests, documentation checks, formatting, lint, type checks, dependency audit, and the production build. Browser and packaged installation/upgrade/restore gates are recorded separately in [current B1 verification](b1-verification.md) and the private PR.

## Historical review

> Historical review of candidates before the final September 29 v1 task-list reduction. The screenshots, feature descriptions, test/CI receipts, and acceptance statements below are retained as evidence of that earlier scope. They do not establish current behavior or readiness. See [the current scope and evidence](b1-verification.md).

This independent review covers the original working implementation on 2026-09-28. At that checkpoint, its 13 security regressions were included in an 84-test API/database suite and the local browser run passed 72 cases. Those receipts describe the historical candidate; exact-commit CI, clean installation, production verification, and private artifacts remain separate from the review below.

## Verification

The reviewer ran `pnpm test` against disposable isolated PostgreSQL schemas on 2026-09-28: **67 passed, 0 failed, 0 skipped**. That run includes real WebAuthn signatures, TOTP and recovery, setup and last-admin concurrency, REST permission tests, live HTTP MCP SDK calls, OAuth SDK registration/PKCE/consent/token exchange, task/status concurrency, portable-data consistency, large-content task reads and pagination, and HTTP retry transaction tests.

The independent review owns `tests/security-review.test.ts`: **13 passed, 0 failed, 0 skipped**, with no source implementation changes by the reviewer. Its ESLint check and the root TypeScript check passed. Re-run these checks on the final reviewed commit:

```sh
pnpm exec tsx --test tests/security-review.test.ts
pnpm exec eslint tests/security-review.test.ts --max-warnings 0
pnpm test
```

The independent tests verify:

- Board-restricted agents cannot reorder unrelated boards, create credentials, invite administrators, change workspace settings, read portable exports, or resolve unrelated board IDs.
- Mixed accessible and inaccessible notification IDs fail atomically, and notification collections/unread counts remain scoped.
- OAuth tokens match the canonical MCP resource and cannot call public REST endpoints directly.
- Failed late responses roll back both the retry record and nested domain writes.
- REST and MCP task/comment/activity IDs resolve through board scope. An administrator-owned agent cannot moderate another person's comments through its owner's admin role.
- Invalid portable references leave no partial import. Valid imports preserve dates, checklists, subtasks, assignments and comments, exclude security secrets, and preserve the importing operator's administrator access.
- Member removal, Member-to-Viewer changes, and credential revocation prevent mutations already waiting on board locks. These tests use a held PostgreSQL board lock and confirm the waiting backend with `pg_blocking_pids`, then complete the access change before releasing the lock.
- Anonymous rate limits isolate socket peers and ignore arbitrary forwarded addresses. Forwarded client addresses are accepted only from explicitly trusted proxy peers.
- Credential creation retries return the same token and create one credential, while persisted retry responses contain an encrypted envelope rather than the returned secret.
- Accounts accepted by identity remain exportable/importable at the accepted email-length boundary.
- MCP reads a valid task with a long description, many long child tasks, and a long discussion. The regression passes unchanged after the task detail gained compact related-task metadata and explicit preview limits.

## Findings addressed during review

| Finding                                                                      | Current implementation                                                                                                                          | Evidence                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A restricted agent could reorder other workspace boards                      | Board reorder denies restricted credentials before the transaction                                                                              | Independent scoped-board test                                                                   |
| Mixed notification IDs partially updated permitted rows before returning 403 | Full selection is validated and locked before any write                                                                                         | Independent notification test                                                                   |
| Admin-owned agents inherited comment moderation                              | Comment author override requires a human administrator                                                                                          | Independent REST/MCP ID and moderation test                                                     |
| OAuth access accepted an old canonical audience                              | Credential resolution compares the stored resource with the current MCP resource                                                                | Independent audience test; OAuth attack suite                                                   |
| A password proof could issue a session after a concurrent password reset     | Login rechecks the locked user/password state; sessions and challenges bind to a security epoch                                                 | Identity's PostgreSQL lock-barrier regression and signed factor tests                           |
| Revoked actors could mutate after waiting on a board lock                    | Board/workspace mutations revalidate locked current membership and session/credential; root mutation transaction checks authority before commit | Three independent lock-barrier regressions                                                      |
| Anonymous callers shared one throttle bucket                                 | Limiter uses actual socket peers and an explicit trusted-proxy allowlist                                                                        | Independent peer/forwarded-address test                                                         |
| Export used inconsistent snapshots during task/comment writes                | Export locks the workspace and all boards before reading related data                                                                           | Domain concurrent-export test and independent roundtrip                                         |
| Inherited sort keys and empty time zones reached unsafe runtime paths        | Sort validates own supported keys; profile validates any provided nonempty time zone                                                            | Domain bounded-input test and identity profile test                                             |
| Portable import rejected some email addresses already accepted by setup      | Portable members use the same accepted maximum email length as identity                                                                         | Independent identity-to-portable boundary regression                                            |
| Large valid tasks could not be read through MCP                              | Full task content is retained; compact related metadata and paged discussion bound detail responses; large MCP results avoid duplicated text    | Independent large-task regression, domain continuation tests, and live SDK maximum-content test |
| Browser documents bypassed security headers in an earlier server snapshot    | Outer server applies the shared HTTP security middleware and forwards Node connection bindings                                                  | Source review; final production document response evidence belongs in B1 verification           |

## Review boundaries

The reviewer inspected the current Towbar auth/OAuth conventions read-only, then reviewed Mill's configuration, setup, sessions, passkeys, authenticator/recovery, membership, REST/MCP permissions, OAuth grant binding and DNS-pinned metadata fetch, task/status locking, notifications, portable data, and encrypted transactional retries. Ordinary workspace operations do not require an LLM runtime. B1 uses in-app notifications and privately shared invitations; email delivery is unavailable.

No material finding remains open in the reviewed working tree. The final bounded source pass checked task-detail preview limits, same-board compact parent/subtask metadata, owning-task authorization for subtask pagination, and cursor membership. MCP retains the 1 MiB serialized response cap and full `structuredContent`; when duplicating the result as text would exceed that cap, the text names the structured result fields instead. The live SDK test covers maximum accepted description/checklist content, long Unicode children and comments, and distinct continuation pages.

The readiness source returns an uncached 503 on database failure or after a three-second wait; PostgreSQL connections have a five-second connect timeout. Real database-outage and recovery evidence belongs to the production verification run.

Rerun the suite on the final commit and retain the independent UI, installation/upgrade/restore, CI, dependency-audit, and release-package evidence.
