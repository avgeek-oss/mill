---
title: "Mill"
description: "A self-hosted task list for teams."
---

Mill is a self-hosted task list for teams and their clients. Run one web/API service and PostgreSQL on infrastructure you control. Ordinary task management needs no LLM key, external runtime, or paid service.

Create boards and track work through six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks have Task or Bug types, stable identifiers, Markdown descriptions, optional assignees, priorities, due dates, comments, and activity. Search, combine filters, sort, and page through each board's list.

People sign in with their own accounts. Administrators manage invitations and roles; assignment and mention notifications stay in the app. Mill does not currently send account or task email. Administrators share invitation links privately, and the server operator can issue a private recovery link when someone loses account access.

External clients have two paths. A person's API key uses their current permissions for REST. MCP uses OAuth with the approving person's current role, approved scopes, and optional board restrictions. Mill does not run external clients or launch jobs when a task is assigned.

Start with [installation](/installation) and [your first board](/getting-started). Read [everyday work](/workflows) for the task model, [REST and MCP connections](/clients) for external clients, and [backup and recovery](/backup) before storing important work.

Mill is licensed under Apache 2.0. The proposed first public version is `v1.0.0`; publication and public download locations depend on final release review.

## In the app

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

### Task list

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/board-light.png"
            alt="Task list in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/board-dark.png"
            alt="Task list in Mill."
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
            src="/assets/screenshots/release-v1/board-mobile-light.png"
            alt="Task list in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/board-mobile-dark.png"
            alt="Task list in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
