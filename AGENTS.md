# Mill engineering guidance

Read README.md and docs/b1-release-brief.md before implementation. The user has requested a complete, usable first beta, not a skeleton or a smaller substitute for the agreed release scope.

## Product and architecture

- Build a focused task list for humans and external agents. The September 29 v1 scope uses alphabetical boards and six fixed task statuses; Kanban, custom statuses, manual ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded. Existing task and subtask records must survive as independent tasks; unrecognized old status names become Todo. Agents are separate human-created identities: personal Agents belong to their creator, and team Agents grant selected active people or all current and future team members access. The active team Agent creator retains a pinned individual grant. MCP OAuth selects an eligible existing Agent and cannot create one. Personal API keys are separate human credentials: name and expiry only, using their owner's current permissions across all accessible boards without Agent, scope, or board selections. Task Agent attribution is separate from its required human assignee and has no execution side effects. Hosted agent execution, co-founder personas, and a general agent orchestration platform were earlier ideas and are not the current product scope.
- Use /Users/praveen/Repositories/towbar as a read-only reference for current engineering conventions, OSS-safe UI primitives, authentication, API/MCP, Docker packaging, CI, documentation, and release verification. Do not edit Towbar or assume historical notes describe its current code.
- Keep Mill self-contained. A public install and contributor checkout must work without access to private Avgeek packages, paid component libraries, licensed fonts or icons, or local sibling checkouts. Preserve attribution when adapting Apache-licensed code.
- Follow Node.js 24, pnpm, TypeScript, clear owning packages, shared contracts, PostgreSQL migrations, reproducible builds, and container health-check conventions where relevant. Add durable background jobs only where they are needed; do not copy Towbar's deployment infrastructure into a task board.
- Authentication, authorization, validation, and persistence belong on the server. Apply permissions consistently across UI, REST, and MCP. Do not rely on hidden UI controls for security.

## UI and language

- Reuse or adapt the existing OSS-safe Towbar design-system components and tokens. Do not create custom buttons, selects, dialogs, chips, or typography when a shared component covers the behavior.
- Use the actual Towbar People composition: page actions above the tables, no redundant Members/Invitations headings or introductory paragraphs. Use shared `TableCellStack` and `TableCellDescription`: primary `text-sm/5 font-normal`, secondary `text-xs/4 font-normal text-muted`, and the shared line gap. Use semantic role/status Chips and the shared `Avatar({email,name})` with normalized-email SHA-256 Gravatar lookup and initials fallback.
- Buttons use the shared primary, secondary, or danger variant; never ghost or danger-ghost. Explanatory form text uses `text-xs`. Use `text-success-soft-foreground` and `text-danger-soft-foreground` for local operation feedback. Widget titles and icons follow the shared Towbar sizes. Last-administrator guidance belongs in the disabled delete action's keyboard/touch-accessible Tooltip; retain the server protection.
- Keep user-facing text simple. Avoid internal identifiers, attempt details, implementation jargon, placeholder copy, empty features, and disabled future-feature navigation.
- Verify actual rendered desktop and mobile routes in both themes. Check keyboard, touch, wheel/trackpad scrolling, focus, popover height, long content, empty states, and errors.
- Preserve independent sidebar expansion across navigation; reserve icon dimensions and preserve logo aspect ratios. Select menus must scroll correctly inside modal overlays and their search fields must use the established padding.
- Use compact descriptive text and consistent title/description hierarchy. Separator lists should have symmetric first/last spacing. Status and progress belong in the initiating dialog; use existing action components for recovery and dedicated 404/500 pages.
- Prefer passkeys automatically when a person has both a passkey and authenticator verification configured, with an accessible fallback. Keep mobile charts compact, with enough plot headroom, if charts are genuinely useful.
- Respect reduced motion, meaningful accessible names, readable contrast, and touch-sized targets. Do not hide essential actions behind hover.

## Delivery and review

- The implementation task uses GPT-6 Sol with High reasoning. The user explicitly permits bounded subagent work where useful independent work can run in parallel. Assign clear file ownership, integrate every result, and perform independent final reviews.
- Maintain a requirements/evidence matrix for every B1 requirement. Do not claim a feature is complete from a green narrow unit test, mocked screenshot, README, intent, or scaffold.
- Add meaningful tests for permissions, persistence, concurrency, authentication, integration boundaries, installation, backup/restore, and core browser journeys. Avoid tests that only mirror implementation.
- Run pnpm verify (or the complete documented equivalent), real-database integration checks, production builds, and container smoke checks. Fix failures; do not weaken tests, skip gates, or label unresolved defects as acceptable beta work.
- Keep secrets out of code, artifacts, screenshots, and logs. Use disposable isolated local databases and containers for verification.
- Keep the GitHub repository private. Work on a development branch with reviewable commits and a PR when implementation is ready. Do not change repository visibility, merge your own release PR, deploy to production, buy a domain, or publish public artifacts without the coordinating task's final review and the user's applicable authorization.
- Report exact commits, CI runs, runnable preview URLs, rendered screenshots, and remaining gaps. A progress report is not a release-ready claim.
