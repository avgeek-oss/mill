import { Add01Icon, ClipboardListIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Button,
  EmptyState,
  ErrorMessage,
  Link,
  Skeleton,
  TypographyHeading,
  Widget,
} from "@mill/web-design-system";
import type { BoardSummary } from "../../../packages/contracts/src/index.js";
import { PageHeading } from "./page-heading.js";
import { StatusIcon } from "./task-status.js";

export function BoardsPage({
  boards,
  pending,
  error,
  canCreate,
  onCreate,
  onRetry,
}: {
  boards: BoardSummary[];
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
        actionsPlacement="inline"
        icon={<HugeiconsIcon icon={ClipboardListIcon} size={20} aria-hidden />}
        actions={
          canCreate && (
            <Button
              aria-label="Create board"
              variant="ghost"
              isIconOnly
              className="board-create-button size-8 text-muted"
              onPress={onCreate}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                size={16}
                className="size-4"
                aria-hidden
              />
            </Button>
          )
        }
      />
      {error && (
        <div className="grid justify-items-start gap-2">
          <ErrorMessage>{error}</ErrorMessage>
          <Button variant="secondary" isDisabled={pending} onPress={onRetry}>
            Retry loading boards
          </Button>
        </div>
      )}
      {boards.length ? (
        <ul
          aria-label="Boards"
          className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {boards.map((board) => (
            <li key={board.id} className="min-w-0">
              <Link
                href={`/boards/${board.id}`}
                aria-label={board.name}
                className="block h-full w-full min-w-0 rounded-2xl no-underline outline-none transition-colors hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
                        <dd className="flex items-center gap-2 text-lg font-medium tabular-nums text-foreground">
                          <StatusIcon status="backlog" />
                          {board.backlogCount}
                        </dd>
                      </div>
                      <div className="grid gap-1">
                        <dt className="text-xs text-muted">To Do</dt>
                        <dd className="flex items-center gap-2 text-lg font-medium tabular-nums text-foreground">
                          <StatusIcon status="todo" />
                          {board.todoCount}
                        </dd>
                      </div>
                      <div className="grid gap-1">
                        <dt className="text-xs text-muted">In Progress</dt>
                        <dd className="flex items-center gap-2 text-lg font-medium tabular-nums text-foreground">
                          <StatusIcon status="in_progress" />
                          {board.inProgressCount}
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
        <div
          aria-label="Loading boards"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : !error ? (
        <EmptyState>
          <EmptyState.Media>
            <HugeiconsIcon icon={ClipboardListIcon} size={32} aria-hidden />
          </EmptyState.Media>
          <EmptyState.Header>
            <EmptyState.Title>Your work starts here</EmptyState.Title>
            <EmptyState.Description>
              Create a board, give it a few tasks, and make the next step clear.
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            {canCreate ? (
              <Button onPress={onCreate}>
                <HugeiconsIcon
                  icon={Add01Icon}
                  size={16}
                  className="size-4"
                  aria-hidden
                />
                Create your first board
              </Button>
            ) : (
              <p className="text-sm text-muted">
                Ask a member or administrator to create a board.
              </p>
            )}
          </EmptyState.Content>
        </EmptyState>
      ) : null}
    </div>
  );
}
