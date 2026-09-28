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
  Choice,
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
  ArrowDown01Icon,
  ArrowRight01Icon,
  Audit01Icon,
  Download01Icon,
  KanbanIcon,
  Key01Icon,
  Notification01Icon,
  Settings01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Board, Member } from "../../../packages/contracts/src/index.js";
import { ErrorPage } from "./error-page.js";
import { QueryLoading } from "./query-state.js";
import { hasBoardResponse, hasBoardsResponse } from "./responses.js";
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
        className="shrink-0"
        {...props}
        icon={icon}
      />
    );
  };
}
const Bell = iconComponent(Notification01Icon);
const ChevronDown = iconComponent(ArrowDown01Icon);
const ChevronRight = iconComponent(ArrowRight01Icon);
const Columns3 = iconComponent(KanbanIcon);
const Plus = iconComponent(Add01Icon);
const Settings = iconComponent(Settings01Icon);
const Users = iconComponent(UserGroupIcon);
const KeyRound = iconComponent(Key01Icon);
const Download = iconComponent(Download01Icon);
const ScrollText = iconComponent(Audit01Icon);
const Auth = lazy(() => import("./auth.js").then((m) => ({ default: m.Auth })));
const BoardPage = lazy(() =>
  import("./board.js").then((m) => ({ default: m.BoardPage })),
);
const SettingsPage = lazy(() =>
  import("./settings.js").then((m) => ({ default: m.SettingsPage })),
);
const Inbox = lazy(() =>
  import("./inbox.js").then((m) => ({ default: m.Inbox })),
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
  const [boardsMore, setBoardsMore] = useState(false);
  const [boardsCursor, setBoardsCursor] = useState<string | null>(null);
  const [boardsPending, setBoardsPending] = useState(false);
  const [boardsError, setBoardsError] = useState("");
  const [boardsRestart, setBoardsRestart] = useState(false);
  const [routeBoard, setRouteBoard] = useState<Pick<
    Board,
    "id" | "name"
  > | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [notificationCount, setNotificationCount] = useState(0);
  const sidebarState = usePersistentAppSidebar();
  const [boardsExpanded, setBoardsExpanded] = useState(
    localStorage.getItem("mill:boards-expanded") !== "false",
  );
  const [boardState, setBoardState] = useState("active");
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
  async function loadBoards({
    append = false,
    collection = boardState,
  }: { append?: boolean; collection?: string } = {}) {
    if (append && (boardsPending || !boardsCursor)) return;
    const req = ++lastBoardsRequest.current;
    setBoardsPending(true);
    setBoardsError("");
    setBoardsRestart(false);
    if (!append) {
      setBoards([]);
      setBoardsMore(false);
      setBoardsCursor(null);
    }
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (collection !== "active")
        params.set(collection === "deleted" ? "deleted" : "archived", "true");
      if (append && boardsCursor) params.set("cursor", boardsCursor);
      const result = await api<{
        items: Board[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(`/boards?${params}`, undefined, "GET", {
        validateResponse: hasBoardsResponse,
      });
      if (req !== lastBoardsRequest.current) return;
      let created = recentlyCreatedBoard.current;
      if (created) {
        const fresh = result.items.find((board) => board.id === created?.id);
        if (fresh) {
          recentlyCreatedBoard.current = null;
          created = null;
        } else {
          try {
            const current = await api<{ board: Board }>(
              `/boards/${created.id}`,
              undefined,
              "GET",
              { validateResponse: hasBoardResponse },
            );
            if (req !== lastBoardsRequest.current) return;
            created = current.board;
            recentlyCreatedBoard.current = current.board;
          } catch (e) {
            if (req !== lastBoardsRequest.current) return;
            if (e instanceof ApiError && [403, 404].includes(e.status)) {
              recentlyCreatedBoard.current = null;
              created = null;
            } else throw e;
          }
        }
      }
      const include =
        created &&
        (collection === "deleted"
          ? !!created.deletedAt
          : collection === "archived"
            ? created.archived && !created.deletedAt
            : !created.archived && !created.deletedAt)
          ? created
          : null;
      setBoards((current) => {
        const items = [
          ...(append ? current : []),
          ...result.items,
          ...(include ? [include] : []),
        ];
        return Array.from(
          new Map(items.map((board) => [board.id, board])).values(),
        ).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      });
      setBoardsMore(result.hasMore);
      setBoardsCursor(result.nextCursor);
    } catch (e) {
      if (req === lastBoardsRequest.current) {
        setBoardsError(errorText(e));
        setBoardsRestart(
          append && e instanceof ApiError && [400, 409].includes(e.status),
        );
      }
    } finally {
      if (req === lastBoardsRequest.current) setBoardsPending(false);
    }
  }
  useEffect(() => {
    void initial();
    const listener = () => {
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
  }, [session?.user.id, boardState]);
  useEffect(() => {
    if (session && path.startsWith("/settings/"))
      document.title = `${path.split("/").pop()?.replaceAll("-", " ")} · Mill`;
    if (session && path === "/notifications") document.title = "Inbox · Mill";
    if (session && path === "/") document.title = "Boards · Mill";
  }, [path, session?.user.id]);
  useEffect(() => {
    if (session && path === "/" && boards.length)
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
    "audit",
    "data",
  ];
  function nav(label: string, url: string, icon: ReactNode): ShellLinkConfig {
    return {
      id: url,
      href: url,
      label,
      icon,
      active: path === url,
      ...(url === "/notifications" && notificationCount > 0
        ? {
            badge: {
              value: notificationCount,
              label: `${notificationCount} unread notifications`,
            },
          }
        : {}),
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
          { id: "inbox", items: [nav("Inbox", "/notifications", <Bell />)] },
          {
            id: "boards",
            header: (
              <div className="flex min-w-0 items-center justify-between gap-1">
                <Button
                  variant="ghost"
                  className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-3 rounded-2xl px-2 py-1.5 text-sm font-normal text-muted"
                  aria-expanded={boardsExpanded}
                  onPress={() => {
                    setBoardsExpanded(!boardsExpanded);
                    localStorage.setItem(
                      "mill:boards-expanded",
                      String(!boardsExpanded),
                    );
                  }}
                >
                  {boardsExpanded ? <ChevronDown /> : <ChevronRight />}
                  <span>Boards</span>
                </Button>
                {session.user.role !== "viewer" && (
                  <Button
                    variant="ghost"
                    isIconOnly
                    aria-label="Create board"
                    onPress={() => {
                      setNewBoard(true);
                      setCreateError("");
                    }}
                  >
                    <Plus />
                  </Button>
                )}
              </div>
            ),
            content: boardsExpanded ? (
              <div
                id="sidebar-board-collection"
                className="grid min-w-0 gap-2 px-2 py-1"
              >
                <Choice
                  label="Board collection"
                  variant="secondary"
                  value={boardState}
                  onChange={setBoardState}
                  items={[
                    { id: "active", name: "Active boards" },
                    { id: "archived", name: "Archived boards" },
                    { id: "deleted", name: "Deleted boards" },
                  ]}
                />
                {!boards.length && !boardsPending && !boardsError && (
                  <p className="text-xs text-muted">No {boardState} boards.</p>
                )}
              </div>
            ) : undefined,
            items: boardsExpanded
              ? boards.map((board) => ({
                  id: board.id,
                  href: `/boards/${board.id}`,
                  label: board.name,
                  icon: <Columns3 />,
                  active: activeBoardId === board.id,
                }))
              : [],
            footerContent: boardsExpanded ? (
              <div className="grid min-w-0 gap-2 px-2 py-1">
                <ErrorMessage>{boardsError}</ErrorMessage>
                {boardsPending && (
                  <p className="text-sm text-muted" role="status">
                    Loading boards…
                  </p>
                )}
                {(boardsMore || boardsError) && (
                  <Button
                    variant="secondary"
                    isDisabled={boardsPending}
                    onPress={() =>
                      void loadBoards({
                        append: !!boardsCursor && !boardsRestart,
                      })
                    }
                  >
                    {boardsError
                      ? boardsRestart
                        ? "Reload boards"
                        : "Retry loading boards"
                      : "Load more boards"}
                  </Button>
                )}
              </div>
            ) : undefined,
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
                    nav("Export and import", "/settings/data", <Download />),
                    nav("Audit history", "/settings/audit", <ScrollText />),
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
    audit: "Audit history",
    data: "Export and import",
  };
  const navbarTitle = activeBoardId
    ? (boards.find((board) => board.id === activeBoardId)?.name ??
      (routeBoard?.id === activeBoardId ? routeBoard.name : "Board"))
    : path === "/notifications"
      ? "Inbox"
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
                <Button
                  variant="ghost"
                  isIconOnly
                  className="relative"
                  aria-label="Open notifications"
                  onPress={() => navigate("/notifications")}
                >
                  <Bell />
                  {notificationCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute end-1 top-1 size-1.5 rounded-full bg-accent"
                    />
                  )}
                </Button>
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
                onBoardsChanged={() => {
                  void loadBoards();
                  void refresh();
                }}
                path={path}
              />
            ) : path === "/notifications" ? (
              <Inbox
                timeZone={session.user.timeZone}
                userId={session.user.id}
                onRead={() => void refresh()}
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
                  <Columns3 size={32} />
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
                setBoardState("active");
                void loadBoards({ collection: "active" });
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
