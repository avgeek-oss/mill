# Everyday work

Mill opens on your boards. Choose a board from the sidebar, or create one with a short name and a task prefix such as `ENG`. Mill adds Backlog, In progress, and Done. You can rename these statuses, change their colors, and add statuses for your own workflow.

Each board has a permanent prefix. Its tasks receive identifiers such as `ENG-1` and `ENG-2`; archiving, deleting, and restoring a task keep its identifier. Use the task's link when sharing work with a teammate.

## Create and update a task

Open a board and choose New task. Enter a title and pick a status. You can also add a description, assignee, priority, labels, due date, parent task, and checklist.

Descriptions and comments support Markdown. Use Preview to check a description before saving. Links must use a safe web protocol. B1 stores links in Markdown and does not accept file uploads.

Due dates are calendar dates, such as `2026-10-04`. They do not shift when a teammate changes time zones. Your profile time zone controls how Mill shows activity times.

Open an existing task to change its fields or status. Use its status and position controls to move it with the keyboard or on a touch screen. A checklist item has its own completion state. A subtask is a full task with a parent on the same board.

If another person or agent changes a task while your form is open, Mill rejects the stale save and asks you to reload. Your form does not silently replace their changes. The API uses the task's `version` for this check.

## Find work

Use the board or list view for the same tasks. Search matches titles, descriptions, and task identifiers. Combine search with status, assignee, priority, and label filters. Choose Unassigned to find tasks without an owner.

Sort by board position, title, priority, due date, creation time, or latest update. Mill loads bounded pages instead of rendering the entire board at once. Task details include their parent and up to 100 subtasks, even when your current board filters hide them.

## Comments and notifications

Add a comment to keep a decision next to the task. Mention a teammate using `@their-email@example.com`. API clients can include member UUIDs in the `mentionIds` field when posting a comment.

Assignments and mentions create in-app notifications for the affected teammate. Mill does not notify you about your own actions. Turn assignment or mention notifications off in your profile preferences. The Notifications page shows your unread count and lets you mark items as read or unread.

You can edit or delete your own comments. A human administrator can moderate another person's comment. An external agent can edit comments belonging to its credential owner, within its board and write permissions.

Activity records show what changed and whether a person or an external agent made the change. Administrators can also read the workspace audit log, including identity and credential events.

## Archive, delete, and restore

Archive a task when you want to keep it out of active work. The Archived view keeps it available for reference and restoration. Delete moves a task to the Deleted view. Deleted tasks remain readable, and restoring them returns them to active work.

Archiving a board makes its tasks and statuses read-only. Restore the board before changing its contents. Administrators can delete and restore boards. The Deleted view includes boards and tasks that were archived before deletion.

When deleting a status that contains tasks, choose another status on the same board. Mill moves every task before removing the status. A board always keeps at least one status.

## Permissions

| Action                                                   | Viewer | Member | Administrator         |
| -------------------------------------------------------- | ------ | ------ | --------------------- |
| Read active, archived, and deleted boards and tasks      | Yes    | Yes    | Yes                   |
| Read task comments and activity                          | Yes    | Yes    | Yes                   |
| Manage own notification read state and profile           | Yes    | Yes    | Yes                   |
| Create and change boards, statuses, tasks, and comments  | No     | Yes    | Yes                   |
| Edit or delete another person's comment                  | No     | No     | Yes, personal session |
| Delete or restore a board                                | No     | No     | Yes, personal session |
| Invite or manage members, change workspace settings      | No     | No     | Yes, personal session |
| Export/import portable data and read the workspace audit | No     | No     | Yes, personal session |

Every active member can read the workspace's boards. A credential can narrow an external agent's access to selected boards and to read or write operations. The agent keeps its owner's current role. Changing that role, removing the owner, revoking a session, or revoking the credential also prevents a mutation already waiting for a board lock from committing.

## Export and import

