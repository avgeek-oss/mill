import { QueryFeedback } from "./query-feedback.js";
import { RouteLink as Link } from "@avgeek-oss/design-system/navigation/route-link";
import { ActionConfirmation, ResourceTable } from "@avgeek-oss/design-system";
import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
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
  TableCellStack,
  TableCellDescription,
  TooltipText,
  TypographyHeading,
  Chip,
  Pagination,
  QueryLoading,
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
import { BoardFilters } from "./board-filters.js";
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
import { TaskTypeIndicator } from "./task-type.js";
const CreateTaskDialog = lazy(() =>
  import("./create-task-dialog.js").then((m) => ({
    default: m.CreateTaskDialog,
  })),
);
import { ErrorPage, errorPageCode } from "./error-page.js";
type Page = { items: Task[]; total: number; page: number; revision: string };

function TaskIdentity({ name, email = "" }: { name?: string; email?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {name && (
        <Avatar
          email={email}
          name={name}
          size="sm"
          className="size-7 shrink-0 rounded-full [&_[data-slot=avatar-fallback]]:text-xs [&_[data-slot=avatar-fallback]]:text-muted"
        />
      )}
      <TooltipText
        className={`block min-w-0 flex-1 truncate${name ? "" : " text-muted"}`}
        tooltip={name || "Unassigned"}
      >
        {name || "Unassigned"}
      </TooltipText>
    </span>
  );
}

