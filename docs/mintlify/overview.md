---
title: "Mill"
description: "A self-hosted task list for people and external agents."
---

Mill is a self-hosted task list for people and external agents. Run one web/API service and PostgreSQL on infrastructure you control. Ordinary task management needs no LLM key, external agent runtime, or paid service.

Create boards and track work through six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks have stable identifiers, Markdown descriptions, optional human assignees and Agent attribution, priorities, due dates, comments, and activity. Search, combine filters, sort, and page through each board's list.

People sign in with their own accounts. Administrators manage invitations and roles; assignment and mention notifications stay in the app. Mill does not currently send account or task email. Administrators share invitation links privately, and the server operator can issue a private recovery link when someone loses account access.

External clients have two paths. A person's API key uses their current permissions for REST. MCP uses OAuth with an eligible Agent created in the human interface, approved scopes, and optional board restrictions. Assigning an Agent to a task records responsibility; Mill does not run the Agent or contact a client automatically.

Start with [installation](/installation) and [your first board](/getting-started). Read [everyday work](/workflows) for the task model, [REST and MCP connections](/agents) for external clients, and [backup and recovery](/backup) before storing important work.

Mill is licensed under Apache 2.0. The proposed first public version is `v1.0.0-beta.1`; publication and public download locations depend on final release review.