An administrator can download portable workspace data from Settings. The JSON file contains workspace name, member metadata, boards, statuses, tasks, and comments. It includes archived and deleted data. Passwords, sessions, passkeys, authenticator secrets, recovery codes, API credentials, OAuth grants, notifications, and audit/activity records are excluded.

Import adds the exported boards to the current workspace. It does not replace current boards or change the signed-in administrator's account or role. Mill gives imported records new internal IDs. If a task prefix is already in use, Mill chooses an available prefix for the imported board. Links to internal IDs from the old instance need updating after an import.

Mill matches member metadata by normalized email. New imported members start with access disabled. Open People and choose Invite a person to let them choose a new password and regain access. Their restored task assignments and comment attribution stay attached to the same imported member record.

Portable files have a 32 MiB limit. Each document supports up to 100 boards, 50 statuses per board, 50,000 tasks, and 100,000 comments, subject to that file limit. Imports add their boards without a workspace-wide board quota. Export reports an error when the workspace exceeds the document limits and directs the administrator to [database backup and restore](operations.md) to preserve the complete larger instance, including accounts, credentials, notifications, and history.

## Domain API

See [API and MCP access](agents.md) for authentication, scopes, rate limits, and retries. All paths below start with `/api`. Collections return `{ "items": [...] }`. Paged collections also include `hasMore` and `nextCursor`. Limits are integers from 1 to 100, with a default of 50. Treat opaque cursors as strings; changing search filters requires starting a new page sequence.

| Method and path            | Request or query                                                          | Response                                                                          |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /boards`              | `archived=true` or `deleted=true`; optional `limit`, opaque `cursor`      | `{items,hasMore,nextCursor}`; up to 100 boards per page in board order            |
| `POST /boards`             | `{name,prefix?,description?}`                                             | `201 {board}` with default statuses                                               |
| `GET /boards/:id`          |                                                                           | `{board,columns}`                                                                 |
| `PATCH /boards/:id`        | `{version,name?,description?,archived?,deleted?,beforeId?}`               | `{board}`                                                                         |
| `POST /boards/:id/restore` | `{version}`                                                               | `{board}`                                                                         |
| `GET /boards/:id/columns`  |                                                                           | `{items}` in status order                                                         |
| `POST /boards/:id/columns` | `{name,color?}`                                                           | `201 {column}`                                                                    |
| `PATCH /columns/:id`       | `{version,name?,color?,beforeId?}`                                        | `{column}`                                                                        |
| `DELETE /columns/:id`      | `{version,moveToColumnId?}`                                               | `{ok:true}`                                                                       |
| `GET /boards/:id/tasks`    | `q,columnId,assigneeId,priority,label,archived,deleted,sort,limit,cursor` | `{items,hasMore,nextCursor}`                                                      |
| `POST /boards/:id/tasks`   | Task fields below                                                         | `201 {task}`                                                                      |
| `GET /tasks/:id`           | `commentLimit,activityLimit,subtaskLimit`                                 | `{task,comments,activity,subtasks,parent,commentsPage,activityPage,subtasksPage}` |
| `GET /tasks/:id/subtasks`  | `limit,cursor`                                                            | `{items,hasMore,nextCursor}` with compact child metadata                          |
| `PATCH /tasks/:id`         | `{version,...taskFields,columnId?,beforeId?}`                             | `{task}`                                                                          |
| `POST /tasks/:id/move`     | `{version,columnId,beforeId?}`                                            | `{task}`                                                                          |
| `DELETE /tasks/:id`        | `{version}`                                                               | `{task}` with `deletedAt`                                                         |
| `POST /tasks/:id/restore`  | `{version}`                                                               | `{task}` with archive/deletion cleared                                            |
| `GET /tasks/:id/comments`  | `limit,cursor`                                                            | `{items,hasMore,nextCursor}`, oldest first                                        |
| `POST /tasks/:id/comments` | `{body,mentionIds?}`                                                      | `201 {comment}`                                                                   |
| `PATCH /comments/:id`      | `{version,body,mentionIds?}`                                              | `{comment}`                                                                       |
| `DELETE /comments/:id`     | `{version}`                                                               | `{ok:true}`                                                                       |
| `GET /tasks/:id/activity`  | `limit,cursor`                                                            | `{items,hasMore,nextCursor}`, newest first                                        |
| `GET /notifications`       | `unread=true,limit,cursor`                                                | `{items,unreadCount,hasMore,nextCursor}` for the signed-in user                   |
| `PATCH /notifications`     | `{ids:[UUID],read?}` or `{all:true,read?}`                                | `{ok:true,updated}`; `read` defaults to true                                      |
| `GET /audit`               | `limit,cursor`                                                            | `{items,hasMore,nextCursor}` for personal administrators                          |
| `GET /workspace`           |                                                                           | `{workspace}` for personal sessions                                               |
| `PATCH /workspace`         | `{name}`                                                                  | `{workspace}` for personal administrators                                         |
| `GET /export`              |                                                                           | Portable JSON, downloaded as `mill-export-DATE.json`                              |
| `POST /import`             | Portable JSON directly, without a wrapper                                 | `201 {imported:{boards,tasks,comments,members,boardIds}}`                         |

Task creation requires `title`. Optional fields are `columnId`, `description`, `assigneeId`, `priority`, `labels`, `dueDate`, `checklist`, `parentId`, and `archived`. A missing `columnId` uses the board's first status. PATCH accepts the same editable fields and requires the current `version`.

Task detail returns the complete selected task. Its parent and subtasks contain compact metadata rather than descriptions or checklists; fetch a related task by its ID to read its full contents. The `commentLimit`, `activityLimit`, and `subtaskLimit` query parameters each accept 0 through 100 and default to 100 for REST. MCP `get_task` defaults to no discussion preview and ten subtask summaries so long task descriptions remain readable within the tool response limit.

Each detail preview has a matching `commentsPage`, `activityPage`, or `subtasksPage` object with `hasMore` and `nextCursor`. Continue through the corresponding comments, activity, or subtasks endpoint using that cursor. A zero-length preview has a null cursor; start the corresponding collection without a cursor to load its first page.

Priorities are `none`, `low`, `medium`, `high`, and `urgent`. Status colors are `gray`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`, and `pink`. A checklist is an array of `{id,text,done}` objects with unique IDs. Null clears `assigneeId`, `dueDate`, or `parentId`.

