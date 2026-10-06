---
title: "Your first board"
description: "Set up a workspace and make your first task."
---

Install Mill using [the installation guide](/installation), then open its URL. On a fresh database, Mill asks for a workspace name and the first administrator's account. Use a password you do not use on another service.

## Make a board

Choose **Boards** under **Operate**, then use the **plus button** on the Boards page and give the board a short, recognizable name. You can add an optional description and task prefix when creating it. Boards appear as alphabetical cards with separate Backlog, To Do and In Progress task counts. Each count includes only its named status. Open a card to see its task table. The **ellipsis button after New task** opens a menu with **Board settings** and, for a human administrator, **Delete board**. Settings let you rename the board or edit its description. Deletion opens a separate confirmation dialog.

Create a task with a title, a Task or Bug type, an optional description, and an optional assignee; its detail page opens when you create it. New tasks default to Task type and Todo status. Change the type using the Type dropdown above Status on the task page. Add a Markdown description, assignee, priority, or due date as needed. Task links keep their stable identifier when the title or type changes.

Use the status control to change Todo to In Progress, then In Review or Done. The six fixed choices are Backlog, Todo, In Progress, In Review, Done, and Won't Do. They work with a keyboard and touch. Leave a comment and reload to check the saved result.

Search tasks above the table. Use the secondary panel for status, assignee and priority filters and for sort. On smaller screens, choose **Filters** to open the drawer to find work. Opening and saving a task preserves your list context. See [everyday workflows](/workflows) for roles and permanent deletion. There are no Kanban lanes, custom statuses, labels, manual ordering, or task parents/subtasks. Older subtasks become independent tasks when you upgrade. Deleted tasks and boards cannot be restored in Mill.

## Invite your team

An administrator opens **Team settings → Members**, chooses **Invite a person**, and selects their role. Share the invitation link privately with the intended recipient; Mill does not deliver email. Invitations expire and create an account for the invited email address. Each person should use their own account.

Admins manage the team through **Team settings → Members** and **General**. Members create and edit work. Viewers can read boards and tasks but cannot change them. Personal API keys inherit their owner's current role across all accessible boards. Only MCP OAuth has approved-board and read/write scope restrictions. A key cannot administer the workspace.

## Secure your account

Open **Account security** to register a passkey, configure an authenticator, and save recovery codes. When both methods are configured, Mill prefers the passkey for a second-factor challenge and offers an authenticator or recovery-code fallback. Register your own device at the final HTTPS origin.

Review active sessions and revoke a device you no longer use. Select your name at the bottom of the sidebar to choose your time zone and notification preferences. If you lose access, use your saved recovery code or ask the server administrator to follow the local account-recovery procedure in [operations](/operations). Full database recovery is separate from account recovery.

## Connect an external client

For REST, open **API keys**, choose **Create API key**, and enter a Name and Expiry: 30, 60, 90, or 365 days. Save the one-time token in the client's secret store. It uses your current permissions.

For MCP OAuth, enter Mill's `/mcp` URL in your client. Sign in, review the requesting client and scopes, and optionally choose approved boards before allowing access. The connection belongs to you and uses your current role within those approved permissions. Follow [the REST/MCP connection guide](/clients).

Revoke the key or connection when the client no longer needs access.

Before relying on the board, take a [backup](/backup) and practice restoring it into a separate installation.

## In the app

### Workspace setup

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/setup-light.png"
            alt="Workspace setup in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/setup-dark.png"
            alt="Workspace setup in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/setup-mobile-light.png"
            alt="Workspace setup in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/setup-mobile-dark.png"
            alt="Workspace setup in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### Boards

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/boards-light.png"
            alt="Boards in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/boards-dark.png"
            alt="Boards in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/boards-mobile-light.png"
            alt="Boards in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/boards-mobile-dark.png"
            alt="Boards in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### Create a task

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/create-task-light.png"
            alt="Create a task in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/create-task-dark.png"
            alt="Create a task in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/create-task-mobile-light.png"
            alt="Create a task in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/create-task-mobile-dark.png"
            alt="Create a task in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### An empty board

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/empty-board-light.png"
            alt="An empty board in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/empty-board-dark.png"
            alt="An empty board in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/empty-board-mobile-light.png"
            alt="An empty board in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/empty-board-mobile-dark.png"
            alt="An empty board in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
