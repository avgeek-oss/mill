import { QueryFeedback } from "./query-feedback.js";
import { ErrorPage } from "./error-page.js";
import { RouteLink as Link } from "@avgeek-oss/design-system/navigation/route-link";
import {
  Add01Icon,
  ClipboardListIcon,
  GridViewIcon,
  TableIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@avgeek-oss/design-system/buttons/toggle-button";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import { UserAvatar as Avatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import {
  Button,
  EmptyState,
  QueryLoading,
  TooltipText,
  TypographyHeading,
  Widget,
} from "@mill/web-design-system";
import type { BoardSummary } from "../../../packages/contracts/src/index.js";
import type { User } from "./api.js";
import { RelativeDateTime } from "./relative-date-time.js";
import { PageHeading } from "./page-heading.js";
import { StatusIcon } from "./task-status.js";

type BoardLayout = "grid" | "table";

function BoardCount({
  count,
  status,
}: {
  count: number;
  status: "backlog" | "todo" | "in_progress";
}) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium tabular-nums text-foreground">
      <StatusIcon status={status} size={16} />
      {count.toLocaleString()}
    </span>
  );
}

export function BoardsPage({
  boards,
  user,
  layout,
  onLayoutChange,
  pending,
  error,
  canCreate,
  onCreate,
  onRetry,
}: {
  boards: BoardSummary[];
  user: User;
  layout: BoardLayout;
  onLayoutChange: (layout: BoardLayout) => void;
  pending: boolean;
  error: string;
  canCreate: boolean;
  onCreate: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="grid min-w-0" aria-busy={pending}>
      <PageHeading
        title="Boards"
        icon={<HugeiconsIcon icon={ClipboardListIcon} size={24} aria-hidden />}
        actions={
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <ToggleButtonGroup
              aria-label="Boards view"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[layout]}
              onSelectionChange={(keys) => {
                if (keys.has("grid")) onLayoutChange("grid");
                else if (keys.has("table")) onLayoutChange("table");
              }}
              className="shrink-0"
            >
              <Tooltip>
                <ToggleButton
                  id="grid"
                  isIconOnly
                  aria-label="Grid view"
                  className="size-9 min-w-9"
                >
                  <HugeiconsIcon
                    icon={GridViewIcon}
                    size={16}
                    className="size-4"
                    aria-hidden
                  />
                </ToggleButton>
                <Tooltip.Content>Grid view</Tooltip.Content>
              </Tooltip>
              <Tooltip>
                <ToggleButton
                  id="table"
                  isIconOnly
                  aria-label="Table view"
                  className="size-9 min-w-9"
                >
                  <HugeiconsIcon
                    icon={TableIcon}
                    size={16}
                    className="size-4"
                    aria-hidden
                  />
                </ToggleButton>
                <Tooltip.Content>Table view</Tooltip.Content>
              </Tooltip>
            </ToggleButtonGroup>
            {canCreate && (
              <Button onPress={onCreate}>
                <HugeiconsIcon icon={Add01Icon} aria-hidden />
                Create Board
              </Button>
            )}
          </div>
        }
      />
      {error && !boards.length ? (
        <ErrorPage
          code="500"
          title="Boards unavailable"
          description={error}
          pending={pending}
          showBoards={false}
          onRetry={onRetry}
        />
      ) : error ? (
        <QueryFeedback
          message={error}
          onRetry={() => {
            if (!pending) onRetry();
          }}
        />
      ) : null}
      {boards.length && layout === "table" ? (
        <ResourceTable
          ariaLabel="Boards"
          items={boards}
          getRowKey={(board) => board.id}
          tableClassName="min-w-4xl"
          columns={[
            {
              key: "prefix",
              header: "Prefix",
              isRowHeader: false,
              headerClassName: "w-24 whitespace-nowrap",
              cell: (board) => (
                <span className="whitespace-nowrap font-mono text-sm text-muted">
                  {board.prefix}
                </span>
              ),
            },
            {
              key: "name",
              header: "Board",
              isRowHeader: true,
              className: "min-w-48",
              cell: (board) => (
                <Link
                  href={`/boards/${board.id}`}
                  className="block min-w-0 rounded-lg hover:underline"
                >
                  <ResourceName
                    name={board.name}
                    description={board.description}
                  />
                </Link>
              ),
            },
            {
              key: "backlog",
              header: "Backlog",
              headerClassName: "whitespace-nowrap",
              cell: (board) => (
                <BoardCount count={board.backlogCount} status="backlog" />
              ),
            },
            {
              key: "todo",
              header: "To Do",
              headerClassName: "whitespace-nowrap",
              cell: (board) => (
                <BoardCount count={board.todoCount} status="todo" />
              ),
            },
            {
              key: "in_progress",
              header: "In Progress",
              headerClassName: "whitespace-nowrap",
              cell: (board) => (
                <BoardCount
                  count={board.inProgressCount}
                  status="in_progress"
                />
              ),
            },
            {
              key: "createdBy",
              header: "Created by",
              headerClassName: "whitespace-nowrap",
              className: "min-w-40",
              cell: (board) =>
                board.createdBy ? (
                  <span className="flex min-w-0 max-w-48 items-center gap-2">
                    <Avatar
                      name={board.createdBy.name}
                      email={board.createdBy.email ?? ""}
                      size="sm"
                      className="size-7 shrink-0 rounded-full [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:text-muted"
                    />
                    <TooltipText
                      className="block min-w-0 flex-1 truncate"
                      tooltip={board.createdBy.name}
                    >
                      {board.createdBy.name}
                    </TooltipText>
                  </span>
                ) : (
                  <span className="text-muted">Unknown</span>
                ),
            },
            {
              key: "lastActivityAt",
              header: "Last activity",
              headerClassName: "whitespace-nowrap",
              className: "min-w-48",
              cell: (board) => (
                <RelativeDateTime
                  value={board.lastActivityAt}
                  timeZone={user.timeZone}
                  dateFormat={user.dateFormat}
                  timeFormat={user.timeFormat}
                  label="Last activity"
                />
              ),
            },
          ]}
          emptyTitle="Your work starts here"
          emptyDescription="Organize your team’s work with boards and tasks."
        />
      ) : boards.length ? (
        <ul
          aria-label="Boards"
          className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {boards.map((board) => (
            <li key={board.id} className="min-w-0">
              <Link
                href={`/boards/${board.id}`}
                aria-label={board.name}
                className="board-card block h-full w-full min-w-0 rounded-2xl no-underline outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <Widget className="h-full">
                  <Widget.Content className="flex flex-col gap-5">
                    <TypographyHeading
                      elementType="h2"
                      level={4}
                      className="min-w-0 break-words text-base font-medium"
                    >
                      {board.name}
                    </TypographyHeading>
                    <dl
                      id={`board-counts-${board.id}`}
                      className="mt-auto grid grid-cols-3 gap-4"
                    >
                      <div className="grid gap-1">
                        <dt className="text-xs text-muted">Backlog</dt>
                        <dd className="flex">
                          <BoardCount
                            count={board.backlogCount}
                            status="backlog"
                          />
                        </dd>
                      </div>
                      <div className="grid gap-1">
                        <dt className="text-xs text-muted">To Do</dt>
                        <dd className="flex">
                          <BoardCount count={board.todoCount} status="todo" />
                        </dd>
                      </div>
                      <div className="grid gap-1">
                        <dt className="text-xs text-muted">In Progress</dt>
                        <dd className="flex">
                          <BoardCount
                            count={board.inProgressCount}
                            status="in_progress"
                          />
                        </dd>
                      </div>
                    </dl>
                  </Widget.Content>
                </Widget>
              </Link>
            </li>
          ))}
        </ul>
      ) : pending ? (
        <QueryLoading className="sr-only">Loading boards</QueryLoading>
      ) : !error ? (
        <EmptyState>
          <EmptyState.Media>
            <HugeiconsIcon icon={ClipboardListIcon} size={32} aria-hidden />
          </EmptyState.Media>
          <EmptyState.Header>
            <EmptyState.Title>Your work starts here</EmptyState.Title>
            <EmptyState.Description>
              Organize your team’s work with boards and tasks.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : null}
    </div>
  );
}
