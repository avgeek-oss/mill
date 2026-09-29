# Towbar task and board flow review

> Historical review of earlier candidates, retained through the preceding `7fc132` fixed-list candidate. The screenshots, feature descriptions, test/CI receipts, and acceptance statements below do not verify the current explicit-Agent architecture or the 14 requested interface changes. See [the current scope and evidence](b1-verification.md).

This records the bounded Gate 2B task and board flow changes after the accepted [foundation checkpoint](towbar-foundation-review.md). The coordinator accepted Gate 2B after the focused browser results and independent desktop/phone review in both themes. This gate does not establish overall B1 approval, final CI, or release readiness.

## Public source and composition

The reference remains the read-only Apache-2.0 Towbar checkout at `../towbar/packages/web-design-system/src`. Public primitives retain their attribution in the design-system notice and the generated frontend notice asset. No paid HeroUI Pro component, private package, paid icon pack, or third-party image is included.

| Towbar source                                                    | Mill implementation                                                               | Flow adaptation                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlays/modal.tsx`                                             | Shared `Dialog` composition in `packages/web-design-system/src/compatibility.tsx` | Native inside scrolling and wide task/settings layouts; pinned footer; dismissal disabled during mutations, ordinary loading dismissible.            |
| `navigation/tabs.tsx`                                            | Matching shared module                                                            | One Description label with Write/Preview panels; Comments/Activity panels retain keyboard behavior and unbroken count labels.                        |
| `forms/checkbox.tsx` and Field separators                        | Matching shared module and task checklist rows                                    | Label/control compound composition, independent remove action, first/last row spacing, persisted checked state.                                      |
| `forms/{field,select,input,textarea,label,description}.tsx`      | Existing accepted shared modules and compatibility wrappers                       | Secondary form controls, native required validation, bounded selections, shared labels and descriptions.                                             |
| `data-display/{widget,chip}.tsx`, public HeroUI Avatar/Separator | Existing accepted shared modules                                                  | Board details/status/archive Widgets; compact subtask status/date chips and initials avatars. Avatar does not add an external image-service request. |
| Typography, Alert, Button, Link recipes                          | Existing accepted shared modules                                                  | Medium author names, small supporting timestamps, plain activity labels, local conflict/error/success feedback, canonical task links.                |
| `data-display/list-view.tsx`                                     | Matching shared module                                                            | Public shared row composition exported for subsequent settings flows.                                                                                |

`task-dialog.tsx` owns the application flow. Its edit form, controlled properties and separate comment form are sibling elements; no forms are nested. Desktop discussion follows description/checklist/subtasks in the left column while properties occupy the right column. Phone order is content, paired properties, then discussion. Only application layout rules remain in the task CSS; component surfaces and controls use the shared recipes.

`board.tsx` uses the wide shared Modal and responsive content grid for details, statuses and lifecycle actions. Prefix is immutable supporting information. Status controls include readable color names and indicators, with bounded rows and wrapping actions. Populated-status deletion preserves the initiating confirmation after failure and allows transfer to another status. Archive/delete confirmations preserve cancellation and permission checks, and their completion remains in Board settings with a restore path.

An existing-task detail failure renders an owning load error with Reload task and Close. It never exposes New task or a creation POST. A task save conflict keeps the current draft until the user explicitly chooses Reload task. Task and comment lifecycle feedback remains in the task dialog.

New board, task and comment POSTs use the shared stable retry-key factory. The same path/payload retains its key after an unreadable or lost response; changed payloads rotate the key, and a successfully received mutation response resets it. The root owns server replay verification and the additional malformed-success response case.

The subsequent response-validation follow-up requires usable board/task/comment records before resetting keys or invoking completion callbacks. The shared retry map preserves all unresolved payload keys, including a return to an earlier failed draft. A deliberate form/dialog dismissal clears them. Sidebar pages prefer the fresh server row over a provisional created-board entry; an entry retained outside the current page is checked with a direct board GET before rendering it.

## Focused browser evidence

The six focused journeys passed in **30.3 seconds** on production assets `index-D5769Zoe.js`, `task-dialog-BnAnyDEi.js` and `board-CPW4ExBN.js`. They used the isolated PostgreSQL browser schema on localhost:4323. Result lines transcribed from the captured tool output are in ignored `tmp/gate2b-browser.log`; the original process stdout was not redirected to a file. `tmp/gate2b-touch.log` records actual DOM measurements on the review preview. Fixture credentials and session state remain outside tracked documentation.

The journeys cover:

- First installation and actual board/task creation, including disabled close actions and Escape during pending board, task and comment requests; title/status edits, safe Markdown, checklist persistence, subtask creation, comment edit/delete confirmation and keyboard submission.
- Canonical task links with client routing, keyboard task movement, filtered list click/close and Enter/Back retaining search/view, accurate filtered-empty recovery, and overlay search/scrolling.
- Real concurrent task version conflict, preserved draft and explicit reload recovery.
- Task archive/delete/restore with local completion, disabled deleted-task edits and reload/persistence checks.
- Status creation/color/name changes, actual populated-status failure, transfer and deletion recovery, board archive/delete cancellation and restoration.
- Actual PostgreSQL task-detail 500 and network failure, restored lookup/retry, unchanged task identity and zero creation requests. The database fault is restricted to the wrapper's known isolated schema, proves the fixture first and restores the table in `finally`.

The separately invited detail-review actor keeps these requests within the real per-actor rate budget. No rate limit is disabled or reset.

Actual coarse-pointer measurements used **390×844**, `isMobile: true`, `hasTouch: true`:

| Target                              | Measured result                                                |
| ----------------------------------- | -------------------------------------------------------------- |
| Write / Preview tabs                | 44px high; widths 67.47px / 85.25px                            |
| Modal close                         | 44×44px                                                        |
| Comments / Activity tabs            | 44px high                                                      |
| Checkbox root and clickable content | At least 44px high; 16×16px control glyph retained             |
| Native property text/date inputs    | 16px text                                                      |
| Property controls                   | 155px columns; rightmost edge 358px within dialog edge 382px   |
| Dialog / document                   | Dialog 374×812px; document width 390px; no horizontal overflow |
| Pinned Save footer                  | Position unchanged when the modal body scrolls to the bottom   |

The desktop DOM measured content/discussion at x=214px and properties at x=846px. Discussion starts at y=754.78px while the properties column continues to y=807.70px, demonstrating the intended left-column flow. The modal body is the scroll container. The document contains zero nested forms.

## Rendered captures

These fourteen files contain native PNG bytes, captured from the authenticated localhost:4321 review preview on the same accepted Gate 2B build. Desktop viewport was 1280×800. Phone viewport was 390×844 in a real coarse-pointer Playwright context. Full-page capture includes the background document below the fixed modal; **image dimensions differ from viewport dimensions**.

| View                                     | Light                                                     | Dark                                                    | Actual image dimensions |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| Desktop task, initial scroll             | [Light](screenshots/gate2b/task-light-1280.png)           | [Dark](screenshots/gate2b/task-dark-1280.png)           | 1280×1035               |
| Desktop task, Activity after body scroll | [Light](screenshots/gate2b/task-activity-light-1280.png)  | [Dark](screenshots/gate2b/task-activity-dark-1280.png)  | 1280×1035               |
| Desktop Board settings                   | [Light](screenshots/gate2b/board-settings-light-1280.png) | [Dark](screenshots/gate2b/board-settings-dark-1280.png) | 1280×1035               |
| Phone task, initial scroll               | [Light](screenshots/gate2b/task-light-390.png)            | [Dark](screenshots/gate2b/task-dark-390.png)            | 390×1008                |
| Phone task properties after body scroll  | [Light](screenshots/gate2b/task-properties-light-390.png) | [Dark](screenshots/gate2b/task-properties-dark-390.png) | 390×932                 |
| Phone Board settings                     | [Light](screenshots/gate2b/board-settings-light-390.png)  | [Dark](screenshots/gate2b/board-settings-dark-390.png)  | 390×932                 |
| Phone statuses after body scroll         | [Light](screenshots/gate2b/board-statuses-light-390.png)  | [Dark](screenshots/gate2b/board-statuses-dark-390.png)  | 390×932                 |

Later `index-CdDKPbUK.js` includes the accepted task/board composition plus the parser, sidebar continuation and independently owned settings checkpoint. It does not retroactively change the capture provenance above. The existing shared JavaScript chunk advisory remains open; its threshold has not been raised.

## Sidebar continuation follow-up

The authorized board directory follow-up is in `app.tsx`. It requests 100-item cursor pages, shows owning pending/error/retry states, appends with deduplication, ignores obsolete collection responses and preserves collection/expansion through settings navigation. A newly created board remains visible even when its position is beyond the first page. Board metadata updates refresh that retained entry so lifecycle actions remain accurate.

The minimal shared `SidebarGroupConfig.footerContent` extension renders continuation controls after board links without changing the existing shell recipe. Shared `FileField`, used by the separate data owner, composes the accepted Field/Input/Description/Error primitives and forwards native props/ref without new CSS.

Three focused sidebar/setup/detail journeys passed in **14.1 seconds** on `index-CdDKPbUK.js`. The original process log was later overwritten; its passing result lines, transcribed from the captured tool output, are in ignored `tmp/sidebar-CdDKPbUK-transcribed.log` with explicit provenance. The sidebar test seeds 234 boards in the guarded isolated schema, traverses all 210 active directory entries, preserves loaded rows after an actual network failure, retries, rejects a delayed obsolete archived response, preserves Deleted collection through Profile and expansion changes, and creates a visible board beyond the former 100-board ceiling. Full assembled browser and release verification remain separate gates.

The ordering follow-up treats board cursors as opaque revision tokens. An invalid or stale continuation offers Reload boards and resets to the first page without changing the chosen collection. The strengthened browser source also checks a real reorder producing a 409 and server-side rename/archive/delete updates to a retained later-page board. Its first `index-Cm6aXEr6.js` run failed the earlier comment-edit assertion because the new validator expected an author-name field omitted by the valid PATCH response. The exact original failed process output is preserved in ignored `tmp/sidebar-Cm6aXEr6-failed.log`. Source now validates the core response and preserves the known author identity. The next production checkpoint, `index-q3SYgGGh.js`, includes the corrected validator, C settings and bundled static guides. Exact build output is retained in ignored `tmp/web-C-guides-build-20260928.log`. Three strengthened sidebar/setup/detail journeys passed in **14.4 seconds**; exact original process output is retained in ignored `tmp/sidebar-q3SYgGGh-fixture5.log`. They verify the real reordered opaque cursor returning 409, reload of the chosen collection, a new board beyond the first page, and direct fresh server metadata after rename/archive/delete. The sidebar fixture uses a separately invited administrator and a guarded finally block removes only its captured 234 seeded board IDs plus the newly created board, including their empty status/activity rows. It verifies that the original workflow board remains. The test retains the installation UI, comment edit author and owning deletion feedback, and existing-task failure recovery assertions. Earlier unsuccessful runs on this checkpoint remain separately named; they cover fixture actor/navigation/API-contract mistakes and a global status locator corrected to the initiating dialog. Full assembled browser and release checks remain separate gates.
