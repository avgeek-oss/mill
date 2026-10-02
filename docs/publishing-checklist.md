# Mill publishing checklist

Prepared on October 2–3, 2026 from the reviewed local candidate and release documentation. Checked items have completed preparation or executed local evidence, as stated. Exact-head hosted CI and native artifact receipts are recorded on the [private release PR](https://github.com/avgeek-inc/mill/pull/1) after the source freeze. This document does not authorize or claim public publication.

## Confirmed direction and starting point

- [x] Product name: **Mill**.
- [x] `mill.fyi` is reserved, as reported by the owner. DNS, HTTPS and published content still need verification.
- [x] A Mintlify project exists, as reported by the owner. Content integration, navigation, branding and publication still need verification.
- [x] Brand direction: **brown UI theme** and a **literal tower mill logo**, in the same visual design language as Towbar.

The application, REST/MCP, migrations, operator guides, brown branding, current Towbar audit, Mintlify staging content and product-page preview are implemented. Current local source verification passes 165 database/API/security tests and 14 tooling tests. A native ARM64 working-tree production rehearsal passes 109 steps. Final browser and clean-checkout receipts are tracked in [B1 verification](b1-verification.md); hosted gates and downloaded packages must cover the private PR's exact head. Earlier receipts remain clearly historical.

The owner authorized completing this checklist and preparing the final repository PR on October 2. The earlier automated-suite and PR-delivery hold is lifted. Verification must cover this candidate; public publication, repository visibility changes, merge and deployment remain separate final-approval gates.

## 1. Finish the brand and brown theme

- [x] Create a recognizable tower mill mark: the October 2 local implementation replaces the M with a transparent 3D tower, cap and sails. Final visual approval remains open below.
- [x] Prepare the mark, wordmark/lockup, light/dark versions, monochrome version, favicon, touch icon and social preview assets. Preserve aspect ratio and provide accessible names where appropriate.
- [x] Introduce semantic brown accent tokens and warm neutral surfaces for light and dark themes. The local implementation uses existing component roles and retains semantic success, warning and danger colors; see [brand foundation](branding.md) for every token and contrast measurements.
- [x] Review contrast and default/hover/pressed/focus/disabled states throughout the app. Brown must remain legible on both themes and must not make urgent/destructive states ambiguous.
- [x] Apply the prepared assets and tokens to setup/sign-in, navigation, task/board pages, settings, OAuth consent, error pages, documentation and the public product surface.
- [ ] Obtain visual approval of the reviewable logo, palette and current release screenshots before public publication.

## 2. Audit against current Towbar primitives

The source audit is recorded in [current UI audit](current-ui-audit.md), against Towbar revision `73278680683b4cc4e3492285678610a950acc3f8`. Use the current Towbar checkout read-only. Record the reference revision, exact source component, Mill counterpart, intentional differences and any finding. Older source-mapping reviews are useful starting points, not current acceptance.

| Audit area           | Required comparison and acceptance                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance           | Typography, weights, line heights, muted text, spacing, radii, borders, shadows and icon sizes match the shared visual language; Mill's brown palette is intentional.                                                                  |
| Component reuse      | Buttons, fields, selects, DatePicker, tables, chips, avatars, tabs, dialogs, popovers, tooltips, alerts/toasts and empty states use shared primitives; remove accidental custom substitutes.                                           |
| Shell and navigation | Primary/secondary sidebar, mobile drawer, scrolling, breadcrumbs, dropdown switchers, active states, collapse animation and logo lockup behave consistently.                                                                           |
| Page composition     | Headings/actions, table stacks, People/settings layouts, task panes and modal sizing use consistent hierarchy and containment. Preserve the user's full-width task layout.                                                             |
| Interaction          | Keyboard and touch behavior, focus restoration, clipped focus rings, overflow, Escape, disabled/pending actions, word wrapping and reduced motion meet the same standard.                                                              |
| Feature basics       | Validate complete end-to-end Mill workflows against Towbar's quality standard: navigation, forms, search/filter/sort, pagination, persistence, recovery and permissions. Towbar-specific deployment features do not become Mill scope. |
| Feedback and states  | Toasts for completed actions, local actionable validation/retry/conflict messages, honest loading/empty states and dedicated errors have coherent copy and treatment.                                                                  |
| Engineering          | Public dependencies, attribution, server-enforced permissions, migrations, configuration, release artifacts and operator guides follow applicable Towbar conventions without sibling-checkout dependencies.                            |

- [x] Complete the source/component inventory and classify differences as intended brand/product choices or defects.
- [x] Compare the actual rendered routes at desktop, tablet and phone widths in both themes, including long content and dense lists.
- [x] Close every material audit finding and capture current screenshots plus keyboard/touch review evidence.

## 3. Complete error, empty and recovery experiences

Branded ErrorPage and shared feedback components now cover recovery and permission states. The source, rendered browser and production receipts retain their separate verification boundaries.

- [x] Finish branded 404, access-denied, unexpected-server-error and application-startup failure views with accurate recovery destinations.
- [x] Reproduce and close the intermittent task-opening failure; verify direct links, reload, stale frontend assets, browser Back/Forward and deleted/inaccessible tasks.
- [x] Review offline/timeouts, expired sessions, revoked credentials, rate limiting and failed mutations. Preserve unsaved drafts and avoid duplicate actions during retries.
- [x] Review empty workspace/board, no matching filters, no comments/activity, no eligible Agents, empty People/invitations/keys/sessions and notification emptiness. Offer only available next actions.
- [x] Keep successful operation feedback in alert toasts; keep validation and retry/conflict recovery near the action that needs attention. Avoid raw backend/internal details and untrue claims about unsaved work.
- [x] Verify failed requests do not masquerade as empty results, leak stale data or leave controls/focus unusable.

## 4. Verify the final feature basics

- [x] Setup, invitation acceptance, sign-in/out, recovery, passkeys/authenticator fallback, sessions, profile/time zone and notification preferences.
- [x] Roles and access: Admin/Member/Viewer, workspace-wide human board access, scoped MCP board grants, invitations, last-administrator protection and human-only administration.
- [x] Boards: creation/settings/deletion, alphabetical complete directory, last accessible board, primary/secondary navigation and accurate breadcrumb routing.
- [x] Tasks: creation with Title/Description/Assignee, dedicated page, independent immediate field saves, edit modal, fixed statuses, priority, HeroUI due date, stable ID/deep link and confirmed deletion.
- [x] Search, combined assignee/Agent/status/priority filters, sort groups, complete pagination and URL state across reload, Back/Forward, task returns and board switching.
- [x] Assign an Agent without a human assignee and verify persistence through UI, REST and MCP. Check actor access and any selected assignee's Agent access, including access revocation.
- [x] Comments: newest first, mentions autocomplete, correct author/date tooltip, valid/disabled send states, hover/focus/touch trash action, deletion confirmation and attributed activity. Comment editing must be absent from UI, REST and MCP.
- [x] Notifications: assignments/mentions, unread/read behavior, preferences, full-width hover treatment, scrolling/pagination and correct task links.
- [x] Agents/credentials: personal versus team access, all-members grants and pinned creator, personal REST keys, selected-Agent MCP OAuth/PKCE, scopes/board grants, expiry and revocation. Exercise actual MCP SDK calls.
- [x] Concurrent edits, version conflicts, navigation with drafts, idempotent retries and deletion races preserve data and attribution.
- [x] Confirm excluded features are absent from current UI/contracts/docs: checklists, comment editing, Kanban, custom statuses, manual ordering, labels, subtasks, portable import/export and task email notifications. Preserve legacy data according to migration policy.

## 5. Documentation, Mintlify and mill.fyi

- [x] Refresh the release brief, verification matrix, release notes and screenshots to the actual final implementation. Remove current-facing stale references to X comment deletion, editable comments, older navigation and historical autosave behavior.
- [x] Populate Mintlify from the maintained guides: overview, quickstart, first board/task, team/access, Agents, REST API, MCP, configuration, security, backup/restore, upgrades and troubleshooting.
- [x] Prepare accurate API/MCP examples and contracts for publication: no checklist/comment-edit endpoints, Agent-only assignment supported, real auth/scope/error behavior and bounded pagination.
- [x] Apply the brown theme/logo to docs, configure navigation/search, check internal/external links and test beginner instructions from a clean environment.
- [ ] Define the domain layout for product website, documentation and any hosted demo/app; do not imply a managed hosting offering without a decision to provide one.
- [x] Prepare the `mill.fyi` public product page with truthful feature/scope copy, current screenshots, install/docs/source links, license and support/security contact.
- [ ] Configure and verify the chosen DNS, HTTPS, redirects, canonical URLs, favicon and social metadata after the targets are approved.
- [x] Decide account/invitation email behavior for launch. The current docs say the provider is unavailable; launch with documented private-link invitations and operator recovery. No email provider or task email notifications are advertised.

## 6. Fresh verification and operational readiness

- [x] Run the complete local `pnpm verify` and `pnpm test:browser` after the final presentation fixes: 165 database/API/security tests, 14 tooling tests, 51 link checks and 86 browser cases pass. Record distribution identity and cleanup in B1 verification; fix failures without weakening gates.
- [ ] Repeat production verification and browser/source CI on the exact frozen head. Post-freeze receipts belong to the private release PR. The prior native ARM64 working-tree rehearsal passes all 109 steps.
- [x] Refresh meaningful regression coverage for the scope/UI changes. Re-run real PostgreSQL permission, authentication, concurrency, persistence and REST/MCP checks.
- [ ] Verify clean checkout/install without private Avgeek dependencies or a sibling Towbar checkout, one-time setup and documented configuration.
- [ ] Verify native amd64/arm64 container builds, non-root runtime, health/readiness, persistent PostgreSQL and actual HTTPS/reverse-proxy behavior.
- [x] Exercise upgrade migrations including 010, preserved tasks/history, privately retained old checklist content and Agent-only assignments. Keep applied migration checksums intact.
- [x] Complete local full backup/restore and account recovery drills with isolated disposable data; document upgrade recovery and required secret/configuration retention. Final native architecture repetition is tracked on the private PR.
- [x] Complete vulnerability/license/secret review and verify OSS attribution, source notices, bundled fonts/icons and distributable assets.
- [x] Review frontend size and slow-network performance: the task-only date picker split and negotiated static gzip reduce initial transfer; cold sign-in/board usability and large collections are exercised in the final browser gate. Vite's 500 kB advisory remains documented; no warning threshold was raised. See the current UI audit for measurements.
- [x] Document environment-specific passkey, delivery and proxy checks separately from local/virtual evidence. Physical authenticators and the approved public HTTPS origin require operator deployment checks.

## 7. Review and publish the release

- [ ] Review the complete local diff, include required new files, exclude private fixture evidence/secrets and produce reviewable commits/private PR once the hold is lifted.
- [ ] Require passing hosted source/browser/production CI on the exact reviewed commit, plus independent final product, UI, security and operational review.
- [ ] Prepare the final version/tag, changelog, checksums, source manifest and verified architecture artifacts. The current workflow prepares private archives; registry/GitHub release publication is a separate remaining step.
- [ ] Finalize image registry/release destinations, public installation instructions and source visibility. Keep the repository/artifacts private until publication is authorized.
- [ ] Obtain final owner/coordinator approval of the concrete release candidate, public assets and deployment/domain plan.
- [ ] Publish the approved source/artifacts, website and Mintlify docs. Verify actual public download/image paths, beginner installation, docs links and live domain behavior before announcing availability.

All feature, state and primitive-review checkboxes above reflect executed local source/browser review. The exact frozen checkout, hosted CI and downloaded native architecture artifacts are intentionally tracked after the source freeze on the private PR; their outcomes do not become a public-deployment claim.

The product-page and Mintlify content are prepared locally. Domain targets, current starter migration and public publication remain pending owner approval; see [site cutover plan](../site/README.md). Completed preparation items do not close live-publication gates.

The remaining sequence is final source freeze → exact-head hosted CI and native package inspection → owner review of branding and the domain/deployment plan → authorized publication. Post-freeze hosted outcomes belong to the private PR; live DNS, public downloads, physical authenticators and production deployment remain separate gates.