export function BoardPage({
  boardId,
  boards,
  user,
  members,
  onBoardsChanged,
  onBoardLoaded,
  path,
  sessionRevision,
  filterContainer,
  onOpenFilters,
}: {
  boardId: string;
  boards: Board[];
  user: User;
  members: Member[];
  onBoardsChanged: (removedBoardId?: string) => void;
  onBoardLoaded: (board: Board) => void;
  path: string;
  sessionRevision: number;
  filterContainer?: HTMLElement | null;
  onOpenFilters?: () => void;
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
  const [query, setQuery] = useState(q);
  const [creatingTask, setCreatingTask] = useState(false);
  const [confirmBoard, setConfirmBoard] = useState(false);
  const [boardDeleteKey] = useState(createRetryKey);
  const [settings, setSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState({
    name: "",
    description: "",
  });
  const [busy, setBusy] = useState(false);
  const mutationRequest = useRef<AbortController | null>(null);
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
  const newTaskButton = useRef<HTMLButtonElement | null>(null);
  const boardActionsButton = useRef<HTMLButtonElement | null>(null);
  const boardDialogWasOpen = useRef(false);
  const boardContent = useRef<HTMLDivElement>(null);
  const appSuspended = useAppSuspended();
  const writable = !!board && user.role !== "viewer";
  useLayoutEffect(() => {
    setBusy(false);
    return () => {
      mutationRequest.current?.abort();
      mutationRequest.current = null;
      ++latestLoad.current;
    };
  }, [appSuspended, boardId]);
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
    for (const key of ["assigneeId", "priority", "status"] as const)
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
      if (document.querySelector('[data-board-dialog], [role="dialog"]'))
        return;
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
    action: (signal: AbortSignal) => Promise<void>,
    notice = "Changes saved.",
  ) {
    if (busy || appSuspended || mutationRequest.current) return false;
    const request = new AbortController();
    mutationRequest.current = request;
    const current = () =>
      mutationRequest.current === request && !request.signal.aborted;
    pendingSettingsOpener.current =
      settings && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBusy(true);
    setSettingsError("");
    try {
      await action(request.signal);
      if (!current()) return false;
      await load(taskPage, true);
      if (!current()) return false;
      onBoardsChanged();
      toast.success(notice);
      return true;
    } catch (e) {
      if (current()) setSettingsError(errorText(e));
      return false;
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = null;
        setBusy(false);
      }
    }
  }
  async function deleteBoard() {
    if (
      busy ||
      appSuspended ||
      mutationRequest.current ||
      !board ||
      user.role !== "admin"
    )
      return;
    const request = new AbortController();
    mutationRequest.current = request;
    setBusy(true);
    setSettingsError("");
    try {
      await api(`/boards/${board.id}`, { version: board.version }, "DELETE", {
        validateResponse: hasOkResponse,
        signal: request.signal,
        headers: {
          "Idempotency-Key": boardDeleteKey.forRequest(
            `/boards/${board.id}`,
            { version: board.version },
            "DELETE",
          ),
        },
      });
      if (mutationRequest.current !== request || request.signal.aborted) return;
      boardDeleteKey.reset();
      ++latestLoad.current;
      setConfirmBoard(false);
      setSettings(false);
      onBoardsChanged(board.id);
      toast.success("Board deleted.");
      navigate("/boards");
    } catch (cause) {
      if (mutationRequest.current === request && !request.signal.aborted)
        throw cause;
    } finally {
      if (mutationRequest.current === request) {
        mutationRequest.current = null;
        setBusy(false);
      }
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
    changeList({
      q: "",
      page: 1,
      assigneeId: "",
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
  if (!accessDenied && !board && !loading && error)
    return (
      <QueryFeedback
        message={error}
        onRetry={() => void load(requestedPage.current, true)}
      />
    );
  const accessFailure = (
    <ErrorPage
      code={errorPageCode(errorStatus)}
      pending={loading}
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
        aria-busy={loading}
      >
        <SuspendedAppProvider value={appSuspended || accessDenied}>
          <PortalProvider getContainer={() => boardContent.current}>
            <PageHeading
              truncateTitle
              title={
                board?.name ??
                boards.find((item) => item.id === boardId)?.name ??
                "Board"
              }
              icon={<List />}
              actions={
                <div className="flex shrink-0 items-center gap-2">
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
                            if (key === "settings" && board) {
                              setSettingsDraft({
                                name: board.name,
                                description: board.description ?? "",
                              });
                              setSettings(true);
                            } else if (
                              key === "delete" &&
                              user.role === "admin"
                            )
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
                              className="text-danger-soft-foreground [&_svg]:text-danger-soft-foreground"
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
            <div className="mb-4 flex min-w-0 items-center gap-3">
              <SearchField
                aria-label="Search tasks"
                variant="secondary"
                className="min-w-0 flex-1 lg:max-w-sm"
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
              {onOpenFilters && (
                <Button
                  className="shrink-0 lg:hidden"
                  variant="secondary"
                  onPress={onOpenFilters}
                >
                  <Settings2 />
                  Filters
                </Button>
              )}
            </div>
            {filterContainer &&
              !appSuspended &&
              !accessDenied &&
              createPortal(
                <PortalProvider
                  getContainer={() =>
                    filterContainer.closest('[role="dialog"]')
                      ? filterContainer
                      : boardContent.current
                  }
                >
                  <BoardFilters
                    filters={filters}
                    members={members}
                    hasFilters={hasFilters}
                    onChange={changeList}
                    onClear={clearFilters}
                  />
                </PortalProvider>,
                filterContainer,
              )}
            {!accessDenied && error && board && (
              <ErrorMessage>{error}</ErrorMessage>
            )}
            {loading && !tasks.length ? (
              <QueryLoading className="sr-only">Loading tasks…</QueryLoading>
            ) : !tasks.length ? (
              error ? null : (
                emptyTasks()
              )
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
                          variant="soft"
                          size="sm"
                          aria-label={`${group.tasks.length} tasks on this page`}
                        >
                          {group.tasks.length}
                        </Chip>
                      </div>
                    )}
                    <ResourceTable
                      ariaLabel={
                        group.name ? `${group.name} tasks` : "Task list"
                      }
                      tableClassName="task-table"
                      items={group.tasks}
                      getRowKey={(task) => task.id}
                      emptyTitle="No tasks yet"
                      emptyDescription="Tasks created by your team will appear here."
                      columns={[
                        {
                          key: "identifier",
                          header: "Task ID",
                          isRowHeader: false,
                          className: "hidden sm:table-cell",
                          headerClassName: "hidden sm:table-cell",
                          cell: (task) => (
                            <div className="flex min-w-0 items-center gap-2">
                              <TaskTypeIndicator type={task.type} />
                              <Link
                                href={`/boards/${boardId}/tasks/${task.id}${window.location.search}`}
                                className="block shrink-0 whitespace-nowrap rounded-lg font-mono text-sm text-muted hover:underline"
                              >
                                {task.identifier}
                              </Link>
                            </div>
                          ),
                        },
                        {
                          key: "title",
                          header: "Task",
                          isRowHeader: true,
                          cell: (task) => (
                            <Link
                              href={`/boards/${boardId}/tasks/${task.id}${window.location.search}`}
                              className="block min-w-0 rounded-lg hover:underline"
                            >
                              <TableCellStack>
                                <TooltipText
                                  className="block w-full truncate align-middle"
                                  tooltip={task.title}
                                >
                                  {task.title}
                                </TooltipText>
                                <TableCellDescription className="flex items-center gap-2 font-mono sm:hidden">
                                  <TaskTypeIndicator
                                    type={task.type}
                                    focusable={false}
                                  />
                                  <span className="shrink-0 whitespace-nowrap">
                                    {task.identifier}
                                  </span>
                                </TableCellDescription>
                              </TableCellStack>
                            </Link>
                          ),
                        },
                        {
                          key: "status",
                          header: "Status",
                          headerClassName: "w-36",
                          cell: (task) => <StatusChip status={task.status} />,
                        },
                        {
                          key: "assignee",
                          header: "Assignee",
                          headerClassName: "w-40",
                          cell: (task) => {
                            const member = members.find(
                              (member) => member.id === task.assigneeId,
                            );
                            return (
                              <TaskIdentity
                                name={member?.name}
                                email={member?.email}
                              />
                            );
                          },
                        },
                        {
                          key: "priority",
                          header: "Priority",
                          headerClassName: "w-32",
                          cell: (task) => (
                            <PriorityChip priority={task.priority} />
                          ),
                        },
                      ]}
                    />
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
                <fieldset disabled={paginationDisabled || taskListChanged}>
                  <Pagination
                    className="w-auto"
                    aria-label="Task pages"
                    page={taskPage}
                    totalPages={totalPages}
                    onPageChange={(page) => {
                      if (
                        !paginationDisabled &&
                        !taskListChanged &&
                        page !== taskPage
                      ) {
                        rememberPaginationFocus();
                        changeList({ page });
                      }
                    }}
                  />
                </fieldset>
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
              >
                <ErrorMessage>{settingsError}</ErrorMessage>
                <form
                  className="content-grid min-w-0"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void settingsRun(async (signal) => {
                      await api(
                        `/boards/${board.id}`,
                        {
                          version: board.version,
                          name: data.get("name"),
                          description: data.get("description"),
                        },
                        "PATCH",
                        { signal },
                      );
                    }, "Board updated.");
                  }}
                >
                  <TextField
                    label="Board name"
                    name="name"
                    value={settingsDraft.name}
                    onChange={(event) =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        name: event.target.value,
                      }))
                    }
                    required
                    maxLength={100}
                    disabled={!writable}
                    className="min-w-0 w-full"
                  />
                  <TextField
                    label="Description"
                    name="description"
                    value={settingsDraft.description}
                    onChange={(event) =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        description: event.target.value,
                      }))
                    }
                    multiline
                    maxLength={2000}
                    disabled={!writable}
                    className="min-w-0 w-full"
                  />
                  <div className="flex">
                    <Button
                      type="submit"
                      isPending={busy}
                      isDisabled={!writable}
                    >
                      <Save />
                      <span className="grid">
                        <span aria-hidden className="invisible [grid-area:1/1]">
                          Save board
                        </span>
                        <span className="[grid-area:1/1]">
                          {busy ? "Saving…" : "Save board"}
                        </span>
                      </span>
                    </Button>
                  </div>
                </form>
              </Dialog>
            )}
            {confirmBoard && board && user.role === "admin" && (
              <ActionConfirmation
                isOpen
                onOpenChange={setConfirmBoard}
                title="Delete board?"
                description={`Permanently delete “${board.name}” and all of its tasks and comments? This cannot be undone. There is no restore.`}
                confirmLabel="Delete board"
                variant="danger"
                onConfirm={deleteBoard}
              />
            )}
          </PortalProvider>
        </SuspendedAppProvider>
      </div>
    </>
  );
}
