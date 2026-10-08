# Mill

Mill is a self-hosted task list for teams and their clients. Run one web/API service and PostgreSQL on infrastructure you control. Ordinary task management needs no LLM key, external runtime, or paid service.

Create boards and track work through six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks have Task or Bug types, stable identifiers, Markdown descriptions, optional human assignees, priorities, start and due dates, comments, and activity. Search, combine filters, sort, and page through each board's list. Completed tasks leave the default list after 24 hours but remain available through an explicit status filter or direct link.

People sign in with their own accounts. Administrators manage invitations and roles; assignment and mention notifications stay in the app. Optional SMTP enables invitation, verification, and password-reset email. Without SMTP, administrators share invitation links privately and the server operator can issue a private account-recovery link. Mill does not send task notifications by email.

External clients can use personal or team API keys with explicit grants for REST and MCP. Personal keys remain bounded by the owner's current active role; team keys use a stored team policy. MCP also uses OAuth with the approving person's current role, approved scopes, and optional board restrictions. Mill does not run external clients or launch jobs when a task is assigned.

Start with [installation](installation.md) and [your first board](getting-started.md). Read [everyday work](workflows.md) for the task model, [accounts and team access](authentication.md) for invitations and passkeys, [REST and MCP connections](clients.md) for external clients, and [backup and recovery](backup.md) before storing important work.

Mill is licensed under Apache 2.0. See [release notes](release-notes.md) for the proposed version and [installation](installation.md) for the available installation methods.
