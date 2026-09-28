import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  Button,
  Chip,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
} from "@mill/web-design-system";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  List,
  Plus,
  Settings2,
  Search,
} from "lucide-react";
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
type Page = { items: Task[]; nextCursor?: string | null };
export function BoardPage({
  boardId,
  boards,
  user,
  members,
  onBoardsChanged,
  path,
}: {
  boardId: string;
  boards: Board[];
  user: User;
  members: Member[];
  onBoardsChanged: () => void;
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
  const [boardBefore, setBoardBefore] = useState("keep");
  const [settings, setSettings] = useState(false);
  const [columnDraft, setColumnDraft] = useState({ name: "", color: "gray" });
  const [busy, setBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const latestLoad = useRef(0);
  const writable =
    user.role !== "viewer" && !board?.archived && !board?.deletedAt;
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
  async function settingsRun(action: () => Promise<void>) {
    const focusTarget =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBusy(true);
    setSettingsError("");
    try {
      await action();
      await load();
      onBoardsChanged();
    } catch (e) {
      setSettingsError(errorText(e));
    } finally {
      setBusy(false);
      window.requestAnimationFrame(() => {
        if (
          focusTarget?.isConnected &&
          (document.activeElement === document.body ||
            document.activeElement === focusTarget)
        )
          focusTarget.focus({ preventScroll: true });
      });
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
  const visibleTasks = tasks.filter((task) =>
    filters.state === "deleted"
      ? !!task.deletedAt
      : filters.state === "archived"
        ? task.archived && !task.deletedAt
        : !task.archived && !task.deletedAt,
  );
  function card(task: Task) {
    const member = members.find((m) => m.id === task.assigneeId);
    return (
      <button
        key={task.id}
        className="task-card"
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
        <span className="task-title">{task.title}</span>
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
    );
  }
  if (!loading && errorStatus >= 500)
    return <ErrorPage onRetry={() => void load()} />;
  if (!board && !loading)
    return (
      <section className="error-page">
        <h1>Board unavailable</h1>
        <ErrorMessage>{error || "This board could not be found."}</ErrorMessage>
        <Button onPress={() => void load()}>Try again</Button>
        <Button variant="secondary" onPress={() => navigate("/")}>
          Go to boards
        </Button>
      </section>
    );
  return (
    <>
      <header className="board-header">
        <div>
          <div className="row">
            <h1>{board?.name ?? "Loading board…"}</h1>
            {board?.archived && <Chip>Archived</Chip>}
            {board?.deletedAt && <Chip color="danger">Deleted</Chip>}
          </div>
          {board?.description && (
            <p className="muted board-description">{board.description}</p>
          )}
        </div>
        <div className="row">
          <div className="segmented">
            <Button
              aria-label="Kanban view"
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
      </header>
      <div className={`board-toolbar ${mobileFilters ? "filters-open" : ""}`}>
        <div className="board-search">
          <Search aria-hidden="true" />
          <input
            id="board-search"
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
          />
          <kbd>/</kbd>
        </div>
        <Button
          className="mobile-filter-trigger"
          variant="secondary"
          aria-expanded={mobileFilters}
          onPress={() => setMobileFilters(!mobileFilters)}
        >
          <Settings2 />
          Filters
        </Button>
        <Choice
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
        <Choice
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
        <Choice
          label="Status filter"
          value={filters.columnId}
          onChange={(v) => setFilters({ ...filters, columnId: v })}
          items={[{ id: "", name: "All statuses" }, ...columns]}
        />
        <TextField
          label="Label filter"
          placeholder="Label"
          value={filters.label}
          onChange={(e) => setFilters({ ...filters, label: e.target.value })}
        />
        <Choice
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
        <Choice
          label="Task view"
          value={filters.state}
          onChange={(v) => setFilters({ ...filters, state: v })}
          items={[
            { id: "active", name: "Active tasks" },
            { id: "archived", name: "Archived tasks" },
            { id: "deleted", name: "Deleted tasks" },
          ]}
        />
        {(q ||
          filters.assigneeId ||
          filters.priority ||
          filters.label ||
          filters.columnId ||
          filters.state !== "active") && (
          <Button
            variant="ghost"
            onPress={() => {
              setQuery("");
              setFilters({
                assigneeId: "",
                priority: "",
                label: "",
                columnId: "",
                sort: "position",
                state: "active",
              });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      {loading ? (
        <div className="loading-state" role="status">
          Loading tasks…
        </div>
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
              <section
                key={column.id}
                className={`kanban-column ${mobileColumn === column.id ? "mobile-selected" : ""}`}
                aria-label={column.name}
              >
                <header className="column-header">
                  <div className="row">
                    <span
                      className="status-dot"
                      style={{
                        backgroundColor: `var(--status-${column.color},var(--mill-muted))`,
                      }}
                    />
                    <h2>{column.name}</h2>
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
                      aria-label={`Add task to ${column.name}`}
                      onPress={() => choose({ columnId: column.id })}
                    >
                      <Plus />
                    </Button>
                  )}
                </header>
                <div className="column-tasks">
                  {visibleTasks
                    .filter((t) => t.columnId === column.id)
                    .map(card)}
                  {!visibleTasks.some((t) => t.columnId === column.id) && (
                    <div className="column-empty">
                      <p>No tasks here.</p>
                      {writable && filters.state === "active" && (
                        <Button
                          variant="ghost"
                          onPress={() => choose({ columnId: column.id })}
                        >
                          Add a task
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="task-table" role="table" aria-label="Task list">
          <div className="task-table-heading" role="row">
            <span>Task</span>
            <span>Status</span>
            <span>Assignee</span>
            <span>Priority</span>
          </div>
          {visibleTasks.map((task) => (
            <button
              className="task-table-row"
              role="row"
              key={task.id}
              onClick={() => choose({ id: task.id })}
            >
              <span>
                <span className="task-id">{task.identifier}</span>
                <span className="task-title">{task.title}</span>
              </span>
              <span>{columns.find((c) => c.id === task.columnId)?.name}</span>
              <span>
                {members.find((m) => m.id === task.assigneeId)?.name ??
                  "Unassigned"}
              </span>
              <span className={`priority priority-${task.priority}`}>
                {task.priority}
              </span>
            </button>
          ))}
          {!visibleTasks.length && (
            <div className="empty-state">
              <h2>No tasks match this view</h2>
              <p className="muted">
                Change your filters or add the first task.
              </p>
              {writable && (
                <Button onPress={() => choose({})}>Create task</Button>
              )}
            </div>
          )}
        </div>
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
          open
          onClose={() => setSettings(false)}
          title="Board settings"
          footer={
            <Button variant="secondary" onPress={() => setSettings(false)}>
              Done
            </Button>
          }
        >
          <ErrorMessage>{settingsError}</ErrorMessage>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void settingsRun(async () => {
                const data = new FormData(e.currentTarget);
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
              });
            }}
          >
            <TextField
              label="Board name"
              name="name"
              defaultValue={board.name}
              required
              maxLength={100}
            />
            <TextField
              label="Task prefix"
              name="prefix"
              value={board.prefix}
              readOnly
              description="Stable task identifiers keep their original prefix."
            />
            <TextField
              label="Description"
              name="description"
              defaultValue={board.description}
              multiline
              maxLength={2000}
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
            />
            <Button type="submit" isDisabled={busy || !writable}>
              Save board
            </Button>
          </form>
          <section className="settings-section">
            <h2>Statuses</h2>
            <p className="muted small">
              Move statuses with the arrows. Tasks keep their order within each
              status.
            </p>
            {columns.map((column, index) => (
              <ColumnEditor
                key={column.id}
                column={column}
                busy={busy || !writable}
                onSave={(name, color) =>
                  void settingsRun(async () => {
                    await api(
                      `/columns/${column.id}`,
                      { version: column.version, name, color },
                      "PATCH",
                    );
                  })
                }
                onShift={(delta) => void shiftColumn(column, index, delta)}
                first={index === 0}
                last={index === columns.length - 1}
                onDelete={() =>
                  void settingsRun(async () => {
                    await api(
                      `/columns/${column.id}`,
                      { version: column.version },
                      "DELETE",
                    );
                  })
                }
              />
            ))}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void settingsRun(async () => {
                  await api(`/boards/${board.id}/columns`, columnDraft);
                  setColumnDraft({ ...columnDraft, name: "" });
                });
              }}
            >
              <TextField
                label="New status"
                value={columnDraft.name}
                onChange={(e) =>
                  setColumnDraft({ ...columnDraft, name: e.target.value })
                }
                required
                maxLength={80}
              />
              <Button type="submit" isDisabled={busy || !writable}>
                Add status
              </Button>
            </form>
          </section>
          <section className="settings-section">
            <h2>Archive and deletion</h2>
            <p className="muted small">
              Archived boards remain accessible. Deleted boards can be restored
              from the sidebar.
            </p>
            <div className="row">
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() =>
                  void settingsRun(async () => {
                    await api(
                      `/boards/${board.id}`,
                      { version: board.version, archived: !board.archived },
                      "PATCH",
                    );
                  })
                }
              >
                {board.archived ? "Restore board" : "Archive board"}
              </Button>
              <Button
                variant={board.deletedAt ? "secondary" : "danger-ghost"}
                isDisabled={busy}
                onPress={() => {
                  if (board.deletedAt)
                    void settingsRun(async () => {
                      await api(`/boards/${board.id}/restore`, {
                        version: board.version,
                      });
                    });
                  else setConfirmBoard(true);
                }}
              >
                {board.deletedAt ? "Restore deleted board" : "Delete board"}
              </Button>
            </div>
          </section>
        </Dialog>
      )}
      {confirmBoard && board && (
        <Dialog
          open
          onClose={() => setConfirmBoard(false)}
          title="Delete board?"
          footer={
            <>
              <Button
                variant="secondary"
                onPress={() => setConfirmBoard(false)}
              >
                Keep board
              </Button>
              <Button
                variant="danger"
                isDisabled={busy}
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
  busy,
  onSave,
  onShift,
  first,
  last,
  onDelete,
}: {
  column: Column;
  busy: boolean;
  onSave: (name: string, color: string) => void;
  onShift: (delta: number) => void;
  first: boolean;
  last: boolean;
  onDelete: () => void;
}) {
  const [name, setName] = useState(column.name);
  const [color, setColor] = useState(column.color);
  useEffect(() => {
    setName(column.name);
    setColor(column.color);
  }, [column.name, column.color]);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="column-editor">
      <TextField
        label="Status name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
      />
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
        ].map((id) => ({ id, name: id }))}
        disabled={busy}
      />
      <Button
        variant="secondary"
        isDisabled={
          busy ||
          (name === column.name && color === column.color) ||
          !name.trim()
        }
        onPress={() => onSave(name, color)}
      >
        Save
      </Button>
      <Button
        variant="ghost"
        aria-label={`Move ${column.name} earlier`}
        isDisabled={busy || first}
        onPress={() => onShift(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        aria-label={`Move ${column.name} later`}
        isDisabled={busy || last}
        onPress={() => onShift(1)}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="danger-ghost"
        isDisabled={busy}
        onPress={() => setConfirm(true)}
      >
        Delete
      </Button>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete status?"
        footer={
          <>
            <Button variant="secondary" onPress={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                onDelete();
                setConfirm(false);
              }}
            >
              Delete status
            </Button>
          </>
        }
      >
        <p>Move tasks out of this status before deleting it.</p>
      </Dialog>
    </div>
  );
}
