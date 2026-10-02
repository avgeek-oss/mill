import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  AppLayout,
  AppShell,
  ApplicationSidebar,
  Button,
  Dialog,
  EmptyState,
  ErrorMessage,
  FooterIdentity,
  Navbar,
  PortalProvider,
  SecondarySidebar,
  SuspendedAppProvider,
  TextField,
  ThemeSwitcher,
  usePersistentAppSidebar,
  type ShellLinkConfig,
} from "@mill/web-design-system";
import {
  Add01Icon,
  ClipboardListIcon,
  Key01Icon,
  Settings01Icon,
  UserGroupIcon,
  BotIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  Board,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import { ErrorPage } from "./error-page.js";
import { AppBreadcrumbs, settingsTitles } from "./app-breadcrumbs.js";
import { MillMark, millBrand } from "./brand.js";
import {
  isFrontendLoadError,
  reloadOutdatedFrontend,
} from "./frontend-load.js";
import { hasBoardResponse, hasBoardsResponse } from "./responses.js";
import { compareBoardNames } from "./board-directory.js";
import { loadMemberDirectory } from "./member-directory.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  initializeNavigation,
  navigate,
  navigationIndex,
  requestNavigation,
  type Session,
} from "./api.js";

function iconComponent(icon: ComponentProps<typeof HugeiconsIcon>["icon"]) {
  return function Icon(
    props: Omit<ComponentProps<typeof HugeiconsIcon>, "icon">,
  ) {
    return (
      <HugeiconsIcon
        aria-hidden="true"
        size={16}
        className="size-4 shrink-0"
        {...props}
        icon={icon}
      />
    );
  };
}
const BoardIcon = iconComponent(ClipboardListIcon);
const Plus = iconComponent(Add01Icon);
const Settings = iconComponent(Settings01Icon);
const Users = iconComponent(UserGroupIcon);
const KeyRound = iconComponent(Key01Icon);
const AgentIcon = iconComponent(BotIcon);
const Auth = lazy(() => import("./auth.js").then((m) => ({ default: m.Auth })));
const BoardPage = lazy(() =>
  import("./board.js").then((m) => ({ default: m.BoardPage })),
);
const TaskPage = lazy(() =>
  import("./task-page.js").then((m) => ({ default: m.TaskPage })),
);
const SettingsPage = lazy(() =>
  import("./settings.js").then((m) => ({ default: m.SettingsPage })),
);
const NotificationsPopover = lazy(() =>
  import("./inbox.js").then((m) => ({ default: m.NotificationsPopover })),
);
const AppConsent = lazy(() =>
  import("./app-consent.js").then((m) => ({ default: m.AppConsent })),
);
function usePath() {
  const [path, setPath] = useState(
    window.location.pathname + window.location.search,
  );
  useEffect(() => {
    initializeNavigation();
    let currentPath = window.location.pathname + window.location.search;
    let currentIndex = navigationIndex() ?? 0;
    let restoration: { index: number; restored: () => void } | null = null;
    const listener = () => {
      currentPath = window.location.pathname + window.location.search;
      currentIndex = navigationIndex() ?? currentIndex;
      setPath(currentPath);
    };
    const pop = () => {
      const targetPath = window.location.pathname + window.location.search;
      const targetIndex = navigationIndex();
      if (restoration) {
        if (targetIndex === restoration.index) {
          const complete = restoration.restored;
          restoration = null;
          complete();
        }
        return;
      }
      if (targetIndex !== null && targetIndex !== currentIndex) {
        const delta = targetIndex - currentIndex;
        let restored = false;
        let proceed = false;
        const resume = () => {
          proceed = true;
          if (restored) window.history.go(delta);
        };
        if (!requestNavigation(targetPath, resume)) {
          restoration = {
            index: currentIndex,
            restored: () => {
              restored = true;
              if (proceed) window.history.go(delta);
            },
          };
          window.history.go(-delta);
          return;
        }
      } else {
        const targetState = window.history.state;
        const resume = () => {
          window.history.replaceState(targetState, "", targetPath);
          listener();
        };
        if (!requestNavigation(targetPath, resume)) {
          window.history.replaceState(
            { millNavigationIndex: currentIndex },
            "",
            currentPath,
          );
          return;
        }
      }
      listener();
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("mill:navigate", listener);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("mill:navigate", listener);
    };
  }, []);
  return path;
}
export function App() {
  const location = usePath();
  const path = location.split("?")[0];
  const activeBoardId = path.match(/^\/boards\/([^/]+)/)?.[1];
  const activeTaskId = path.match(/^\/boards\/[^/]+\/tasks\/([^/]+)\/?$/)?.[1];
  const [session, setSession] = useState<Session | null>(null);
  const [setup, setSetup] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardsPending, setBoardsPending] = useState(false);
  const [boardsError, setBoardsError] = useState("");
  const [lastUsedBoardId, setLastUsedBoardId] = useState<string | null>(null);
  const [routeBoard, setRouteBoard] = useState<Pick<
    Board,
    "id" | "name"
  > | null>(null);
  const [routeTask, setRouteTask] = useState<Pick<
    Task,
    "id" | "identifier"
  > | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const sidebarState = usePersistentAppSidebar();
  const [newBoard, setNewBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [boardPrefix, setBoardPrefix] = useState("");
  const [createError, setCreateError] = useState("");
  const [boardCreateKey] = useState(createRetryKey);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(
    localStorage.getItem("mill:theme") ??
      (window.matchMedia("(prefers-color-scheme:dark)").matches
        ? "dark"
        : "light"),
  );
  const lastBoardsRequest = useRef(0);
  const lastRefreshRequest = useRef(0);
  const recentlyCreatedBoard = useRef<Board | null>(null);
  const appContainer = useRef<HTMLDivElement>(null);
  const suspendedFocus = useRef<HTMLElement | null>(null);
  const suspensionActive = useRef(false);
  const logoutPending = useRef(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        theme === "dark"
          ? millBrand.themeColor.dark
          : millBrand.themeColor.light,
      );
    localStorage.setItem("mill:theme", theme);
  }, [theme]);
  async function initial() {
    setReady(false);
    setError("");
    try {
      const status = await api<{ setupRequired: boolean }>("/auth/status");
      setSetup(status.setupRequired);
      if (!status.setupRequired) {
        try {
          setSession(await api<Session>("/auth/me"));
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) setSession(null);
          else throw e;
        }
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReady(true);
    }
  }
  async function refresh() {
    const request = ++lastRefreshRequest.current;
    try {
      const [me, people, notification] = await Promise.all([
        api<Session>("/auth/me"),
        loadMemberDirectory(),
        api<{ unreadCount: number }>("/notifications?limit=1"),
      ]);
      if (request !== lastRefreshRequest.current) return;
      setSession(me);
      setMembers(people);
      setNotificationCount(notification.unreadCount);
      setError("");
    } catch (e) {
      if (request === lastRefreshRequest.current) setError(errorText(e));
    }
  }
  async function loadBoards() {
    const request = ++lastBoardsRequest.current;
    setBoardsPending(true);
    setBoardsError("");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const directory = new Map<string, Board>();
          const cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const params = new URLSearchParams({
              directory: "true",
              limit: "100",
            });
            if (cursor) params.set("cursor", cursor);
            const result = await api<{
              items: Board[];
              hasMore: boolean;
              nextCursor: string | null;
            }>(`/boards?${params}`, undefined, "GET", {
              validateResponse: hasBoardsResponse,
            });
            if (request !== lastBoardsRequest.current) return;
            for (const board of result.items) directory.set(board.id, board);
            const created = recentlyCreatedBoard.current;
            if (created && directory.has(created.id))
              recentlyCreatedBoard.current = null;
            setBoards((previous) =>
              [
                ...new Map([
                  ...previous.map((board) => [board.id, board] as const),
                  ...directory,
                  ...(created && !directory.has(created.id)
                    ? [[created.id, created] as const]
                    : []),
                ]).values(),
              ].sort(compareBoardNames),
            );
            cursor = result.nextCursor;
            if (cursor) {
              if (cursors.has(cursor))
                throw new Error(
                  "The board list could not be completed. Try again.",
                );
              cursors.add(cursor);
            }
          } while (cursor);
          recentlyCreatedBoard.current = null;
          setBoards([...directory.values()].sort(compareBoardNames));
          return;
        } catch (cause) {
          if (!(
            cause instanceof ApiError &&
            cause.status === 409 &&
            attempt < 2
          ))
            throw cause;
          if (request !== lastBoardsRequest.current) return;
        }
      }
    } catch (cause) {
      if (request === lastBoardsRequest.current)
        setBoardsError(errorText(cause));
    } finally {
      if (request === lastBoardsRequest.current) setBoardsPending(false);
    }
  }
  useEffect(() => {
    void initial();
    const listener = () => {
      if (suspensionActive.current) return;
      suspensionActive.current = true;
      lastBoardsRequest.current++;
      lastRefreshRequest.current++;
      const focused = document.activeElement;
      suspendedFocus.current =
        focused instanceof HTMLElement &&
        appContainer.current?.contains(focused)
          ? focused
          : null;
      if (!window.matchMedia("(min-width: 64rem)").matches)
        sidebarState.onSidebarOpenChange(false);
      setExpired(true);
    };
    window.addEventListener("mill:expired", listener);
    return () => window.removeEventListener("mill:expired", listener);
  }, []);
  useEffect(() => {
    if (session && !expired) {
      void refresh();
      void loadBoards();
      const timer = setInterval(
        () =>
          void api<{ unreadCount: number }>("/notifications?limit=1")
            .then((n) => setNotificationCount(n.unreadCount))
            .catch(() => {}),
        30000,
      );
      return () => clearInterval(timer);
    }
  }, [session?.user.id, expired]);
  useLayoutEffect(() => {
    if (expired) return;
    const focused = suspendedFocus.current;
    suspendedFocus.current = null;
    if (focused?.isConnected && appContainer.current?.contains(focused))
      focused.focus({ preventScroll: true });
  }, [expired]);
  useEffect(() => {
    if (session && path.startsWith("/settings/")) {
      const section = path.split("/").pop() ?? "";
      document.title = `${settingsTitles[section] ?? "Settings"} · Mill`;
    }
    if (session && path === "/") document.title = "Boards · Mill";
  }, [path, session?.user.id]);
  useEffect(() => {
    if (!session) {
      setLastUsedBoardId(null);
      return;
    }
    try {
      setLastUsedBoardId(
        localStorage.getItem(`mill:last-board:${session.user.id}`),
      );
    } catch {
      setLastUsedBoardId(null);
    }
  }, [session?.user.id]);
  useEffect(() => {
    if (
      !session ||
      !activeBoardId ||
      !boards.some((b) => b.id === activeBoardId)
    )
      return;
    setLastUsedBoardId(activeBoardId);
    try {
      localStorage.setItem(`mill:last-board:${session.user.id}`, activeBoardId);
    } catch {
      // The current session still remembers the selected board.
    }
  }, [session?.user.id, activeBoardId, boards]);
  useEffect(() => {
    if (
      session &&
      (path === "/" || path === "/notifications") &&
      !boardsPending &&
      boards.length
    ) {
      const board = boards.find((b) => b.id === lastUsedBoardId) ?? boards[0];
      navigate(`/boards/${board.id}`);
    }
  }, [session, path, boards, boardsPending, lastUsedBoardId]);
  function acceptSession(next: Session) {
    suspensionActive.current = false;
    const changedPerson =
      !!session &&
      (session.user.id !== next.user.id ||
        session.workspace.id !== next.workspace.id);
    if (changedPerson) {
      lastBoardsRequest.current++;
      lastRefreshRequest.current++;
      recentlyCreatedBoard.current = null;
      suspendedFocus.current = null;
      setBoards([]);
      setMembers([]);
      setNotificationCount(0);
      setRouteBoard(null);
      setRouteTask(null);
      window.history.replaceState({ millNavigationIndex: 0 }, "", "/");
      window.dispatchEvent(new Event("mill:navigate"));
    } else if (session && expired) {
      setSessionRevision((revision) => revision + 1);
    }
    setSession(next);
    setSetup(false);
    setExpired(false);
    if (
      !changedPerson &&
      (path.startsWith("/invite") || path.startsWith("/recover"))
    )
      navigate("/");
  }
  function signOut() {
    if (logoutPending.current) return;
    const perform = () => {
      if (logoutPending.current) return;
      logoutPending.current = true;
      void api("/auth/logout", {})
        .then(() => {
          lastBoardsRequest.current++;
          lastRefreshRequest.current++;
          recentlyCreatedBoard.current = null;
          suspendedFocus.current = null;
          suspensionActive.current = false;
          setSession(null);
          setExpired(false);
          setBoards([]);
          setMembers([]);
          setNotificationCount(0);
          window.history.replaceState({ millNavigationIndex: 0 }, "", "/");
          window.dispatchEvent(new Event("mill:navigate"));
        })
        .catch((cause) => setError(errorText(cause)))
        .finally(() => {
          logoutPending.current = false;
        });
    };
    if (requestNavigation("/", perform)) perform();
  }
  const authView = (
    <>
      {expired && (
        <div role="status" className="session-banner">
          Your session expired. Sign in again to continue.
        </div>
      )}
      <Suspense fallback={null}>
        <Auth setup={setup} onSession={acceptSession} focusEmail={expired} />
      </Suspense>
    </>
  );
  if (!ready)
    return (
      <main aria-busy className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" />
    );
  if (!session) {
    if (error)
      return (
        <main className="min-h-dvh">
          <ErrorPage
            title="Mill could not load"
            description={error}
            onRetry={() => void initial()}
            showBoards={false}
          />
        </main>
      );
    return authView;
  }
  if (path === "/oauth/consent")
    return expired ? (
      authView
    ) : (
      <Suspense fallback={null}>
        <AppConsent session={session} />
      </Suspense>
    );
  const settingsSection = path.match(/^\/settings\/([^/]+)/)?.[1];
  const knownSettings = [
    "profile",
    "security",
    "members",
    "agents",
    "api-keys",
    "workspace",
  ];
  function nav(label: string, url: string, icon: ReactNode): ShellLinkConfig {
    return {
      id: url,
      href: url,
      label,
      icon,
      active: path === url,
    };
  }
  const admin = session.user.role === "admin";
  const preferredBoardId =
    boards.find((board) => board.id === lastUsedBoardId)?.id ?? boards[0]?.id;
  const boardsHref = preferredBoardId
    ? `/boards/${preferredBoardId}${preferredBoardId === activeBoardId ? window.location.search : ""}`
    : "/";
  const secondarySidebar =
    activeBoardId || path === "/" ? (
      <SecondarySidebar
        title="Boards"
        actions={
          session.user.role !== "viewer" && (
            <Button
              aria-label="Create board"
              variant="secondary"
              isIconOnly
              className="board-create-button size-8 text-muted"
              onPress={() => {
                if (!window.matchMedia("(min-width: 64rem)").matches)
                  sidebarState.onSidebarOpenChange(false);
                setCreateError("");
                setNewBoard(true);
              }}
            >
              <Plus />
            </Button>
          )
        }
        items={boards.map((board) => ({
          id: board.id,
          href: `/boards/${board.id}${board.id === activeBoardId ? window.location.search : ""}`,
          label: board.name,
          icon: <BoardIcon />,
          active: activeBoardId === board.id,
        }))}
      >
        {boardsError && (
          <div className="grid min-w-0 gap-2">
            <ErrorMessage>{boardsError}</ErrorMessage>
            <Button
              variant="secondary"
              isDisabled={boardsPending}
              onPress={() => void loadBoards()}
            >
              Retry loading boards
            </Button>
          </div>
        )}
      </SecondarySidebar>
    ) : undefined;
  const sidebar = (
    <ApplicationSidebar
      config={{
        accessibleLabel: "Workspace navigation",
        homeHref: "/",
        brand: {
          title: "Mill",
          logo: <MillMark />,
        },
        groups: [
          {
            id: "operate",
            label: "Operate",
            items: [
              {
                id: "boards",
                href: boardsHref,
                label: "Boards",
                icon: <BoardIcon />,
                active: !!activeBoardId || path === "/",
              },
            ],
          },
          {
            id: "workspace",
            label: "Workspace",
            items: [
              ...(admin ? [nav("People", "/settings/members", <Users />)] : []),
              nav("Agents", "/settings/agents", <AgentIcon />),
              nav("API keys", "/settings/api-keys", <KeyRound />),
              ...(admin
                ? [nav("Team settings", "/settings/workspace", <Settings />)]
                : []),
            ],
          },
        ],
        footerContent: (
          <FooterIdentity
            name={session.user.name}
            email={session.user.email}
            workspaceName={session.workspace.name}
            onLogout={signOut}
          />
        ),
      }}
    />
  );
  const navbarTitle = activeBoardId
    ? (boards.find((board) => board.id === activeBoardId)?.name ??
      (routeBoard?.id === activeBoardId ? routeBoard.name : "Board"))
    : settingsSection && knownSettings.includes(settingsSection)
      ? settingsTitles[settingsSection]
      : path === "/oauth/consent"
        ? "Connect an agent"
        : path === "/"
          ? "Boards"
          : "Page not found";
  const navbarContent = (
    <AppBreadcrumbs
      boards={boards}
      boardsHref={boardsHref}
      boardId={activeBoardId}
      boardName={navbarTitle}
      taskId={activeTaskId}
      taskIdentifier={
        routeTask?.id === activeTaskId ? routeTask?.identifier : undefined
      }
      settingsSection={settingsSection}
      admin={admin}
      search={window.location.search}
      fallback={navbarTitle}
    />
  );
  return (
    <>
      {expired && authView}
      <SuspendedAppProvider value={expired}>
        <div
          ref={appContainer}
          data-authenticated-app
          hidden={expired}
          inert={expired}
          aria-hidden={expired}
        >
          <PortalProvider getContainer={() => appContainer.current}>
            <AppShell contentWidth="full">
              <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:ring-2 focus:ring-focus"
              >
                Skip to content
              </a>
              <AppLayout
                navigate={navigate}
                path={path}
                sidebar={sidebar}
                secondarySidebar={secondarySidebar}
                toggleShortcut
                {...sidebarState}
                sidebarOpen={expired ? false : sidebarState.sidebarOpen}
                navbar={
                  <Navbar
                    title={navbarContent}
                    sidebarOpen={sidebarState.sidebarOpen}
                    onSidebarToggle={() =>
                      sidebarState.onSidebarOpenChange(
                        !sidebarState.sidebarOpen,
                      )
                    }
                    actions={
                      <>
                        <Suspense fallback={null}>
                          <NotificationsPopover
                            key={session.user.id}
                            userId={session.user.id}
                            timeZone={session.user.timeZone}
                            unreadCount={notificationCount}
                            onRead={() => void refresh()}
                            suspended={expired}
                            sessionRevision={sessionRevision}
                          />
                        </Suspense>
                        <ThemeSwitcher
                          size="small"
                          className="pointer-coarse:size-11"
                          theme={theme}
                          onThemeChange={setTheme}
                        />
                      </>
                    }
                  />
                }
              >
                <AppShell.Content>
                  <Suspense fallback={null}>
                    {error && <ErrorMessage>{error}</ErrorMessage>}
                    {activeBoardId && activeTaskId ? (
                      <TaskPage
                        key={activeTaskId}
                        boardId={activeBoardId}
                        taskId={activeTaskId}
                        user={session.user}
                        members={members}
                        returnHref={`/boards/${activeBoardId}${window.location.search}`}
                        onBoardLoaded={setRouteBoard}
                        onTaskLoaded={setRouteTask}
                        sessionRevision={sessionRevision}
                      />
                    ) : activeBoardId ? (
                      <BoardPage
                        key={activeBoardId}
                        boardId={activeBoardId}
                        onBoardLoaded={(board) => {
                          setRouteBoard(board);
                          if (recentlyCreatedBoard.current?.id === board.id)
                            recentlyCreatedBoard.current = board;
                        }}
                        boards={boards}
                        user={session.user}
                        members={members}
                        sessionRevision={sessionRevision}
                        onBoardsChanged={(removedBoardId?: string) => {
                          if (removedBoardId) {
                            if (
                              recentlyCreatedBoard.current?.id ===
                              removedBoardId
                            )
                              recentlyCreatedBoard.current = null;
                            setBoards((previous) =>
                              previous.filter(
                                (board) => board.id !== removedBoardId,
                              ),
                            );
                          }
                          void loadBoards();
                          void refresh();
                        }}
                        path={location}
                      />
                    ) : settingsSection &&
                      knownSettings.includes(settingsSection) ? (
                      <SettingsPage
                        key={settingsSection}
                        section={settingsSection}
                        session={session}
                        members={members}
                        boards={boards}
                        onRefresh={() => {
                          void refresh();
                          void loadBoards();
                        }}
                      />
                    ) : path === "/" && boardsPending ? null : path === "/" &&
                      boardsError ? (
                      <EmptyState>
                        <EmptyState.Header>
                          <EmptyState.Title>
                            Boards could not be loaded
                          </EmptyState.Title>
                          <EmptyState.Description>
                            {boardsError}
                          </EmptyState.Description>
                        </EmptyState.Header>
                        <EmptyState.Content>
                          <Button onPress={() => void loadBoards()}>
                            Retry loading boards
                          </Button>
                        </EmptyState.Content>
                      </EmptyState>
                    ) : path === "/" ? (
                      <EmptyState>
                        <EmptyState.Media>
                          <BoardIcon size={32} />
                        </EmptyState.Media>
                        <EmptyState.Header>
                          <EmptyState.Title>
                            Your work starts here
                          </EmptyState.Title>
                          <EmptyState.Description>
                            Create a board, give it a few tasks, and make the
                            next step clear.
                          </EmptyState.Description>
                        </EmptyState.Header>
                        <EmptyState.Content>
                          {session.user.role !== "viewer" ? (
                            <Button onPress={() => setNewBoard(true)}>
                              <Plus />
                              Create your first board
                            </Button>
                          ) : (
                            <p className="text-sm text-muted">
                              Ask a member or administrator to create a board.
                            </p>
                          )}
                        </EmptyState.Content>
                      </EmptyState>
                    ) : (
                      <ErrorPage code="404" />
                    )}
                  </Suspense>
                </AppShell.Content>
              </AppLayout>
              <Dialog
                isDismissDisabled={busy}
                open={newBoard}
                onClose={() => {
                  boardCreateKey.reset();
                  setNewBoard(false);
                }}
                title="Create a board"
                footer={
                  <>
                    <Button
                      variant="secondary"
                      onPress={() => {
                        boardCreateKey.reset();
                        setNewBoard(false);
                      }}
                      isDisabled={busy}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" form="new-board" isDisabled={busy}>
                      {busy ? "Creating…" : "Create board"}
                    </Button>
                  </>
                }
              >
                <form
                  id="new-board"
                  className="content-grid min-w-0"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (busy) return;
                    setBusy(true);
                    setCreateError("");
                    const payload = {
                      name: boardName,
                      ...(boardPrefix ? { prefix: boardPrefix } : {}),
                    };
                    void api<{ board: Board }>("/boards", payload, "POST", {
                      validateResponse: hasBoardResponse,
                      headers: {
                        "Idempotency-Key": boardCreateKey.forRequest(
                          "/boards",
                          payload,
                        ),
                      },
                    })
                      .then((result) => {
                        boardCreateKey.reset();
                        recentlyCreatedBoard.current = result.board;
                        setNewBoard(false);
                        setBoardName("");
                        setBoardPrefix("");
                        void loadBoards();
                        navigate(`/boards/${result.board.id}`);
                      })
                      .catch((e) => setCreateError(errorText(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  <TextField
                    label="Board name"
                    value={boardName}
                    onChange={(e) => setBoardName(e.target.value)}
                    required
                    autoFocus={!window.matchMedia("(pointer: coarse)").matches}
                    maxLength={100}
                  />
                  <TextField
                    label="Task prefix"
                    value={boardPrefix}
                    onChange={(e) =>
                      setBoardPrefix(e.target.value.toUpperCase())
                    }
                    maxLength={12}
                    placeholder="e.g. WEB"
                  />
                  <ErrorMessage>{createError}</ErrorMessage>
                </form>
              </Dialog>
            </AppShell>
          </PortalProvider>
        </div>
      </SuspendedAppProvider>
    </>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; loadFailed: boolean }
> {
  state = { failed: false, loadFailed: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, loadFailed: isFrontendLoadError(error) };
  }
  componentDidCatch(error: unknown) {
    if (isFrontendLoadError(error)) void reloadOutdatedFrontend();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.state.loadFailed ? (
      <ErrorPage
        code="Load error"
        title="Unable to open this page"
        description="This page could not finish loading. Reload to try again. If you had an unfinished edit, check it before continuing."
      />
    ) : (
      <ErrorPage />
    );
  }
}
