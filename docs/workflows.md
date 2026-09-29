# Everyday work

Mill opens on your task lists. The sidebar's **Boards** section lists every accessible board alphabetically. Choose **Create Project** after the final board to create one with a short name and a prefix such as `ENG`.

A board's prefix is permanent. Its tasks receive identifiers such as `ENG-1`; editing a title or changing a status keeps that identifier. Share the task's link with teammates.

## Create and update a task

Open a board and choose New task. Enter a title and choose Backlog, Todo, In Progress, In Review, Done, or Won't Do. A new task defaults to Todo. You can add a description, assignee, priority, due date, and checklist.

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

A human administrator can delete a board from Board settings. Confirmation covers every task and its associated discussion in that board. Mill removes the board from navigation and opens another board or the empty view.

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
| Manage membership and workspace settings        | No     | No     | Yes, human session |

Every active member can read workspace boards. Credentials can narrow an agent to selected boards and read or read/write scope, within its owner's current role. Role changes, removal, or revocation also prevent a waiting mutation from committing without current authority.

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
