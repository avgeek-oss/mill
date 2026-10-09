# Everyday work

Mill opens on **Boards** under **Operate**. The page lists accessible boards as alphabetical cards with separate Backlog, To Do and In Progress task counts. Each count includes only its named status and covers all tasks in the board. Choose a card to open its task table, or choose **Create Board** at the top right to create a board with a short name and a prefix such as `ENG`. Search tasks above the table. The board's secondary sidebar contains filters and sort; on smaller screens, choose **Filters** to open the navigation drawer. The breadcrumb links back to Boards or the selected board, preserving your table view when you return from a task.

A board's prefix is permanent. Its tasks receive identifiers such as `ENG-1`; editing a title or changing a status keeps that identifier. Share the task's link with teammates.

## Create and update a task

Open a board and choose **New task**. Enter a title, choose Task or Bug in **Type**, optionally add a description and choose an assignee, then choose **Create task**. Its dedicated page opens immediately. A new task defaults to Task type and Todo status; priority, start date and due date can be added on the page. REST and MCP clients can provide those fields during creation.

Change Type using the dropdown above Status on the task page. Task uses the theme-colored task icon and Bug uses a red bug icon. The table shows this icon before the task identifier, in its own Task ID column on desktop and beneath the title on mobile. Changing type keeps the task's identifier and records the change in Activity. Existing tasks start with Task type.

Descriptions and comments support Markdown. Edit descriptions in a plain textarea; the task page renders the saved Markdown. Use a web link to reference a file stored elsewhere; Mill does not accept file uploads.

Due dates are calendar dates such as `2026-10-04`; changing time zones does not shift them. Your profile time zone controls displayed activity times.

Each task field saves independently. Selections save immediately. Use **Edit task** to open a dialog for title and description; those fields save after a short typing pause or when you leave the field. Closing the dialog waits for pending saves. If a save fails, keep your draft and choose **Retry** or **Use saved value**. If the same field changed elsewhere, review the newer value before choosing **Keep my change**. Navigation waits for pending saves and retains failed drafts.

Choose **Duplicate task** from a task's ellipsis menu to open a creation modal. The title starts with `[Copy] `; description, type and priority are copied, Status starts at Backlog, and Assignee is empty. Review or change the fields, then choose **Create task** to confirm. Cancelling creates nothing. The copy receives a new identifier and has no due date, comments or previous activity; the original task remains unchanged.

Start date appears before Due date in task properties. Both are optional calendar dates and save independently. Use the calendar or date segments to choose a date, or Clear date to remove it. Duplicating a task leaves both dates empty.

## Find work

Use **Search tasks** above the table to match titles, descriptions, and task identifiers. Combine status, assignee and priority filters. Choose **Unassigned** for tasks without an assignee. Clear the filters to return to the full default list.

Done and Won't Do tasks appear in the default list for one day after entering that status. After that, choose Done or Won't Do in the Status dropdown to find them. Editing other fields does not restart the day. This also applies when searching without a status filter. Direct task links continue to work.

Sort by title, priority, status, due date, creation time, or latest update. Priority and status sorting split the current page into named groups. Creation time is the default, newest first. Pagination applies to the entire filtered result, with one footer across the groups. Search, filters, sort, page and page size are stored in the URL, so reload and task return links preserve your view. Changing filters returns to page 1. If work changes between pages, Mill asks you to reload the current filtered list rather than combining pages from different revisions. Existing rows stay visible while the replacement list loads.

Boards are alphabetical and task order comes from the selected sort. There are no drag-and-drop lanes, custom statuses, labels, manual positions, or task parent/subtask controls. Existing subtasks from an older installation remain independent tasks after upgrade.

## Comments and notifications

Keep decisions next to the task in a comment. Mention a teammate using `@their-email@example.com`; API clients can use active member UUIDs in `mentionIds`.

Assignments and mentions create in-app notifications for the affected teammate, subject to their preferences. Your own actions do not notify you. Open the header bell for a single scrolling list with unread indicators. Opening a notification marks it as read; the popover header also offers Mark all read. Task notifications are delivered in the app.

Comments cannot be edited after posting. You can delete your own comments. An administrator can remove another person's comment. An OAuth client can delete its connection owner's comments within the approved boards and write scope.

Task activity shows changes and the person responsible for each action. Workspace-wide audit history is excluded from v1.

## Delete work permanently

Delete a task from its detail view when it is no longer needed. Confirming permanently removes that task, its comments, notifications, and task activity. Other independent tasks remain. Members and administrators can delete tasks; viewers cannot.

An administrator opens the menu beside **New task** and chooses **Delete board**. The separate confirmation dialog covers every task and its associated discussion in that board. **Board settings** in the same menu contains the board's name and description. After deletion, Mill removes the board from navigation and returns to the Boards overview.

There is no archive, trash, or restore view. Save a [full database backup](backup.md) before deleting work you may need later. There is no portable export/import feature. Task numbers are not reused within an existing board.

## Permissions

| Action                                          | Viewer | Member | Administrator          |
| ----------------------------------------------- | ------ | ------ | ---------------------- |
| Read boards, tasks, comments, and activity      | Yes    | Yes    | Yes                    |
| Manage own notifications, profile, and security | Yes    | Yes    | Yes                    |
| Create/change boards, tasks, and own comments   | No     | Yes    | Yes                    |
| Permanently delete tasks                        | No     | Yes    | Yes                    |
| Moderate another person's comments              | No     | No     | Yes, with Admin access |
| Permanently delete a board                      | No     | No     | Yes, with Admin access |
| Manage membership and Team Settings             | No     | No     | Yes, human session     |

## People and API keys

People are accounts that sign in to Mill. Manage invitations and roles in **Team Settings → Members**, and the workspace name in **Team Settings → General**. With SMTP configured, invitations include an email verification step; without SMTP, copy and share a private invitation link. See [accounts and team access](authentication.md#join-a-team).

Personal API keys belong to the person who creates them. Open **Account Settings → API Keys** and choose Name, Permissions (Read-only, Edit, or Administrative permissions), and Expires after (30 days, 90 days, 1 year, or Never). The stored grant remains bounded by the owner's active current role and narrows permanently on demotion. Admins manage team-owned keys under **Team Settings → Team API Keys**; those keys use their stored team grants independently of creator membership.

MCP OAuth connects a client to the person who approves it. Review the requested read or read/write scopes, and optionally limit the connection to selected boards. Every active member can read workspace boards. API keys use explicit grants on REST; MCP OAuth adds approved-board restrictions. Role changes, removal, or revocation prevent a waiting mutation from committing without current authority.

## Work through the API

See [the REST reference](api.md) for fields, fixed status values, filters, and pagination, and [Connect a client](clients.md) for REST/MCP authentication. Read the latest task, then use its current version and one idempotency key per intended mutation. Keep that same key for an uncertain network retry.

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
