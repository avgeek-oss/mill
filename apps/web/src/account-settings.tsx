// Adapted from Towbar's public Apache-2.0 security-settings, passkey-settings,
// reauthentication-dialog, and settings-pages compositions.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  startRegistration,
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  Choice,
  CodeBlock,
  Dialog,
  ErrorMessage,
  FieldDescription,
  FieldGroup,
  NewTabIndicator,
  QueryLoading,
  ResourceTable,
  TableCellStack,
  TextField,
  TypographyCode,
  TypographyParagraph,
  Widget,
  toast,
  type ResourceTableColumn,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Logout01Icon,
  Mail01Icon,
  MonitorIcon,
  SecurityCheckIcon,
  Settings01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { Save } from "./icons.js";
import { PageHeading } from "./page-heading.js";
import { RelativeDateTime } from "./relative-date-time.js";
import { timeZoneOffset } from "./time-zone.js";
import { api, errorText, type Session } from "./api.js";
import {
  ChallengeFields,
  PasswordField,
  passkeyError,
  verifyPasskey,
  type IdentityChallenge,
} from "./identity-ui.js";

type SessionRow = {
  id: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};
type Passkey = { id: string; name: string; createdAt: string };
function AccountWidget({
  title,
  icon,
  status,
  busy = false,
  children,
}: {
  title: string;
  icon?: ReactNode;
  status?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Widget
      className="min-w-0"
      aria-label={title}
      role="region"
      aria-busy={busy}
    >
      <Widget.Header endContent={status}>
        <Widget.Title icon={icon}>
          <h2 className="font-medium">{title}</h2>
        </Widget.Title>
      </Widget.Header>
      <Widget.Content>
        <div className="content-grid min-w-0">{children}</div>
      </Widget.Content>
    </Widget>
  );
}
function useAccountList<T>(path: string) {
  const [state, setState] = useState<{
    items: T[] | null;
    pending: boolean;
    error: string;
  }>({ items: null, pending: true, error: "" });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setState((old) => ({ ...old, pending: true, error: "" }));
    try {
      const result = await api<{ items: T[] }>(path);
      if (current === generation.current)
        setState({ items: result.items, pending: false, error: "" });
    } catch (cause) {
      if (current === generation.current)
        setState((old) => ({
          ...old,
          pending: false,
          error: errorText(cause),
        }));
    }
  }, [path]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return { ...state, refresh };
}
function ListState({
  loaded,
  error,
  retry,
  noun,
  children,
}: {
  loaded: boolean;
  error: string;
  retry: () => void;
  noun: string;
  children: ReactNode;
}) {
  if (error)
    return (
      <div className="content-grid">
        <ErrorMessage>{error}</ErrorMessage>
        <div>
          <Button variant="secondary" onPress={retry}>
            Retry {noun}
          </Button>
        </div>
      </div>
    );
  return loaded ? children : <QueryLoading label={`Loading ${noun}`} />;
}
export function AccountSettings({
  section,
  session,
  onRefresh,
}: {
  section: string;
  session: Session;
  onRefresh: () => void;
}) {
  const titles: Record<string, string> = {
    profile: "Profile",
    preferences: "Preferences",
    "email-password": "Email & Password",
    "two-factor": "Two-factor Auth",
    sessions: "Sessions",
    security: "Email & Password",
  };
  const title = titles[section] ?? "Email & Password";
  useEffect(() => {
    document.title = `${title} · Mill`;
  }, [title]);
  switch (section) {
    case "profile":
      return <ProfileSettings session={session} onRefresh={onRefresh} />;
    case "preferences":
      return <PreferenceSettings session={session} onRefresh={onRefresh} />;
    case "two-factor":
      return <TwoFactorSettings session={session} onRefresh={onRefresh} />;
    case "sessions":
      return <SessionSettings session={session} onRefresh={onRefresh} />;
    default:
      return <EmailPasswordSettings session={session} onRefresh={onRefresh} />;
  }
}
function ProfileSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const [name, setName] = useState(session.user.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/auth/profile", { name }, "PATCH");
      toast.success("Profile saved.");
      onRefresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0">
      <PageHeading
        title="Profile"
        icon={<HugeiconsIcon icon={UserAccountIcon} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget title="Profile details">
          <form
            className="content-grid"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-3">
              <p className="text-sm text-muted">
                Click the image to update it on Gravatar.
              </p>
              <a
                aria-label="Edit Gravatar image (opens in a new tab)"
                className="inline-flex w-fit items-center rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                href="https://gravatar.com/profile/avatars"
                rel="noopener noreferrer"
                target="_blank"
              >
                <Avatar
                  aria-hidden="true"
                  email={session.user.email}
                  name={session.user.name}
                  size="md"
                />
                <NewTabIndicator />
              </a>
            </div>
            <FieldGroup>
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
                disabled={busy}
                autoComplete="name"
              />
              <TextField
                label="Email"
                value={session.user.email}
                readOnly
                description="Your email identifies this account."
                autoComplete="username"
              />
            </FieldGroup>
            <ErrorMessage>{error}</ErrorMessage>
            <div>
              <Button type="submit" isDisabled={busy}>
                <Save />
                {busy ? "Saving…" : "Save profile"}
              </Button>
            </div>
          </form>
        </AccountWidget>
      </div>
    </section>
  );
}
function PreferenceSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const [zone, setZone] = useState(session.user.timeZone);
  const timeZones = useMemo(() => {
    const now = new Date();
    return [
      ...new Set([
        "UTC",
        session.user.timeZone,
        ...Intl.supportedValuesOf("timeZone"),
      ]),
    ].map((id) => ({ id, name: id, endContent: timeZoneOffset(id, now) }));
  }, [session.user.timeZone]);
  const [assignments, setAssignments] = useState(
    session.user.notificationPreferences.assignments !== false,
  );
  const [mentions, setMentions] = useState(
    session.user.notificationPreferences.mentions !== false,
  );
  const [busy, setBusy] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  const [notificationError, setNotificationError] = useState("");
  async function save(part: "preferences" | "notifications") {
    if (busy) return;
    setBusy(true);
    const setError =
      part === "preferences" ? setPreferenceError : setNotificationError;
    setError("");
    try {
      await api(
        "/auth/profile",
        part === "preferences"
          ? { timeZone: zone }
          : { notificationPreferences: { assignments, mentions } },
        "PATCH",
      );
      toast.success(
        part === "preferences" ? "Preferences saved." : "Notifications saved.",
      );
      onRefresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0">
      <PageHeading
        title="Preferences"
        icon={<HugeiconsIcon icon={Settings01Icon} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget title="Time zone">
          <form
            className="content-grid"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void save("preferences");
            }}
          >
            <Choice
              label="Time zone"
              value={zone}
              onChange={setZone}
              disabled={busy}
              search
              items={timeZones}
            />
            <ErrorMessage>{preferenceError}</ErrorMessage>
            <div>
              <Button type="submit" isDisabled={busy}>
                <Save />
                {busy ? "Saving…" : "Save preferences"}
              </Button>
            </div>
          </form>
        </AccountWidget>
        <AccountWidget title="Notifications">
          <form
            className="content-grid"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void save("notifications");
            }}
          >
            <p className="text-sm text-muted">
              Choose which in-app notifications you receive.
            </p>
            <div className="grid gap-3">
              <Checkbox
                variant="secondary"
                isSelected={assignments}
                onChange={setAssignments}
                isDisabled={busy}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  Task assignments
                </Checkbox.Content>
              </Checkbox>
              <Checkbox
                variant="secondary"
                isSelected={mentions}
                onChange={setMentions}
                isDisabled={busy}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  Mentions in comments
                </Checkbox.Content>
              </Checkbox>
            </div>
            <ErrorMessage>{notificationError}</ErrorMessage>
            <div>
              <Button type="submit" isDisabled={busy}>
                <Save />
                {busy ? "Saving…" : "Save notifications"}
              </Button>
            </div>
          </form>
        </AccountWidget>
      </div>
    </section>
  );
}
function EmailPasswordSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  return (
    <section className="min-w-0">
      <PageHeading
        title="Email & Password"
        icon={<HugeiconsIcon icon={Mail01Icon} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget title="Email address">
          <TextField
            label="Current email"
            value={session.user.email}
            readOnly
            autoComplete="username"
          />
          <FieldDescription>
            Your email identifies this account.
          </FieldDescription>
        </AccountWidget>
        <AccountWidget title="Password">
          <p className="text-sm text-muted">
            Use a unique password with at least 15 characters.
          </p>
          <PasswordChange onChanged={async () => onRefresh()} />
        </AccountWidget>
      </div>
    </section>
  );
}
function TwoFactorSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const keys = useAccountList<Passkey>("/auth/passkeys");
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(
    null,
  );
  const [totpMode, setTotpMode] = useState<"idle" | "disable" | "recovery">(
    "idle",
  );
  const [code, setCode] = useState("");
  const [totpError, setTotpError] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  async function refresh() {
    onRefresh();
    await keys.refresh();
  }
  function secure(action: () => Promise<void>) {
    setPending(() => action);
  }
  async function verifyAuthenticator() {
    if (totpBusy) return;
    setTotpBusy(true);
    setTotpError("");
    try {
      const result = await api<{ recoveryCodes?: string[] }>(
        totp
          ? "/auth/totp/verify"
          : `/auth/totp/${totpMode === "disable" ? "disable" : "recovery-codes"}`,
        { code },
      );
      if (result.recoveryCodes) setCodes(result.recoveryCodes);
      setTotp(null);
      setTotpMode("idle");
      setCode("");
      toast.success(
        totpMode === "disable"
          ? "Authenticator removed."
          : totpMode === "recovery"
            ? "Recovery codes replaced. Save your new codes now."
            : "Authenticator enabled. Save your recovery codes now.",
      );
      await refresh();
    } catch (cause) {
      setTotpError(errorText(cause));
    } finally {
      setTotpBusy(false);
    }
  }
  return (
    <section className="min-w-0">
      <PageHeading
        title="Two-factor Auth"
        icon={<HugeiconsIcon icon={SecurityCheckIcon} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget
          title="Passkeys"
          busy={keys.pending}
          status={
            keys.items && !keys.error ? (
              <Chip color={keys.items.length ? "success" : "default"}>
                {keys.items.length
                  ? `${keys.items.length} added`
                  : "None added"}
              </Chip>
            ) : undefined
          }
        >
          <p className="text-sm text-muted">
            Sign in with your device or password manager. Mill prefers a passkey
            when second verification is needed.
          </p>
          <ListState
            loaded={keys.items !== null}
            error={keys.error}
            retry={() => void keys.refresh()}
            noun="passkeys"
          >
            {keys.items?.length ? (
              <ul className="divide-y divide-separator">
                {keys.items.map((key) => (
                  <li
                    key={key.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium break-words">
                        {key.name}
                      </p>
                      <RelativeDateTime
                        value={key.createdAt}
                        timeZone={session.user.timeZone}
                        label="Passkey added"
                        prefix="Added"
                        compact
                        className="text-muted"
                      />
                    </div>
                    <Button
                      variant="danger"
                      isDisabled={!!pending || keys.pending}
                      onPress={() =>
                        secure(async () => {
                          await api(`/auth/passkeys/${key.id}`, {}, "DELETE");
                          toast.success("Passkey removed.");
                        })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No passkeys added.</p>
            )}
          </ListState>
          <div>
            <Button
              variant="secondary"
              isDisabled={!!pending}
              onPress={() =>
                secure(async () => {
                  const options = await api<{
                    challengeId: string;
                    options: PublicKeyCredentialCreationOptionsJSON;
                  }>("/auth/passkeys/register/options", { name: "My passkey" });
                  const response = await startRegistration({
                    optionsJSON: options.options,
                  });
                  await api("/auth/passkeys/register/verify", {
                    challengeId: options.challengeId,
                    response,
                    name: "My passkey",
                  });
                  toast.success("Passkey added.");
                })
              }
            >
              Add passkey
            </Button>
          </div>
        </AccountWidget>
        <AccountWidget
          title="Authenticator"
          status={
            <Chip color={session.user.totpEnabled ? "success" : "default"}>
              {session.user.totpEnabled
                ? "Authenticator enabled"
                : "Not enabled"}
            </Chip>
          }
        >
          <p className="text-sm text-muted">
            An authenticator app adds a one-time code to your password. Keep
            recovery codes in a safe place.
          </p>
          {totp || totpMode !== "idle" ? (
            <form
              className="content-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void verifyAuthenticator();
              }}
              aria-busy={totpBusy}
            >
              {totp && (
                <>
                  <p className="text-sm text-muted">
                    Add this setup key to your authenticator app, then enter its
                    six-digit code.
                  </p>
                  <CodeBlock className="secret">
                    <CodeBlock.Header>
                      <span className="text-sm text-muted">Setup key</span>
                      <CodeBlock.CopyButton
                        code={totp.secret}
                        aria-label="Copy setup key"
                      />
                    </CodeBlock.Header>
                    <CodeBlock.Code
                      code={totp.secret}
                      className="break-all whitespace-pre-wrap"
                    />
                  </CodeBlock>
                  <a
                    href={totp.uri}
                    className="w-fit text-sm text-muted underline underline-offset-4"
                  >
                    Open authenticator app
                  </a>
                </>
              )}
              {!totp && (
                <TypographyParagraph size="sm" color="muted">
                  {totpMode === "disable"
                    ? "Future sign-ins will use your remaining sign-in methods."
                    : "Your previous recovery codes will stop working."}{" "}
                  Enter a fresh authenticator code.
                </TypographyParagraph>
              )}
              <TextField
                label={totp ? "Six-digit code" : "Authenticator code"}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                disabled={totpBusy}
              />
              <ErrorMessage>{totpError}</ErrorMessage>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant={totpMode === "disable" ? "danger" : "primary"}
                  isDisabled={totpBusy}
                >
                  {totpBusy
                    ? "Please wait…"
                    : totp
                      ? "Verify authenticator"
                      : totpMode === "disable"
                        ? "Remove authenticator"
                        : "New recovery codes"}
                </Button>
                <Button
                  variant="secondary"
                  isDisabled={totpBusy}
                  onPress={() => {
                    setTotp(null);
                    setTotpMode("idle");
                    setTotpError("");
                    setCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-3">
              {session.user.totpEnabled ? (
                <>
                  <Button
                    variant="secondary"
                    isDisabled={!!pending}
                    onPress={() =>
                      secure(async () => {
                        setTotpMode("recovery");
                        setCode("");
                        setTotpError("");
                      })
                    }
                  >
                    New recovery codes
                  </Button>
                  <Button
                    variant="danger"
                    isDisabled={!!pending}
                    onPress={() =>
                      secure(async () => {
                        setTotpMode("disable");
                        setCode("");
                        setTotpError("");
                      })
                    }
                  >
                    Remove authenticator
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  isDisabled={!!pending}
                  onPress={() =>
                    secure(async () => {
                      setTotp(await api("/auth/totp/setup", {}));
                      setCode("");
                      setTotpError("");
                    })
                  }
                >
                  Set up authenticator
                </Button>
              )}
            </div>
          )}
        </AccountWidget>
      </div>
      {pending && (
        <ReauthenticationDialog
          email={session.user.email}
          onClose={() => setPending(null)}
          onConfirmed={async () => {
            await pending();
            await refresh();
            setPending(null);
          }}
        />
      )}
      <RecoveryCodesDialog codes={codes} onClose={() => setCodes([])} />
    </section>
  );
}
function SessionSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const sessions = useAccountList<SessionRow>("/auth/sessions");
  const [revoking, setRevoking] = useState<SessionRow | null>(null);
  const [revoked, setRevoked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [sessionError, setSessionError] = useState("");
  async function revoke() {
    if (!revoking || busy) return;
    setBusy(true);
    setSessionError("");
    try {
      try {
        await api(`/auth/sessions/${revoking.id}`, {}, "DELETE");
      } catch (cause) {
        let remaining: { items: SessionRow[] };
        try {
          remaining = await api("/auth/sessions");
        } catch {
          throw cause;
        }
        if (remaining.items.some((item) => item.id === revoking.id))
          throw cause;
      }
      setRevoked((old) => new Set(old).add(revoking.id));
      setRevoking(null);
      toast.success("Session revoked.");
      onRefresh();
      await sessions.refresh();
    } catch (cause) {
      setSessionError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  function revokeButton(item: SessionRow) {
    return (
      <Button
        variant="danger"
        isDisabled={item.current || busy || sessions.pending}
        onPress={() => {
          setSessionError("");
          setRevoking(item);
        }}
      >
        <HugeiconsIcon icon={Logout01Icon} aria-hidden="true" />
        Revoke
      </Button>
    );
  }
  function status(item: SessionRow) {
    return (
      <Chip
        variant={item.current ? "default" : "success"}
        icon={<HugeiconsIcon icon={CheckmarkCircle02Icon} />}
        tooltip={
          item.current ? "This is the session currently in use." : undefined
        }
      >
        {item.current ? "Current" : "Active"}
      </Chip>
    );
  }
  const desktop = "hidden md:table-cell";
  const columns: ResourceTableColumn<SessionRow>[] = [
    {
      key: "session",
      header: "Session",
      isRowHeader: true,
      headerClassName: "max-md:after:hidden",
      className:
        "resource-identity-cell whitespace-normal! md:whitespace-nowrap! md:min-w-40 max-md:[.table__row:first-child_&]:rounded-se-2xl max-md:[.table__row:last-child_&]:rounded-ee-2xl",
      cell: (item) => (
        <TableCellStack>
          <span>
            {item.current ? "This browser" : sessionDevice(item.userAgent)}
          </span>
          <div className="grid gap-3 md:hidden">
            <div>
              <TypographyCode title={item.id}>
                {item.id.slice(0, 8)}
              </TypographyCode>
            </div>
            <RelativeDateTime
              value={item.lastSeenAt}
              timeZone={session.user.timeZone}
              label="Last active"
              prefix="Last active"
            />
            <RelativeDateTime
              value={item.expiresAt}
              timeZone={session.user.timeZone}
              label="Expires"
              prefix="Expires"
            />
            <div>{status(item)}</div>
            <div>{revokeButton(item)}</div>
          </div>
        </TableCellStack>
      ),
    },
    {
      key: "id",
      header: "Session ID",
      headerClassName: desktop,
      className: `${desktop} min-w-32`,
      cell: (item) => (
        <TypographyCode title={item.id}>{item.id.slice(0, 8)}</TypographyCode>
      ),
    },
    {
      key: "lastActive",
      header: "Last active",
      headerClassName: desktop,
      className: `${desktop} whitespace-nowrap`,
      cell: (item) => (
        <RelativeDateTime
          value={item.lastSeenAt}
          timeZone={session.user.timeZone}
          label="Last active"
        />
      ),
    },
    {
      key: "expires",
      header: "Expires",
      headerClassName: desktop,
      className: `${desktop} whitespace-nowrap`,
      cell: (item) => (
        <RelativeDateTime
          value={item.expiresAt}
          timeZone={session.user.timeZone}
          label="Expires"
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      headerClassName: desktop,
      className: desktop,
      cell: status,
    },
    {
      key: "actions",
      header: "Actions",
      headerClassName: `${desktop} text-end`,
      className: `${desktop} text-end`,
      cell: revokeButton,
    },
  ];
  return (
    <section
      className="min-w-0"
      role="region"
      aria-label="Sessions"
      aria-busy={sessions.pending}
    >
      <PageHeading
        title="Sessions"
        icon={<HugeiconsIcon icon={MonitorIcon} />}
      />
      <div className="content-grid min-w-0">
        <ListState
          loaded={sessions.items !== null}
          error={sessions.error}
          retry={() => void sessions.refresh()}
          noun="sessions"
        >
          <ResourceTable
            ariaLabel="Active browser sessions"
            columns={columns}
            emptyTitle="No active sessions"
            emptyDescription="Sign in to create a browser session."
            getRowKey={(item) => item.id}
            items={(sessions.items ?? []).filter(
              (item) => !revoked.has(item.id),
            )}
            tableClassName="w-full! max-md:table-fixed!"
          />
        </ListState>
      </div>
      <Dialog
        open={!!revoking}
        onClose={() => {
          setRevoking(null);
          setSessionError("");
        }}
        isDismissDisabled={busy}
        title="Revoke this session?"
        footer={
          <>
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => setRevoking(null)}
            >
              Keep session
            </Button>
            <Button
              variant="danger"
              isDisabled={busy}
              onPress={() => void revoke()}
            >
              {busy ? "Revoking…" : "Revoke session"}
            </Button>
          </>
        }
      >
        <TypographyParagraph size="sm">
          That browser will lose access immediately and must sign in again.
        </TypographyParagraph>
        <ErrorMessage>{sessionError}</ErrorMessage>
      </Dialog>
    </section>
  );
}

function PasswordChange({ onChanged }: { onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(form: HTMLFormElement) {
    if (busy) return;
    const values = new FormData(form);
    setError("");
    if (values.get("next") !== values.get("confirmation")) {
      toast.danger("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/password", {
        currentPassword: values.get("current"),
        password: values.get("next"),
      });
      toast.success("Password changed.");
      form.reset();
      await onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="content-grid"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void change(event.currentTarget);
      }}
    >
      <FieldGroup>
        <PasswordField
          label="Current password"
          name="current"
          autoComplete="current-password"
          required
          disabled={busy}
          maxLength={1024}
        />
        <PasswordField
          label="New password"
          name="next"
          autoComplete="new-password"
          required
          disabled={busy}
          minLength={15}
          maxLength={1024}
        />
        <PasswordField
          label="Confirm new password"
          name="confirmation"
          autoComplete="new-password"
          required
          disabled={busy}
          maxLength={1024}
        />
      </FieldGroup>
      <ErrorMessage>{error}</ErrorMessage>
      <div>
        <Button variant="secondary" type="submit" isDisabled={busy}>
          {busy ? "Changing password…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
function ReauthenticationDialog({
  email,
  onClose,
  onConfirmed,
}: {
  email: string;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<IdentityChallenge | null>(null);
  const [method, setMethod] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const ceremony = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current = false;
      ceremony.current?.abort();
    },
    [],
  );
  function dismiss() {
    if (busy && !passkeyBusy) return;
    active.current = false;
    ceremony.current?.abort();
    WebAuthnAbortService.cancelCeremony();
    onClose();
  }
  async function complete() {
    if (!active.current) return;
    setVerified(true);
    await onConfirmed();
  }
  async function passkey(value: IdentityChallenge) {
    setBusy(true);
    setPasskeyBusy(true);
    setError("");
    const controller = new AbortController();
    ceremony.current = controller;
    try {
      await verifyPasskey(value.challengeId, controller.signal);
      if (!active.current) return;
      setPasskeyBusy(false);
      await complete();
    } catch (cause) {
      if (active.current) setError(passkeyError(cause));
    } finally {
      if (active.current) {
        setBusy(false);
        setPasskeyBusy(false);
      }
    }
  }
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (verified) {
        await onConfirmed();
        return;
      }
      if (challenge) {
        if (!challenge.methods.includes(method)) return;
        await api("/auth/second-factor", {
          challengeId: challenge.challengeId,
          method,
          code,
        });
        await complete();
      } else {
        const result = await api<IdentityChallenge | { ok: true }>(
          "/auth/reauth",
          { password },
        );
        if ("requiresSecondFactor" in result) {
          setChallenge(result);
          setMethod(
            result.methods.find((m) => m === "totp" || m === "recovery") ?? "",
          );
          if (result.preferredMethod === "passkey") await passkey(result);
        } else await complete();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const canSubmit =
    verified ||
    !challenge ||
    challenge.methods.some((m) => m === "totp" || m === "recovery");
  return (
    <Dialog
      open
      size="sm"
      isDismissDisabled={busy && !passkeyBusy}
      onClose={dismiss}
      title="Confirm it’s you"
    >
      <form
        className="content-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
        aria-label="Confirm identity"
        aria-busy={busy}
      >
        <TypographyParagraph size="sm" color="muted">
          {verified
            ? "Continue with the security change."
            : "Confirm your identity before changing account security."}
        </TypographyParagraph>
        <input
          type="text"
          name="username"
          value={email}
          readOnly
          autoComplete="username"
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
        {!verified &&
          (challenge ? (
            <ChallengeFields
              challenge={challenge}
              method={method}
              onMethod={setMethod}
              code={code}
              onCode={setCode}
              busy={busy}
              passkeyBusy={passkeyBusy}
              onPasskey={() => void passkey(challenge)}
              methodLabel="Verification method"
              codeLabel="Authenticator code"
            />
          ) : (
            <PasswordField
              label="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              maxLength={1024}
              autoFocus
              disabled={busy}
            />
          ))}
        <ErrorMessage>{error}</ErrorMessage>
        {busy && (
          <p role="status" className="text-sm text-muted">
            {passkeyBusy
              ? "Waiting for your passkey…"
              : verified
                ? "Updating account security…"
                : "Verifying your identity…"}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {canSubmit && (
            <Button type="submit" isDisabled={busy}>
              {verified ? "Retry security change" : "Confirm"}
            </Button>
          )}
          <Button
            variant="secondary"
            isDisabled={busy && !passkeyBusy}
            onPress={dismiss}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function RecoveryCodesDialog({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success("Recovery codes copied.");
    } catch {
      toast.danger(
        "Copy the codes manually. Your browser did not allow clipboard access.",
      );
    }
  }
  const id = useId();
  return (
    <Dialog
      open={codes.length > 0}
      onClose={onClose}
      title="Save your recovery codes"
      size="sm"
      footer={<Button onPress={onClose}>I saved these codes</Button>}
    >
      <div className="content-grid">
        <p className="text-sm text-muted">
          Each code can be used once when your authenticator is unavailable.
          These codes are only shown now.
        </p>
        <pre
          id={id}
          className="recovery-codes rounded-lg bg-default p-3 font-mono text-sm"
        >
          {codes.join("\n")}
        </pre>
        <div>
          <Button variant="secondary" onPress={() => void copyCodes()}>
            Copy codes
          </Button>
        </div>
      </div>
    </Dialog>
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
