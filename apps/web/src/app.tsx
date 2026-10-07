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
} from "react";
import {
  AppLayout,
  AppShell,
  ApplicationSidebar,
  Button,
  Dialog,
  ErrorMessage,
  ApplicationNavbar,
  PortalProvider,
  RouteProvider,
  useTheme,
  SuspendedAppProvider,
  TextField,
  ThemeSwitcher,
  toast,
} from "@mill/web-design-system";
import {
  ClipboardListIcon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { OverlaySuspensionScope } from "@avgeek-oss/design-system/overlays/overlay-suspension";
import type {
  Board,
  BoardSummary,
  Member,
  Task,
} from "../../../packages/contracts/src/index.js";
import {
  SecondarySection,
  SecondarySidebarLayout,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { usePersistentAppSidebar } from "@avgeek-oss/design-system/layouts/app-shell";
import type { SidebarLinkConfig } from "@avgeek-oss/design-system/layouts/application-shell-types";
import { ErrorPage } from "./error-page.js";
import { AppBreadcrumbs } from "./app-breadcrumbs.js";
import { AccountMenu } from "./account-menu.js";
import {
  SettingsNavigation,
  isAccountSection,
  settingsTitles,
  settingsRoute,
  settingsHref,
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
  hasSessionResponse,
  isResponseObject,
  initializeNavigation,
  navigate,
  navigationIndex,
  requestNavigation,
  type Session,
} from "./api.js";

const BoardIcon = ClipboardListIcon;
const AccountIcon = UserAccountIcon;
const Users = UserGroupIcon;
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
    window.location.pathname + window.location.search + window.location.hash,
  );
  useEffect(() => {
    initializeNavigation();
    let currentPath =
      window.location.pathname + window.location.search + window.location.hash;
    let currentIndex = navigationIndex() ?? 0;
    let restoration: { index: number; restored: () => void } | null = null;
    const listener = () => {
      currentPath =
        window.location.pathname +
        window.location.search +
        window.location.hash;
      currentIndex = navigationIndex() ?? currentIndex;
      setPath(currentPath);
    };
    const pop = () => {
      const targetPath =
        window.location.pathname +
        window.location.search +
        window.location.hash;
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
    window.addEventListener("hashchange", listener);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("mill:navigate", listener);
      window.removeEventListener("hashchange", listener);
    };
  }, []);
  return path;
}
export function App() {
  const location = usePath();
  const path = location.split(/[?#]/)[0];
  const settingsSection = settingsRoute(path);
  const activeBoardId = path.match(/^\/boards\/([^/]+)/)?.[1];
  const activeTaskId = path.match(/^\/boards\/[^/]+\/tasks\/([^/]+)\/?$/)?.[1];
  const [session, setSession] = useState<Session | null>(null);
  const [setup, setSetup] = useState(false);
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState(false);
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
  const sidebarState = usePersistentAppSidebar("mill:sidebar-open");
  const [newBoard, setNewBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [boardDescription, setBoardDescription] = useState("");
  const [boardPrefix, setBoardPrefix] = useState("");
  const [createError, setCreateError] = useState("");
  const [boardCreateKey] = useState(createRetryKey);
  const accountActionGeneration = useRef(0);
  const logoutRequest = useRef<AbortController | null>(null);
  const boardCreateGeneration = useRef(0);
  const boardCreateRequest = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const { resolvedTheme: theme } = useTheme();
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
  useEffect(() => {
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", millBrand.themeColor[theme]);
  }, [theme]);
  async function initial() {
    setReady(false);
    setError("");
    try {
      const status = await api<{
        setupRequired: boolean;
        emailDeliveryConfigured: boolean;
      }>("/auth/status", undefined, "GET", {
        validateResponse: (value) =>
          isResponseObject(value) &&
          typeof value.setupRequired === "boolean" &&
          typeof value.emailDeliveryConfigured === "boolean",
      });
      setEmailDeliveryConfigured(status.emailDeliveryConfigured);
      setSetup(status.setupRequired);
      if (!status.setupRequired) {
        try {
          setSession(
            await api<Session>("/auth/me", undefined, "GET", {
              validateResponse: hasSessionResponse,
            }),
          );
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
        api<Session>("/auth/me", undefined, "GET", {
          validateResponse: hasSessionResponse,
        }),
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
      interruptAccountActions();
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
      let active = true;
      let pending = false;
      let outage = false;
      const poll = async () => {
        if (!active || pending || suspensionActive.current) return;
        pending = true;
        try {
          const notification = await api<{ unreadCount: number }>(
            "/notifications?limit=1",
          );
          if (!active || suspensionActive.current) return;
          if (
            !Number.isSafeInteger(notification.unreadCount) ||
            notification.unreadCount < 0
          )
            throw new Error("Notification counts could not be loaded.");
          setNotificationCount(notification.unreadCount);
          outage = false;
        } catch (cause) {
          if (!active || suspensionActive.current) return;
          if (!outage) toast.danger(errorText(cause));
          outage = true;
        } finally {
          pending = false;
        }
      };
      const timer = setInterval(() => void poll(), 30000);
      return () => {
        active = false;
        clearInterval(timer);
      };
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
    if (session && settingsSection)
      document.title = `${settingsTitles[settingsSection]} · Mill`;
    if (session && (path === "/" || path === "/boards"))
      document.title = "Boards · Mill";
  }, [path, session?.user.id]);
  const canonicalizeToBoards = Boolean(
    session &&
    (path === "/" ||
      path === "/notifications" ||
      (!expired && path === "/login")),
  );
  const overview = path === "/boards" || path === "/" || canonicalizeToBoards;
  useEffect(() => {
    if (session && !expired) void loadBoards();
  }, [session?.user.id, expired, overview, sessionRevision]);
  useEffect(() => {
    if (canonicalizeToBoards) {
      window.history.replaceState(window.history.state, "", "/boards");
      window.dispatchEvent(new Event("mill:navigate"));
    }
  }, [canonicalizeToBoards, path]);
  useEffect(() => {
    if (!session || expired || !settingsSection) return;
    const canonical = settingsHref(settingsSection);
    if (path !== canonical) {
      window.history.replaceState(
        window.history.state,
        "",
        `${canonical}${location.slice(path.length)}`,
      );
      window.dispatchEvent(new Event("mill:navigate"));
    }
  }, [session?.user.id, expired, settingsSection, path, location]);
  function interruptAccountActions(clearDraft = false) {
    accountActionGeneration.current++;
    logoutRequest.current?.abort();
    logoutRequest.current = null;
    logoutPending.current = false;
    boardCreateGeneration.current++;
    boardCreateRequest.current?.abort();
    boardCreateRequest.current = null;
    setBusy(false);
    if (clearDraft) {
      setError("");
      setBoardsError("");
      boardCreateKey.reset();
      setNewBoard(false);
      setBoardName("");
      setBoardDescription("");
      setBoardPrefix("");
      setCreateError("");
    }
  }
  function acceptSession(next: Session) {
    suspensionActive.current = false;
    const changedPerson =
      !!session &&
      (session.user.id !== next.user.id ||
        session.workspace.id !== next.workspace.id);
    if (changedPerson) {
      interruptAccountActions(true);
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
      (path === "/login" ||
        path.startsWith("/invite") ||
        path.startsWith("/recover"))
    )
      navigate("/");
  }
  function signOut() {
    if (logoutPending.current || suspensionActive.current) return;
    const generation = accountActionGeneration.current;
    const perform = () => {
      if (
        logoutPending.current ||
        suspensionActive.current ||
        generation !== accountActionGeneration.current
      )
        return;
      const request = new AbortController();
      logoutRequest.current = request;
      logoutPending.current = true;
      setError("");
      void api("/auth/logout", {}, "POST", { signal: request.signal })
        .then(() => {
          if (
            request.signal.aborted ||
            logoutRequest.current !== request ||
            generation !== accountActionGeneration.current
          )
            return;
          interruptAccountActions(true);
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
        .catch((cause) => {
          if (
            !request.signal.aborted &&
            logoutRequest.current === request &&
            generation === accountActionGeneration.current
          )
            setError(errorText(cause));
        })
        .finally(() => {
          if (logoutRequest.current === request) {
            logoutRequest.current = null;
            logoutPending.current = false;
          }
        });
    };
    if (requestNavigation("/", perform)) perform();
  }
  function discardRevokedSession() {
    interruptAccountActions(true);
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
  }
  async function reconcileIdentity() {
    try {
      const current = await api<Session>("/auth/me", undefined, "GET", {
        validateResponse: hasSessionResponse,
      });
      acceptSession(current);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401)
        discardRevokedSession();
      else throw cause;
    }
  }
  const authView = (
    <>
      {expired && (
        <ErrorMessage>
          Your session expired. Sign in again to continue.
        </ErrorMessage>
      )}
      <Suspense fallback={null}>
        <Auth
          key={location}
          setup={setup}
          emailDeliveryConfigured={emailDeliveryConfigured}
          onSession={acceptSession}
          onIdentityChanged={reconcileIdentity}
          focusEmail={expired}
        />
      </Suspense>
    </>
  );
  if (!ready)
    return (
      <main aria-busy className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" />
    );
  if (
    [
      "/invite",
      "/recover",
      "/verify-email",
      "/confirm-email-change",
      "/verification-email",
    ].includes(path)
  )
    return authView;
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
  const knownSettings = Object.keys(settingsTitles);
  function nav(
    label: string,
    url: string,
    icon: SidebarLinkConfig["icon"],
  ): SidebarLinkConfig {
    return {
      id: url,
      href: url,
      label,
      icon,
      kind: "link",
    };
  }
  const admin = session.user.role === "admin";
  const boardsHref = "/boards";
  const secondarySidebar =
    activeBoardId && !activeTaskId ? (
      <SecondarySection>
        <div ref={setFilterContainer} className="min-w-0" />
      </SecondarySection>
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
          id: "mill",
          accessibleLabel: "Mill",
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
                kind: "link",
                icon: BoardIcon,
                activePath: "/boards",
              },
            ],
          },
          {
            id: "settings",
            label: "Settings",
            items: [
              {
                ...nav("Account Settings", "/settings/profile", AccountIcon),
                activePath: isAccountSection(settingsSection)
                  ? "/settings"
                  : "/settings/profile",
              },
              ...(admin
                ? [
                    {
                      ...nav("Team Settings", "/team-settings/general", Users),
                      activePath: "/team-settings",
                    },
                  ]
                : []),
            ],
          },
        ],
        footerContent: (
          <AccountMenu
            name={session.user.name}
            email={session.user.email}
            teamName={session.workspace.name}
            onLogout={signOut}
          />
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
  const breadcrumbProps = {
    boards,
    boardsHref,
    boardId: activeBoardId,
    boardName: navbarTitle,
    taskId: activeTaskId,
    taskIdentifier:
      routeTask?.id === activeTaskId ? routeTask?.identifier : undefined,
    settingsSection,
    admin,
    search: window.location.search,
    fallback: navbarTitle,
  };
  return (
    <>
      {expired && authView}
      <OverlaySuspensionScope
        key={`${session.user.id}:${session.workspace.id}`}
        isSuspended={expired}
      >
        <SuspendedAppProvider value={expired}>
          <div
            ref={appContainer}
            data-authenticated-app
            hidden={expired}
            inert={expired}
            aria-hidden={expired}
          >
            <PortalProvider getContainer={() => appContainer.current}>
              <RouteProvider
                pathname={path.split("?")[0] ?? "/"}
                navigate={navigate}
              >
                <AppShell
                  contentWidth="broad"
                  policy={{ kind: "product", toasts: false }}
                >
                  <AppBreadcrumbs {...breadcrumbProps}>
                    <a
                      href="#main-content"
                      className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:ring-2 focus:ring-focus"
                    >
                      Skip to content
                    </a>
                    <AppLayout
                      navigate={navigate}
                      sidebar={sidebar}
                      toggleShortcut
                      {...sidebarState}
                      sidebarOpen={expired ? false : sidebarState.sidebarOpen}
                      navbar={
                        <ApplicationNavbar
                          config={{
                            homeHref: "/boards",
                            brand: {
                              id: "mill",
                              accessibleLabel: "Mill",
                              title: "Mill",
                              logo: <MillMark />,
                            },
                          }}
                          hasSidebar
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
                              <ThemeSwitcher />
                            </>
                          }
                        />
                      }
                    >
                      <SecondarySidebarLayout>
                        {secondarySidebar}
                        <AppShell.Content
                          id="main-content"
                          tabIndex={-1}
                          variant="broad"
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
                                  if (
                                    recentlyCreatedBoard.current?.id ===
                                    board.id
                                  )
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
                                      latestLoadedBoard.current?.id ===
                                      removedBoardId
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
                                key={`${session.user.id}:${session.workspace.id}:${settingsSection}`}
                                emailDeliveryConfigured={
                                  emailDeliveryConfigured
                                }
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
                      </SecondarySidebarLayout>
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
                          <Button
                            type="submit"
                            form="new-board"
                            isDisabled={busy}
                          >
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
                          if (boardCreateRequest.current || expired) return;
                          const generation = ++boardCreateGeneration.current;
                          const request = new AbortController();
                          boardCreateRequest.current = request;
                          const current = () =>
                            !request.signal.aborted &&
                            generation === boardCreateGeneration.current;
                          setBusy(true);
                          setCreateError("");
                          const payload = {
                            name: boardName,
                            description: boardDescription,
                            ...(boardPrefix ? { prefix: boardPrefix } : {}),
                          };
                          void api<{ board: Board }>(
                            "/boards",
                            payload,
                            "POST",
                            {
                              validateResponse: hasBoardResponse,
                              signal: request.signal,
                              headers: {
                                "Idempotency-Key": boardCreateKey.forRequest(
                                  "/boards",
                                  payload,
                                ),
                              },
                            },
                          )
                            .then((result) => {
                              if (!current()) return;
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
                            .catch((e) => {
                              if (current()) setCreateError(errorText(e));
                            })
                            .finally(() => {
                              if (boardCreateRequest.current === request) {
                                boardCreateRequest.current = null;
                                setBusy(false);
                              }
                            });
                        }}
                      >
                        <TextField
                          label="Board name"
                          value={boardName}
                          onChange={(e) => setBoardName(e.target.value)}
                          required
                          autoFocus={
                            !window.matchMedia("(pointer: coarse)").matches
                          }
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
                  </AppBreadcrumbs>
                </AppShell>
              </RouteProvider>
            </PortalProvider>
          </div>
        </SuspendedAppProvider>
      </OverlaySuspensionScope>
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
