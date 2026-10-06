# Mill

Mill is a self-hosted task list for teams and their clients. Run one web/API service and PostgreSQL on infrastructure you control. Ordinary task management needs no LLM key, external runtime, or paid service.

Create boards and track work through six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks have Task or Bug types, stable identifiers, Markdown descriptions, optional assignees, priorities, due dates, comments, and activity. Search, combine filters, sort, and page through each board's list.

People sign in with their own accounts. Administrators manage invitations and roles; assignment and mention notifications stay in the app. Mill does not currently send account or task email. Administrators share invitation links privately, and the server operator can issue a private recovery link when someone loses account access.

External clients have two paths. A person's API key uses their current permissions for REST. MCP uses OAuth with the approving person's current role, approved scopes, and optional board restrictions. Mill does not run external clients or launch jobs when a task is assigned.

Start with [installation](installation.md) and [your first board](getting-started.md). Read [everyday work](workflows.md) for the task model, [REST and MCP connections](clients.md) for external clients, and [backup and recovery](backup.md) before storing important work.

Mill is licensed under Apache 2.0. The proposed first public version is `v1.0.0`; publication and public download locations depend on final release review.
