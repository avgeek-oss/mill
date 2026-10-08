# Notifications

Mill creates in-app notifications when a teammate assigns a task to you or mentions you in a comment. Your own actions do not notify you. Task notifications are not sent by email. Everyone with an active account can manage their own notification preferences and read state.

## Read and clear notifications

Choose the bell in the header to open your notifications. Unread items are marked in the list and reflected in the bell count. Choose an item to open its task; opening an unread item marks it as read. Choose **Mark all read** to clear the unread state of the visible account's notifications. Use **Load older notifications** when the list has more items.

If opening an item or marking it read fails, Mill keeps the action available so you can retry. If its task was deleted, the old task link cannot reopen the task. A notification does not copy the task's content or serve as a backup.

## Choose what you receive

Open **Account Settings → Preferences**. Turn assignment or mention notifications on or off independently. These preferences affect future notifications; changing them does not remove earlier items. Your time zone, date format and time format also control how timestamps appear in Mill, while task start and due dates remain calendar dates.

Mention a teammate by typing `@` in a task comment and choosing them from the suggestions. Assignments and mentions made through the REST API or MCP follow the same notification preferences. API and MCP notifications remain within the owning person's account and, for board-restricted OAuth connections, their approved boards.

For the task discussion workflow, see [task details](task-details.md). For notification endpoints and pagination, see the [REST API](api.md#notifications-and-settings).
