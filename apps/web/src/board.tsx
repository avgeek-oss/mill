import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons/core-free-icons";
import {
  Button,
  Avatar,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
  SearchField,
  Dropdown,
  EmptyState,
  TypographyText,
  Table,
  TableCellStack,
  TableCellDescription,
  Link,
  TooltipText,
  TypographyParagraph,
  TypographyHeading,
  Chip,
  Pagination,
  PortalProvider,
  SuspendedAppProvider,
  useAppSuspended,
  toast,
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
import { boardUrl, parseBoardUrl, type BoardUrlState } from "./board-url.js";
import { hasOkResponse } from "./responses.js";
import { PriorityChip, priorityOptions } from "./task-priority.js";
import { StatusChip, statusOptions } from "./task-status.js";
import { useAgentDirectory } from "./agents-settings.js";
const CreateTaskDialog = lazy(() =>
  import("./create-task-dialog.js").then((m) => ({
    default: m.CreateTaskDialog,
  })),
);
import { ErrorPage, errorPageCode } from "./error-page.js";
type Page = { items: Task[]; total: number; page: number; revision: string };
export function BoardPage({
  boardId,
  boards,
  user,
  members,
  onBoardsChanged,
  onBoardLoaded,
  path,
  sessionRevision,
}: {
  boardId: string;
  boards: Board[];
  user: User;
  members: Member[];
  onBoardsChanged: (removedBoardId?: string) => void;
  onBoardLoaded: (board: Board) => void;
  path: string;
  sessionRevision: number;
}) {
  const listState = useMemo(() => parseBoardUrl(path), [path]);
  const q = listState.q;
  const filters = listState;
  const pageSize = listState.limit;
  const [board, setBoard] = useState<Board | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskPage, setTaskPage] = useState(listState.page);
  const [displayedPageSize, setDisplayedPageSize] = useState(pageSize);
  const [taskTotal, setTaskTotal] = useState<number | null>(null);
  const [displayedSort, setDisplayedSort] = useState(filters.sort);
  const [errorStatus, setErrorStatus] = useState(0);
  const [accessDenied, setAccessDenied] = useState(false);
  const deniedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [taskListChanged, setTaskListChanged] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [query, setQuery] = useState(q);
  const [creatingTask, setCreatingTask] = useState(false);
  const [confirmBoard, setConfirmBoard] = useState(false);
  const [boardDeleteKey] = useState(createRetryKey);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingSettingsOpener = useRef<HTMLElement | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const latestLoad = useRef(0);
  const requestedPage = useRef(listState.page);
  const pageCollection = useRef<{ query: string; revision?: string }>({
    query: "",
  });
  const loadedPage = useRef<{ query: string; page: number } | null>(null);
  const lastSessionRevision = useRef(sessionRevision);
  const creationOpener = useRef<HTMLElement | null>(null);
  const creationWasOpen = useRef(false);
  const taskList = useRef<HTMLDivElement | null>(null);
  const paginationFooter = useRef<HTMLDivElement | null>(null);
  const paginationOpener = useRef<HTMLElement | null>(null);
  const retryTasksButton = useRef<HTMLButtonElement | null>(null);
  const agentFilter = useRef<HTMLDivElement | null>(null);
  const newTaskButton = useRef<HTMLButtonElement | null>(null);
  const boardActionsButton = useRef<HTMLButtonElement | null>(null);
  const boardDialogWasOpen = useRef(false);
  const boardContent = useRef<HTMLDivElement>(null);
  const appSuspended = useAppSuspended();
  const writable = !!board && user.role !== "viewer";
  useLayoutEffect(() => {
    if (
      !board ||
      loading ||
      accessDenied ||
      window.history.state?.millFocusAfterTaskDeletion !== true
    )
      return;
    const target = newTaskButton.current;
    if (!target) return;
    const nextState = { ...window.history.state };
    delete nextState.millFocusAfterTaskDeletion;
    window.history.replaceState(nextState, "", window.location.href);
    target.focus({ preventScroll: true });
  }, [board, loading, accessDenied]);
  const agentDirectory = useAgentDirectory(`${user.id}:${user.role}`);
  function changeList(changes: Partial<BoardUrlState>, replace = false) {
    if (window.location.pathname !== `/boards/${boardId}`) return;
    const next = boardUrl(
      boardId,
      { ...listState, q: query, ...changes },
      window.location.search,
    );
    if (next === `${window.location.pathname}${window.location.search}`) return;
    if (replace) {
      window.history.replaceState(window.history.state, "", next);
      window.dispatchEvent(new Event("mill:navigate"));
    } else navigate(next);
  }
  useLayoutEffect(() => setQuery(q), [q]);
  useEffect(() => {
    const restoreSearch = () =>
      setQuery(
        parseBoardUrl(window.location.pathname + window.location.search).q,
      );
    window.addEventListener("popstate", restoreSearch);
    return () => window.removeEventListener("popstate", restoreSearch);
  }, []);
  useEffect(() => {
    if (window.location.pathname !== `/boards/${boardId}`) return;
    const next = boardUrl(boardId, listState, window.location.search);
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, "", next);
      window.dispatchEvent(new Event("mill:navigate"));
    }
  }, [boardId, path]);
  useEffect(() => {
    if (query === q) return;
    const timer = setTimeout(
      () => changeList({ q: query, page: 1 }, true),
      250,
    );
    return () => clearTimeout(timer);
  }, [query, q, path]);
  function taskQuery(page?: number, revision?: string) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      sort: filters.sort,
    });
    if (q) params.set("q", q);
    for (const key of ["assigneeId", "agentId", "priority", "status"] as const)
      if (filters[key]) params.set(key, filters[key]);
    if (page) params.set("page", String(page));
    if (revision) params.set("revision", revision);
    return params;
  }
  async function load(targetPage = 1, refresh = false) {
    const request = ++latestLoad.current;
    requestedPage.current = targetPage;
    setLoading(true);
    setError("");
    setTaskListChanged(false);
    const queryKey = `${boardId}?${taskQuery()}`;
    if (refresh || pageCollection.current.query !== queryKey) {
      pageCollection.current = { query: queryKey };
    }
    const collection = pageCollection.current;
    async function readPage() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await api<Page>(
            `/boards/${boardId}/tasks?${taskQuery(targetPage, collection.revision)}`,
          );
        } catch (e) {
          if (request !== latestLoad.current) return null;
          if (!(e instanceof ApiError) || e.status !== 409 || attempt > 0)
            throw e;
          collection.revision = undefined;
        }
      }
      return null;
    }
    try {
      const [info, page] = await Promise.all([
        api<{ board: Board }>(`/boards/${boardId}`),
        readPage(),
      ]);
      if (!page || request !== latestLoad.current) return;
      setBoard(info.board);
      deniedRef.current = false;
      setAccessDenied(false);
      setErrorStatus(0);
      onBoardLoaded(info.board);
      setTasks(page.items);
      collection.revision = page.revision;
      setTaskPage(page.page);
      loadedPage.current = { query: queryKey, page: page.page };
      requestedPage.current = page.page;
      setTaskTotal(page.total);
      setDisplayedPageSize(pageSize);
      setDisplayedSort(filters.sort);
      if (page.page !== targetPage) changeList({ page: page.page, q }, true);
    } catch (e) {
      if (request === latestLoad.current) {
        const changed = e instanceof ApiError && e.status === 409;
        if (e instanceof ApiError && [403, 404].includes(e.status)) {
          if (!deniedRef.current)
            window.dispatchEvent(new Event("mill:route-access-denied"));
          deniedRef.current = true;
          setAccessDenied(true);
        }
        setError(errorText(e));
        setErrorStatus(e instanceof ApiError ? e.status : -1);
        setTaskListChanged(changed);
      }
    } finally {
      if (request === latestLoad.current) {
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    if (accessDenied) document.title = "Board unavailable · Mill";
    else if (board) document.title = `${board.name} · Mill`;
  }, [board?.name, path, accessDenied]);
  useEffect(() => {
    const queryKey = `${boardId}?${taskQuery()}`;
    const resumed = lastSessionRevision.current !== sessionRevision;
    lastSessionRevision.current = sessionRevision;
    if (
      !resumed &&
      loadedPage.current?.query === queryKey &&
      loadedPage.current.page === listState.page
    ) {
      requestedPage.current = listState.page;
      setLoading(false);
      setError("");
      setErrorStatus(0);
      setTaskListChanged(false);
      return;
    }
    void load(listState.page);
    return () => {
      ++latestLoad.current;
    };
  }, [
    boardId,
    q,
    filters.assigneeId,
    filters.agentId,
    filters.priority,
    filters.status,
    filters.sort,
    pageSize,
    listState.page,
    sessionRevision,
  ]);
  function rememberPaginationFocus(element = document.activeElement) {
    const opener =
      element instanceof HTMLElement &&
      (paginationFooter.current?.contains(element) ||
        element === retryTasksButton.current)
        ? element
        : paginationFooter.current?.querySelector<HTMLElement>(
            'button[aria-current="page"]',
          );
    if (opener) {
      paginationOpener.current = opener;
      paginationFooter.current?.focus({ preventScroll: true });
    }
  }
  useLayoutEffect(() => {
    const opener = paginationOpener.current;
    if (loading || !opener) return;
    paginationOpener.current = null;
    const active = document.activeElement;
    if (
      active !== document.body &&
      active !== paginationFooter.current &&
      active !== opener
    )
      return;
    const target =
      opener.isConnected && !opener.matches(":disabled")
        ? opener
        : (retryTasksButton.current ??
          paginationFooter.current?.querySelector<HTMLElement>(
            'button[aria-current="page"]',
          ));
    target?.focus({ preventScroll: true });
  }, [loading, taskPage, taskTotal]);
  function openCreation() {
    if (!writable) return;
    creationOpener.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : newTaskButton.current;
    setCreatingTask(true);
  }
  useEffect(() => {
    if (creatingTask) {
      creationWasOpen.current = true;
      return;
    }
    if (!creationWasOpen.current) return;
    let frame = 0;
    const restore = () => {
      creationWasOpen.current = false;
      const opener = creationOpener.current;
      creationOpener.current = null;
      const active = document.activeElement;
      if (
        active !== document.body &&
        active !== opener &&
        !taskList.current?.contains(active)
      )
        return;
      const target =
        opener?.isConnected && !opener.matches(":disabled")
          ? opener
          : newTaskButton.current;
      const row = target?.closest<HTMLElement>('[role="row"]');
      if (row && taskList.current?.contains(row))
        flushSync(() => row.focus({ preventScroll: true }));
      target?.focus({ preventScroll: true });
    };
    const afterDialogRemoved = () => {
      if (document.querySelector("[data-create-task-dialog]")) return;
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
  }, [creatingTask]);
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
        creatingTask ||
        settings
      )
        return;
      if (e.key.toLowerCase() === "n" && writable) {
        e.preventDefault();
        openCreation();
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        document.getElementById("board-search")?.focus();
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [creatingTask, settings, writable]);
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
    try {
      await action();
      await load(taskPage, true);
      onBoardsChanged();
      toast.success(notice);
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
    filters.agentId ||
    filters.priority ||
    filters.status
  );
  function clearFilters() {
    setQuery("");
    changeList({
      q: "",
      page: 1,
      assigneeId: "",
      agentId: "",
      priority: "",
      status: "",
      sort: "createdAt",
    });
  }
  const groups =
    displayedSort === "priority" || displayedSort === "status"
      ? (displayedSort === "priority" ? priorityOptions : statusOptions)
          .map((option) => ({
            ...option,
            tasks: tasks.filter(
              (task) =>
                task[displayedSort === "priority" ? "priority" : "status"] ===
                option.id,
            ),
          }))
          .filter((group) => group.tasks.length > 0)
      : [{ id: "all", name: "", startContent: null, tasks }];
  const paginationDisabled = loading || query !== q;
  const totalPages = Math.max(
    1,
    Math.ceil((taskTotal ?? 0) / displayedPageSize),
  );
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
            writable && <Button onPress={openCreation}>Create task</Button>
          )}
        </EmptyState.Content>
      </EmptyState>
    );
  }
  if (!accessDenied && !board && !loading && errorStatus >= 500)
    return (
      <ErrorPage
        code={errorPageCode(errorStatus)}
        onRetry={() => void load(requestedPage.current, true)}
      />
    );
  const accessFailure = (
    <ErrorPage
      code={errorPageCode(errorStatus)}
      title={
        errorStatus === 403 ? "Board access required" : "Board unavailable"
      }
      description={
        errorStatus === 403
          ? "You do not have access to this board. Ask an administrator or return to your boards."
          : errorStatus === 404
            ? "This board may have been deleted or the link may be outdated."
            : error || "This board could not be opened. Try again."
      }
      onRetry={() => void load(requestedPage.current, true)}
    />
  );
  if (!board && (accessDenied || !loading)) return accessFailure;
  return (
    <>
      {accessDenied && accessFailure}
      <div
        ref={boardContent}
        hidden={accessDenied}
        inert={accessDenied}
        aria-hidden={accessDenied}
      >
        <SuspendedAppProvider value={appSuspended || accessDenied}>
          <PortalProvider getContainer={() => boardContent.current}>
            <PageHeading
              title={
                board?.name ??
                boards.find((item) => item.id === boardId)?.name ??
                "Board"
              }
              icon={<List />}
              actions={
                <div className="flex flex-wrap items-center gap-3">
                  <div className="w-36 min-w-0">
                    <Choice
                      variant="secondary"
                      label="Sort"
                      hideLabel
                      value={filters.sort}
                      onChange={(v) => changeList({ sort: v, page: 1 })}
                      items={[
                        { id: "createdAt", name: "Newest first" },
                        { id: "title", name: "Title" },
                        { id: "updatedAt", name: "Recently updated" },
                        { id: "dueDate", name: "Due date" },
                        { id: "priority", name: "Priority" },
                        { id: "status", name: "Status" },
                      ]}
                    />
                  </div>
                  {writable && (
                    <Button ref={newTaskButton} onPress={openCreation}>
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
                      <Dropdown.Popover
                        placement="bottom end"
                        className="min-w-44"
                      >
                        <Dropdown.Menu
                          aria-label="Board actions"
                          onAction={(key) => {
                            setSettingsError("");
                            if (key === "settings") setSettings(true);
                            else if (key === "delete" && user.role === "admin")
                              setConfirmBoard(true);
                          }}
                        >
                          <Dropdown.Item
                            id="settings"
                            textValue="Board settings"
                          >
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
            <div
              className={`board-toolbar ${mobileFilters ? "filters-open" : ""}`}
            >
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
                  onChange={(v) => changeList({ assigneeId: v, page: 1 })}
                  items={[
                    { id: "", name: "All assignees" },
                    { id: "unassigned", name: "Unassigned", muted: true },
                    ...members.map((member) => ({
                      id: member.id,
                      name: member.name,
                      startContent: (
                        <Avatar
                          className="size-5"
                          email={member.email}
                          name={member.name}
                          size="sm"
                        />
                      ),
                    })),
                  ]}
                  search
                />
              </div>
              <div className="board-filter-slot" ref={agentFilter}>
                <Choice
                  variant="secondary"
                  label="Agent filter"
                  hideLabel
                  value={filters.agentId}
                  onChange={(value) => changeList({ agentId: value, page: 1 })}
                  items={[
                    { id: "", name: "All agents" },
                    { id: "unassigned", name: "Unassigned", muted: true },
                    ...agentDirectory.items.map((agent) => ({
                      id: agent.id,
                      name: agent.name,
                      startContent: (
                        <HugeiconsIcon
                          icon={BotIcon}
                          size={16}
                          aria-hidden="true"
                          className="shrink-0 text-muted"
                        />
                      ),
                    })),
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
                  onChange={(v) => changeList({ priority: v, page: 1 })}
                  items={[
                    { id: "", name: "All priorities" },
                    ...priorityOptions,
                  ]}
                />
              </div>
              <div className="board-filter-slot">
                <Choice
                  variant="secondary"
                  label="Status filter"
                  hideLabel
                  value={filters.status}
                  onChange={(v) => changeList({ status: v, page: 1 })}
                  items={[{ id: "", name: "All statuses" }, ...statusOptions]}
                />
              </div>
              {hasFilters && (
                <div className="board-clear-slot">
                  <Button variant="secondary" onPress={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              )}
            </div>
            <ErrorMessage>{agentDirectory.error}</ErrorMessage>
            {agentDirectory.error && (
              <div>
                <Button
                  variant="secondary"
                  isDisabled={agentDirectory.pending}
                  onPress={() => {
                    agentFilter.current
                      ?.querySelector<HTMLElement>("button")
                      ?.focus({ preventScroll: true });
                    void agentDirectory.reload();
                  }}
                >
                  Retry loading agents
                </Button>
              </div>
            )}
            <ErrorMessage>{error}</ErrorMessage>
            {error && board && (
              <div>
                <Button
                  ref={retryTasksButton}
                  variant="secondary"
                  isDisabled={loading}
                  onPress={() => {
                    rememberPaginationFocus(retryTasksButton.current);
                    void load(requestedPage.current, true);
                  }}
                >
                  Retry loading tasks
                </Button>
              </div>
            )}
            {loading && !tasks.length ? null : !tasks.length ? (
              emptyTasks()
            ) : (
              <div ref={taskList} className="space-y-4" aria-busy={loading}>
                {groups.map((group) => (
                  <section key={group.id} className="space-y-3">
                    {group.name && (
                      <div className="flex items-center gap-2 pt-2">
                        <TypographyHeading
                          elementType="h2"
                          className="flex items-center gap-2 text-sm font-normal tracking-normal"
                        >
                          {group.startContent}
                          {group.name}
                        </TypographyHeading>
                        <Chip
                          variant="secondary"
                          size="small"
                          aria-label={`${group.tasks.length} tasks on this page`}
                        >
                          {group.tasks.length}
                        </Chip>
                      </div>
                    )}
                    <Table>
                      <Table.ScrollContainer>
                        <Table.Content
                          className="task-table"
                          aria-label={
                            group.name ? `${group.name} tasks` : "Task list"
                          }
                        >
                          <Table.Header>
                            <Table.Column isRowHeader>Task</Table.Column>
                            <Table.Column className="w-36">Status</Table.Column>
                            <Table.Column className="w-40">
                              Assignee
                            </Table.Column>
                            <Table.Column className="w-28">Agent</Table.Column>
                            <Table.Column className="w-32">
                              Priority
                            </Table.Column>
                          </Table.Header>
                          <Table.Body>
                            {group.tasks.map((task) => (
                              <Table.Row
                                key={task.id}
                                id={task.id}
                                data-task-id={task.id}
                              >
                                <Table.Cell>
                                  <Link
                                    href={`/boards/${boardId}/tasks/${task.id}${window.location.search}`}
                                    className="block min-w-0 rounded-lg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                                  >
                                    <TableCellStack>
                                      <TooltipText
                                        className="block w-full truncate align-middle"
                                        tooltip={task.title}
                                      >
                                        {task.title}
                                      </TooltipText>
                                      <TableCellDescription className="font-mono">
                                        {task.identifier}
                                      </TableCellDescription>
                                    </TableCellStack>
                                  </Link>
                                </Table.Cell>
                                <Table.Cell>
                                  <StatusChip status={task.status} />
                                </Table.Cell>
                                <Table.Cell>
                                  <TooltipText
                                    className={`block truncate${task.assigneeId ? "" : " text-muted"}`}
                                    tooltip={
                                      members.find(
                                        (m) => m.id === task.assigneeId,
                                      )?.name ?? "Unassigned"
                                    }
                                  >
                                    {members.find(
                                      (m) => m.id === task.assigneeId,
                                    )?.name ?? "Unassigned"}
                                  </TooltipText>
                                </Table.Cell>
                                <Table.Cell>
                                  <TooltipText
                                    className={`block truncate${task.agentName ? "" : " text-muted"}`}
                                    tooltip={task.agentName || "Unassigned"}
                                  >
                                    {task.agentName || "Unassigned"}
                                  </TooltipText>
                                </Table.Cell>
                                <Table.Cell>
                                  <PriorityChip priority={task.priority} />
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Content>
                      </Table.ScrollContainer>
                    </Table>
                  </section>
                ))}
              </div>
            )}
            {taskTotal !== null && (
              <div
                ref={paginationFooter}
                role="group"
                aria-label="Task list pagination"
                aria-busy={loading}
                tabIndex={-1}
                className="mt-3 flex flex-wrap items-center justify-end gap-3 outline-none"
              >
                <TypographyText textRole="caption" role="status">
                  {taskTotal === 0
                    ? "0 tasks"
                    : `${(taskPage - 1) * displayedPageSize + 1}–${Math.min(taskPage * displayedPageSize, taskTotal)} of ${taskTotal} tasks`}
                </TypographyText>
                <Pagination
                  className="w-auto"
                  aria-label="Task pages"
                  page={taskPage}
                  totalPages={totalPages}
                  isDisabled={paginationDisabled || taskListChanged}
                  onPageChange={(page) => {
                    if (!paginationDisabled && page !== taskPage) {
                      rememberPaginationFocus();
                      changeList({ page });
                    }
                  }}
                />
                <Choice
                  className="w-36"
                  label="Tasks per page"
                  hideLabel
                  variant="secondary"
                  value={String(pageSize)}
                  disabled={paginationDisabled}
                  onChange={(value) => {
                    if (Number(value) === pageSize) return;
                    rememberPaginationFocus(
                      paginationFooter.current?.querySelector<HTMLElement>(
                        'button[aria-haspopup="listbox"]',
                      ) ?? null,
                    );
                    changeList({ limit: Number(value), page: 1 });
                  }}
                  items={[10, 25, 50, 100].map((size) => ({
                    id: String(size),
                    name: `${size} per page`,
                  }))}
                />
              </div>
            )}
            {creatingTask && (
              <Suspense fallback={null}>
                <CreateTaskDialog
                  boardId={boardId}
                  members={members}
                  user={user}
                  open={creatingTask}
                  onClose={() => setCreatingTask(false)}
                  onCreated={(task) => {
                    setCreatingTask(false);
                    navigate(
                      `/boards/${boardId}/tasks/${task.id}${window.location.search}`,
                    );
                  }}
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
                    {busy && (
                      <TypographyText textRole="supporting" role="status">
                        Saving…
                      </TypographyText>
                    )}
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
                <TypographyParagraph className="text-xs">
                  Permanently delete “{board.name}” and all of its tasks and
                  comments? This cannot be undone. There is no restore.
                </TypographyParagraph>
                <ErrorMessage>{settingsError}</ErrorMessage>
              </Dialog>
            )}
          </PortalProvider>
        </SuspendedAppProvider>
      </div>
    </>
  );
}
