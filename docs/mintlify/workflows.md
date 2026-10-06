---
title: "Everyday work"
description: "Boards, tasks, roles, comments, and notifications."
---

Mill opens on **Boards** under **Operate**. The page lists every accessible board as an alphabetical card with separate Backlog, To Do and In Progress task counts. Each count includes only its named status. These counts cover all tasks in the board. Choose a card to open its task table, or use the page’s **plus button** to create a board with a short name and a prefix such as `ENG`. Search tasks above the table. The board’s secondary sidebar contains filters and sort; on smaller screens, choose **Filters** to open the navigation drawer. The header breadcrumb shows Boards, the selected board, and the task identifier when a task is open. The Boards link opens the overview. Use the board dropdown to search and switch boards, or the board link to return to the table with your URL filters intact. Workspace and Account breadcrumbs provide dropdowns for their available settings pages.

A board's prefix is permanent. Its tasks receive identifiers such as `ENG-1`; editing a title or changing a status keeps that identifier. Share the task's link with teammates.

## Create and update a task

Open a board and choose New task. Enter a title, choose Task or Bug in Type, optionally add a description and choose an assignee, then create the task. Its dedicated page opens immediately. A new task defaults to Task type and Todo status; status, priority and due date can be added on the page. REST and MCP clients can provide type and those fields during creation.

Change Type using the dropdown above Status on the task page. Task uses the theme-colored task icon and Bug uses a red bug icon. The table shows this icon before the task identifier, in its own Task ID column on desktop and beneath the title on mobile. Changing type keeps the task's identifier and records the change in Activity. Existing tasks start with Task type.

Descriptions and comments support Markdown. Edit descriptions in a plain textarea; the task page renders the saved Markdown. Links must use a safe web protocol; Mill does not accept file uploads.

Due dates are calendar dates such as `2026-10-04`; changing time zones does not shift them. Your profile time zone controls displayed activity times.

Each task field saves independently. Selections save immediately. Use Edit task to open a modal for title and description; those fields save after a short typing pause or when you leave the field. Closing the modal waits for pending saves. There is no whole-task Save button. Failures stay beside the field with Retry and Use saved value. If the same field changed elsewhere, Keep my change explicitly saves your draft against the latest version. Unrelated updates can be reconciled automatically. Navigation waits for pending saves and retains failed drafts.

Choose **Duplicate task** from a task's ellipsis menu to open a creation modal. The title starts with `[Copy] `; description, type and priority are copied, Status starts at Backlog, and Assignee is empty. Review or change the fields, then choose **Create task** to confirm. Cancelling creates nothing. The copy receives a new identifier and has no due date, comments or previous activity; the original task remains unchanged.

Start date appears before Due date in task properties. Both are optional calendar dates and save independently. Use the calendar or date segments to choose a date, or Clear date to remove it. Duplicating a task leaves both dates empty.

## Find work

Use Search tasks above the table to match titles, descriptions, and task identifiers. Combine status, assignee and priority filters. Choose Unassigned for tasks without an assignee.

Done and Won't Do tasks appear in the default list for one day after entering that status. After that, choose Done or Won't Do in the Status dropdown to find them. Editing other fields does not restart the day; reopening a task makes it visible again. This also applies when searching without a status filter. Direct task links continue to work.

Sort by title, priority, status, due date, creation time, or latest update. Priority and status sorting split the current page into named groups. Creation time is the default, newest first. Pagination applies to the entire filtered result, with one footer across the groups. Search, filters, sort, page and page size are stored in the URL, so reload and task return links preserve your view. Changing filters returns to page 1. If work changes between pages, Mill asks you to reload the current filtered list rather than combining pages from different revisions. Existing rows stay visible while the replacement list loads.

Boards are alphabetical and task order comes from the selected sort. There are no drag-and-drop lanes, custom statuses, labels, manual positions, or task parent/subtask controls. Existing subtasks from an older installation remain independent tasks after upgrade.

## Comments and notifications

Keep decisions next to the task in a comment. Mention a teammate using `@their-email@example.com`; API clients can use active member UUIDs in `mentionIds`.

Assignments and mentions create in-app notifications for the affected teammate, subject to their preferences. Your own actions do not notify you. Open the header bell for a single scrolling list with unread indicators. Opening a notification marks it as read; the popover header also offers Mark all read. Task notifications are delivered in the app.

Comments cannot be edited after posting. You can delete your own comments. A human administrator can remove another person's comment. An OAuth client can delete its connection owner's comments within the approved boards and write scope.

