import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Choice,
  Dialog,
  Drawer,
  ErrorMessage,
  TextField,
} from "@mill/web-design-system";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Columns3,
  LogOut,
  Menu,
  Moon,
  Plus,
  Settings,
  Sun,
  Users,
  X,
  KeyRound,
  Shield,
  Download,
  ScrollText,
} from "lucide-react";
import type { Board, Member } from "../../../packages/contracts/src/index.js";
import { ErrorPage } from "./error-page.js";
import { api, errorText, navigate, type Session } from "./api.js";
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
  const [mobileMenu, setMobileMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(
    window.matchMedia("(max-width:700px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width:700px)");
    const change = () => {
      setIsMobile(media.matches);
      if (!media.matches) setMobileMenu(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
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
    setMobileMenu(false);
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
  function nav(label: string, url: string, icon: ReactNode) {
    return (
      <a
        href={url}
        className={`nav-item ${path === url ? "active" : ""}`}
        onClick={(e) => {
          e.preventDefault();
          navigate(url);
        }}
      >
        {icon}
        <span>{label}</span>
        {url === "/notifications" && notificationCount > 0 && (
          <span className="unread-badge">{notificationCount}</span>
        )}
      </a>
    );
  }
  const admin = session.user.role === "admin";
  const sidebar = (
    <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
      <div className="sidebar-brand">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <span className="mark">M</span>Mill
        </a>
        <Button
          variant="ghost"
          className="mobile-close"
          autoFocus={isMobile}
          aria-label="Close navigation"
          onPress={() => setMobileMenu(false)}
        >
          <X />
        </Button>
      </div>
      <div className="workspace-name" title={session.workspace.name}>
        {session.workspace.name}
      </div>
      <nav aria-label="Workspace navigation">
        {nav("Inbox", "/notifications", <Bell />)}
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <Button
              variant="ghost"
              className="section-toggle"
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
          {boardsExpanded && (
            <>
              <div className="sidebar-board-filter">
                <Choice
                  label="Board collection"
                  value={boardState}
                  onChange={setBoardState}
                  items={[
                    { id: "active", name: "Active boards" },
                    { id: "archived", name: "Archived boards" },
                    { id: "deleted", name: "Deleted boards" },
                  ]}
                />
              </div>
              {boards.map((board) => (
                <a
                  key={board.id}
                  href={`/boards/${board.id}`}
                  className={`nav-item ${activeBoardId === board.id ? "active" : ""}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/boards/${board.id}`);
                  }}
                >
                  <Columns3 />
                  <span>{board.name}</span>
                </a>
              ))}
              {!boards.length && (
                <p className="sidebar-empty muted small">
                  No {boardState} boards.
                </p>
              )}
            </>
          )}
        </div>
        <div className="sidebar-section settings-nav">
          <span className="sidebar-label">Workspace</span>
          {admin && nav("People", "/settings/members", <Users />)}
          {nav("Agent access", "/settings/agents", <KeyRound />)}
          {admin &&
            nav("Workspace settings", "/settings/workspace", <Settings />)}
          {admin && nav("Export and import", "/settings/data", <Download />)}
          {admin && nav("Audit history", "/settings/audit", <ScrollText />)}
        </div>
      </nav>
      <div className="sidebar-bottom">
        {nav("Account security", "/settings/security", <Shield />)}
        <a
          href="/settings/profile"
          className={`profile-link ${settingsSection === "profile" ? "active" : ""}`}
          onClick={(e) => {
            e.preventDefault();
            navigate("/settings/profile");
          }}
        >
          <span className="avatar">{session.user.name.slice(0, 1)}</span>
          <span>
            <strong>{session.user.name}</strong>
            <small>{session.user.role}</small>
          </span>
        </a>
        <div className="row space-between">
          <Button
            variant="ghost"
            aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
            onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button
            variant="ghost"
            aria-label="Sign out"
            onPress={() =>
              void api("/auth/logout", {})
                .then(() => {
                  setSession(null);
                  setBoards([]);
                  navigate("/");
                })
                .catch((e) => setError(errorText(e)))
            }
          >
            <LogOut />
          </Button>
        </div>
      </div>
    </aside>
  );
  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <Button
          variant="ghost"
          aria-label="Open navigation"
          onPress={() => setMobileMenu(true)}
        >
          <Menu />
        </Button>
        <span className="brand">
          <span className="mark">M</span>Mill
        </span>
        <Button
          variant="ghost"
          aria-label="Open notifications"
          onPress={() => navigate("/notifications")}
        >
          <Bell />
          {notificationCount > 0 && <span className="unread-dot" />}
        </Button>
      </div>
      {isMobile ? (
        <Drawer open={mobileMenu} onClose={() => setMobileMenu(false)}>
          {sidebar}
        </Drawer>
      ) : (
        sidebar
      )}
      <main className="workspace-main">
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
            <div className="empty-state welcome">
              <span className="mark large">M</span>
              <h1>Your work starts here</h1>
              <p className="muted">
                Create a board, give it a few tasks, and make the next step
                clear.
              </p>
              {session.user.role !== "viewer" ? (
                <Button onPress={() => setNewBoard(true)}>
                  <Plus />
                  Create your first board
                </Button>
              ) : (
                <p className="muted small">
                  Ask a member or administrator to create a board.
                </p>
              )}
            </div>
          ) : (
            <ErrorPage code="404" />
          )}
        </Suspense>
      </main>
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
    </div>
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
