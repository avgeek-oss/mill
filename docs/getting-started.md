# Your first board

Install Mill using [the installation guide](installation.md), then open its URL. On a fresh database, Mill asks for a workspace name and the first administrator's account. Use a password you do not use on another service.

## Make a board

Choose the **plus button beside Boards** in the sidebar and give the board a short, recognizable name. Boards appear alphabetically. The **ellipsis button after New task** opens a menu with **Board settings** and, for a human administrator, **Delete board**. Settings let you rename the board or edit its description. Deletion opens a separate confirmation dialog.

Create a task, give it a clear title, and open its detail view. New tasks default to Todo. Add a Markdown description, human assignee, priority, due date, or checklist as needed. An optional Agent requires a human assignee who can access that Agent. Preview the description before saving. Task links keep their stable identifier when the title changes.

Use the status control to change Todo to In Progress, then In Review or Done. The six fixed choices are Backlog, Todo, In Progress, In Review, Done, and Won't Do. They work with a keyboard and touch. Leave a comment and reload to check the saved result.

Use the task list's search, status/assignee/priority filters, and sort controls to find work. Opening and saving a task preserves your list context. See [everyday workflows](workflows.md) for roles and permanent deletion. There are no Kanban lanes, custom statuses, labels, manual ordering, or task parents/subtasks. Older subtasks become independent tasks when you upgrade. Deleted tasks and boards cannot be restored in Mill.

## Invite your team

An administrator opens **People** in the sidebar, chooses **Invite a person**, and selects their role. Share the invitation link privately with the intended recipient; B1 does not deliver email. Invitations expire and create an account for the invited email address. Each person should use their own account.

Admins manage the team through **People** and **Team settings**. Members create and edit work. Viewers can read boards and tasks but cannot change them. API keys are personal and inherit their owner's current membership; approved boards and read/write scopes narrow their access. A key cannot administer the workspace.

## Secure your account

Open **Account security** to register a passkey, configure an authenticator, and save recovery codes. When both methods are configured, Mill prefers the passkey for a second-factor challenge and offers an authenticator or recovery-code fallback. Register your own device at the final HTTPS origin.

Review active sessions and revoke a device you no longer use. Select your name at the bottom of the sidebar to choose your time zone and notification preferences. If you lose access, use your saved recovery code or ask the server administrator to follow the local account-recovery procedure in [operations](operations.md). Full database recovery is separate from account recovery.

## Add an external agent

Open **Agents** and create a personal Agent, or ask an administrator to create a team Agent and grant you access. Agents are separate from the people invited to Mill. Then open **API keys**, select that existing Agent, choose the narrowest needed access, and copy the one-time token to the external client's secret store. Connect using [REST or MCP](agents.md). OAuth also requires selection of an eligible existing Agent; it cannot create one for you.

Setting an Agent on a task records responsibility alongside the human assignee. It does not launch the external client, run a job, or change the task by itself. Revoke an API key when the client no longer needs access.

Before relying on the board, take a [backup](backup.md) and practice restoring it into a separate installation.
