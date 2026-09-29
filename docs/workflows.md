# Everyday work

Mill opens on your task lists. The sidebar's **Boards** section lists every accessible board alphabetically. Choose its **plus button** to create one with a short name and a prefix such as `ENG`.

A board's prefix is permanent. Its tasks receive identifiers such as `ENG-1`; editing a title or changing a status keeps that identifier. Share the task's link with teammates.

## Create and update a task

Open a board and choose New task. Enter a title and choose Backlog, Todo, In Progress, In Review, Done, or Won't Do. A new task defaults to Todo. You can add a description, human assignee, Agent, priority, due date, and checklist.

An Agent is optional and separate from the human assignee. Choose the human first; both you and that person must have access to an Agent when you change the binding. A task cannot have an Agent without an active human assignee. Unrelated edits preserve an existing valid binding. Selecting an Agent does not run work or contact an external service.

Descriptions and comments support Markdown. Preview a description before saving. Links must use a safe web protocol; Mill does not accept file uploads. Checklist items have independent completion states.

Due dates are calendar dates such as `2026-10-04`; changing time zones does not shift them. Your profile time zone controls displayed activity times.

Open a task to change its properties or fixed status with keyboard or touch controls. If another person or agent changes it while your form is open, Mill rejects the stale save and preserves your draft for reconciliation. The API checks the task's current `version`.

## Find work

Use the list's search to match titles, descriptions, and task identifiers. Combine status, assignee, and priority filters. Choose Unassigned for tasks without an owner.

Sort by title, priority, due date, creation time, or latest update. Creation time is the default, newest first. Lists load bounded pages. Changing filters starts a new page sequence; editing retains the current list context. If work changes between pages, Mill asks you to reload the current filtered list rather than combining pages from different revisions. Existing rows stay visible while the replacement list loads.

Boards are alphabetical and task order comes from the selected sort. There are no drag-and-drop lanes, custom statuses, labels, manual positions, or task parent/subtask controls. Existing subtasks from an older installation remain independent tasks after upgrade.

## Comments and notifications

Keep decisions next to the task in a comment. Mention a teammate using `@their-email@example.com`; API clients can use active member UUIDs in `mentionIds`.

Assignments and mentions create in-app notifications for the affected teammate, subject to their preferences. Your own actions do not notify you. Open the header bell for a single scrolling list with unread indicators. Opening a notification marks it as read; the popover header also offers Mark all read. Task notifications are delivered in the app.

You can edit or delete your own comments. A human administrator can moderate another person's comment. An external agent can edit its credential owner's comments within the approved boards and write scope.

Task activity shows changes and human/agent attribution. Workspace-wide audit history is excluded from v1.

## Delete work permanently

Delete a task from its detail view when it is no longer needed. Confirming permanently removes that task, its comments, notifications, and task activity. Other independent tasks remain. Members and administrators can delete tasks; viewers cannot.

A human administrator opens the ellipsis menu after New task and chooses Delete board. The separate confirmation dialog covers every task and its associated discussion in that board. Board settings in the same menu contains the board's name and description. After deletion, Mill removes the board from navigation and opens another board or the empty view.

There is no archive, trash, or restore view. Save a [full database backup](backup.md) before deleting work you may need later. There is no portable export/import feature. Task numbers are not reused within an existing board.

## Permissions

| Action                                          | Viewer | Member | Administrator      |
| ----------------------------------------------- | ------ | ------ | ------------------ |
| Read boards, tasks, comments, and activity      | Yes    | Yes    | Yes                |
| Manage own notifications, profile, and security | Yes    | Yes    | Yes                |
| Create/change boards, tasks, and own comments   | No     | Yes    | Yes                |
| Permanently delete tasks                        | No     | Yes    | Yes                |
| Moderate another person's comments              | No     | No     | Yes, human session |
| Permanently delete a board                      | No     | No     | Yes, human session |
| Manage membership and Team settings             | No     | No     | Yes, human session |

## People, Agents, and API keys

People are accounts that sign in to Mill. Manage invitations and roles in People, and the workspace name in Team settings. Agents are separate identities created in the human Agents interface. Members and administrators can create personal Agents; only their creator can use and manage them. An administrator creates and manages team Agents, granting access to selected active people or all current and future members. The active creator retains a pinned individual grant. Administrator status alone does not grant use of a team Agent.

Personal API keys belong to the person who creates them. Open API keys and choose Name and Expiry: 30, 60, 90, or 365 days. They use the owner's current permissions across all accessible boards and have no Agent, scope, or board selector. Another administrator does not own your keys.

MCP OAuth requires an eligible existing Agent and can narrow access with scopes and approved boards. If none is available, create a personal Agent or ask an administrator for team access before connecting. Neither REST/MCP clients nor OAuth create Agent identities.

Every active member can read workspace boards. OAuth connections can narrow an Agent to selected boards and read or read/write scope, within the human owner's current role. Personal API keys use that owner's role without those restrictions. Role changes, removal, or revocation also prevent a waiting mutation from committing without current authority.

## Work through the API

See [the REST reference](api.md) for fields, fixed status values, filters, and pagination, and [Connect an agent](agents.md) for REST/MCP authentication. Read the latest task, then use its current version and one idempotency key per intended mutation. Keep that same key for an uncertain network retry.

```sh
curl "$MILL_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $MILL_TOKEN"

curl -X PATCH "$MILL_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $MILL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: finish-eng-1' \
  --data '{"version":1,"status":"done","priority":"high"}'
```

A stale version returns `409`. Reload and reconcile before starting a new mutation. A forbidden operation returns `403`; expired/revoked authentication returns `401`. Mixed notification selections fail as a whole if any selected ID is inaccessible.
