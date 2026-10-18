# Find work in a task list

Choose **Boards** under **Operate** to see the boards you can access. Cards are ordered alphabetically and show separate counts for Backlog, To Do and In Progress. These counts include every task in those statuses, even when a board list is filtered or paginated. Choose a card to open its task list.

<!-- screenshot:board -->

## Search and filter

Type in **Search tasks** above the table to find a task by title, description, acceptance criteria, or stable task ID such as `ENG-17`. The search applies to the current board. Choose **Filters** beside the search field to combine **Assignee**, **Priority**, and **Status** in a modal, then choose **Apply filters**. **Unassigned** finds tasks without an assignee. The button shows the number of active filters. **Cancel** closes the modal without applying changes. The board’s secondary sidebar groups **Tasks** under **Board**, **General** under **Settings**, and **Delete board** under **Danger zone** for administrators. **Tasks** returns to this list from a task or settings page.

With no status selected, Done and Won't Do tasks remain in the list for 24 hours after entering that status. Afterward, choose **Done** or **Won't Do** in the Status filter to find all matching tasks, including older ones. Search alone does not bring older completed tasks back into the default list. A direct task link continues to work. Editing another property does not restart the 24-hour clock.

In the filter modal, choose **Clear filters**, then **Apply filters** to remove the assignee, priority and status filters while keeping search and sort. If no task matches, **Clear filters** in the empty state also clears search and returns to the default sort. A board with no tasks offers **Create task** to members and administrators.

## Sort and move between pages

Choose the **Sort tasks** icon beside Filters to open a separate modal. Choose **Newest first**, **Title**, **Recently updated**, **Due date**, **Priority**, or **Status**, then **Apply sort**. Cancel leaves the current order unchanged. Priority is the default, from Urgent to None. Due date puts undated tasks last; Priority runs from Urgent to None; Status follows Backlog, Todo, In Progress, In Review, Done and Won't Do. Priority and Status show headings for the matching tasks on the current page.

Members and administrators can select tasks with the checkbox at the start of each row. The checkbox in a table heading selects all tasks in that table on the current page. Mixed selections show an indeterminate checkbox. Selection works with every sort order and resets when you change pages, search, filters, or sort.

A bottom action bar appears when tasks are selected. Choose **Status**, **Assignee**, **Priority**, **Start date**, or **Due date**, choose a value in the modal, then choose **Apply**. The Assignee picker searches active workspace members and offers **Unassigned** to remove assignments. Assignment notifications follow each person’s preferences. Date actions also offer **Clear dates**. Each action saves the entire selection together. If any selected task changed elsewhere, no tasks are updated; the list refreshes so you can review the current values and try again. Selected tasks remain selected for further actions while they still match the current view. **Clear selection** closes the bar. Read-only accounts do not show selection controls.

Use the pagination controls below the table to move between pages or change the page size. Search, filters, sort, page and page size are saved in the URL. You can reload, use Back and Forward, or open a task and return to the same view. Changing a filter starts at page 1. If the underlying list changes while you page through it, reload that filtered view so pages are not mixed across revisions.

At widths of 640 pixels and above, **Task ID** has its own column. On narrower screens the ID appears beneath the task title. Task and Bug icons appear beside IDs in both layouts. The identifier remains stable when a task is renamed or changes type.

For task editing, comments and duplication, see [task details](task-details.md). For exact query parameters and pagination responses, see the [REST API](api.md#tasks).
