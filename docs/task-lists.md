# Find work in a task list

Choose **Boards** under **Operate** to see the boards you can access. Cards are ordered alphabetically and show separate counts for Backlog, To Do and In Progress. These counts include every task in those statuses, even when a board list is filtered or paginated. Choose a card to open its task list.

## Search and filter

Type in **Search tasks** above the table to find a task by title, description, or stable task ID such as `ENG-17`. The search applies to the current board. Use **Filter tasks** in the secondary sidebar to combine **Assignee**, **Priority**, and **Status**. **Unassigned** finds tasks without an assignee. On a smaller screen, choose **Filters** beside the search field to open the same controls in the navigation drawer.

With no status selected, Done and Won't Do tasks remain in the list for 24 hours after entering that status. Afterward, choose **Done** or **Won't Do** in the Status filter to find all matching tasks, including older ones. Search alone does not bring older completed tasks back into the default list. A direct task link continues to work. Editing another property does not restart the 24-hour clock.

Choose **Clear filters** to remove search and filters and return to the default sort. If no task matches, Mill offers the same action in the empty state. A board with no tasks offers **Create task** to members and administrators.

## Sort and move between pages

In **Sort tasks**, choose **Newest first**, **Title**, **Recently updated**, **Due date**, **Priority**, or **Status**. Newest first is the default. Due date puts undated tasks last; Priority runs from Urgent to None; Status follows Backlog, Todo, In Progress, In Review, Done and Won't Do. Priority and Status show headings for the matching tasks on the current page.

Use the pagination controls below the table to move between pages or change the page size. Search, filters, sort, page and page size are saved in the URL. You can reload, use Back and Forward, or open a task and return to the same view. Changing a filter starts at page 1. If the underlying list changes while you page through it, reload that filtered view so pages are not mixed across revisions.

At widths of 640 pixels and above, **Task ID** has its own column. On narrower screens the ID appears beneath the task title. Task and Bug icons appear beside IDs in both layouts. The identifier remains stable when a task is renamed or changes type.

For task editing, comments and duplication, see [task details](task-details.md). For exact query parameters and pagination responses, see the [REST API](api.md#tasks).
