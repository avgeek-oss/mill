import { usePageRead } from "./page-navigation.js";
import { readBoardPage } from "./board-page-data.js";
import { useBoardAccess } from "./use-board-access.js";
import { RouteLink as Link } from "@avgeek-oss/design-system/navigation/route-link";
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
import {
  Button,
  Avatar,
  Choice,
  ErrorMessage,
  SearchField,
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
import { List, Plus, Filter, Sort } from "./icons.js";
import { PageHeading } from "./page-heading.js";
import { BoardFiltersDialog, BoardSortDialog } from "./board-filters.js";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import type {
  Board,
  Member,
  Task,
  BulkTaskChanges,
} from "../../../packages/contracts/src/index.js";
import { DEFAULT_TASK_SORT } from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  api,
  errorText,
  isResponseObject,
  navigate,
  type NavigationRequest,
  type User,
} from "./api.js";
import { boardUrl, parseBoardUrl, type BoardUrlState } from "./board-url.js";
import { formatDate } from "./date-time-preferences.js";
import { PriorityChip, priorityOptions } from "./task-priority.js";
import { StatusChip, statusOptions } from "./task-status.js";
import { TaskTypeIndicator } from "./task-type.js";
import { navigationCache, type TaskListPage } from "./navigation-cache.js";
import { preloadTaskPage } from "./task-page-loader.js";
import { TaskTable } from "./task-table.js";
import {
  BulkTaskBar,
  BulkTaskDialog,
  type BulkTaskField,
} from "./bulk-task-actions.js";
import { hasTaskResponse } from "./responses.js";
const CreateTaskDialog = lazy(() =>
  import("./create-task-dialog.js").then((m) => ({
    default: m.CreateTaskDialog,
  })),
);
import { ErrorPage, errorPageCode } from "./error-page.js";
type Page = TaskListPage;

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
        className={`block min-w-0 flex-1 truncate${name ? "" : " text-muted opacity-50"}`}
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
  onBoardLoaded,
  path,
  sessionRevision,
}: {
  boardId: string;
  boards: Board[];
  user: User;
  members: Member[];
  onBoardLoaded: (board: Board) => void;
  path: string;
  sessionRevision: number;
}) {
  const listState = useMemo(() => parseBoardUrl(path), [path]);
  const search = new URL(path, window.location.origin).search;
  const prepared = usePageRead(
    `board-list:${boardUrl(boardId, listState)}:${sessionRevision}`,
    (signal) => readBoardPage(boardId, listState, signal),
  );
  const preparedError =
    prepared?.status === "rejected" ? prepared.reason : null;
  const preparedStatus =
    preparedError instanceof ApiError
      ? preparedError.status
      : preparedError
        ? -1
        : 0;
  const q = listState.q;
  const filters = listState;
  const pageSize = listState.limit;
  const [initialPage] = useState(() =>
    prepared?.status === "fulfilled"
      ? prepared.value
      : preparedError
        ? null
        : navigationCache.boardPage(boardId, listState),
  );
  const [board, setBoard] = useState<Board | null>(
    initialPage?.board ?? boards.find((item) => item.id === boardId) ?? null,
  );
  const [tasks, setTasks] = useState<Task[]>(initialPage?.tasks.items ?? []);
  const [taskPage, setTaskPage] = useState(listState.page);
  const [displayedPageSize, setDisplayedPageSize] = useState(pageSize);
  const [taskTotal, setTaskTotal] = useState<number | null>(
    initialPage?.tasks.total ?? null,
  );
  const [displayedSort, setDisplayedSort] = useState(filters.sort);
  const { errorStatus, accessDenied, failed, authorized, clearError } =
    useBoardAccess(boardId, preparedStatus);
  const [loading, setLoading] = useState(!prepared);
  const [error, setError] = useState(
    preparedError ? errorText(preparedError) : "",
  );
  const [taskListChanged, setTaskListChanged] = useState(false);
  const [query, setQuery] = useState(q);
  const [creatingTask, setCreatingTask] = useState(false);
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
  const boardContent = useRef<HTMLDivElement>(null);
  const [listDialog, setListDialog] = useState<"filters" | "sort" | null>(null);
  const appSuspended = useAppSuspended();
  const writable = !!board && user.role !== "viewer";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState<BulkTaskField | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const bulkRequest = useRef(false);
  const bulkOutcome = useRef<Promise<boolean> | null>(null);
  const bulkContext = useRef(0);
  useEffect(() => {
    const beforeNavigate = (event: Event) => {
      if (!bulkOutcome.current) return;
      event.preventDefault();
      (event as CustomEvent<NavigationRequest>).detail.waitUntil(
        bulkOutcome.current,
      );
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!bulkOutcome.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("mill:before-navigate", beforeNavigate);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("mill:before-navigate", beforeNavigate);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);
  useLayoutEffect(() => {
    setSelected(new Set());
    setBulkField(null);
    setBulkPending(false);
    return () => {
      ++bulkContext.current;
    };
  }, [boardId, path, sessionRevision, appSuspended, writable, accessDenied]);
  useEffect(() => {
    if (loading) return;
    const visible = new Set(tasks.map((task) => task.id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => visible.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [tasks, loading]);
  useEffect(preloadTaskPage, []);
  useLayoutEffect(() => {
    return () => {
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
    if (
      window.location.pathname +
        window.location.search +
        window.location.hash !==
      path
    )
      return;
    const next = boardUrl(
      boardId,
      { ...listState, q: query, ...changes },
      search,
    );
    if (next === `${window.location.pathname}${search}`) return;
    if (replace) {
      window.history.replaceState(window.history.state, "", next);
      window.dispatchEvent(new Event("mill:navigate"));
    } else navigate(next);
  }
  const displayedQuery = useRef(q);
  useLayoutEffect(() => {
    const previous = displayedQuery.current;
    displayedQuery.current = q;
    setQuery((current) => (current === previous ? q : current));
  }, [q]);
  useEffect(() => {
    if (
      window.location.pathname +
        window.location.search +
        window.location.hash !==
      path
    )
      return;
    const next = boardUrl(boardId, listState, search);
    if (next !== `${window.location.pathname}${search}`) {
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
    const cacheGeneration = navigationCache.generation;
    requestedPage.current = targetPage;
    setLoading(true);
    setError("");
    setTaskListChanged(false);
    const queryKey = `${boardId}?${taskQuery()}`;
    if (refresh || pageCollection.current.query !== queryKey) {
      pageCollection.current = { query: queryKey };
    }
    const collection = pageCollection.current;
    const cached = !refresh
      ? navigationCache.boardPage(boardId, { ...listState, page: targetPage })
      : null;
    if (cached) {
      setBoard(cached.board);
      setTasks(cached.tasks.items);
      setTaskPage(cached.tasks.page);
      setTaskTotal(cached.tasks.total);
      setDisplayedPageSize(pageSize);
      setDisplayedSort(filters.sort);
    }
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
      navigationCache.rememberBoardPage(
        info.board,
        listState,
        page,
        cacheGeneration,
      );
      setBoard(info.board);
      authorized();
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
        failed(e);
        setError(errorText(e));
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
  const preparedRequest = useRef<{
    read: typeof prepared;
    path: string;
    revision: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!prepared || preparedRequest.current?.read === prepared) return;
    ++latestLoad.current;
    preparedRequest.current = {
      read: prepared,
      path,
      revision: sessionRevision,
    };
    setLoading(false);
    setTaskListChanged(false);
    if (prepared.status === "rejected") {
      setError(errorText(prepared.reason));
      failed(prepared.reason);
      return;
    }
    const { board: info, tasks: page } = prepared.value;
    navigationCache.rememberBoardPage(
      info,
      listState,
      page,
      navigationCache.generation,
    );
    setBoard(info);
    onBoardLoaded(info);
    setTasks(page.items);
    setTaskPage(page.page);
    setTaskTotal(page.total);
    setDisplayedPageSize(pageSize);
    setDisplayedSort(filters.sort);
    setError("");
    authorized();
    requestedPage.current = page.page;
    pageCollection.current = {
      query: `${boardId}?${taskQuery()}`,
      revision: page.revision,
    };
    loadedPage.current = {
      query: `${boardId}?${taskQuery()}`,
      page: page.page,
    };
    if (page.page !== listState.page) changeList({ page: page.page, q }, true);
  }, [prepared]);
  useEffect(() => {
    const queryKey = `${boardId}?${taskQuery()}`;
    if (
      preparedRequest.current?.read === prepared &&
      preparedRequest.current?.path === path &&
      preparedRequest.current?.revision === sessionRevision
    )
      return;
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
      clearError();
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
        creatingTask
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
  }, [creatingTask, writable]);
  const hasFilters = !!(
    q ||
    filters.assigneeId ||
    filters.priority ||
    filters.status
  );
  const activeFilterCount = [
    filters.assigneeId,
    filters.priority,
    filters.status,
  ].filter(Boolean).length;
  function clearFilters() {
    setQuery("");
    changeList({
      q: "",
      page: 1,
      assigneeId: "",
      priority: "",
      status: "",
      sort: DEFAULT_TASK_SORT,
    });
  }
  const selectedTasks = tasks.filter((task) => selected.has(task.id));
  const selectionDisabled =
    loading || bulkPending || query !== q || appSuspended || !!error;
  function applyBulk(changes: BulkTaskChanges) {
    if (bulkOutcome.current) return;
    const outcome = updateSelected(changes);
    bulkOutcome.current = outcome;
    void outcome.finally(() => {
      if (bulkOutcome.current === outcome) bulkOutcome.current = null;
    });
  }
  async function updateSelected(changes: BulkTaskChanges): Promise<boolean> {
    if (
      !writable ||
      !selectedTasks.length ||
      selectionDisabled ||
      bulkRequest.current
    )
      return false;
    const context = bulkContext.current;
    const cacheGeneration = navigationCache.generation;
    const current = () =>
      context === bulkContext.current &&
      cacheGeneration === navigationCache.generation;
    bulkRequest.current = true;
    setBulkPending(true);
    navigationCache.forgetBoardPages(boardId);
    try {
      const result = await api<{ items: Task[] }>(
        `/boards/${boardId}/tasks/bulk`,
        {
          tasks: selectedTasks.map(({ id, version }) => ({ id, version })),
          changes,
        },
        "PATCH",
        {
          validateResponse: (result) =>
            isResponseObject(result) &&
            Array.isArray(result.items) &&
            result.items.length === selectedTasks.length &&
            result.items.every(
              (task) => hasTaskResponse({ task }) && selected.has(task.id),
            ),
        },
      );
      if (cacheGeneration === navigationCache.generation) {
        navigationCache.forgetBoardPages(boardId);
        for (const task of result.items)
          navigationCache.rememberTask(task, cacheGeneration);
      }
      if (!current()) return false;
      const saved = new Map(result.items.map((task) => [task.id, task]));
      setTasks((items) => items.map((task) => saved.get(task.id) ?? task));
      setBulkField(null);
      toast.success(
        `Updated ${result.items.length} ${result.items.length === 1 ? "task" : "tasks"}.`,
      );
      return true;
    } catch (cause) {
      if (!current()) return false;
      toast.danger(
        cause instanceof ApiError && cause.status === 409
          ? "One or more selected tasks changed elsewhere. No tasks were updated. Review the latest values and try again."
          : errorText(cause),
      );
      return false;
    } finally {
      bulkRequest.current = false;
      if (current()) {
        await load(requestedPage.current, true);
        if (current()) setBulkPending(false);
      }
    }
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
        className={selectedTasks.length ? "pb-12" : undefined}
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
              <Button
                className="shrink-0"
                variant="secondary"
                aria-haspopup="dialog"
                onPress={() => setListDialog("filters")}
              >
                <Filter aria-hidden />
                Filters
                {activeFilterCount > 0 && (
                  <Chip
                    size="sm"
                    variant="soft"
                    aria-label={`${activeFilterCount} active ${activeFilterCount === 1 ? "filter" : "filters"}`}
                  >
                    {activeFilterCount}
                  </Chip>
                )}
              </Button>
              <Tooltip>
                <Button
                  variant="secondary"
                  isIconOnly
                  aria-label="Sort tasks"
                  aria-haspopup="dialog"
                  onPress={() => setListDialog("sort")}
                >
                  <Sort aria-hidden />
                </Button>
                <Tooltip.Content>Sort tasks</Tooltip.Content>
              </Tooltip>
            </div>
            {listDialog === "filters" && (
              <BoardFiltersDialog
                filters={filters}
                members={members}
                onClose={() => setListDialog(null)}
                onApply={(next) => {
                  changeList({ ...next, page: 1 });
                  setListDialog(null);
                }}
              />
            )}
            {listDialog === "sort" && (
              <BoardSortDialog
                sort={filters.sort}
                onClose={() => setListDialog(null)}
                onApply={(sort) => {
                  changeList({ sort, page: 1 });
                  setListDialog(null);
                }}
              />
            )}
            {writable && selectedTasks.length > 0 && (
              <BulkTaskBar
                count={selectedTasks.length}
                disabled={selectionDisabled}
                onClear={() => setSelected(new Set())}
                onAction={setBulkField}
              />
            )}
            {writable && bulkField && selectedTasks.length > 0 && (
              <BulkTaskDialog
                key={bulkField}
                field={bulkField}
                count={selectedTasks.length}
                pending={bulkPending}
                members={members}
                onApply={applyBulk}
                onClose={() => setBulkField(null)}
              />
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
                          <span className="tabular-nums">
                            {group.name} ({group.tasks.length})
                          </span>
                        </TypographyHeading>
                      </div>
                    )}
                    <TaskTable
                      label={group.name}
                      items={group.tasks}
                      writable={writable}
                      disabled={
                        selectionDisabled ||
                        bulkField !== null ||
                        listDialog !== null
                      }
                      selected={selected}
                      onSelectionChange={setSelected}
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
                                href={`/boards/${boardId}/tasks/${task.id}${search}`}
                                onNavigate={() =>
                                  navigationCache.rememberTask(
                                    task,
                                    navigationCache.generation,
                                  )
                                }
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
                          className: "task-title-column",
                          headerClassName: "task-title-column",
                          isRowHeader: true,
                          cell: (task) => (
                            <Link
                              href={`/boards/${boardId}/tasks/${task.id}${search}`}
                              onNavigate={() =>
                                navigationCache.rememberTask(
                                  task,
                                  navigationCache.generation,
                                )
                              }
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
                          headerClassName: "w-40 min-w-40 whitespace-nowrap",
                          cell: (task) => <StatusChip status={task.status} />,
                        },
                        {
                          key: "assignee",
                          header: "Assignee",
                          headerClassName: "w-52 min-w-52 whitespace-nowrap",
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
                          headerClassName: "w-40 min-w-40 whitespace-nowrap",
                          cell: (task) => (
                            <PriorityChip priority={task.priority} />
                          ),
                        },
                        {
                          key: "startDate",
                          header: "Start date",
                          headerClassName: "w-40 min-w-40 whitespace-nowrap",
                          cell: (task) =>
                            task.startDate ? (
                              <time
                                dateTime={task.startDate}
                                className="whitespace-nowrap tabular-nums"
                              >
                                {formatDate(task.startDate, user)}
                              </time>
                            ) : (
                              <span className="text-muted opacity-50">—</span>
                            ),
                        },
                        {
                          key: "dueDate",
                          header: "Due date",
                          headerClassName: "w-40 min-w-40 whitespace-nowrap",
                          cell: (task) =>
                            task.dueDate ? (
                              <time
                                dateTime={task.dueDate}
                                className="whitespace-nowrap tabular-nums"
                              >
                                {formatDate(task.dueDate, user)}
                              </time>
                            ) : (
                              <span className="text-muted opacity-50">—</span>
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
                    navigate(`/boards/${boardId}/tasks/${task.id}${search}`);
                  }}
                />
              </Suspense>
            )}
          </PortalProvider>
        </SuspendedAppProvider>
      </div>
    </>
  );
}
