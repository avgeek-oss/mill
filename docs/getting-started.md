# Your first board

Install Mill using [the installation guide](installation.md), then open its URL. On a fresh database, Mill asks for a workspace name and the first administrator's account. Use a password you do not use on another service.

## Make a board

Create a board with a short, recognizable name. New boards start with Backlog, In progress, and Done. Open board settings when you need to rename statuses, change their order, or archive the board.

Create a task in Backlog, give it a clear title, and open its detail view. Add a Markdown description, assignment, priority, labels, due date, or checklist as needed. Preview the description before saving. Task links keep their stable identifier even when the title changes.

Move the task to In progress using its status control. This works with a keyboard or touch and is an alternative to dragging. Leave a comment, then move it to Done. Reload the page to see the persisted result.

Switch between Kanban and list view to find the layout that suits the work. Combine search with status, assignee, priority, and label filters. Opening and saving a task preserves the board context. See [everyday workflows](workflows.md) for archive, restore, and permission behavior.

## Invite your team

An administrator opens **People** in the sidebar, chooses **Invite a person**, and selects their role. Share the invitation link privately with the intended recipient; B1 does not deliver email. Invitations expire and create an account for the invited email address. Each person should use their own account.

Admins manage the workspace and team. Members create and edit work. Viewers can read boards and tasks but cannot change them. Agent credentials inherit their owner's current membership and can be narrowed to selected boards and read/write scopes. An agent credential cannot administer the workspace.

## Secure your account

Open **Account security** to register a passkey, configure an authenticator, and save recovery codes. When both methods are configured, Mill prefers the passkey for a second-factor challenge and offers an authenticator or recovery-code fallback. Register your own device at the final HTTPS origin.

Review active sessions and revoke a device you no longer use. Select your name at the bottom of the sidebar to choose your time zone and notification preferences. If you lose access, use your saved recovery code or ask the server administrator to follow the local account-recovery procedure in [operations](operations.md). Full database recovery is separate from account recovery.

## Add an external agent

Open **Agent access**, create a credential with the narrowest needed access, copy its one-time token to the agent's secret store, and connect using [REST or MCP](agents.md). Activity distinguishes agent actions from human actions. Revoke the credential when the agent no longer needs access.

Before relying on the board, take a [backup](backup.md) and practice restoring it into a separate installation.
