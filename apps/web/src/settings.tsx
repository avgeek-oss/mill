import { useEffect, useState, type ReactNode } from "react";
import {
  startRegistration,
  startAuthentication,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  Button,
  Chip,
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
} from "@mill/web-design-system";
import { Download, KeyRound, Plus, Shield, Trash2 } from "lucide-react";
import type {
  Activity,
  Board,
  Member,
} from "../../../packages/contracts/src/index.js";
import { api, errorText, type Session } from "./api.js";
type SessionRow = {
  id: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};
type Passkey = { id: string; name: string; createdAt: string };
type Credential = {
  id: string;
  name: string;
  scopes: string[];
  boardIds: string[] | null;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
};
export function SettingsPage({
  section,
  session,
  members,
  boards,
  onRefresh,
}: {
  section: string;
  session: Session;
  members: Member[];
  boards: Board[];
  onRefresh: () => void;
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [audit, setAudit] = useState<Activity[]>([]);
  const [invite, setInvite] = useState({ email: "", role: "member" });
  const [inviteLink, setInviteLink] = useState("");
  const [credentialForm, setCredentialForm] = useState({
    name: "",
    scope: "read",
    boardId: "",
    expiresInDays: "30",
  });
  const [token, setToken] = useState("");
  const [securityPassword, setSecurityPassword] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(
    null,
  );
  const [codes, setCodes] = useState<string[]>([]);
  const [reauth, setReauth] = useState(false);
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [reauthMethod, setReauthMethod] = useState("totp");
  const [reauthChallenge, setReauthChallenge] = useState<{
    challengeId: string;
    methods: string[];
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    action: () => Promise<void>;
  } | null>(null);
  async function load() {
    setError("");
    try {
      if (section === "security") {
        const [s, p] = await Promise.all([
          api<{ items: SessionRow[] }>("/auth/sessions"),
          api<{ items: Passkey[] }>("/auth/passkeys"),
        ]);
        setSessions(s.items);
        setPasskeys(p.items);
      }
      if (section === "agents")
        setCredentials(
          (await api<{ items: Credential[] }>("/credentials")).items,
        );
      if (section === "members")
        setInvitations(
          (await api<{ items: Invitation[] }>("/auth/invitations")).items,
        );
      if (section === "audit")
        setAudit((await api<{ items: Activity[] }>("/audit?limit=100")).items);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    document.title = `${title} · Mill`;
    void load();
    setNotice("");
    setToken("");
  }, [section]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      onRefresh();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function secure(action: () => Promise<void>) {
    setPending(() => action);
    setReauth(true);
    setReauthChallenge(null);
    setSecurityPassword("");
    setVerifyCode("");
  }
  async function confirmIdentity() {
    setBusy(true);
    setError("");
    try {
      if (reauthChallenge) {
        await api("/auth/second-factor", {
          challengeId: reauthChallenge.challengeId,
          method: reauthMethod,
          code: verifyCode,
        });
      } else {
        const result = await api<{
          requiresSecondFactor?: boolean;
          challengeId: string;
          methods: string[];
          preferredMethod: string;
        }>("/auth/reauth", { password: securityPassword });
        if (result.requiresSecondFactor) {
          setReauthChallenge(result);
          setReauthMethod(
            result.methods.includes("totp") ? "totp" : "recovery",
          );
          if (result.preferredMethod === "passkey") {
            const opts = await api<{
              challengeId: string;
              options: PublicKeyCredentialRequestOptionsJSON;
            }>("/auth/passkeys/authenticate/options", {
              challengeId: result.challengeId,
            });
            const response = await startAuthentication({
              optionsJSON: opts.options,
            });
            await api("/auth/passkeys/authenticate/verify", {
              challengeId: opts.challengeId,
              response,
            });
          } else {
            setReauthChallenge(result);
            return;
          }
        }
      }
      setReauth(false);
      if (pending) await run(pending);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const admin = session.user.role === "admin";
  const title =
    (
      {
        profile: "Profile",
        security: "Account security",
        members: "People",
        agents: "Agent access",
        workspace: "Workspace",
        audit: "Audit history",
        data: "Export and import",
      } as Record<string, string>
    )[section] ?? "Settings";
  if (["members", "workspace", "audit", "data"].includes(section) && !admin)
    return (
      <section className="settings-page">
        <h1>Administrator access required</h1>
        <p className="muted">
          Ask your workspace administrator to manage this setting.
        </p>
      </section>
    );
  function block(title: string, description: string, children: ReactNode) {
    return (
      <section className="settings-section">
        <h2>{title}</h2>
        <p className="muted">{description}</p>
        {children}
      </section>
    );
  }
  return (
    <section className="settings-page">
      <header>
        <h1>{title}</h1>
        <p className="muted">
          {section === "agents"
            ? "Connect external agents with scoped, revocable credentials."
            : section === "members"
              ? "Give each person the access they need."
              : "Manage your workspace and account."}
        </p>
      </header>
      <ErrorMessage>{error}</ErrorMessage>
      {notice && (
        <p role="status" className="success-message">
          {notice}
        </p>
      )}
      {section === "profile" && (
        <form
          className="stack narrow"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void run(async () => {
              await api(
                "/auth/profile",
                {
                  name: data.get("name"),
                  timeZone: data.get("timeZone"),
                  notificationPreferences: {
                    assignments: data.get("assignments") === "on",
                    mentions: data.get("mentions") === "on",
                  },
                },
                "PATCH",
              );
              setNotice("Preferences saved.");
            });
          }}
        >
          <TextField
            label="Name"
            name="name"
            defaultValue={session.user.name}
            required
            maxLength={100}
          />
          <TextField
            label="Email"
            value={session.user.email}
            readOnly
            description="Your email identifies this account."
          />
          <TimeZoneField initial={session.user.timeZone} />
          <h2>Notifications</h2>
          <label className="check-option">
            <input
              type="checkbox"
              name="assignments"
              defaultChecked={
                session.user.notificationPreferences.assignments !== false
              }
            />
            Task assignments
          </label>
          <label className="check-option">
            <input
              type="checkbox"
              name="mentions"
              defaultChecked={
                session.user.notificationPreferences.mentions !== false
              }
            />
            Mentions in comments
          </label>
          <p className="muted small">
            Notifications appear in your inbox. Email delivery is unavailable in
            B1.
          </p>
          <Button type="submit" isDisabled={busy}>
            Save preferences
          </Button>
        </form>
      )}
      {section === "security" && (
        <>
          {block(
            "Passkeys",
            "Sign in with your device or security key. Mill prefers a passkey when second verification is needed.",
            <>
              <div className="separator-list">
                {passkeys.map((p) => (
                  <div className="row space-between" key={p.id}>
                    <span>
                      <KeyRound /> {p.name}
                      <small className="muted">
                        Added {new Date(p.createdAt).toLocaleDateString()}
                      </small>
                    </span>
                    <Button
                      variant="danger-ghost"
                      isDisabled={busy}
                      onPress={() =>
                        void secure(async () => {
                          await api(`/auth/passkeys/${p.id}`, {}, "DELETE");
                          setNotice("Passkey removed.");
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() =>
                  void secure(async () => {
                    const opts = await api<{
                      challengeId: string;
                      options: PublicKeyCredentialCreationOptionsJSON;
                    }>("/auth/passkeys/register/options", {
                      name: "My passkey",
                    });
                    const response = await startRegistration({
                      optionsJSON: opts.options,
                    });
                    await api("/auth/passkeys/register/verify", {
                      challengeId: opts.challengeId,
                      response,
                      name: "My passkey",
                    });
                    setNotice("Passkey added.");
                  })
                }
              >
                <Plus />
                Add passkey
              </Button>
            </>,
          )}
          {block(
            "Authenticator",
            "Add a second step to password sign-in. Keep recovery codes somewhere safe.",
            session.user.totpEnabled ? (
              <div className="stack narrow">
                <Chip color="success">Authenticator enabled</Chip>
                <TextField
                  label="Authenticator code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                />
                <div className="row">
                  <Button
                    variant="secondary"
                    onPress={() =>
                      void secure(async () => {
                        const r = await api<{ recoveryCodes: string[] }>(
                          "/auth/totp/recovery-codes",
                          { code: verifyCode },
                        );
                        setCodes(r.recoveryCodes);
                      })
                    }
                    isDisabled={busy}
                  >
                    New recovery codes
                  </Button>
                  <Button
                    variant="danger-ghost"
                    onPress={() =>
                      void secure(async () => {
                        await api("/auth/totp/disable", { code: verifyCode });
                        setNotice("Authenticator removed.");
                      })
                    }
                    isDisabled={busy}
                  >
                    Remove authenticator
                  </Button>
                </div>
              </div>
            ) : totp ? (
              <div className="stack narrow">
                <p className="small">
                  Add this secret in your authenticator app, then enter its
                  six-digit code.
                </p>
                <code className="secret">{totp.secret}</code>
                <a href={totp.uri} className="text-link">
                  Open authenticator app
                </a>
                <TextField
                  label="Six-digit code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                />
                <Button
                  onPress={() =>
                    void run(async () => {
                      const r = await api<{ recoveryCodes: string[] }>(
                        "/auth/totp/verify",
                        { code: verifyCode },
                      );
                      setCodes(r.recoveryCodes);
                      setTotp(null);
                      setNotice(
                        "Authenticator enabled. Save your recovery codes now.",
                      );
                    })
                  }
                  isDisabled={busy}
                >
                  Verify authenticator
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                onPress={() =>
                  void secure(async () =>
                    setTotp(await api("/auth/totp/setup", {})),
                  )
                }
                isDisabled={busy}
              >
                <Shield />
                Set up authenticator
              </Button>
            ),
          )}
          {block(
            "Password",
            "Use a unique password with at least 15 characters.",
            <form
              className="stack narrow"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void run(async () => {
                  await api("/auth/password", {
                    currentPassword: data.get("current"),
                    password: data.get("next"),
                  });
                  setNotice("Password changed.");
                  form.reset();
                });
              }}
            >
              <TextField
                label="Current password"
                type="password"
                name="current"
                autoComplete="current-password"
                required
              />
              <TextField
                label="New password"
                type="password"
                name="next"
                autoComplete="new-password"
                required
                minLength={15}
                maxLength={1024}
              />
              <Button variant="secondary" type="submit" isDisabled={busy}>
                Change password
              </Button>
            </form>,
          )}
          {block(
            "Sessions",
            "Review devices signed in to your account. Revoking a session signs out that device.",
            <div className="separator-list">
              {sessions.map((s) => (
                <div className="row space-between" key={s.id}>
                  <div>
                    <strong>
                      {s.current ? "This device" : sessionDevice(s.userAgent)}
                    </strong>
                    <p className="small muted">
                      Last active{" "}
                      {new Date(s.lastSeenAt).toLocaleString(undefined, {
                        timeZone: session.user.timeZone,
                      })}
                    </p>
                  </div>
                  {s.current ? (
                    <Chip>Current</Chip>
                  ) : (
                    <Button
                      variant="danger-ghost"
                      isDisabled={busy}
                      onPress={() =>
                        void run(async () => {
                          await api(`/auth/sessions/${s.id}`, {}, "DELETE");
                          setNotice("Session revoked.");
                        })
                      }
                    >
                      Sign out
                    </Button>
                  )}
                </div>
              ))}
            </div>,
          )}
        </>
      )}
      {section === "members" && (
        <>
          {block(
            "Workspace members",
            "Administrators manage the workspace. Members manage tasks. Viewers can read boards.",
            <div className="separator-list">
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  busy={busy}
                  currentId={session.user.id}
                  onRole={(role) =>
                    void run(async () => {
                      await api(`/auth/members/${m.id}`, { role }, "PATCH");
                      setNotice("Member updated.");
                    })
                  }
                  onRemove={() =>
                    setConfirm({
                      title: "Remove member?",
                      body: `${m.name} will lose access to this workspace. Their comments and activity stay in the history.`,
                      action: async () => {
                        await api(`/auth/members/${m.id}`, {}, "DELETE");
                      },
                    })
                  }
                />
              ))}
            </div>,
          )}
          {block(
            "Invite a person",
            "Share the invitation link directly. Invitations expire after seven days.",
            <form
              className="stack narrow"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await api<{
                    url?: string;
                    inviteUrl?: string;
                    token?: string;
                    invitation?: { token?: string };
                  }>("/auth/invitations", invite);
                  setInviteLink(
                    result.url ??
                      result.inviteUrl ??
                      `${window.location.origin}/invite?token=${result.token ?? result.invitation?.token ?? ""}`,
                  );
                  setNotice(
                    "Invitation created. Share the link with your teammate.",
                  );
                });
              }}
            >
              <TextField
                label="Email"
                type="email"
                value={invite.email}
                onChange={(e) =>
                  setInvite({ ...invite, email: e.target.value })
                }
                required
              />
              <Choice
                label="Role"
                value={invite.role}
                onChange={(role) => setInvite({ ...invite, role })}
                items={["member", "viewer", "admin"].map((id) => ({
                  id,
                  name: id[0].toUpperCase() + id.slice(1),
                }))}
              />
              <Button type="submit" isDisabled={busy}>
                Create invitation
              </Button>
              {inviteLink && (
                <TextField
                  label="Invitation link"
                  value={inviteLink}
                  readOnly
                />
              )}
            </form>,
          )}
          {invitations.length > 0 &&
            block(
              "Invitations",
              "Active invitations grant access only when accepted.",
              <div className="separator-list">
                {invitations.map((i) => (
                  <div className="row space-between" key={i.id}>
                    <span>
                      {i.email}
                      <small className="muted">
                        {i.role} · Expires{" "}
                        {new Date(i.expiresAt).toLocaleDateString()}
                      </small>
                    </span>
                    <div className="row">
                      <Chip>
                        {i.acceptedAt
                          ? "Accepted"
                          : i.revokedAt
                            ? "Revoked"
                            : new Date(i.expiresAt).getTime() <= Date.now()
                              ? "Expired"
                              : "Pending"}
                      </Chip>
                      {!i.acceptedAt &&
                        !i.revokedAt &&
                        new Date(i.expiresAt).getTime() > Date.now() && (
                          <Button
                            variant="danger-ghost"
                            onPress={() =>
                              void run(async () => {
                                await api(
                                  `/auth/invitations/${i.id}`,
                                  {},
                                  "DELETE",
                                );
                                setNotice("Invitation revoked.");
                              })
                            }
                          >
                            Revoke
                          </Button>
                        )}
                    </div>
                  </div>
                ))}
              </div>,
            )}
        </>
      )}
      {section === "agents" && (
        <>
          {block(
            "Credentials",
            "Each credential acts with your current role. Choose read access unless the agent needs to change tasks.",
            <>
              <div className="separator-list">
                {credentials.map((c) => (
                  <div className="row space-between" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <Chip
                        color={
                          c.revokedAt
                            ? "danger"
                            : new Date(c.expiresAt).getTime() <= Date.now()
                              ? "warning"
                              : "success"
                        }
                      >
                        {c.revokedAt
                          ? "Revoked"
                          : new Date(c.expiresAt).getTime() <= Date.now()
                            ? "Expired"
                            : "Active"}
                      </Chip>
                      <p className="small muted">
                        {c.scopes.join(" + ")} · Expires{" "}
                        {new Date(c.expiresAt).toLocaleDateString()}
                        {c.boardIds?.length
                          ? ` · ${c.boardIds.length} boards`
                          : " · All boards"}
                        {c.lastUsedAt
                          ? ` · Last used ${new Date(c.lastUsedAt).toLocaleString(undefined, { timeZone: session.user.timeZone })}`
                          : " · Never used"}
                      </p>
                    </div>
                    <Button
                      variant="danger-ghost"
                      isDisabled={
                        !!c.revokedAt ||
                        new Date(c.expiresAt).getTime() <= Date.now()
                      }
                      onPress={() =>
                        setConfirm({
                          title: "Revoke credential?",
                          body: "This agent will immediately lose access. Existing activity remains in the audit history.",
                          action: async () => {
                            await api(`/credentials/${c.id}`, {}, "DELETE");
                          },
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
              {!credentials.length && (
                <p className="muted small">No credentials yet.</p>
              )}
            </>,
          )}
          {block(
            "Create a credential",
            "The token is shown once. Store it in the agent’s secret manager.",
            <form
              className="stack narrow"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await api<{ token: string }>("/credentials", {
                    name: credentialForm.name,
                    scopes:
                      credentialForm.scope === "write"
                        ? ["read", "write"]
                        : ["read"],
                    ...(credentialForm.boardId
                      ? { boardIds: [credentialForm.boardId] }
                      : {}),
                    expiresInDays: Number(credentialForm.expiresInDays),
                  });
                  setToken(result.token);
                  setNotice(
                    "Credential created. Copy the token before leaving this page.",
                  );
                });
              }}
            >
              <TextField
                label="Name"
                value={credentialForm.name}
                onChange={(e) =>
                  setCredentialForm({ ...credentialForm, name: e.target.value })
                }
                required
                maxLength={80}
              />
              <Choice
                label="Permissions"
                value={credentialForm.scope}
                onChange={(scope) =>
                  setCredentialForm({ ...credentialForm, scope })
                }
                items={[
                  { id: "read", name: "Read tasks" },
                  { id: "write", name: "Read and write tasks" },
                ]}
              />
              <Choice
                label="Board access"
                value={credentialForm.boardId}
                onChange={(boardId) =>
                  setCredentialForm({ ...credentialForm, boardId })
                }
                items={[{ id: "", name: "All boards" }, ...boards]}
                search
              />
              <TextField
                label="Expires in days"
                type="number"
                value={credentialForm.expiresInDays}
                onChange={(e) =>
                  setCredentialForm({
                    ...credentialForm,
                    expiresInDays: e.target.value,
                  })
                }
                min={1}
                max={365}
                required
              />
              <Button type="submit" isDisabled={busy}>
                Create credential
              </Button>
              {token && (
                <TextField label="Token · shown once" value={token} readOnly />
              )}
            </form>,
          )}
          {block(
            "Remote MCP and OAuth",
            "Connect an OAuth-capable agent to this endpoint. Mill will ask you to approve its requested access.",
            <>
              <code className="endpoint">{window.location.origin}/mcp</code>
              <p className="muted small">
                Use HTTPS outside localhost. See the Agents guide in the
                repository for REST and MCP examples.
              </p>
            </>,
          )}
        </>
      )}
      {section === "workspace" &&
        block(
          "Workspace name",
          "A familiar name helps your team find the right place.",
          <form
            className="stack narrow"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void run(async () => {
                await api("/workspace", { name: data.get("name") }, "PATCH");
                setNotice("Workspace updated.");
              });
            }}
          >
            <TextField
              label="Name"
              name="name"
              defaultValue={session.workspace.name}
              required
              maxLength={120}
            />
            <Button type="submit" isDisabled={busy}>
              Save workspace
            </Button>
          </form>,
        )}
      {section === "audit" && (
        <ol className="activity-list">
          {audit.map((a) => (
            <li key={a.id}>
              <span className="activity-dot" />
              <div>
                <strong>{a.actorName}</strong>{" "}
                {a.actorKind === "agent" && <Chip>Agent</Chip>}{" "}
                {a.action.replaceAll("_", " ")}
                <time>
                  {new Date(a.createdAt).toLocaleString(undefined, {
                    timeZone: session.user.timeZone,
                  })}
                </time>
              </div>
            </li>
          ))}
          {!audit.length && <p className="muted">No workspace activity yet.</p>}
        </ol>
      )}
      {section === "data" && (
        <>
          {block(
            "Export your workspace",
            "Download boards, tasks, comments, and member metadata. Passwords, sessions, authenticators, and credentials are excluded.",
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() =>
                void run(async () => {
                  const data = await api("/export");
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(data, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `mill-export-${new Date().toISOString().slice(0, 10)}.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                  setNotice("Workspace exported.");
                })
              }
            >
              <Download />
              Download export
            </Button>,
          )}
          {block(
            "Import an export",
            "Import portable Mill data while keeping your administrator account. Make a database backup before importing.",
            <label className="file-input">
              Choose Mill export
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 32 * 1024 * 1024) {
                    setError("Choose a file smaller than 32 MB.");
                    return;
                  }
                  void file
                    .text()
                    .then((text) => {
                      const payload = JSON.parse(text);
                      setConfirm({
                        title: "Import workspace data?",
                        body: "Mill will validate the export and import its boards, tasks, and comments. Your current administrator remains able to sign in.",
                        action: async () => {
                          const result = await api<{
                            imported: {
                              boards: number;
                              tasks: number;
                              comments: number;
                              members: number;
                              boardIds: string[];
                            };
                          }>("/import", payload);
                          setNotice(
                            `Import completed: ${result.imported.boards} boards, ${result.imported.tasks} tasks, ${result.imported.comments} comments, and ${result.imported.members} members.`,
                          );
                        },
                      });
                    })
                    .catch(() =>
                      setError("This file is not a valid JSON export."),
                    );
                }}
              />
            </label>,
          )}
        </>
      )}
      <Dialog
        open={reauth}
        onClose={() => setReauth(false)}
        title="Confirm it’s you"
        footer={
          <>
            <Button variant="secondary" onPress={() => setReauth(false)}>
              Cancel
            </Button>
            <Button onPress={() => void confirmIdentity()} isDisabled={busy}>
              Confirm
            </Button>
          </>
        }
      >
        <p className="muted small">
          Confirm your identity before changing account security.
        </p>
        {reauthChallenge ? (
          <>
            <Choice
              label="Verification method"
              value={reauthMethod}
              onChange={setReauthMethod}
              items={reauthChallenge.methods
                .filter((m) => m !== "passkey")
                .map((id) => ({
                  id,
                  name: id === "totp" ? "Authenticator" : "Recovery code",
                }))}
            />
            <TextField
              label={
                reauthMethod === "totp" ? "Authenticator code" : "Recovery code"
              }
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              autoComplete="one-time-code"
            />
          </>
        ) : (
          <TextField
            label="Password"
            type="password"
            value={securityPassword}
            onChange={(e) => setSecurityPassword(e.target.value)}
            autoComplete="current-password"
          />
        )}
        <ErrorMessage>{error}</ErrorMessage>
      </Dialog>
      <Dialog
        open={codes.length > 0}
        onClose={() => setCodes([])}
        title="Save your recovery codes"
        footer={
          <Button onPress={() => setCodes([])}>I saved these codes</Button>
        }
      >
        <p>
          Each code can be used once when your authenticator is unavailable.
          These codes are only shown now.
        </p>
        <pre className="recovery-codes">{codes.join("\n")}</pre>
        <Button
          variant="secondary"
          onPress={() =>
            void navigator.clipboard
              .writeText(codes.join("\n"))
              .then(() => setNotice("Recovery codes copied."))
              .catch(() => setError("Copy the codes manually."))
          }
        >
          Copy codes
        </Button>
      </Dialog>
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={confirm.title}
          footer={
            <>
              <Button variant="secondary" onPress={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onPress={() =>
                  void run(async () => {
                    await confirm.action();
                    setConfirm(null);
                  })
                }
                isDisabled={busy}
              >
                Confirm
              </Button>
            </>
          }
        >
          <p>{confirm.body}</p>
          <ErrorMessage>{error}</ErrorMessage>
        </Dialog>
      )}
    </section>
  );
}
function TimeZoneField({ initial }: { initial: string }) {
  const [zone, setZone] = useState(initial);
  return (
    <>
      <Choice
        label="Time zone"
        value={zone}
        onChange={setZone}
        items={[
          ...new Set(["UTC", initial, ...Intl.supportedValuesOf("timeZone")]),
        ].map((id) => ({ id, name: id }))}
        search
      />
      <input type="hidden" name="timeZone" value={zone} />
    </>
  );
}
function MemberRow({
  member,
  busy,
  currentId,
  onRole,
  onRemove,
}: {
  member: Member;
  busy: boolean;
  currentId: string;
  onRole: (role: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="member-row">
      <div>
        <strong>
          {member.name}
          {member.id === currentId ? " (you)" : ""}
        </strong>
        <p className="small muted">{member.email}</p>
      </div>
      <Choice
        label={`Role for ${member.name}`}
        value={member.role}
        onChange={onRole}
        disabled={busy}
        items={["admin", "member", "viewer"].map((id) => ({
          id,
          name: id[0].toUpperCase() + id.slice(1),
        }))}
      />
      <Button
        variant="danger-ghost"
        aria-label={`Remove ${member.name}`}
        isDisabled={busy}
        onPress={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function sessionDevice(agent: string) {
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : null;
  const system = /iPad/.test(agent)
    ? "iPad"
    : /iPhone/.test(agent)
      ? "iPhone"
      : /Android/.test(agent)
        ? "Android"
        : /Windows/.test(agent)
          ? "Windows"
          : /Macintosh|Mac OS/.test(agent)
            ? "macOS"
            : /Linux/.test(agent)
              ? "Linux"
              : null;
  return browser && system
    ? `${browser} on ${system}`
    : (browser ?? system ?? "Another signed-in device");
}
