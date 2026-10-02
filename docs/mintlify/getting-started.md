---
title: "Your first board"
description: "Set up a workspace and make your first task."
---

Install Mill using [the installation guide](/installation), then open its URL. On a fresh database, Mill asks for a workspace name and the first administrator's account. Use a password you do not use on another service.

## Make a board

Choose the **plus button beside Boards** in the sidebar and give the board a short, recognizable name. Boards appear alphabetically. The **ellipsis button after New task** opens a menu with **Board settings** and, for a human administrator, **Delete board**. Settings let you rename the board or edit its description. Deletion opens a separate confirmation dialog.

Create a task with a title, optional description, and optional human assignee; its detail page opens when you create it. New tasks default to Todo. Add a Markdown description, human assignee, Agent, priority, or due date as needed. You can assign an Agent without assigning a person. Task links keep their stable identifier when the title changes.

Use the status control to change Todo to In Progress, then In Review or Done. The six fixed choices are Backlog, Todo, In Progress, In Review, Done, and Won't Do. They work with a keyboard and touch. Leave a comment and reload to check the saved result.

Use the task list's search, status/assignee/Agent/priority filters, and sort controls to find work. Opening and saving a task preserves your list context. See [everyday workflows](/workflows) for roles and permanent deletion. There are no Kanban lanes, custom statuses, labels, manual ordering, or task parents/subtasks. Older subtasks become independent tasks when you upgrade. Deleted tasks and boards cannot be restored in Mill.

## Invite your team

An administrator opens **People** in the sidebar, chooses **Invite a person**, and selects their role. Share the invitation link privately with the intended recipient; B1 does not deliver email. Invitations expire and create an account for the invited email address. Each person should use their own account.

Admins manage the team through **People** and **Team settings**. Members create and edit work. Viewers can read boards and tasks but cannot change them. Personal API keys inherit their owner's current role across all accessible boards. Only MCP OAuth has approved-board and read/write scope restrictions. A key cannot administer the workspace.

## Secure your account

Open **Account security** to register a passkey, configure an authenticator, and save recovery codes. When both methods are configured, Mill prefers the passkey for a second-factor challenge and offers an authenticator or recovery-code fallback. Register your own device at the final HTTPS origin.

Review active sessions and revoke a device you no longer use. Select your name at the bottom of the sidebar to choose your time zone and notification preferences. If you lose access, use your saved recovery code or ask the server administrator to follow the local account-recovery procedure in [operations](/operations). Full database recovery is separate from account recovery.

## Add an external agent

For REST, open **API keys**, choose **Create API key**, and enter a Name and Expiry: 30, 60, 90, or 365 days. Save the one-time token in the client's secret store. It uses your current permissions and needs no Agent.

For MCP OAuth, first open **Agents** and create a personal Agent, or ask an administrator for access to a team Agent. Team access can cover selected people or all current and future members. Agents are separate from the people invited to Mill. OAuth requires selection of an eligible existing Agent and cannot create one for you. Follow [the REST/MCP connection guide](/agents).

Setting an Agent on a task records responsibility separately from an optional human assignee. It does not launch the external client, run a job, or change the task by itself. Revoke an API key when the client no longer needs access.

Before relying on the board, take a [backup](/backup) and practice restoring it into a separate installation.
