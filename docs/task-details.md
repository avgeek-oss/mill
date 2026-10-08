# Work on a task

Open a task from its board list. Its page shows the stable task ID, title, Markdown description, properties, comments and activity. **Back to board** returns to the search, filters, sort and page you were using.

## Create and edit

Choose **New task** on a board. Enter a title, select Task or Bug, and optionally add a description and human assignee. Creating the task opens its detail page. A new task defaults to Task type and Todo status. The full REST/MCP creation contract can also set status, priority, start date and due date.

Choose **Edit task** to change the title or Markdown description. The description is edited as plain text and rendered after saving. The **Type** property appears above **Status**; choose Task or Bug without changing the task ID. Set Status to Backlog, Todo, In Progress, In Review, Done or Won't Do. Add an assignee, priority, optional Start date and optional Due date. Dates are calendar dates and do not shift when you change time zones.

Each property saves independently. Selection changes save immediately; title and description save after a short pause or when you leave their field. If a save fails, your draft remains available. Choose **Retry** to submit it again or **Use saved value** to discard it. If the same field changed elsewhere, review the newer value before choosing **Keep my change**. Mill waits for pending saves before leaving the page.

## Duplicate a task

Open the task menu and choose **Duplicate task**. Mill opens a creation dialog with `[Copy] ` before the title and copies the description, type and priority. The copy starts in Backlog with no assignee, start date or due date. Review the fields and choose **Create task**; closing the dialog creates nothing. The copy gets a new ID and does not inherit comments or activity.

## Discuss and review changes

Use **Comments** to post Markdown text. To mention a teammate, type `@` and select them from the suggestions. A mention can create an in-app notification according to that person's preferences. You can delete your own comment; an administrator can moderate another person's comment. Comments cannot be edited after posting, and Mill has no file uploads. Use **Load more comments** for older discussion.

Switch to **Activity** to see task changes and comment actions in time order. Each entry identifies the responsible person or team key and distinguishes browser, API-key and OAuth changes where connection information is available. Activity is attached to a task; there is no workspace-wide audit page.

## Delete a task

Members and administrators can choose **Delete task** from the task menu. Confirming permanently removes the task, its comments, notifications and activity. Independent tasks remain. Mill has no trash or task restore view, so take a [full database backup](backup.md) before removing work you may need later.

For finding older Done and Won't Do tasks, see [task lists](task-lists.md). For fields and version conflicts in clients, see the [REST API](api.md#tasks).