The `beforeId` order field must reference an item in the destination list. Null moves the item to the end. Task moves and status reorder serialize on the owning board; workspace board reorder serializes on the workspace. Every changed row receives a new version. A credential restricted to selected boards cannot reorder workspace boards.

Task sorts are `position`, `title`, `priority`, `dueDate`, `createdAt`, and `updatedAt`. Creation and update sorts are newest first; the other sorts are ascending. Empty due dates sort last, and urgent priority sorts first. `assigneeId=unassigned` matches a null assignee. Deleted queries include deleted records regardless of their previous archive state.

Field limits are 100 characters for board names, 80 for status names, 300 for task titles, 100,000 for descriptions, 10,000 for comments, 20 labels of 40 characters each, and 100 checklist items of 500 characters each. A board supports up to 50 statuses. These limits also apply to API and MCP writes.

### Change a task safely

Read the task first, then submit its current version. Use a distinct idempotency key for each intended mutation so a network retry cannot duplicate a comment or task.

```sh
curl "$MILL_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $MILL_TOKEN"

curl -X PATCH "$MILL_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $MILL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: finish-eng-1" \
  --data '{"version":1,"title":"Review the release","priority":"high"}'
```

A stale version returns `409` with a plain error message. Read the latest task and reconcile the change before trying again with a new key. A forbidden board or operation returns `403`; an expired session or revoked credential returns `401`. Mixed notification selections fail as a whole when any selected ID is outside the caller's access.
