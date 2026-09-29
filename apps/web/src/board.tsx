import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  Button,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
  SearchField,
  Dropdown,
  EmptyState,
  TypographyText,
  Table,
  Link,
  TooltipText,
  TypographyParagraph,
} from "@mill/web-design-system";
import {
  List,
  Plus,
  Settings2,
  Save,
  MoreHorizontal,
  Trash2,
} from "./icons.js";
import { PageHeading } from "./page-heading.js";
import type {
  Board,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  navigate,
  type User,
} from "./api.js";
import type { TaskSelection } from "./task-dialog.js";
import { hasOkResponse } from "./responses.js";
import { TASK_STATUSES } from "../../../packages/contracts/src/index.js";
import { taskStatusLabel } from "./activity-label.js";
const TaskDialog = lazy(() =>
  import("./task-dialog.js").then((m) => ({ default: m.TaskDialog })),
);
import { ErrorPage } from "./error-page.js";
import { QueryLoading } from "./query-state.js";
type Page = { items: Task[]; nextCursor?: string | null };
export function BoardPage({
  boardId,
  boards,
  user,
  members,
  onBoardsChanged,
  onBoardLoaded,
  path,
}: {
  boardId: string;
  boards: Board[];
  user: User;
  members: Member[];
  onBoardsChanged: (removedBoardId?: string) => void;
  onBoardLoaded: (board: Board) => void;
  path: string;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [taskListChanged, setTaskListChanged] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState({
    assigneeId: "",
    priority: "",
    status: "",
    sort: "createdAt",
  });
  const [selection, setSelection] = useState<TaskSelection | null>(null);
  const [confirmBoard, setConfirmBoard] = useState(false);
  const [boardDeleteKey] = useState(createRetryKey);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingSettingsOpener = useRef<HTMLElement | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const latestLoad = useRef(0);
  const taskOpener = useRef<{
    taskId?: string;
    element: HTMLElement | null;
  } | null>(null);
  const taskWasOpen = useRef(false);
  const taskList = useRef<HTMLTableElement | null>(null);
  const newTaskButton = useRef<HTMLButtonElement | null>(null);
  const boardActionsButton = useRef<HTMLButtonElement | null>(null);
  const boardDialogWasOpen = useRef(false);
  const writable = !!board && user.role !== "viewer";
  useEffect(() => {
    const timer = setTimeout(() => setQ(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  function taskQuery(cursor?: string) {
    const params = new URLSearchParams({ limit: "100", sort: filters.sort });
    if (q) params.set("q", q);
    for (const key of ["assigneeId", "priority", "status"] as const)
      if (filters[key]) params.set(key, filters[key]);
    if (cursor) params.set("cursor", cursor);
    return params;
  }
  async function load(more = false, preserveWindow = false) {
    const request = ++latestLoad.current;
    if (!more) setLoading(true);
    else setMoreLoading(true);
    setError("");
    setErrorStatus(0);
    setTaskListChanged(false);
    try {
      const [info, page] = await Promise.all([
        api<{ board: Board }>(`/boards/${boardId}`),
        api<Page>(
          `/boards/${boardId}/tasks?${taskQuery(more ? (nextCursor ?? undefined) : undefined)}`,
        ),
      ]);
      const collected = [...page.items];
      let cursor = page.nextCursor ?? null;
      while (
        !more &&
        preserveWindow &&
        collected.length < tasks.length &&
        cursor
      ) {
        if (request !== latestLoad.current) return;
        const next = await api<Page>(
          `/boards/${boardId}/tasks?${taskQuery(cursor)}`,
        );
        collected.push(...next.items);
        cursor = next.nextCursor ?? null;
      }
      if (request !== latestLoad.current) return;
      setBoard(info.board);
      onBoardLoaded(info.board);
      setTasks((prev) =>
        more
          ? [...prev, ...page.items].filter(
              (item, index, list) =>
                list.findIndex((i) => i.id === item.id) === index,
            )
          : collected,
      );
      setNextCursor(cursor);
    } catch (e) {
      if (request === latestLoad.current) {
        const changed = e instanceof ApiError && e.status === 409;
        if (more && changed) {
          await load(false, true);
          return;
        }
        setError(errorText(e));
        setErrorStatus(e instanceof ApiError ? e.status : 0);
        setTaskListChanged(changed);
      }
    } finally {
      if (request === latestLoad.current) {
        setLoading(false);
        setMoreLoading(false);
      }
    }
  }
  useEffect(() => {
    if (board && !path.includes("/tasks/"))
      document.title = `${board.name} · Mill`;
  }, [board?.name, path]);
  useEffect(() => {
    void load();
  }, [
    boardId,
    q,
    filters.assigneeId,
    filters.priority,
    filters.status,
    filters.sort,
  ]);
  useEffect(() => {
    const taskId = path.match(/\/tasks\/([^/]+)/)?.[1];
    setSelection((prev) => (taskId ? { id: taskId } : prev?.id ? null : prev));
  }, [path]);
  function rememberTaskOpener(
    taskId: string,
    target: EventTarget | null,
    row: HTMLElement,
  ) {
    taskOpener.current = {
      taskId,
      element:
        target instanceof Element
          ? (target.closest<HTMLElement>("a[href]") ?? row)
          : row,
    };
  }
  useEffect(() => {
    if (selection) {
      taskWasOpen.current = true;
      taskOpener.current ??= { taskId: selection.id, element: null };
      return;
    }
    if (!taskWasOpen.current || loading) return;
    let frame = 0;
    const restore = () => {
      const opener = taskOpener.current;
      taskWasOpen.current = false;
      taskOpener.current = null;
      const active = document.activeElement;
      if (
        active !== document.body &&
        active !== opener?.element &&
        !taskList.current?.contains(active)
      )
        return;
      const currentLink = opener?.taskId
        ? taskList.current?.querySelector<HTMLAnchorElement>(
            `a[href="/boards/${boardId}/tasks/${opener.taskId}"]`,
          )
        : null;
      const target = opener?.element?.isConnected
        ? opener.element
        : (currentLink ??
          newTaskButton.current ??
          document.getElementById("board-search"));
      const row = target?.closest<HTMLElement>('[role="row"]');
      if (row && taskList.current?.contains(row)) {
        // Synchronize the table's focused row before returning to its nested link.
        flushSync(() => row.focus({ preventScroll: true }));
      }
      target?.focus({ preventScroll: true });
    };
    const afterDialogRemoved = () => {
      if (document.querySelector("[data-task-dialog]")) return;
      observer.disconnect();
      // The modal's focus scope restores on the first frame after teardown.
      frame = requestAnimationFrame(restore);
    };
    const observer = new MutationObserver(afterDialogRemoved);
    observer.observe(document.body, { childList: true, subtree: true });
    afterDialogRemoved();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [selection, loading, tasks, boardId]);
  function choose(next: TaskSelection | null) {
    if (next && !selection) {
      taskOpener.current = {
        taskId: next.id,
        element:
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
            ? document.activeElement
            : null,
      };
    }
    setSelection(next);
    if (next?.id) navigate(`/boards/${boardId}/tasks/${next.id}`);
    else if (path.includes("/tasks/")) navigate(`/boards/${boardId}`);
  }
  useEffect(() => {
    function shortcuts(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement &&
          !!e.target.closest(
            '[role="dialog"],[role="listbox"],[contenteditable="true"]',
          )) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        selection ||
        settings
      )
        return;
      if (e.key.toLowerCase() === "n" && writable) {
        e.preventDefault();
        choose({});
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [selection, settings, writable]);
  useLayoutEffect(() => {
    if (!settings) {
      pendingSettingsOpener.current = null;
      return;
    }
    if (busy) return;
    const target = pendingSettingsOpener.current;
    pendingSettingsOpener.current = null;
    if (
      target?.isConnected &&
      !target.matches(":disabled") &&
      target.getAttribute("aria-disabled") !== "true" &&
      (document.activeElement === document.body ||
        document.activeElement === target)
    )
      target.focus({ preventScroll: true });
  }, [busy, settings]);
  useLayoutEffect(
    () => () => {
      pendingSettingsOpener.current = null;
    },
    [],
  );
  useEffect(() => {
    if (settings || confirmBoard) {
      boardDialogWasOpen.current = true;
      return;
    }
    if (!boardDialogWasOpen.current) return;
    let frame = 0;
    const restore = () => {
      boardDialogWasOpen.current = false;
      const active = document.activeElement;
      if (
        active === document.body ||
        active === boardActionsButton.current ||
        active?.closest('[role="menu"]') ||
        taskList.current?.contains(active)
      )
        boardActionsButton.current?.focus({ preventScroll: true });
    };
    const afterDialogRemoved = () => {
      if (document.querySelector("[data-board-dialog]")) return;
      observer.disconnect();
      frame = requestAnimationFrame(restore);
    };
    const observer = new MutationObserver(afterDialogRemoved);
    observer.observe(document.body, { childList: true, subtree: true });
    afterDialogRemoved();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [settings, confirmBoard]);
  async function settingsRun(
    action: () => Promise<void>,
    notice = "Changes saved.",
  ) {
    if (busy) return false;
    pendingSettingsOpener.current =
      settings && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBusy(true);
    setSettingsError("");
    setSettingsNotice("");
    try {
      await action();
      await load(false, true);
      onBoardsChanged();
      setSettingsNotice(notice);
      return true;
    } catch (e) {
      setSettingsError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function deleteBoard() {
    if (busy || !board || user.role !== "admin") return;
    setBusy(true);
    setSettingsError("");
    try {
      await api(`/boards/${board.id}`, { version: board.version }, "DELETE", {
        validateResponse: hasOkResponse,
        headers: {
          "Idempotency-Key": boardDeleteKey.forRequest(
            `/boards/${board.id}`,
            { version: board.version },
            "DELETE",
          ),
        },
      });
      boardDeleteKey.reset();
      ++latestLoad.current;
      setConfirmBoard(false);
      setSettings(false);
      onBoardsChanged(board.id);
      const nextBoard = boards.find((item) => item.id !== board.id);
      navigate(nextBoard ? `/boards/${nextBoard.id}` : "/");
    } catch (e) {
      setSettingsError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const hasFilters = !!(
    q ||
    filters.assigneeId ||
    filters.priority ||
    filters.status
  );
  function clearFilters() {
    setQuery("");
    setFilters({
      assigneeId: "",
      priority: "",
      status: "",
      sort: "createdAt",
    });
  }
  const visibleTasks = tasks;
  function emptyTasks() {
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>
            {hasFilters ? "No tasks match these filters" : "No tasks yet"}
          </EmptyState.Title>
          <EmptyState.Description>
            {hasFilters
              ? "Adjust or clear your filters to see existing tasks."
              : writable
                ? "Create the first task on this board."
                : "Tasks created by your team will appear here."}
          </EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content>
          {hasFilters ? (
            <Button variant="secondary" onPress={clearFilters}>
              Clear filters
            </Button>
          ) : (
            writable && <Button onPress={() => choose({})}>Create task</Button>
          )}
        </EmptyState.Content>
      </EmptyState>
    );
  }
  if (!loading && errorStatus >= 500)
    return <ErrorPage onRetry={() => void load()} />;
  if (!board && !loading)
    return (
      <ErrorPage
        code={[403, 404].includes(errorStatus) ? String(errorStatus) : "500"}
        title={
          errorStatus === 403 ? "Board access required" : "Board unavailable"
        }
        description={error || "This board could not be found."}
        onRetry={() => void load()}
      />
    );
  return (
    <>
      <PageHeading
        title={
          board?.name ??
          boards.find((item) => item.id === boardId)?.name ??
          "Board"
        }
        icon={<List />}
        description={board?.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {writable && (
              <Button ref={newTaskButton} onPress={() => choose({})}>
                <Plus />
                New task
              </Button>
            )}
            {user.role !== "viewer" && (
              <Dropdown>
                <Button
                  ref={boardActionsButton}
                  variant="secondary"
                  aria-label="Board actions"
                  isIconOnly
                  isDisabled={!board || busy}
                >
                  <MoreHorizontal />
                </Button>
                <Dropdown.Popover placement="bottom end" className="min-w-44">
                  <Dropdown.Menu
                    aria-label="Board actions"
                    onAction={(key) => {
                      setSettingsError("");
                      setSettingsNotice("");
                      if (key === "settings") setSettings(true);
                      else if (key === "delete" && user.role === "admin")
                        setConfirmBoard(true);
                    }}
                  >
                    <Dropdown.Item id="settings" textValue="Board settings">
                      <Settings2 />
                      Board settings
                    </Dropdown.Item>
                    {user.role === "admin" && (
                      <Dropdown.Item
                        id="delete"
                        textValue="Delete board"
                        variant="danger"
                      >
                        <Trash2 />
                        Delete board
                      </Dropdown.Item>
                    )}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            )}
          </div>
        }
      />
      <div className={`board-toolbar ${mobileFilters ? "filters-open" : ""}`}>
        <SearchField
          aria-label="Search tasks"
          variant="secondary"
          className="board-search"
          value={query}
          onChange={setQuery}
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input
              id="board-search"
              placeholder="Search tasks…"
              maxLength={200}
            />
            <SearchField.ClearButton aria-label="Clear task search" />
          </SearchField.Group>
        </SearchField>
        <Button
          className="mobile-filter-trigger"
          variant="secondary"
          aria-expanded={mobileFilters}
          onPress={() => setMobileFilters(!mobileFilters)}
        >
          <Settings2 />
          Filters
        </Button>
        <div className="board-filter-slot">
          <Choice
            variant="secondary"
            label="Assignee filter"
            hideLabel
            value={filters.assigneeId}
            onChange={(v) => setFilters({ ...filters, assigneeId: v })}
            items={[
              { id: "", name: "All assignees" },
              { id: "unassigned", name: "Unassigned" },
              ...members,
            ]}
            search
          />
        </div>
        <div className="board-filter-slot">
          <Choice
            variant="secondary"
            label="Priority filter"
            hideLabel
            value={filters.priority}
            onChange={(v) => setFilters({ ...filters, priority: v })}
            items={[
              { id: "", name: "All priorities" },
              ...["urgent", "high", "medium", "low", "none"].map((id) => ({
                id,
                name: id === "none" ? "No priority" : id,
              })),
            ]}
          />
        </div>
        <div className="board-filter-slot">
          <Choice
            variant="secondary"
            label="Status filter"
            hideLabel
            value={filters.status}
            onChange={(v) => setFilters({ ...filters, status: v })}
            items={[
              { id: "", name: "All statuses" },
              ...TASK_STATUSES.map((id) => ({ id, name: taskStatusLabel(id) })),
            ]}
          />
        </div>
        <div className="board-filter-slot">
          <Choice
            variant="secondary"
            label="Sort"
            hideLabel
            value={filters.sort}
            onChange={(v) => setFilters({ ...filters, sort: v })}
            items={[
              { id: "createdAt", name: "Newest first" },
              { id: "title", name: "Title" },
              { id: "updatedAt", name: "Recently updated" },
              { id: "dueDate", name: "Due date" },
              { id: "priority", name: "Priority" },
            ]}
          />
        </div>
        <div className="board-clear-slot">
          {hasFilters && (
            <Button variant="ghost" onPress={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      {taskListChanged && (
        <div>
          <Button
            variant="secondary"
            isDisabled={loading || moreLoading}
            onPress={() => void load(false, true)}
          >
            Retry loading tasks
          </Button>
        </div>
      )}
      {loading ? (
        <QueryLoading label="Loading tasks…" variant="list" />
      ) : !visibleTasks.length ? (
        emptyTasks()
      ) : (
        <div
          onKeyDownCapture={(event) => {
            if (event.key !== "Enter" || !(event.target instanceof Element))
              return;
            const row = event.target.closest<HTMLElement>("[data-task-id]");
            if (row?.dataset.taskId)
              rememberTaskOpener(row.dataset.taskId, event.target, row);
          }}
        >
          <Table>
            <Table.ScrollContainer>
              <Table.Content ref={taskList} aria-label="Task list">
                <Table.Header>
                  <Table.Column isRowHeader>Task</Table.Column>
                  <Table.Column>Status</Table.Column>
                  <Table.Column>Assignee</Table.Column>
                  <Table.Column>Agent</Table.Column>
                  <Table.Column>Priority</Table.Column>
                </Table.Header>
                <Table.Body>
                  {visibleTasks.map((task) => (
                    <Table.Row
                      key={task.id}
                      id={task.id}
                      href={`/boards/${boardId}/tasks/${task.id}`}
                      data-task-id={task.id}
                      onClickCapture={(event) =>
                        rememberTaskOpener(
                          task.id,
                          event.target,
                          event.currentTarget,
                        )
                      }
                    >
                      <Table.Cell>
                        <Link
                          href={`/boards/${boardId}/tasks/${task.id}`}
                          className="grid min-w-0 gap-0.5 rounded-lg text-sm/5 font-normal outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <span className="min-w-0 text-sm/5 font-normal">
                            <TooltipText
                              className="inline-block max-w-xs truncate align-middle"
                              tooltip={task.title}
                            >
                              {task.title}
                            </TooltipText>
                          </span>
                          <span className="font-mono text-xs/4 font-normal text-muted">
                            {task.identifier}
                          </span>
                        </Link>
                      </Table.Cell>
                      <Table.Cell>{taskStatusLabel(task.status)}</Table.Cell>
                      <Table.Cell>
                        {members.find((m) => m.id === task.assigneeId)?.name ??
                          "Unassigned"}
                      </Table.Cell>
                      <Table.Cell>{task.agentName}</Table.Cell>
                      <Table.Cell>
                        <span className={`priority priority-${task.priority}`}>
                          {task.priority}
                        </span>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </div>
      )}
      {nextCursor && !taskListChanged && (
        <div className="load-more">
          <Button
            variant="secondary"
            onPress={() => void load(true)}
            isDisabled={loading || moreLoading || query !== q}
          >
            {moreLoading ? "Loading…" : "Load more tasks"}
          </Button>
        </div>
      )}
      {selection && (
        <Suspense fallback={<div role="status">Opening task…</div>}>
          <TaskDialog
            key={selection.id ?? "new"}
            selection={selection}
            boardId={boardId}
            members={members}
            user={user}
            readOnly={!writable}
            onClose={() => choose(null)}
            onSaved={() => void load(false, true)}
            onSelect={choose}
          />
        </Suspense>
      )}
      {settings && board && (
        <Dialog
          data-board-dialog
          isDismissDisabled={busy}
          open
          onClose={() => {
            pendingSettingsOpener.current = null;
            setSettings(false);
          }}
          title="Board settings"
          footer={
            <div className="grid w-full gap-2">
              <ErrorMessage>{settingsError}</ErrorMessage>
              <TypographyText textRole="supporting" role="status">
                {busy ? "Saving…" : settingsNotice}
              </TypographyText>
            </div>
          }
        >
          <form
            className="content-grid min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void settingsRun(async () => {
                await api(
                  `/boards/${board.id}`,
                  {
                    version: board.version,
                    name: data.get("name"),
                    description: data.get("description"),
                  },
                  "PATCH",
                );
              }, "Board updated.");
            }}
          >
            <TextField
              label="Board name"
              name="name"
              defaultValue={board.name}
              required
              maxLength={100}
              disabled={!writable}
              className="min-w-0 w-full"
            />
            <TextField
              label="Description"
              name="description"
              defaultValue={board.description}
              multiline
              maxLength={2000}
              disabled={!writable}
              className="min-w-0 w-full"
            />
            <div>
              <Button type="submit" isPending={busy} isDisabled={!writable}>
                <Save />
                Save board
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {confirmBoard && board && user.role === "admin" && (
        <Dialog
          data-board-dialog
          isDismissDisabled={busy}
          open
          onClose={() => setConfirmBoard(false)}
          title="Delete board?"
          footer={
            <>
              <Button
                variant="secondary"
                onPress={() => setConfirmBoard(false)}
                isDisabled={busy}
              >
                Keep board
              </Button>
              <Button
                variant="danger"
                isPending={busy}
                onPress={() => void deleteBoard()}
              >
                Delete board
              </Button>
            </>
          }
        >
          <TypographyParagraph size="sm">
            Permanently delete “{board.name}” and all of its tasks and comments?
            This cannot be undone. There is no restore.
          </TypographyParagraph>
          <ErrorMessage>{settingsError}</ErrorMessage>
        </Dialog>
      )}
    </>
  );
}
