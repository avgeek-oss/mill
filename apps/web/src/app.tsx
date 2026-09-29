import {
  Component,
  Suspense,
  lazy,
  useEffect,
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
  TextField,
  ThemeSwitcher,
  usePersistentAppSidebar,
  type ShellLinkConfig,
} from "@mill/web-design-system";
import {
  Add01Icon,
  ListViewIcon,
  Key01Icon,
  Settings01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Board, Member } from "../../../packages/contracts/src/index.js";
import { ErrorPage } from "./error-page.js";
import { QueryLoading } from "./query-state.js";
import { hasBoardResponse, hasBoardsResponse } from "./responses.js";
import { compareBoardNames } from "./board-directory.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  navigate,
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
const BoardIcon = iconComponent(ListViewIcon);
const Plus = iconComponent(Add01Icon);
const Settings = iconComponent(Settings01Icon);
const Users = iconComponent(UserGroupIcon);
const KeyRound = iconComponent(Key01Icon);
const Auth = lazy(() => import("./auth.js").then((m) => ({ default: m.Auth })));
const BoardPage = lazy(() =>
  import("./board.js").then((m) => ({ default: m.BoardPage })),
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
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const listener = () => setPath(window.location.pathname);
    window.addEventListener("popstate", listener);
    window.addEventListener("mill:navigate", listener);
    return () => {
      window.removeEventListener("popstate", listener);
      window.removeEventListener("mill:navigate", listener);
    };
  }, []);
  return path;
}
export function App() {
  const path = usePath();
  const [session, setSession] = useState<Session | null>(null);
  const [setup, setSetup] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardsPending, setBoardsPending] = useState(false);
  const [boardsError, setBoardsError] = useState("");
  const [routeBoard, setRouteBoard] = useState<Pick<
    Board,
    "id" | "name"
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
  const recentlyCreatedBoard = useRef<Board | null>(null);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
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
    try {
      const [me, people, notification] = await Promise.all([
        api<Session>("/auth/me"),
        api<{ items: Member[] }>("/auth/members"),
        api<{ unreadCount: number }>("/notifications?limit=1"),
      ]);
      setSession(me);
      setMembers(people.items);
      setNotificationCount(notification.unreadCount);
    } catch (e) {
      setError(errorText(e));
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
      lastBoardsRequest.current++;
      recentlyCreatedBoard.current = null;
      setBoards([]);
      setSession(null);
      setExpired(true);
    };
    window.addEventListener("mill:expired", listener);
    return () => window.removeEventListener("mill:expired", listener);
  }, []);
  useEffect(() => {
    if (session) {
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
  }, [session?.user.id]);
  useEffect(() => {
    if (session && path.startsWith("/settings/"))
      document.title = `${path.split("/").pop()?.replaceAll("-", " ")} · Mill`;
    if (session && path === "/") document.title = "Boards · Mill";
  }, [path, session?.user.id]);
  useEffect(() => {
    if (session && (path === "/" || path === "/notifications") && boards.length)
      navigate(`/boards/${boards[0].id}`);
  }, [session, path, boards]);
  if (!ready)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <QueryLoading label="Opening Mill…" />
      </main>
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
    return (
      <>
        {expired && (
          <div role="status" className="session-banner">
            Your session expired. Sign in again to continue.
          </div>
        )}
        <Suspense fallback={<QueryLoading />}>
          <Auth
            setup={setup}
            onSession={(s) => {
              setSession(s);
              setSetup(false);
              setExpired(false);
              if (path.startsWith("/invite") || path.startsWith("/recover"))
                navigate("/");
            }}
          />
        </Suspense>
      </>
    );
  }
  const activeBoardId = path.match(/^\/boards\/([^/]+)/)?.[1];
  if (path === "/oauth/consent")
    return (
      <Suspense fallback={<QueryLoading />}>
        <AppConsent session={session} />
      </Suspense>
    );
  const settingsSection = path.match(/^\/settings\/([^/]+)/)?.[1];
  const knownSettings = [
    "profile",
    "security",
    "members",
    "agents",
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
  const sidebar = (
    <ApplicationSidebar
      config={{
        accessibleLabel: "Workspace navigation",
        homeHref: "/",
        brand: {
          title: "Mill",
          logo: (
            <span className="grid size-8 place-items-center rounded-lg bg-accent text-base font-semibold text-accent-foreground">
              M
            </span>
          ),
        },
        groups: [
          {
            id: "boards",
            label: "Boards",
            items: [
              ...boards.map((board) => ({
                id: board.id,
                href: `/boards/${board.id}`,
                label: board.name,
                icon: <BoardIcon />,
                active: activeBoardId === board.id,
              })),
              ...(session.user.role === "viewer"
                ? []
                : [
                    {
                      id: "create-project",
                      label: "Create Project",
                      icon: <Plus />,
                      onPress: () => {
                        setNewBoard(true);
                        setCreateError("");
                      },
                    },
                  ]),
            ],
            content: (
              <div className="grid min-w-0 gap-1">
                <ErrorMessage>{boardsError}</ErrorMessage>
                {boardsPending && (
                  <p className="px-2 py-1.5 text-xs text-muted" role="status">
                    Loading boards…
                  </p>
                )}
                {boardsError && (
                  <Button
                    variant="secondary"
                    isDisabled={boardsPending}
                    onPress={() => void loadBoards()}
                  >
                    Retry loading boards
                  </Button>
                )}
              </div>
            ),
          },
          {
            id: "workspace",
            label: "Workspace",
            items: [
              ...(admin ? [nav("People", "/settings/members", <Users />)] : []),
              nav("Agent access", "/settings/agents", <KeyRound />),
              ...(admin
                ? [
                    nav(
                      "Workspace settings",
                      "/settings/workspace",
                      <Settings />,
                    ),
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
            onLogout={() =>
              void api("/auth/logout", {})
                .then(() => {
                  lastBoardsRequest.current++;
                  recentlyCreatedBoard.current = null;
                  setSession(null);
                  setBoards([]);
                  navigate("/");
                })
                .catch((e) => setError(errorText(e)))
            }
          />
        ),
      }}
    />
  );
  const settingsTitles: Record<string, string> = {
    profile: "Profile",
    security: "Account security",
    members: "People",
    agents: "Agent access",
    workspace: "Workspace",
  };
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
  return (
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
        toggleShortcut
        {...sidebarState}
        navbar={
          <Navbar
            title={navbarTitle}
            sidebarOpen={sidebarState.sidebarOpen}
            onSidebarToggle={() =>
              sidebarState.onSidebarOpenChange(!sidebarState.sidebarOpen)
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
          <Suspense fallback={<QueryLoading />}>
            {error && <ErrorMessage>{error}</ErrorMessage>}
            {activeBoardId ? (
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
                onBoardsChanged={(removedBoardId?: string) => {
                  if (removedBoardId) {
                    if (recentlyCreatedBoard.current?.id === removedBoardId)
                      recentlyCreatedBoard.current = null;
                    setBoards((previous) =>
                      previous.filter((board) => board.id !== removedBoardId),
                    );
                  }
                  void loadBoards();
                  void refresh();
                }}
                path={path}
              />
            ) : settingsSection && knownSettings.includes(settingsSection) ? (
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
            ) : path === "/" && boardsPending ? (
              <QueryLoading label="Loading boards…" variant="list" />
            ) : path === "/" && boardsError ? (
              <EmptyState>
                <EmptyState.Header>
                  <EmptyState.Title>
                    Boards could not be loaded
                  </EmptyState.Title>
                  <EmptyState.Description>{boardsError}</EmptyState.Description>
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
                  <EmptyState.Title>Your work starts here</EmptyState.Title>
                  <EmptyState.Description>
                    Create a board, give it a few tasks, and make the next step
                    clear.
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
            onChange={(e) => setBoardPrefix(e.target.value.toUpperCase())}
            maxLength={12}
            placeholder="e.g. WEB"
            description="Optional. Mill creates stable identifiers such as WEB-12."
          />
          <ErrorMessage>{createError}</ErrorMessage>
        </form>
      </Dialog>
    </AppShell>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <ErrorPage /> : this.props.children;
  }
}
