# Your first board

Install Mill using [the installation guide](installation.md), then open its URL. On a fresh database, Mill asks for a workspace name and the first administrator's account. Use a password you do not use on another service.

## Make a board

Choose **Create Project** at the end of the sidebar's **Boards** list and give the board a short, recognizable name. Boards appear alphabetically. Board settings let you rename the board, edit its description, or permanently delete it. Only a human administrator can delete a board.

Create a task, give it a clear title, and open its detail view. New tasks default to Todo. Add a Markdown description, assignment, priority, due date, or checklist as needed. Preview the description before saving. Task links keep their stable identifier when the title changes.

Use the status control to change Todo to In Progress, then In Review or Done. The six fixed choices are Backlog, Todo, In Progress, In Review, Done, and Won't Do. They work with a keyboard and touch. Leave a comment and reload to check the saved result.

Use the task list's search, status/assignee/priority filters, and sort controls to find work. Opening and saving a task preserves your list context. See [everyday workflows](workflows.md) for roles and permanent deletion. There are no Kanban lanes, custom statuses, labels, manual ordering, or task parents/subtasks. Older subtasks become independent tasks when you upgrade. Deleted tasks and boards cannot be restored in Mill.

## Invite your team

An administrator opens **People** in the sidebar, chooses **Invite a person**, and selects their role. Share the invitation link privately with the intended recipient; B1 does not deliver email. Invitations expire and create an account for the invited email address. Each person should use their own account.

Admins manage the workspace and team. Members create and edit work. Viewers can read boards and tasks but cannot change them. Agent credentials inherit their owner's current membership and can be narrowed to selected boards and read/write scopes. An agent credential cannot administer the workspace.

## Secure your account

Open **Account security** to register a passkey, configure an authenticator, and save recovery codes. When both methods are configured, Mill prefers the passkey for a second-factor challenge and offers an authenticator or recovery-code fallback. Register your own device at the final HTTPS origin.

Review active sessions and revoke a device you no longer use. Select your name at the bottom of the sidebar to choose your time zone and notification preferences. If you lose access, use your saved recovery code or ask the server administrator to follow the local account-recovery procedure in [operations](operations.md). Full database recovery is separate from account recovery.

## Add an external agent

Open **Agent access**, create a credential with the narrowest needed access, copy its one-time token to the agent's secret store, and connect using [REST or MCP](agents.md). Activity distinguishes agent actions from human actions. Revoke the credential when the agent no longer needs access.

Before relying on the board, take a [backup](backup.md) and practice restoring it into a separate installation.
