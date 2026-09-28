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
import { api, errorText, navigate, type Session } from "./api.js";

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
type Notification = {
  id: string;
  taskId: string;
  boardId?: string;
  kind: string;
  actorName?: string;
  identifier?: string;
  body?: string;
  title?: string;
  readAt: string | null;
  createdAt: string;
};
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
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(
    localStorage.getItem("mill:theme") ??
      (window.matchMedia("(prefers-color-scheme:dark)").matches
        ? "dark"
        : "light"),
  );
  const lastBoardsRequest = useRef(0);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mill:theme", theme);
  }, [theme]);
  async function initial() {
    setError("");
    try {
      const status = await api<{ setupRequired: boolean }>("/auth/status");
      setSetup(status.setupRequired);
      if (!status.setupRequired) {
        try {
          setSession(await api<Session>("/auth/me"));
        } catch {
          setSession(null);
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
    const req = ++lastBoardsRequest.current;
    try {
      const param =
        boardState === "active"
          ? ""
          : `?${boardState === "deleted" ? "deleted" : "archived"}=true`;
      const result = await api<{ items: Board[] }>(`/boards${param}`);
      if (req === lastBoardsRequest.current) setBoards(result.items);
    } catch (e) {
      if (req === lastBoardsRequest.current) setError(errorText(e));
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
      <main className="loading-state" role="status">
        Opening Mill…
      </main>
    );
  if (!session) {
    if (error)
      return (
        <main className="error-page">
          <h1>Mill could not load</h1>
          <ErrorMessage>{error}</ErrorMessage>
          <Button onPress={() => void initial()}>Try again</Button>
        </main>
      );
    return (
      <>
        {expired && (
          <div role="status" className="session-banner">
            Your session expired. Sign in again to continue.
          </div>
        )}
        <Suspense
          fallback={
            <div className="loading-state" role="status">
              Loading…
            </div>
          }
        >
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
                {!boards.length && (
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
    ? (boards.find((board) => board.id === activeBoardId)?.name ?? "Board")
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
          <Suspense
            fallback={
              <div className="loading-state" role="status">
                Loading…
              </div>
            }
          >
            {error && <ErrorMessage>{error}</ErrorMessage>}
            {activeBoardId ? (
              <BoardPage
                key={activeBoardId}
                boardId={activeBoardId}
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
            ) : path === "/oauth/consent" ? (
              <Consent boards={boards} />
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
        open={newBoard}
        onClose={() => setNewBoard(false)}
        title="Create a board"
        footer={
          <>
            <Button variant="secondary" onPress={() => setNewBoard(false)}>
              Cancel
            </Button>
            <Button type="submit" form="new-board" isDisabled={busy}>
              Create board
            </Button>
          </>
        }
      >
        <form
          id="new-board"
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setCreateError("");
            void api<{ board: Board }>("/boards", {
              name: boardName,
              ...(boardPrefix ? { prefix: boardPrefix } : {}),
            })
              .then((result) => {
                setNewBoard(false);
                setBoardName("");
                setBoardPrefix("");
                setBoardState("active");
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
            autoFocus
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
function Inbox({
  userId,
  onRead,
  timeZone,
}: {
  userId: string;
  timeZone: string;
  onRead: () => void;
}) {
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  async function load() {
    try {
      const data = await api<{ items: Notification[] }>(
        "/notifications?limit=100",
      );
      setItems(data.items);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void load();
  }, [userId]);
  async function mark(ids?: string[]) {
    setBusy(true);
    try {
      await api(
        "/notifications",
        ids ? { ids, read: true } : { all: true, read: true },
        "PATCH",
      );
      await load();
      onRead();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-page">
      <header className="row space-between">
        <div>
          <h1>Inbox</h1>
          <p className="muted">
            Assignments and mentions that need your attention.
          </p>
        </div>
        <Button
          variant="secondary"
          onPress={() => void mark()}
          isDisabled={busy}
        >
          Mark all read
        </Button>
      </header>
      <div className="row">
        <Button
          variant={unreadOnly ? "ghost" : "secondary"}
          onPress={() => setUnreadOnly(false)}
        >
          All
        </Button>
        <Button
          variant={unreadOnly ? "secondary" : "ghost"}
          onPress={() => setUnreadOnly(true)}
        >
          Unread
        </Button>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      <div className="separator-list notifications">
        {items
          .filter((i) => !unreadOnly || !i.readAt)
          .map((i) => (
            <article
              key={i.id}
              className={`notification ${i.readAt ? "" : "unread"}`}
            >
              <span className="unread-dot" />
              <div>
                <strong>{`${i.actorName ?? "A teammate"} ${i.kind === "assignment" ? "assigned you" : "mentioned you in"} ${i.identifier ?? "a task"}`}</strong>
                <p className="muted small">
                  {new Date(i.createdAt).toLocaleString(undefined, {
                    timeZone,
                  })}
                </p>
                <div className="row">
                  <Button
                    variant="ghost"
                    onPress={() =>
                      void api<{ task: { boardId: string } }>(
                        `/tasks/${i.taskId}`,
                      )
                        .then(({ task }) => {
                          void mark([i.id]);
                          navigate(`/boards/${task.boardId}/tasks/${i.taskId}`);
                        })
                        .catch((e) => setError(errorText(e)))
                    }
                  >
                    Open task
                  </Button>
                  {!i.readAt && (
                    <Button variant="ghost" onPress={() => void mark([i.id])}>
                      Mark read
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
      </div>
      {!items.filter((i) => !unreadOnly || !i.readAt).length && (
        <div className="empty-state">
          <Bell />
          <h2>You’re all caught up</h2>
          <p className="muted">
            New assignments and mentions will appear here.
          </p>
        </div>
      )}
    </section>
  );
}
function Consent({ boards }: { boards: Board[] }) {
  const [boardId, setBoardId] = useState("");
  const request = new URLSearchParams(window.location.search).get("request");
  const [info, setInfo] = useState<{
    clientName: string;
    clientTrust: "unverified" | "metadata-document";
    redirectUri: string;
    scope: string;
    user: { name: string; role: string };
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (request)
      void api<typeof info>(`/oauth/consent/${request}`)
        .then(setInfo)
        .catch((e) => setError(errorText(e)));
    else
      setError(
        "This authorization request is missing. Start the connection again from your agent.",
      );
  }, [request]);
  async function decide(allow: boolean) {
    setBusy(true);
    try {
      const { redirectTo } = await api<{ redirectTo: string }>(
        `/oauth/consent/${request}`,
        { allow, ...(boardId ? { boardIds: [boardId] } : {}) },
      );
      window.location.assign(redirectTo);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <section className="settings-page narrow">
      <h1>Connect an agent</h1>
      <ErrorMessage>{error}</ErrorMessage>
      {info && (
        <>
          <p>
            <strong>{info.clientName}</strong> wants to access Mill as{" "}
            {info.user.name}.
          </p>
          <p className="muted small">
            {info.clientTrust === "unverified"
              ? "This application registered its own name. Mill has not verified its identity. Continue only if you recognize the agent."
              : "This application describes its identity in an HTTPS metadata document. Check that you recognize it before continuing."}
          </p>
          <div className="consent-card">
            <h2>Requested permissions</h2>
            <p>
              {info.scope.includes("write")
                ? "Read and change your boards, tasks, and comments."
                : "Read your boards, tasks, and comments."}
            </p>
            <p className="muted small">
              The agent keeps your current role. You can revoke its access
              later.
            </p>
            <Choice
              label="Approved boards"
              value={boardId}
              onChange={setBoardId}
              items={[{ id: "", name: "All boards" }, ...boards]}
              search
            />
            <p className="small">
              Redirects to {new URL(info.redirectUri).origin}
            </p>
          </div>
          <div className="row">
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => void decide(false)}
            >
              Deny
            </Button>
            <Button isDisabled={busy} onPress={() => void decide(true)}>
              Allow access
            </Button>
          </div>
        </>
      )}
    </section>
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