Task activity shows changes and the person responsible for each action. Workspace-wide audit history is excluded from v1.

## Delete work permanently

Delete a task from its detail view when it is no longer needed. Confirming permanently removes that task, its comments, notifications, and task activity. Other independent tasks remain. Members and administrators can delete tasks; viewers cannot.

A human administrator opens the ellipsis menu after New task and chooses Delete board. The separate confirmation dialog covers every task and its associated discussion in that board. Board settings in the same menu contains the board's name and description. After deletion, Mill removes the board from navigation and returns to the Boards overview.

There is no archive, trash, or restore view. Save a [full database backup](/backup) before deleting work you may need later. There is no portable export/import feature. Task numbers are not reused within an existing board.

## Permissions

| Action                                          | Viewer | Member | Administrator      |
| ----------------------------------------------- | ------ | ------ | ------------------ |
| Read boards, tasks, comments, and activity      | Yes    | Yes    | Yes                |
| Manage own notifications, profile, and security | Yes    | Yes    | Yes                |
| Create/change boards, tasks, and own comments   | No     | Yes    | Yes                |
| Permanently delete tasks                        | No     | Yes    | Yes                |
| Moderate another person's comments              | No     | No     | Yes, human session |
| Permanently delete a board                      | No     | No     | Yes, human session |
| Manage membership and Team settings             | No     | No     | Yes, human session |

## People and API keys

People are accounts that sign in to Mill. Manage invitations and roles in People or **Team settings → Members**, and the workspace name in **Team settings → General**.

Personal API keys belong to the person who creates them. Open **Account settings → API Keys** and choose Name and Expiry: 30, 60, 90, or 365 days. They use the owner's current permissions across all accessible boards. Another administrator does not own your keys.

MCP OAuth connects a client to the person who approves it. Review the requested read or read/write scopes, and optionally limit the connection to selected boards. Every active member can read workspace boards. Personal API keys use that owner's role without OAuth's scope and board restrictions. Role changes, removal, or revocation prevent a waiting mutation from committing without current authority.

## Work through the API

See [the REST reference](/rest-reference) for fields, fixed status values, filters, and pagination, and [Connect a client](/clients) for REST/MCP authentication. Read the latest task, then use its current version and one idempotency key per intended mutation. Keep that same key for an uncertain network retry.

```sh
curl "$MILL_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $MILL_TOKEN"

curl -X PATCH "$MILL_URL/api/tasks/$TASK_ID" \
  -H "Authorization: Bearer $MILL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: finish-eng-1' \
  --data '{"version":1,"status":"done","priority":"high"}'
```

A stale version returns `409`. Reload and reconcile before starting a new mutation. A forbidden operation returns `403`; expired/revoked authentication returns `401`. Mixed notification selections fail as a whole if any selected ID is inaccessible.

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

### Task details and comments

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/task-light.png"
            alt="Task details and comments in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/task-dark.png"
            alt="Task details and comments in Mill."
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
            src="/assets/screenshots/release-v1/task-mobile-light.png"
            alt="Task details and comments in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/task-mobile-dark.png"
            alt="Task details and comments in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### Task activity

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/task-activity-light.png"
            alt="Task activity in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/task-activity-dark.png"
            alt="Task activity in Mill."
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
            src="/assets/screenshots/release-v1/task-activity-mobile-light.png"
            alt="Task activity in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/task-activity-mobile-dark.png"
            alt="Task activity in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### Board settings

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/board-settings-light.png"
            alt="Board settings in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/board-settings-dark.png"
            alt="Board settings in Mill."
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
            src="/assets/screenshots/release-v1/board-settings-mobile-light.png"
            alt="Board settings in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/board-settings-mobile-dark.png"
            alt="Board settings in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### People

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/people-light.png"
            alt="People in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/people-dark.png"
            alt="People in Mill."
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
            src="/assets/screenshots/release-v1/people-mobile-light.png"
            alt="People in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/people-mobile-dark.png"
            alt="People in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### Team settings: General

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/team-light.png"
            alt="Team settings: General in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/team-dark.png"
            alt="Team settings: General in Mill."
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
            src="/assets/screenshots/release-v1/team-mobile-light.png"
            alt="Team settings: General in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/team-mobile-dark.png"
            alt="Team settings: General in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

### Notifications

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/notifications-light.png"
            alt="Notifications in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/notifications-dark.png"
            alt="Notifications in Mill."
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
            src="/assets/screenshots/release-v1/notifications-mobile-light.png"
            alt="Notifications in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/notifications-mobile-dark.png"
            alt="Notifications in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
