# B1 security review

This independent review covers the original working implementation on 2026-09-28. Its 13 security regressions remain in the revised candidate's passing 84-test API/database suite. The final local browser run also passes all 72 cases. These current results are recorded in [B1 verification](b1-verification.md); exact-commit CI, clean installation, production verification, and private artifacts remain separate from the historical review below.

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
