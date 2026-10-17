# Work on a task

Open a task from its board list. Its page shows the stable task ID, title, Markdown description, acceptance criteria, properties, comments and activity. **Back to board** returns to the search, filters, sort and page you were using.

## Create and edit

Choose **New task** on a board. Enter a title and optionally add a Markdown description and acceptance criteria. Choose Type, Assignee, Priority and Status in one row on desktop; these controls stack on mobile. Creating the task opens its detail page. A new task defaults to Task type and Todo status. REST/MCP creation can also set start date and due date.

Choose **Edit task** to change the title, Markdown description or acceptance criteria. Description and acceptance criteria are separate plain-text fields with Markdown rendering after saving. Each allows up to 100,000 characters. The **Type** property appears above **Status**; choose Task or Bug without changing the task ID. Set Status to Backlog, Todo, In Progress, In Review, Done or Won't Do. Add an assignee, priority, optional Start date and optional Due date. Dates are calendar dates and do not shift when you change time zones.

Each property saves independently. Selection changes save immediately; title, description and acceptance criteria save after a short pause or when you leave their field. If a save fails, your draft remains available. Choose **Retry** to submit it again or **Use saved value** to discard it. If the same field changed elsewhere, review the newer value before choosing **Keep my change**. Mill waits for pending saves before leaving the page.

## Duplicate a task

Open the task menu and choose **Duplicate task**. Mill opens a creation dialog with `[Copy] ` before the title and copies the description, acceptance criteria, type and priority. The copy starts in Backlog with no assignee, start date or due date. Review the fields and choose **Create task**; closing the dialog creates nothing. The copy gets a new ID and does not inherit comments, attachments or activity.

## Discuss and review changes

Use **Comments** to post Markdown text. To mention a teammate, type `@` and select them from the suggestions. A mention can create an in-app notification according to that person's preferences. You can delete your own comment; an administrator can moderate another person's comment. Comments cannot be edited after posting. Use **Load more comments** for older discussion.

Leaving a task with an unsent comment or reply opens **Unsaved changes**. Choose **Stay** to keep your draft, or **Leave without saving** to continue to the selected page and discard it. Closing the dialog also keeps the draft. Pending task saves still need to succeed before navigation can continue.

Choose the dashed **Reply** link below a comment to reply inline. Replies appear beneath their parent with indented, curved thread lines and no additional avatar. You can reply to a reply, up to three reply levels beneath the original comment. At the third level, the Reply action is no longer shown. Use **Cmd+Enter** or **Ctrl+Enter** to send; **Cancel reply** keeps the text in the main comment editor.

Threads start collapsed behind **Show replies (count)**. Expand each level separately, or choose **Hide replies (count)** to collapse it again. The count shows direct replies. Posting a reply opens its thread automatically. Deleting a comment preserves its replies and moves them up one level.

Switch to **Activity** to see task changes and attachment actions in time order. Comment and reply actions are not recorded in Activity. Each entry identifies the responsible person or team key and distinguishes browser, API-key and OAuth changes where connection information is available. Activity is attached to a task; there is no workspace-wide audit page.

## Attach files

When your operator configures private S3 storage, uploaded images and PDFs appear below the description and acceptance criteria. Choose the secondary **Upload attachment** button there to open a dialog with the shared file chooser and drop area. You can also drag a file onto the task page to open the dialog and start uploading. Comments and Activity remain tabs. Members and administrators can upload or delete attachments; viewers can read and download them. See [task attachments](task-attachments.md) for limits and supported formats.

## Delete a task

Members and administrators can choose **Delete task** from the task menu. Confirming permanently removes the task, its comments, attachments, notifications and activity. Independent tasks remain. Mill has no trash or task restore view, so take a [full database backup](backup.md) before removing work you may need later.

For finding older Done and Won't Do tasks, see [task lists](task-lists.md). For fields and version conflicts in clients, see the [REST API](api.md#tasks).
