# Mill publishing checklist

Prepared from the October 2–3 candidate. The October 5 scope removes Agents completely and consolidates the prelaunch schema; prior checked receipts do not establish acceptance of this revision. Checked items have completed preparation or executed local evidence, as stated. Exact-head hosted CI and native artifact receipts are recorded on the [private release PR](https://github.com/avgeek-inc/mill/pull/1) after the source freeze. This document does not authorize or claim public publication.

## Confirmed direction and starting point

- [x] Product name: **Mill**.
- [x] `mill.fyi` is reserved, as reported by the owner. DNS, HTTPS and published content still need verification.
- [x] A Mintlify project exists, as reported by the owner. Content integration, navigation, branding and publication still need verification.
- [x] Brand direction: **brown UI theme** and a **literal tower mill logo**, in the same visual design language as Towbar.
- [x] Owner approved the logo and palette on October 3. Documentation typography, capitalization and copy require rework against [Towbar feedback](docs-design-review.md).
- [x] Hosting domain: **mill.fyi**. The revised direction combines the Mintlify homepage and documentation there; the earlier separate docs subdomain proposal is superseded.

The application, REST/MCP, migrations, operator guides, brown branding, current Towbar audit, Mintlify staging content and product-page preview are implemented. After Agent removal, current local verification passes 162 database/API/security tests, 18 tooling tests and 99 browser tests across 13 isolated installations. The native working-tree container rehearsal passes 44 steps. Fresh captures cover 68 application states and 60 documentation views. Final receipts are tracked in [v1 verification](b1-verification.md); hosted gates and downloaded packages must cover the private PR's exact head. Earlier receipts remain clearly historical.

The owner authorized completing this checklist and preparing the final repository PR on October 2. The earlier automated-suite and PR-delivery hold is lifted. Verification must cover this candidate; public publication, repository visibility changes, merge and deployment remain separate final-approval gates.

## 1. Finish the brand and brown theme

- [x] Create a recognizable tower mill mark: the October 2 local implementation replaces the M with a transparent 3D tower, cap and sails. The owner approved the logo on October 3.
- [x] Prepare the mark, wordmark/lockup, light/dark versions, monochrome version, favicon, touch icon and social preview assets. Preserve aspect ratio and provide accessible names where appropriate.
- [x] Introduce semantic brown accent tokens and warm neutral surfaces for light and dark themes. The local implementation uses existing component roles and retains semantic success, warning and danger colors; see [brand foundation](branding.md) for every token and contrast measurements.
- [x] Review contrast and default/hover/pressed/focus/disabled states throughout the app. Brown must remain legible on both themes and must not make urgent/destructive states ambiguous.
- [x] Apply the prepared assets and tokens to setup/sign-in, navigation, task/board pages, settings, OAuth consent, error pages, documentation and the public product surface.
- [x] Obtain owner visual approval of the logo and palette.
- [ ] Obtain approval of final release screenshots and public page compositions before publication.

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
- [x] Review empty workspace/board, no matching filters, no comments/activity, empty People/invitations/keys/sessions and notification emptiness. Offer only available next actions.
- [x] Keep successful operation feedback in alert toasts; keep validation and retry/conflict recovery near the action that needs attention. Avoid raw backend/internal details and untrue claims about unsaved work.
- [x] Verify failed requests do not masquerade as empty results, leak stale data or leave controls/focus unusable.

## 4. Verify the final feature basics

- [x] Setup, invitation acceptance, sign-in/out, recovery, passkeys/authenticator fallback, sessions, profile/time zone and notification preferences.
- [x] Roles and access: Admin/Member/Viewer, workspace-wide human board access, scoped MCP board grants, invitations, last-administrator protection and human-only administration.
- [x] Boards: creation/settings/deletion, alphabetical complete card overview, Backlog/Active counts, primary navigation, secondary filter/sort panel and accurate breadcrumb routing.
- [x] Tasks: creation with Title/Description/Assignee, dedicated page, independent immediate field saves, edit modal, fixed statuses, priority, HeroUI due date, stable ID/deep link and confirmed deletion.
- [x] Search, combined assignee/status/priority filters, sort groups, complete pagination and URL state across reload, Back/Forward, task returns and board switching.
- [x] Remove Agent settings, task assignments/filters, endpoints and MCP tools. Backend/schema verification and guarded local conversion pass; rendered checks use the final stable build.
- [x] Comments: newest first, mentions autocomplete, correct author/date tooltip, valid/disabled send states, hover/focus/touch trash action, deletion confirmation and attributed activity. Comment editing must be absent from UI, REST and MCP.
- [x] Notifications: assignments/mentions, unread/read behavior, preferences, full-width hover treatment, scrolling/pagination and correct task links.
- [x] Verify personal REST keys and human-owned MCP OAuth/PKCE, scopes/board restrictions, current role, expiry and revocation through actual SDK calls and container restart/restore.
- [x] Concurrent edits, version conflicts, navigation with drafts, idempotent retries and deletion races preserve data and attribution.
- [x] Confirm excluded features are absent from current UI/contracts/docs: checklists, comment editing, Kanban, custom statuses, manual ordering, labels, subtasks, portable import/export and task email notifications. Preserve legacy data according to migration policy.

## 5. Documentation, Mintlify and mill.fyi

- [x] Refresh the release brief, verification matrix, release notes and screenshots to the actual final implementation. Remove current-facing stale references to X comment deletion, editable comments, older navigation and historical autosave behavior.
- [x] Populate Mintlify from the maintained guides: overview, quickstart, first board/task, team/access, external clients, REST API, MCP, configuration, security, backup/restore, upgrades and troubleshooting.
- [x] Prepare accurate API/MCP examples and contracts for publication: no checklist/comment-edit endpoints, human-owned client access, real auth/scope/error behavior and bounded pagination.
- [x] Apply the brown theme/logo to docs, configure navigation/search, check internal/external links and test beginner instructions from a clean environment.
- [x] Record `mill.fyi` as the hosting domain. Use a shared Mintlify homepage/docs shell; operators install the Mill app at their own URL.
- [ ] Rework documentation and homepage typography, capitalization, copy and navigation against the detailed Towbar feedback. Verify the rendered result and obtain owner approval; technical preparation is not visual acceptance.
- [ ] Replace the rejected static product-page direction with the shared `mill.fyi` experience: direct product copy, current screenshots, install/docs/source links and native shared footer.
- [ ] Configure and verify the chosen DNS, HTTPS, redirects, canonical URLs, favicon and social metadata after the targets are approved.
- [x] Decide account/invitation email behavior for launch. The current docs say the provider is unavailable; launch with documented private-link invitations and operator recovery. No email provider or task email notifications are advertised.

## 6. Fresh verification and operational readiness

- [x] Run the complete local `pnpm verify` and `pnpm test:browser` after the final presentation fixes: 165 database/API/security tests, 14 tooling tests, 51 link checks and 86 browser cases pass. Record distribution identity and cleanup in v1 verification; fix failures without weakening gates.
- [ ] Repeat production verification and browser/source CI on the exact frozen head. Post-freeze receipts belong to the private release PR. The prior native ARM64 working-tree rehearsal passes all 109 steps.
- [x] Refresh meaningful regression coverage for the scope/UI changes. Re-run real PostgreSQL permission, authentication, concurrency, persistence and REST/MCP checks.
- [ ] Verify clean checkout/install without private Avgeek dependencies or a sibling Towbar checkout, one-time setup and documented configuration.
- [ ] Verify native amd64/arm64 container builds, non-root runtime, health/readiness, persistent PostgreSQL and actual HTTPS/reverse-proxy behavior.
- [x] Verify the single initial migration, incompatible-ledger rejection, guarded conversion with a retained source schema, and preserved tasks/history/credentials. After publication, keep applied migrations immutable.
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

The previous product-page and Mintlify content are prepared locally but their documentation design was rejected on October 3. The logo and palette are approved, and the hosting domain is mill.fyi. Rework is tracked in [documentation design review](docs-design-review.md). Existing project integration, starter replacement and public publication remain pending; see [site cutover plan](../site/README.md). Preparation does not close visual or live-publication gates.

The remaining sequence is documentation rework and owner review → final source freeze and exact-head verification → deployment/project review → authorized publication. Hosted outcomes belong to the private PR; live DNS, public downloads, physical authenticators and production deployment remain separate gates.
