import { readStartup, isBackendUnavailable } from "./startup.js";
import {
  BackendUnavailable,
  useBackendReconnect,
} from "@avgeek-oss/design-system/patterns/feedback/backend-unavailable";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
  Settings01Icon,
  Delete02Icon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OverlaySuspensionScope } from "@avgeek-oss/design-system/overlays/overlay-suspension";
import type {
  Board,
  BoardSummary,
  Task,
} from "../../../packages/contracts/src/index.js";
import {
  SecondaryItems,
  SecondarySidebarLayout,
} from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { usePersistentAppSidebar } from "@avgeek-oss/design-system/layouts/app-shell";
import { AgentChatTrigger } from "@avgeek-oss/design-system/patterns/agent-chat/agent-chat-trigger";
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
import { hasBoardResponse, hasBoardSummariesResponse } from "./responses.js";
import { BoardsPage } from "./boards-page.js";
import {
  PageNavigation,
  PageReadScope,
  usePageNavigationPending,
} from "./page-navigation.js";
import { useDirectoryPreparation } from "./directory-preparation.js";
import { useMemberSnapshot } from "./use-member-snapshot.js";
import { compareBoardNames } from "./board-directory.js";
import { loadMemberDirectory } from "./member-directory.js";
import { navigationCache } from "./navigation-cache.js";
import { loadTaskPage } from "./task-page-loader.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  hasSessionResponse,
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
const BoardSettingsPage = lazy(() =>
  import("./board-settings.js").then((m) => ({ default: m.BoardSettingsPage })),
);
const TaskPage = lazy(loadTaskPage);
const SettingsPage = lazy(() =>
  import("./settings.js").then((m) => ({ default: m.SettingsPage })),
);
const NotificationsPopover = lazy(() =>
  import("./inbox.js").then((m) => ({ default: m.NotificationsPopover })),
);
const Assistant = lazy(() =>
  import("./assistant.js").then((m) => ({ default: m.Assistant })),
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
    let approvedPop: { index: number; path: string } | null = null;
    const listener = () => {
      approvedPop = null;
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
      if (
        approvedPop?.index === targetIndex &&
        approvedPop.path === targetPath
      ) {
        approvedPop = null;
        listener();
        return;
      }
      approvedPop = null;
      if (targetIndex !== null && targetIndex !== currentIndex) {
        const delta = targetIndex - currentIndex;
        let restored = false;
        let proceed = false;
        const continuePop = () => {
          approvedPop = { index: targetIndex, path: targetPath };
          window.history.go(delta);
        };
        const resume = () => {
          proceed = true;
          if (restored) continuePop();
        };
        if (!requestNavigation(targetPath, resume)) {
          restoration = {
            index: currentIndex,
            restored: () => {
              restored = true;
              if (proceed) continuePop();
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
  return (
    <PageNavigation location={location}>
      {(displayed) => <AppContent location={displayed} />}
    </PageNavigation>
  );
}
function AppContent({ location }: { location: string }) {
  const navigationPending = usePageNavigationPending();
  const search = new URL(location, window.location.origin).search;
  const path = location.split(/[?#]/)[0];
  const settingsSection = settingsRoute(path);
  const activeBoardId = path.match(/^\/boards\/([^/]+)/)?.[1];
  const boardSettings: "general" | "delete" | undefined =
    activeBoardId && path === `/boards/${activeBoardId}/settings`
      ? "general"
      : activeBoardId && path === `/boards/${activeBoardId}/settings/delete`
        ? "delete"
        : undefined;
  const activeTaskId = path.match(/^\/boards\/[^/]+\/tasks\/([^/]+)\/?$/)?.[1];
  const updatingBoardQuery =
    navigationPending &&
    activeBoardId &&
    !activeTaskId &&
    !boardSettings &&
    path === window.location.pathname;
  const [session, setSession] = useState<Session | null>(null);
  const [setup, setSetup] = useState(false);
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState(false);
  const [assistantEnabled, setAssistantEnabled] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const [expired, setExpired] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardsPending, setBoardsPending] = useState(false);
  const [boardsError, setBoardsError] = useState("");
  const [routeBoard, setRouteBoard] = useState<Board | null>(null);
  const [routeTask, setRouteTask] = useState<Pick<
    Task,
    "id" | "identifier"
  > | null>(null);
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
  const readScope = session
    ? `${session.user.id}:${session.workspace.id}:${session.user.role}:${sessionRevision}`
    : "anonymous";
  const { boards: directoryRead, members: memberRead } =
    useDirectoryPreparation(
      readScope,
      path,
      !!activeBoardId,
      ready && !!session && !expired,
    );
  const {
    members: viewMembers,
    setMembers,
    beginRefresh: beginMemberRefresh,
  } = useMemberSnapshot(memberRead);
  const adoptedDirectory = useRef<typeof directoryRead>(undefined);
  // Prepared destinations publish shared data only when their render commits.
  useLayoutEffect(() => {
    if (!directoryRead) return;
    ++lastBoardsRequest.current;
    adoptedDirectory.current = directoryRead;
    if (directoryRead.status === "fulfilled") {
      setBoards(directoryRead.value);
      setBoardsError("");
    } else setBoardsError(errorText(directoryRead.reason));
    setBoardsPending(false);
  }, [directoryRead]);
  useLayoutEffect(() => {
    if (memberRead?.status === "rejected")
      setError(errorText(memberRead.reason));
  }, [memberRead]);
  const viewBoards =
    directoryRead?.status === "fulfilled" &&
    adoptedDirectory.current !== directoryRead
      ? directoryRead.value
      : boards;
  const rememberLoadedBoard = useCallback((board: Board) => {
    const current = latestLoadedBoard.current;
    if (current?.id === board.id && current.version > board.version) return;
    navigationCache.rememberBoard(board);
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
  async function initial(signal: AbortSignal, first = false) {
    if (first) setReady(false);
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(20_000),
    ]);
    try {
      const { status, session: nextSession } = await readStartup(requestSignal);
      if (signal.aborted) return false;
      navigationCache.clear();
      setEmailDeliveryConfigured(status.emailDeliveryConfigured);
      setAssistantEnabled(status.assistantEnabled);
      setSetup(status.setupRequired);
      setSession(nextSession);
      setError("");
      setBackendUnavailable(false);
      setReady(true);
      return true;
    } catch (e) {
      if (signal.aborted) return false;
      const unavailable = isBackendUnavailable(e);
      setError(errorText(e));
      setBackendUnavailable(unavailable);
      setReady(true);
      return !unavailable;
    }
  }
  useBackendReconnect(backendUnavailable && !session, (signal) =>
    initial(signal),
  );
  async function refresh() {
    const request = ++lastRefreshRequest.current;
    const publishMembers = beginMemberRefresh();
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
      const identityChanged =
        session?.user.id !== me.user.id ||
        session?.workspace.id !== me.workspace.id ||
        session?.user.role !== me.user.role;
      if (identityChanged) navigationCache.clear();
      setSession(me);
      if (identityChanged) setMembers(people);
      else publishMembers(people);
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
    const startup = new AbortController();
    void initial(startup.signal, true);
    const listener = () => {
      if (suspensionActive.current) return;
      suspensionActive.current = true;
      navigationCache.clear();
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
    return () => {
      startup.abort();
      window.removeEventListener("mill:expired", listener);
    };
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
    if (session && !expired && !directoryRead) void loadBoards();
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
    if (
      !session ||
      expired ||
      session.user.id !== next.user.id ||
      session.workspace.id !== next.workspace.id ||
      session.user.role !== next.user.role
    ) {
      navigationCache.clear();
      setAssistantOpen(false);
    }
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
          navigationCache.clear();
          setSession(null);
          setAssistantOpen(false);
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
    navigationCache.clear();
    interruptAccountActions(true);
    lastBoardsRequest.current++;
    lastRefreshRequest.current++;
    recentlyCreatedBoard.current = null;
    latestLoadedBoard.current = null;
    suspendedFocus.current = null;
    suspensionActive.current = false;
    setSession(null);
    setAssistantOpen(false);
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
  if (backendUnavailable && !session)
    return <BackendUnavailable appName="Mill" />;
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
            onRetry={() => void initial(AbortSignal.timeout(20_000))}
            showBoards={false}
          />
        </main>
      );
    return authView;
  }
  if (path === "/oauth/consent")
    return expired ? authView : <AppConsent session={session} />;
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
  const secondarySidebar = activeBoardId ? (
    <>
      <SecondaryItems
        title="Board"
        selected={boardSettings ?? "tasks"}
        items={[
          {
            id: "tasks",
            label: "Tasks",
            href: `/boards/${activeBoardId}${search}`,
            icon: <HugeiconsIcon icon={ClipboardListIcon} aria-hidden />,
          },
        ]}
      />
      {session.user.role !== "viewer" && (
        <SecondaryItems
          title="Settings"
          selected={boardSettings ?? "tasks"}
          items={[
            {
              id: "general",
              label: "General",
              href: `/boards/${activeBoardId}/settings${search}`,
              icon: <HugeiconsIcon icon={Settings01Icon} aria-hidden />,
            },
          ]}
        />
      )}
      {admin && (
        <SecondaryItems
          title="Danger zone"
          selected={boardSettings ?? "tasks"}
          items={[
            {
              id: "delete",
              label: "Delete board",
              href: `/boards/${activeBoardId}/settings/delete${search}`,
              destructive: true,
              icon: <HugeiconsIcon icon={Delete02Icon} aria-hidden />,
            },
          ]}
        />
      )}
    </>
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
        const directoryBoard = viewBoards.find(
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
    boards: viewBoards,
    boardsHref,
    boardId: activeBoardId,
    boardName: navbarTitle,
    boardSettings,
    taskId: activeTaskId,
    taskIdentifier:
      routeTask?.id === activeTaskId ? routeTask?.identifier : undefined,
    settingsSection,
    search: search,
    fallback: navbarTitle,
  };
  return (
    <>
      {expired && authView}
      <OverlaySuspensionScope
        key={`${session.user.id}:${session.workspace.id}:${session.user.role}`}
        isSuspended={expired || navigationPending}
      >
        <PageReadScope scope={readScope}>
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
                        {...(assistantEnabled
                          ? {
                              aside: (
                                <Suspense fallback={null}>
                                  <Assistant
                                    onClose={() => setAssistantOpen(false)}
                                    boards={viewBoards}
                                    onRefresh={() => {
                                      navigationCache.clear();
                                      setSessionRevision(
                                        (revision) => revision + 1,
                                      );
                                      void refresh();
                                    }}
                                  />
                                </Suspense>
                              ),
                              asideOpen: assistantOpen,
                              onAsideOpenChange: setAssistantOpen,
                            }
                          : {})}
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
                                {assistantEnabled && (
                                  <AgentChatTrigger
                                    isOpen={assistantOpen}
                                    onOpenChange={setAssistantOpen}
                                  />
                                )}
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
                            inert={navigationPending && !updatingBoardQuery}
                            aria-busy={navigationPending || undefined}
                          >
                            <>
                              {error && <ErrorMessage>{error}</ErrorMessage>}
                              {activeBoardId && activeTaskId ? (
                                <TaskPage
                                  key={activeTaskId}
                                  boardId={activeBoardId}
                                  taskId={activeTaskId}
                                  user={session.user}
                                  members={viewMembers}
                                  returnHref={`/boards/${activeBoardId}${search}`}
                                  onBoardLoaded={rememberLoadedBoard}
                                  onTaskLoaded={setRouteTask}
                                  sessionRevision={sessionRevision}
                                />
                              ) : activeBoardId && boardSettings ? (
                                <BoardSettingsPage
                                  key={`${activeBoardId}:${boardSettings}`}
                                  section={boardSettings}
                                  boardId={activeBoardId}
                                  user={session.user}
                                  boards={viewBoards}
                                  sessionRevision={sessionRevision}
                                  onBoardLoaded={rememberLoadedBoard}
                                  onSaved={() => {
                                    void loadBoards();
                                  }}
                                  onDeleted={(removedBoardId: string) => {
                                    if (removedBoardId) {
                                      navigationCache.forgetBoard(
                                        removedBoardId,
                                      );
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
                                          (board) =>
                                            board.id !== removedBoardId,
                                        ),
                                      );
                                    }
                                    void loadBoards();
                                    void refresh();
                                  }}
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
                                  boards={viewBoards}
                                  user={session.user}
                                  members={viewMembers}
                                  sessionRevision={sessionRevision}
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
                                  members={viewMembers}
                                  boards={viewBoards}
                                  onRefresh={() => {
                                    void refresh();
                                    void loadBoards();
                                  }}
                                />
                              ) : overview ? (
                                <BoardsPage
                                  boards={viewBoards}
                                  user={session.user}
                                  layout={
                                    new URL(
                                      location,
                                      window.location.origin,
                                    ).searchParams.get("layout") === "table"
                                      ? "table"
                                      : "grid"
                                  }
                                  onLayoutChange={(layout) => {
                                    const url = new URL(
                                      location,
                                      window.location.origin,
                                    );
                                    if (layout === "grid")
                                      url.searchParams.delete("layout");
                                    else url.searchParams.set("layout", layout);
                                    const next = `${url.pathname}${url.search}${url.hash}`;
                                    if (next !== location) navigate(next);
                                  }}
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
                            </>
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
                                  createdBy: {
                                    id: session.user.id,
                                    name: session.user.name,
                                    email: session.user.email,
                                    kind: "human",
                                  },
                                  lastActivityAt: new Date().toISOString(),
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
                            onChange={(e) =>
                              setBoardDescription(e.target.value)
                            }
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
        </PageReadScope>
      </OverlaySuspensionScope>
    </>
  );
}
