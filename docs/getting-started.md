# Your first board

Install Mill using [the installation guide](installation.md), then open its URL. On a fresh database, Mill asks for a workspace name and the first administrator's account. Use a password you do not use on another service. Mill has no default account.

## Make a board and task

Choose **Boards** under **Operate**, then choose **Create Board**. Give the board a short name and, if useful, a description and task prefix. The prefix becomes part of task IDs such as `ENG-1` and cannot be changed later. Boards appear as alphabetical cards with separate Backlog, To Do and In Progress task counts. Open the card to see its task table.

Choose **New task**. Enter a title, select Task or Bug, and optionally add a description and assignee. The task page opens after creation. New tasks default to Task type and Todo status. On the task page, use **Type** above **Status** and add a priority, start date, or due date as needed. Use **Edit task** for the title and Markdown description. Each property saves independently; the task ID stays the same when its title or type changes.

Change Todo to In Progress, then In Review or Done. The six fixed statuses are Backlog, Todo, In Progress, In Review, Done, and Won't Do. Leave a comment and reload to check that it was saved. The task page records changes in **Activity**.

Search tasks above the board table. Use the secondary panel for status, assignee and priority filters and for sort. On smaller screens, choose **Filters** to open the drawer. Opening and saving a task preserves your list context. Done and Won't Do tasks leave the default list after 24 hours; choose that status in the filter to find older ones. See [everyday workflows](workflows.md) for duplication, comments, notifications, roles, and deletion. Deleted tasks and boards can be recovered only from a full database backup.

The menu beside **New task** has **Board settings** and, for an administrator, **Delete board**. Settings let you rename the board or edit its description. Board deletion requires confirmation and permanently removes its tasks and discussion.

## Invite your team

An administrator opens **Team Settings → Members**, chooses **Create invitation**, enters the person's email address, and selects a role. If the installation has SMTP configured, Mill queues an invitation email and the recipient verifies a code sent to that address. Otherwise, copy the invitation link and share it privately with the intended person. Invitations expire after seven days. Each person should use their own account.

Admins manage the team through **Team Settings → Members** and **General**. Members create and edit work. Viewers can read boards and tasks but cannot change them. Personal API keys are limited by explicit grants and their owner's active current role. Admins can create team keys with stored grants. API keys and OAuth can access MCP, while identity and team security management remain browser-only.

## Secure your account

Open **Account Settings → Passkeys** to register a passkey and save its recovery codes. Once registered, password sign-in also requires a passkey; a single-use recovery code can restore ordinary account access after password verification. Register your own device at the final HTTPS origin.

Review **Account Settings → Sessions** and revoke a device you no longer use. In **Preferences**, choose your time zone, date and time formats, and in-app notification preferences. If you lose access, use your saved recovery code, request a password reset when SMTP is configured, or ask the server operator to follow the [account-recovery procedure](operations.md#account-recovery). Recovery-code access cannot approve security changes. Full database recovery is separate from account recovery.

## Connect an external client

For REST or MCP, open **Account Settings → API Keys**, choose **Create API key**, and enter a Name, Permissions (Read-only, Edit, or Administrative permissions), and Expires after (30 days, 90 days, 1 year, or Never). Save the one-time token in the client's secret store. Admins create team keys under **Team Settings → Team API Keys**.

For MCP OAuth, enter Mill's `/mcp` URL in your client. Sign in, review the requesting client and scopes, and optionally choose approved boards before allowing access. The connection belongs to you and uses your current role within those approved permissions. Follow [the REST/MCP connection guide](clients.md).

Revoke the key or connection when the client no longer needs access.

Before relying on the board, take a [backup](backup.md) and practice restoring it into a separate installation.
