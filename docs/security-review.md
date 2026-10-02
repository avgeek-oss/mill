# B1 security review

This document records the current security model and keeps earlier review receipts for historical context. The older 146-test source and 76-case browser receipts below predate migration 010 and do not establish release readiness for this working tree.

## Current boundaries and focused evidence

People create Agents in Mill. Personal Agents belong to their creator; administrators manage team Agents. Team access comes from selected active people or the all-members policy, and an active team Agent creator retains an individual grant even when all-members access is disabled. An Admin role alone does not grant Agent use. External clients cannot create or manage Agent identities.

Personal REST API keys are human credentials with a name and expiry. They follow their owner's current role across accessible boards and have no Agent, scope or board selections. MCP OAuth selects an eligible existing Agent with approved read/write scopes and optional board restrictions. Grant loss revokes affected OAuth access; a personal REST key is independent of Agent grants.

Task `agentId` is separate from human `assigneeId`. An Agent can be assigned without a human assignee. Setting or changing an Agent binding requires the actor's access, and any selected human assignee must also have access. Unrelated edits preserve an existing valid binding; attribution does not start a job or contact an external client. Migration 010 moves existing nonempty checklist content into the private `retired_task_checklists` table and removes the active field. Comment editing is absent from UI, REST and MCP; comment posting and deletion remain.

The [current feature audit](current-feature-audit.md) maps source and regression coverage for permissions, direct IDs, revocation, conflicts, retries and deletion. Its focused disposable-PostgreSQL run passed **16/16** tests, including a forward 001–010 migration exercise, a 1,006-person REST/MCP directory traversal, and the security-review cases. OAuth credentials still return 403 on direct REST requests; a signed-in person and personal REST key receive 404 from the removed comment PATCH route. These focused checks do not replace final `pnpm verify`, browser, packaged upgrade/restore or hosted CI on the reviewed commit.

## Historical explicit-Agent review before migration 010

The following independent rechecks and source/browser receipts describe the prior candidate. At that point personal API keys were Agent-bound, an Agent required a human assignee on each task, team creators lacked the later pinned grant, and checklists were active. Their passing counts are preserved as historical evidence only.

| Finding                                                                                 | Corrected behavior                                                                                                                  | Independent recheck                                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A completed OAuth approval could remain replayable after its selected Agent was deleted | Agent references are retained in the retry identity; deletion clears encrypted response content and makes the old approval terminal | Exact approval replay returns `410`, its cached response is null, and the real code exchange is denied with `400` |
| Disabling a granted member changed directory content without changing the Agent version | The eligible directory revision includes current membership/grant state                                                             | Continuation returns `409 agent_list_changed`; a clean restart returns the complete current directory             |

The original independent recheck was retained in `tmp/security-agents-boundary-probes-fixed.log`. At that checkpoint, the complete source verification passed **146 real PostgreSQL API/security tests, 14 tooling tests and 28 documentation checks**, formatting, lint, type checks, dependency audit and the production build.

This was local backend review, not a production or publication claim. The nine-installation browser run passed 76 cases on `index-D0aEy3Kr.js`; independent desktop/phone review in both themes accepted that candidate's Agent/API-key captures. Its local receipts are recorded in [B1 verification](b1-verification.md). Exact-commit packaged migration/restore and hosted CI remained separate. Physical authenticators and the operator's HTTPS/proxy environment required their own deployment checks.

## Historical fixed-status review through 7fc132

The independent backend review passed 71 focused PostgreSQL/API/security checks for the reduced model. A separate prior-schema upgrade probe verified preserved task content, former subtasks as independent tasks, unchanged historical activity details, retained sessions and retry identities, and removal of obsolete storage and API/tool surfaces. Existing completed retry responses become content-free terminal records after the upgrade.

The reviewer independently reproduced and then rechecked a task-pagination omission when an unseen task moved across a title cursor. Continuation now returns `409 task_list_changed`; a fresh traversal returns every task exactly once. [Task-pagination regressions](../tests/task-pagination.test.ts) cover inserts, deletions, status-filter changes, updated-time changes, unaffected other boards, and invalid cursors.

That candidate's local source gate passed 115 database/API/security tests, 14 tooling tests, documentation checks, formatting, lint, type checks, dependency audit, and the production build. Browser and packaged installation/upgrade/restore gates were recorded separately in [B1 verification](b1-verification.md) and the private PR.

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

No material finding was reported at that historical checkpoint. Its bounded source pass checked task-detail preview limits, same-board compact parent/subtask metadata, owning-task authorization for subtask pagination, and cursor membership. The MCP implementation had a 1 MiB serialized response cap and full `structuredContent`; when duplicating the result as text would have exceeded that cap, the text named the structured result fields instead. The then-current SDK test covered maximum accepted description/checklist content, long Unicode children and comments, and distinct continuation pages.

The readiness source returns an uncached 503 on database failure or after a three-second wait; PostgreSQL connections have a five-second connect timeout. Real database-outage and recovery evidence belongs to the production verification run.

Rerun the suite on the final commit and retain the independent UI, installation/upgrade/restore, CI, dependency-audit, and release-package evidence.
