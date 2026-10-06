import {
  Component,
  Suspense,
  lazy,
  useCallback,
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
  ClipboardListIcon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  Board,
  BoardSummary,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import { ErrorPage } from "./error-page.js";
import { AppBreadcrumbs } from "./app-breadcrumbs.js";
import { AccountMenuItems } from "./account-menu.js";
import {
  SettingsNavigation,
  isAccountSection,
  settingsTitles,
} from "./settings-navigation.js";
import { MillMark, millBrand, millVersion } from "./brand.js";
import {
  isFrontendLoadError,
  reloadOutdatedFrontend,
} from "./frontend-load.js";
import { hasBoardResponse, hasBoardSummariesResponse } from "./responses.js";
import { BoardsPage } from "./boards-page.js";
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
const AccountIcon = iconComponent(UserAccountIcon);
const Users = iconComponent(UserGroupIcon);
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
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardsPending, setBoardsPending] = useState(false);
  const [boardsError, setBoardsError] = useState("");
  const [filterContainer, setFilterContainer] = useState<HTMLElement | null>(
    null,
  );
  const [routeBoard, setRouteBoard] = useState<Board | null>(null);
  const [routeTask, setRouteTask] = useState<Pick<
    Task,
    "id" | "identifier"
  > | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const sidebarState = usePersistentAppSidebar();
  const [newBoard, setNewBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [boardDescription, setBoardDescription] = useState("");
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
  const recentlyCreatedBoard = useRef<BoardSummary | null>(null);
  const latestLoadedBoard = useRef<Board | null>(null);
  const appContainer = useRef<HTMLDivElement>(null);
  const suspendedFocus = useRef<HTMLElement | null>(null);
  const suspensionActive = useRef(false);
  const logoutPending = useRef(false);
  const rememberLoadedBoard = useCallback((board: Board) => {
    const current = latestLoadedBoard.current;
    if (current?.id === board.id && current.version > board.version) return;
    latestLoadedBoard.current = board;
    setRouteBoard(board);
    setBoards((previous) => {
      const current = previous.find((item) => item.id === board.id);
      if (!current || current.version > board.version) return previous;
      return previous
        .map((item) => (item.id === board.id ? { ...item, ...board } : item))
        .sort(compareBoardNames);
    });
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-changing");
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        theme === "dark"
          ? millBrand.themeColor.dark
          : millBrand.themeColor.light,
      );
    localStorage.setItem("mill:theme", theme);
    // Commit the new colors while transitions are paused, before the next paint.
    getComputedStyle(root).getPropertyValue("color");
    const frame = requestAnimationFrame(() => {
      root.classList.remove("theme-changing");
    });
    return () => {
      cancelAnimationFrame(frame);
      root.classList.remove("theme-changing");
    };
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
    setError("");
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
          const directory = new Map<string, BoardSummary>();
          const cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const params = new URLSearchParams({
              directory: "true",
              limit: "100",
            });
            if (cursor) params.set("cursor", cursor);
            const result = await api<{
              items: BoardSummary[];
              hasMore: boolean;
              nextCursor: string | null;
            }>(`/boards?${params}`, undefined, "GET", {
              validateResponse: hasBoardSummariesResponse,
            });
            if (request !== lastBoardsRequest.current) return;
            for (const board of result.items) {
              const latest = latestLoadedBoard.current;
              directory.set(
                board.id,
                latest?.id === board.id && latest.version > board.version
                  ? { ...board, ...latest }
                  : board,
              );
            }
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
    if (session && (path === "/" || path === "/boards"))
      document.title = "Boards · Mill";
  }, [path, session?.user.id]);
  const overview = path === "/boards" || path === "/";
  useEffect(() => {
    if (session && !expired) void loadBoards();
  }, [session?.user.id, expired, overview, sessionRevision]);
  useEffect(() => {
    if (session && (path === "/" || path === "/notifications")) {
      window.history.replaceState(window.history.state, "", "/boards");
      window.dispatchEvent(new Event("mill:navigate"));
    }
  }, [session?.user.id, path]);
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
      latestLoadedBoard.current = null;
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
      setError("");
      void api("/auth/logout", {})
        .then(() => {
          lastBoardsRequest.current++;
          lastRefreshRequest.current++;
          recentlyCreatedBoard.current = null;
          latestLoadedBoard.current = null;
          suspendedFocus.current = null;
          suspensionActive.current = false;
          setSession(null);
          setExpired(false);
          setBoards([]);
          setMembers([]);
          setNotificationCount(0);
          setRouteBoard(null);
          setRouteTask(null);
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
        <ErrorMessage>
          Your session expired. Sign in again to continue.
        </ErrorMessage>
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
  const knownSettings = Object.keys(settingsTitles);
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
  const boardsHref = "/boards";
  const secondarySidebar =
    activeBoardId && !activeTaskId ? (
      <SecondarySidebar title="Filters" hideTitle items={[]}>
        <div ref={setFilterContainer} className="min-w-0" />
      </SecondarySidebar>
    ) : settingsSection &&
      knownSettings.includes(settingsSection) &&
      (isAccountSection(settingsSection) || admin) ? (
      <SettingsNavigation section={settingsSection} />
    ) : undefined;
  const sidebar = (
    <ApplicationSidebar
      config={{
        accessibleLabel: "Workspace navigation",
        homeHref: "/boards",
        brand: {
          title: "Mill",
          logo: <MillMark />,
        },
        brandVersion: millVersion,
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
                active: !!activeBoardId || overview,
              },
            ],
          },
          {
            id: "settings",
            label: "Settings",
            items: [
              {
                ...nav(
                  "Account settings",
                  "/settings/profile",
                  <AccountIcon />,
                ),
                active: isAccountSection(settingsSection),
              },
              ...(admin
                ? [
                    {
                      ...nav("Team settings", "/settings/workspace", <Users />),
                      active: ["workspace", "members"].includes(
                        settingsSection ?? "",
                      ),
                    },
                  ]
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
          >
            <AccountMenuItems />
          </FooterIdentity>
        ),
      }}
    />
  );
  const navbarTitle = activeBoardId
    ? (() => {
        const directoryBoard = boards.find(
          (board) => board.id === activeBoardId,
        );
        const loadedBoard =
          routeBoard?.id === activeBoardId ? routeBoard : null;
        return loadedBoard &&
          (!directoryBoard || loadedBoard.version >= directoryBoard.version)
          ? loadedBoard.name
          : (directoryBoard?.name ?? "Board");
      })()
    : settingsSection && knownSettings.includes(settingsSection)
      ? settingsTitles[settingsSection]
      : path === "/oauth/consent"
        ? "Connect to Mill"
        : overview
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
            <AppShell contentWidth="broad">
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
                          theme={theme}
                          onThemeChange={setTheme}
                        />
                      </>
                    }
                  />
                }
              >
                <AppShell.Content
                  variant="broad"
                  className="pt-0 pb-20 sm:pt-0 sm:pb-20"
                >
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
                        onBoardLoaded={rememberLoadedBoard}
                        onTaskLoaded={setRouteTask}
                        sessionRevision={sessionRevision}
                      />
                    ) : activeBoardId ? (
                      <BoardPage
                        key={activeBoardId}
                        boardId={activeBoardId}
                        onBoardLoaded={(board) => {
                          rememberLoadedBoard(board);
                          if (recentlyCreatedBoard.current?.id === board.id)
                            recentlyCreatedBoard.current = {
                              ...recentlyCreatedBoard.current,
                              ...board,
                            };
                        }}
                        boards={boards}
                        filterContainer={filterContainer}
                        onOpenFilters={() =>
                          sidebarState.onSidebarOpenChange(true)
                        }
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
                            if (
                              latestLoadedBoard.current?.id === removedBoardId
                            )
                              latestLoadedBoard.current = null;
                            if (routeBoard?.id === removedBoardId)
                              setRouteBoard(null);
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
                    ) : overview ? (
                      <BoardsPage
                        boards={boards}
                        pending={boardsPending}
                        error={boardsError}
                        canCreate={session.user.role !== "viewer"}
                        onRetry={() => void loadBoards()}
                        onCreate={() => {
                          setCreateError("");
                          setNewBoard(true);
                        }}
                      />
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
                      description: boardDescription,
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
                        recentlyCreatedBoard.current = {
                          ...result.board,
                          backlogCount: 0,
                          activeCount: 0,
                          inProgressCount: 0,
                          todoCount: 0,
                        };
                        setNewBoard(false);
                        setBoardName("");
                        setBoardDescription("");
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
                    label="Description"
                    value={boardDescription}
                    onChange={(e) => setBoardDescription(e.target.value)}
                    multiline
                    maxLength={10000}
                    className="min-w-0 w-full"
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
