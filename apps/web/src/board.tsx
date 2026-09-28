import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  Chip,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
  SearchField,
  Widget,
  EmptyState,
  TypographyText,
  Table,
  Link,
  TooltipText,
  FieldDescription,
  TypographyCode,
  TypographyParagraph,
} from "@mill/web-design-system";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  List,
  Plus,
  Settings2,
  Save,
} from "./icons.js";
import { PageHeading } from "./page-heading.js";
import type {
  Board,
  Column,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import { ApiError, api, errorText, navigate, type User } from "./api.js";
import type { TaskSelection } from "./task-dialog.js";
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
  onBoardsChanged: () => void;
  onBoardLoaded: (board: Board) => void;
  path: string;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mobileFilters, setMobileFilters] = useState(false);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [view, setView] = useState(
    localStorage.getItem("mill:view") ?? "board",
  );
  const [filters, setFilters] = useState({
    assigneeId: "",
    priority: "",
    label: "",
    columnId: "",
    sort: "position",
    state: "active",
  });
  const [selection, setSelection] = useState<TaskSelection | null>(null);
  const [mobileColumn, setMobileColumn] = useState("");
  const [confirmBoard, setConfirmBoard] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [boardBefore, setBoardBefore] = useState("keep");
  const [settings, setSettings] = useState(false);
  const [columnDraft, setColumnDraft] = useState({ name: "", color: "gray" });
  const [busy, setBusy] = useState(false);
  const pendingSettingsOpener = useRef<HTMLElement | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const latestLoad = useRef(0);
  const writable =
    !!board && user.role !== "viewer" && !board.archived && !board.deletedAt;
  useEffect(() => {
    const timer = setTimeout(() => setQ(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  function taskQuery(cursor?: string) {
    const params = new URLSearchParams({ limit: "100", sort: filters.sort });
    if (q) params.set("q", q);
    for (const key of ["assigneeId", "priority", "label", "columnId"] as const)
      if (filters[key]) params.set(key, filters[key]);
    if (filters.state === "archived") params.set("archived", "true");
    if (filters.state === "deleted") params.set("deleted", "true");
    if (cursor) params.set("cursor", cursor);
    return params;
  }
  async function load(more = false, preserveWindow = false) {
    const request = ++latestLoad.current;
    if (!more) setLoading(true);
    else setMoreLoading(true);
    setError("");
    setErrorStatus(0);
    try {
      const [info, page] = await Promise.all([
        api<{ board: Board; columns: Column[] }>(`/boards/${boardId}`),
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
      setColumns(info.columns);
      setTasks((prev) =>
        more
          ? [...prev, ...page.items].filter(
              (item, index, list) =>
                list.findIndex((i) => i.id === item.id) === index,
            )
          : collected,
      );
      setNextCursor(cursor);
      setMobileColumn((prev) =>
        info.columns.some((c) => c.id === prev)
          ? prev
          : (info.columns[0]?.id ?? ""),
      );
    } catch (e) {
      if (request === latestLoad.current) {
        setError(errorText(e));
        setErrorStatus(e instanceof ApiError ? e.status : 0);
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
    filters.label,
    filters.columnId,
    filters.sort,
    filters.state,
  ]);
  useEffect(() => {
    const taskId = path.match(/\/tasks\/([^/]+)/)?.[1];
    setSelection((prev) => (taskId ? { id: taskId } : prev?.id ? null : prev));
  }, [path]);
  function choose(next: TaskSelection | null) {
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
        choose({ columnId: mobileColumn });
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [selection, settings, mobileColumn, writable]);
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
      await load();
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
  async function shiftColumn(column: Column, index: number, delta: number) {
    const ordered = [...columns];
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    ordered.splice(index, 1);
    ordered.splice(target, 0, column);
    await settingsRun(async () => {
      await api(
        `/columns/${column.id}`,
        { version: column.version, beforeId: ordered[target + 1]?.id ?? null },
        "PATCH",
      );
    });
  }
  const hasFilters = !!(
    q ||
    filters.assigneeId ||
    filters.priority ||
    filters.label ||
    filters.columnId ||
    filters.state !== "active"
  );
  function clearFilters() {
    setQuery("");
    setFilters({
      assigneeId: "",
      priority: "",
      label: "",
      columnId: "",
      sort: "position",
      state: "active",
    });
  }
  const visibleTasks = tasks.filter((task) =>
    filters.state === "deleted"
      ? !!task.deletedAt
      : filters.state === "archived"
        ? task.archived && !task.deletedAt
        : !task.archived && !task.deletedAt,
  );
  function emptyTasks() {
    const propertyFilters = !!(
      q ||
      filters.assigneeId ||
      filters.priority ||
      filters.label ||
      filters.columnId
    );
    const collection =
      filters.state === "archived"
        ? "archived"
        : filters.state === "deleted"
          ? "deleted"
          : null;
    return (
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Title>
            {propertyFilters
              ? "No tasks match these filters"
              : collection
                ? `No ${collection} tasks`
                : "No tasks yet"}
          </EmptyState.Title>
          <EmptyState.Description>
            {propertyFilters
              ? "Adjust or clear your filters to see existing tasks."
              : collection
                ? `Tasks you ${collection === "archived" ? "archive" : "delete"} appear here.`
                : writable
                  ? "Create the first task on this board."
                  : "Tasks created by your team will appear here."}
          </EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content>
          {hasFilters ? (
            <Button variant="secondary" onPress={clearFilters}>
              {propertyFilters ? "Clear filters" : "View active tasks"}
            </Button>
          ) : (
            writable && (
              <Button onPress={() => choose({ columnId: columns[0]?.id })}>
                Create task
              </Button>
            )
          )}
        </EmptyState.Content>
      </EmptyState>
    );
  }
  function card(task: Task) {
    const member = members.find((m) => m.id === task.assigneeId);
    return (
      <Widget.Content key={task.id} className="m-0 p-0">
        <button
          className="task-card p-4 text-sm text-foreground"
          onClick={() => choose({ id: task.id })}
        >
          <div className="row space-between">
            <span className="task-id">{task.identifier}</span>
            {task.priority !== "none" && (
              <span className={`priority priority-${task.priority}`}>
                {task.priority}
              </span>
            )}
          </div>
          <TypographyText
            textRole="body"
            className="task-title text-sm"
            weight="medium"
          >
            {task.title}
          </TypographyText>
          <div className="task-meta">
            {task.labels.map((label) => (
              <Chip key={label}>{label}</Chip>
            ))}
            {task.dueDate && (
              <time
                className={
                  new Date(task.dueDate).getTime() < Date.now() ? "overdue" : ""
                }
              >
                {new Date(task.dueDate).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })}
              </time>
            )}
            {task.checklist.length > 0 && (
              <span className="muted small">
                {task.checklist.filter((i) => i.done).length}/
                {task.checklist.length}
              </span>
            )}
            {member && (
              <span title={member.name} className="avatar">
                {member.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
        </button>
      </Widget.Content>
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
        title={board?.name ?? "Loading board…"}
        icon={<Columns3 />}
        description={board?.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {board?.archived && <Chip>Archived</Chip>}
            {board?.deletedAt && <Chip color="danger">Deleted</Chip>}
            <div className="segmented">
              <Button
                aria-label="Kanban view"
                isIconOnly
                variant={view === "board" ? "secondary" : "ghost"}
                onPress={() => {
                  setView("board");
                  localStorage.setItem("mill:view", "board");
                }}
              >
                <Columns3 />
              </Button>
              <Button
                aria-label="List view"
                isIconOnly
                variant={view === "list" ? "secondary" : "ghost"}
                onPress={() => {
                  setView("list");
                  localStorage.setItem("mill:view", "list");
                }}
              >
                <List />
              </Button>
            </div>
            {user.role !== "viewer" && (
              <Button
                variant="ghost"
                aria-label="Board settings"
                isIconOnly
                isDisabled={!board}
                onPress={() => setSettings(true)}
              >
                <Settings2 />
              </Button>
            )}
            {writable && !board?.deletedAt && (
              <Button onPress={() => choose({ columnId: columns[0]?.id })}>
                <Plus />
                New task
              </Button>
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
            value={filters.columnId}
            onChange={(v) => setFilters({ ...filters, columnId: v })}
            items={[{ id: "", name: "All statuses" }, ...columns]}
          />
        </div>
        <div className="board-label-slot">
          <TextField
            variant="secondary"
            label="Label filter"
            className="min-w-0 w-full"
            placeholder="Label"
            value={filters.label}
            onChange={(e) => setFilters({ ...filters, label: e.target.value })}
          />
        </div>
        <div className="board-filter-slot">
          <Choice
            variant="secondary"
            label="Sort"
            value={filters.sort}
            onChange={(v) => setFilters({ ...filters, sort: v })}
            items={[
              { id: "position", name: "Board order" },
              { id: "createdAt", name: "Newest first" },
              { id: "updatedAt", name: "Recently updated" },
              { id: "dueDate", name: "Due date" },
              { id: "priority", name: "Priority" },
            ]}
          />
        </div>
        <div className="board-filter-slot">
          <Choice
            variant="secondary"
            label="Task view"
            value={filters.state}
            onChange={(v) => setFilters({ ...filters, state: v })}
            items={[
              { id: "active", name: "Active tasks" },
              { id: "archived", name: "Archived tasks" },
              { id: "deleted", name: "Deleted tasks" },
            ]}
          />
        </div>
        <div className="board-clear-slot">
          {(q ||
            filters.assigneeId ||
            filters.priority ||
            filters.label ||
            filters.columnId ||
            filters.state !== "active") && (
            <Button variant="ghost" onPress={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      {loading ? (
        <QueryLoading label="Loading tasks…" variant="list" />
      ) : !visibleTasks.length ? (
        emptyTasks()
      ) : view === "board" ? (
        <>
          <div className="mobile-column">
            <Choice
              label="Board column"
              value={mobileColumn}
              onChange={setMobileColumn}
              items={columns.map((c) => ({
                ...c,
                name: `${c.name} (${visibleTasks.filter((t) => t.columnId === c.id).length})`,
              }))}
            />
          </div>
          <div className="kanban" aria-label="Task board">
            {columns.map((column) => (
              <Widget
                key={column.id}
                className={`kanban-column ${mobileColumn === column.id ? "mobile-selected" : ""}`}
                aria-label={column.name}
                role="region"
              >
                <Widget.Header className="column-header">
                  <div className="row">
                    <span
                      className="status-dot"
                      style={{
                        backgroundColor: `var(--status-${column.color},var(--muted))`,
                      }}
                    />
                    <Widget.Title help={false}>{column.name}</Widget.Title>
                    <span className="muted small">
                      {
                        visibleTasks.filter((t) => t.columnId === column.id)
                          .length
                      }
                    </span>
                  </div>
                  {writable && filters.state === "active" && (
                    <Button
                      variant="ghost"
                      isIconOnly
                      aria-label={`Add task to ${column.name}`}
                      onPress={() => choose({ columnId: column.id })}
                    >
                      <Plus />
                    </Button>
                  )}
                </Widget.Header>
                <div className="column-tasks">
                  {visibleTasks
                    .filter((t) => t.columnId === column.id)
                    .map(card)}
                  {!visibleTasks.some((t) => t.columnId === column.id) && (
                    <Widget.Content className="m-0 p-0">
                      <EmptyState className="px-4 py-8">
                        <EmptyState.Header>
                          <EmptyState.Description>
                            No tasks here.
                          </EmptyState.Description>
                        </EmptyState.Header>
                        {writable && filters.state === "active" && (
                          <Button
                            variant="ghost"
                            onPress={() => choose({ columnId: column.id })}
                          >
                            Add a task
                          </Button>
                        )}
                      </EmptyState>
                    </Widget.Content>
                  )}
                </div>
              </Widget>
            ))}
          </div>
        </>
      ) : (
        <>
          {visibleTasks.length ? (
            <Table>
              <Table.ScrollContainer>
                <Table.Content aria-label="Task list">
                  <Table.Header>
                    <Table.Column isRowHeader>Task</Table.Column>
                    <Table.Column>Status</Table.Column>
                    <Table.Column>Assignee</Table.Column>
                    <Table.Column>Priority</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {visibleTasks.map((task) => (
                      <Table.Row
                        key={task.id}
                        id={task.id}
                        href={`/boards/${boardId}/tasks/${task.id}`}
                      >
                        <Table.Cell>
                          <Link
                            href={`/boards/${boardId}/tasks/${task.id}`}
                            className="inline-flex min-w-0 items-center gap-3 rounded-lg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <span className="task-id">{task.identifier}</span>
                            <TypographyText
                              textRole="label"
                              className="text-sm"
                            >
                              <TooltipText
                                className="inline-block max-w-xs truncate align-middle"
                                tooltip={task.title}
                              >
                                {task.title}
                              </TooltipText>
                            </TypographyText>
                          </Link>
                        </Table.Cell>
                        <Table.Cell>
                          {columns.find((c) => c.id === task.columnId)?.name}
                        </Table.Cell>
                        <Table.Cell>
                          {members.find((m) => m.id === task.assigneeId)
                            ?.name ?? "Unassigned"}
                        </Table.Cell>
                        <Table.Cell>
                          <span
                            className={`priority priority-${task.priority}`}
                          >
                            {task.priority}
                          </span>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          ) : (
            emptyTasks()
          )}
        </>
      )}
      {nextCursor && (
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
      {selection && columns.length > 0 && (
        <Suspense fallback={<div role="status">Opening task…</div>}>
          <TaskDialog
            key={selection.id ?? `${selection.columnId}:${selection.parentId}`}
            selection={selection}
            boardId={boardId}
            columns={columns}
            members={members}
            tasks={tasks}
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
          isDismissDisabled={busy}
          open
          onClose={() => {
            pendingSettingsOpener.current = null;
            setSettings(false);
          }}
          title="Board settings"
          wide
          footer={
            <div className="grid w-full gap-2">
              <ErrorMessage>{settingsError}</ErrorMessage>
              <TypographyText textRole="supporting" role="status">
                {busy ? "Saving…" : settingsNotice}
              </TypographyText>
            </div>
          }
        >
          <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
            <div className="content-grid min-w-0">
              <Widget>
                <Widget.Header>
                  <Widget.Title icon={<Settings2 />} help={false}>
                    Board details
                  </Widget.Title>
                </Widget.Header>
                <Widget.Content>
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
                            ...(boardBefore === "keep"
                              ? {}
                              : { beforeId: boardBefore || null }),
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
                    <FieldDescription>
                      Task identifiers use{" "}
                      <TypographyCode>{board.prefix}</TypographyCode>. The
                      prefix stays fixed so existing links remain stable.
                    </FieldDescription>
                    <TextField
                      label="Description"
                      name="description"
                      defaultValue={board.description}
                      multiline
                      maxLength={2000}
                      disabled={!writable}
                      className="min-w-0 w-full"
                    />
                    <Choice
                      label="Board order"
                      value={boardBefore}
                      onChange={setBoardBefore}
                      items={[
                        { id: "keep", name: "Keep current order" },
                        { id: "", name: "Move to the end" },
                        ...boards
                          .filter((b) => b.id !== board.id)
                          .map((b) => ({ id: b.id, name: `Before ${b.name}` })),
                      ]}
                      disabled={!writable}
                      className="min-w-0 w-full"
                    />
                    <div>
                      <Button
                        type="submit"
                        isPending={busy}
                        isDisabled={!writable}
                      >
                        <Save />
                        Save board
                      </Button>
                    </div>
                  </form>
                </Widget.Content>
              </Widget>
              <Widget>
                <Widget.Header>
                  <Widget.Title help={false}>Archive and deletion</Widget.Title>
                </Widget.Header>
                <Widget.Content className="content-grid min-w-0">
                  <TypographyParagraph size="sm" color="muted">
                    Archived boards remain accessible. Deleted boards can be
                    restored from the sidebar.
                  </TypographyParagraph>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      isPending={busy}
                      isDisabled={!!board.deletedAt}
                      onPress={() => {
                        if (board.archived)
                          void settingsRun(async () => {
                            await api(
                              `/boards/${board.id}`,
                              { version: board.version, archived: false },
                              "PATCH",
                            );
                          }, "Board restored.");
                        else setConfirmArchive(true);
                      }}
                    >
                      {board.archived ? "Restore board" : "Archive board"}
                    </Button>
                    <Button
                      variant={board.deletedAt ? "secondary" : "danger-ghost"}
                      isPending={busy}
                      onPress={() => {
                        if (board.deletedAt)
                          void settingsRun(async () => {
                            await api(`/boards/${board.id}/restore`, {
                              version: board.version,
                            });
                          }, "Board restored.");
                        else setConfirmBoard(true);
                      }}
                    >
                      {board.deletedAt
                        ? "Restore deleted board"
                        : "Delete board"}
                    </Button>
                  </div>
                </Widget.Content>
              </Widget>
            </div>
            <Widget className="min-w-0">
              <Widget.Header>
                <Widget.Title help={false}>Statuses</Widget.Title>
              </Widget.Header>
              <Widget.Content className="content-grid min-w-0">
                <TypographyParagraph size="sm" color="muted">
                  Use the arrows to reorder statuses. Tasks keep their order
                  within each status.
                </TypographyParagraph>
                <div className="grid min-w-0">
                  {columns.map((column, index) => (
                    <ColumnEditor
                      key={column.id}
                      column={column}
                      columns={columns}
                      busy={busy}
                      readOnly={!writable}
                      error={settingsError}
                      onSave={(name, color) =>
                        void settingsRun(async () => {
                          await api(
                            `/columns/${column.id}`,
                            { version: column.version, name, color },
                            "PATCH",
                          );
                        }, "Status updated.")
                      }
                      onShift={(delta) =>
                        void shiftColumn(column, index, delta)
                      }
                      first={index === 0}
                      last={index === columns.length - 1}
                      onDelete={async (moveToColumnId) => {
                        const ok = await settingsRun(async () => {
                          await api(
                            `/columns/${column.id}`,
                            {
                              version: column.version,
                              ...(moveToColumnId ? { moveToColumnId } : {}),
                            },
                            "DELETE",
                          );
                        }, "Status deleted.");
                        if (ok)
                          requestAnimationFrame(() =>
                            document.getElementById("add-status")?.focus(),
                          );
                        return ok;
                      }}
                    />
                  ))}
                </div>
                <form
                  className="flex min-w-0 flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void settingsRun(async () => {
                      await api(`/boards/${board.id}/columns`, columnDraft);
                      setColumnDraft({ ...columnDraft, name: "" });
                    }, "Status added.");
                  }}
                >
                  <div className="min-w-0 flex-1 basis-40">
                    <TextField
                      label="New status"
                      value={columnDraft.name}
                      onChange={(e) =>
                        setColumnDraft({ ...columnDraft, name: e.target.value })
                      }
                      required
                      maxLength={80}
                      disabled={!writable}
                      className="min-w-0 w-full"
                    />
                  </div>
                  <Button
                    id="add-status"
                    type="submit"
                    isPending={busy}
                    isDisabled={!writable}
                  >
                    <Plus />
                    Add status
                  </Button>
                </form>
              </Widget.Content>
            </Widget>
          </div>
        </Dialog>
      )}
      {confirmArchive && board && (
        <Dialog
          isDismissDisabled={busy}
          open
          onClose={() => setConfirmArchive(false)}
          title="Archive board?"
          footer={
            <>
              <Button
                variant="secondary"
                onPress={() => setConfirmArchive(false)}
                isPending={busy}
              >
                Keep active
              </Button>
              <Button
                isPending={busy}
                onPress={() =>
                  void settingsRun(async () => {
                    await api(
                      `/boards/${board.id}`,
                      { version: board.version, archived: true },
                      "PATCH",
                    );
                    setConfirmArchive(false);
                  }, "Board archived.")
                }
              >
                Archive board
              </Button>
            </>
          }
        >
          <TypographyParagraph size="sm">
            The board stays accessible in archived boards. Restore it before
            adding or editing tasks.
          </TypographyParagraph>
          <ErrorMessage>{settingsError}</ErrorMessage>
        </Dialog>
      )}
      {confirmBoard && board && (
        <Dialog
          isDismissDisabled={busy}
          open
          onClose={() => setConfirmBoard(false)}
          title="Delete board?"
          footer={
            <>
              <Button
                variant="secondary"
                onPress={() => setConfirmBoard(false)}
                isPending={busy}
              >
                Keep board
              </Button>
              <Button
                variant="danger"
                isPending={busy}
                onPress={() =>
                  void settingsRun(async () => {
                    await api(
                      `/boards/${board.id}`,
                      { version: board.version, deleted: true },
                      "PATCH",
                    );
                    setConfirmBoard(false);
                  })
                }
              >
                Delete board
              </Button>
            </>
          }
        >
          <p>
            The board and its tasks move to deleted boards. You can restore the
            board from the sidebar.
          </p>
          <ErrorMessage>{settingsError}</ErrorMessage>
        </Dialog>
      )}
    </>
  );
}
function ColumnEditor({
  column,
  columns,
  busy,
  readOnly,
  error,
  onSave,
  onShift,
  first,
  last,
  onDelete,
}: {
  column: Column;
  columns: Column[];
  busy: boolean;
  readOnly: boolean;
  error: string;
  onSave: (name: string, color: string) => void;
  onShift: (delta: number) => void;
  first: boolean;
  last: boolean;
  onDelete: (moveToColumnId?: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(column.name);
  const [color, setColor] = useState(column.color);
  const [moveTo, setMoveTo] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setName(column.name);
    setColor(column.color);
  }, [column.name, column.color]);
  const colorName = color[0].toUpperCase() + color.slice(1);
  return (
    <div className="column-editor min-w-0 border-b border-separator py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0">
        <TextField
          label="Status name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          disabled={busy || readOnly}
          className="min-w-0 w-full"
        />
      </div>
      <Choice
        label="Status color"
        value={color}
        onChange={setColor}
        items={[
          "gray",
          "blue",
          "green",
          "yellow",
          "orange",
          "red",
          "purple",
          "pink",
        ].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }))}
        disabled={busy || readOnly}
        className="min-w-0 w-full"
      />
      <div className="col-span-full flex flex-wrap items-center gap-2">
        <Chip
          variant="secondary"
          size="small"
          icon={
            <span
              className="status-dot"
              style={{ background: `var(--status-${color})` }}
            />
          }
        >
          {colorName}
        </Chip>
        <Button
          variant="secondary"
          isPending={busy}
          isDisabled={
            readOnly ||
            (name === column.name && color === column.color) ||
            !name.trim()
          }
          onPress={() => onSave(name, color)}
        >
          <Save />
          Save
        </Button>
        <Button
          variant="ghost"
          isIconOnly
          aria-label={`Move ${column.name} earlier`}
          isPending={busy}
          isDisabled={readOnly || first}
          onPress={() => onShift(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          variant="ghost"
          isIconOnly
          aria-label={`Move ${column.name} later`}
          isPending={busy}
          isDisabled={readOnly || last}
          onPress={() => onShift(1)}
        >
          <ArrowDown />
        </Button>
        <Button
          variant="danger-ghost"
          isPending={busy}
          isDisabled={readOnly}
          onPress={() => setConfirm(true)}
        >
          Delete
        </Button>
      </div>
      <Dialog
        isDismissDisabled={busy}
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete status?"
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setConfirm(false)}
              isPending={busy}
            >
              Keep status
            </Button>
            <Button
              variant="danger"
              isPending={busy}
              isDisabled={readOnly}
              onPress={async () => {
                if (await onDelete(moveTo || undefined)) setConfirm(false);
              }}
            >
              Delete status
            </Button>
          </>
        }
      >
        <div className="content-grid min-w-0">
          <TypographyParagraph size="sm">
            Choose another status to receive any tasks in {column.name}. An
            empty status can be deleted directly.
          </TypographyParagraph>
          <Choice
            label="Move tasks to"
            value={moveTo}
            onChange={setMoveTo}
            items={[
              { id: "", name: "Do not move tasks" },
              ...columns.filter((item) => item.id !== column.id),
            ]}
            search
            disabled={busy}
          />
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      </Dialog>
    </div>
  );
}
