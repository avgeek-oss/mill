# Mill B1 release brief

## Objective

Build a complete open-source, self-hosted task list for humans and external agents under avgeek-inc/mill. The repository remains private during implementation and review. B1 is the first usable beta candidate, with proposed tag `v1.0.0-beta.1`. Implement and verify the current user-authorized scope below before publication.

## September 29 scope decision

The user reduced v1 to a list with fixed task statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Boards are alphabetical. Kanban, custom statuses, manual board/task ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded. Earlier September 29 decisions also exclude archive/trash/restore views, a separate Inbox page, and workspace-wide audit history. These are explicit product decisions, not verification shortcuts.

Keep every existing task and subtask record as an independent task. Convert recognized old status names to their fixed counterpart; unrecognized custom names become Todo. Preserve identifiers, descriptions, assignments, priorities, due dates, checklists, comments, attributed task history, and in-app notifications. Document the actual migration before an operator upgrade, and keep applied migrations unchanged.

Earlier Mill ideas included hosted agent teams, co-founder personas, knowledge bases, and Kanban. Those directions and their prior screenshots/test receipts are historical. Mill remains an Avgeek OSS sibling of Towbar, with a focused list for people and permissioned external agents. Ordinary task management needs no LLM key or hosted agent runtime.

## Complete product scope

1. First-install setup, secure sign-in/sign-out, invitations and membership, Admin/Member/Viewer access, profile preferences, time zones, sessions, and recovery. Retain passkeys and authenticator behavior, automatic passkey preference, and an accessible fallback. No default credentials.
2. Multiple boards in one workspace, alphabetical board navigation, stable prefixes, board settings, and human-Admin permanent deletion with confirmation. The fixed Boards sidebar loads every accessible board and places Create Project last.
3. Complete task lifecycle: create, view, edit, change a fixed status, assign, prioritize, set a due date, maintain a checklist, and permanently delete with confirmation. Retain stable human-facing identifiers and deep links. Versions and transactions prevent silent lost updates during concurrent edits, status changes, and deletion.
4. Safe Markdown descriptions with edit/preview; comments, mentions, and attributed task activity. Preserve bounded content and safe links. File uploads are excluded.
5. A usable task list with search, combined status/assignee/priority filters, sorting, and stable bounded pagination. Preserve the current context after editing. Verify keyboard and touch controls, mobile navigation, long content, and empty/loading/error states.
6. In-app notifications for assignments and mentions, profile preferences, meaningful unread state, and the compact header popover with a single bounded scrolling list. No All/Unread tabs or separate Inbox page. Task email notifications are excluded. Keep account and invitation delivery behavior truthful: the current provider is unavailable, invitations use private links, and operator recovery remains available.
7. Documented REST API and remote MCP for external agents, scoped/revocable credentials, human/agent attribution, idempotent mutations, current-role enforcement, rate limits, and bounded requests/responses. Retain HTTPS OAuth/PKCE and credential protections. Verify actual SDK tool calls against the running reduced model.
8. Workspace settings, member management, account/security settings, health/readiness endpoints, understandable operational failures, shared empty/loading/error states, and dedicated 404/500 views. No unavailable navigation or fake production data.
9. Self-hosting: clean-checkout local setup and production Docker Compose, validated configuration, one-time setup, checksummed migrations, persistent PostgreSQL, HTTPS/proxy guidance, upgrades, and full database backup with tested restore. A new user must not need private Avgeek access.
10. OSS delivery: Apache-2.0 and attribution, README and community/maintainer guidance, issue/PR templates, dependency updates, pinned installs, complete CI, vulnerability audit, production image/release tooling, changelog, and accurate B1 notes. Keep repository and artifacts private until publication is authorized.
11. Beginner documentation for installation, first board/task, team roles, everyday work, REST/MCP, configuration, operations, backups, upgrades, and troubleshooting. Current screenshots must show the reduced implementation; old screenshots and proof remain clearly historical.

Routine implementation choices and bounded parallel work are authorized. Record the actual interfaces and behavior. Raise material conflicts to the coordinator while continuing independent work. Do not remove a retained requirement merely to obtain a passing gate.

## Towbar standards and review

Use `/Users/praveen/Repositories/towbar` read-only for current Apache-safe primitives, shell, authentication, scopes, migrations, tooling, packaging, and docs. Mill must stay self-contained with public dependencies. Carry forward restrained typography, stable icons/logo proportions, readable secondary text, shared controls, bounded scrolling selects, symmetric rows, and progress/recovery in the initiating modal. Preserve focus and keyboard behavior without exposing internal implementation details in normal product flows.

Review actual desktop, tablet, and phone routes in both themes. Include long task/member content, many tasks/boards, scrolled selects, checklist/discussion controls, fixed status changes, permission denial, expired sessions, network failure, reload, and Back navigation.

Maintain [B1 verification](b1-verification.md) as the current requirements/evidence matrix. Fresh evidence must cover installation, prior-schema migration preserving independent tasks and mapped statuses, backups/restores, roles/scopes, SDK calls, retry/deletion correctness, concurrent edits, and the real list UI. Previous Kanban/custom-status/export/import proofs do not establish this revision's behavior.

Readiness requires the complete current scope, production installation/container checks, CI on the reviewed commit, no material unresolved finding, and independent coordinator review. Documentation or an implementation report alone cannot establish completion.
