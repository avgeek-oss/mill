import { QueryFeedback } from "./query-feedback.js";
// Adapted from Towbar's public Apache-2.0 security-settings, passkey-settings,
// reauthentication-dialog, and settings-pages compositions.
import {
  useCallback,
  useEffect,
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
  CodeBlock,
  Dialog,
  ErrorMessage,
  FieldDescription,
  NewTabIndicator,
  QueryLoading,
  TextField,
  TypographyParagraph,
  Widget,
  toast,
} from "@mill/web-design-system";
import {
  ProfileSettings as SharedProfileSettings,
  PreferencesSettings,
  PasswordChangeSettings,
  SessionsSettings,
  RecoveryCodes,
  PasskeySettings,
  EmailChangeSettings,
  ConfirmIdentityDialog,
} from "@avgeek-oss/design-system";
import {
  dateTimePreferenceOptions,
  dateTimePreview,
} from "./date-time-preferences.js";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Mail01Icon,
  MonitorIcon,
  SecurityCheckIcon,
  Settings01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { Save } from "./icons.js";
import { PageHeading } from "./page-heading.js";
import { RelativeDateTime } from "./relative-date-time.js";
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
  if (!loaded)
    return error ? (
      <QueryFeedback message={error} onRetry={retry} />
    ) : (
      <QueryLoading className="sr-only">{`Loading ${noun}`}</QueryLoading>
    );
  return (
    <>
      {error ? <QueryFeedback message={error} onRetry={retry} /> : null}
      {children}
    </>
  );
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
  return (
    <section className="min-w-0">
      <PageHeading
        title="Profile"
        icon={<HugeiconsIcon icon={UserAccountIcon} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget title="Profile image">
          <p className="text-sm text-muted">
            Click the image to update it on Gravatar.
          </p>
          <a
            aria-label="Edit Gravatar image (opens in a new tab)"
            className="inline-flex w-fit items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
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
        </AccountWidget>
        <SharedProfileSettings
          value={session.user.name}
          label="Your Name"
          maxLength={100}
          onSave={async (name) => {
            await api("/auth/profile", { name }, "PATCH");
            onRefresh();
          }}
        />
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
  const preferenceOptions = useMemo(
    () => ({
      ...dateTimePreferenceOptions,
      timeZones: [
        ...new Set([
          "UTC",
          session.user.timeZone,
          ...dateTimePreferenceOptions.timeZones,
        ]),
      ],
    }),
    [session.user.timeZone],
  );
  const [assignments, setAssignments] = useState(
    session.user.notificationPreferences.assignments !== false,
  );
  const [mentions, setMentions] = useState(
    session.user.notificationPreferences.mentions !== false,
  );
  const [busy, setBusy] = useState(false);
  const notificationPending = useRef(false);
  const [notificationError, setNotificationError] = useState("");
  async function saveNotifications() {
    if (notificationPending.current) return;
    notificationPending.current = true;
    setBusy(true);
    setNotificationError("");
    try {
      await api(
        "/auth/profile",
        { notificationPreferences: { assignments, mentions } },
        "PATCH",
      );
      toast.success("Notifications saved.");
      onRefresh();
    } catch (cause) {
      setNotificationError(errorText(cause));
    } finally {
      notificationPending.current = false;
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
        <PreferencesSettings
          value={{
            dateFormat: session.user.dateFormat,
            timeFormat: session.user.timeFormat,
            timeZone: session.user.timeZone,
          }}
          options={preferenceOptions}
          formatPreview={dateTimePreview}
          onSave={async (preferences) => {
            await api("/auth/profile", preferences, "PATCH");
            onRefresh();
          }}
        />
        <AccountWidget title="Notifications">
          <form
            className="content-grid"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void saveNotifications();
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
                <Checkbox.Content className="min-h-11">
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
                <Checkbox.Content className="min-h-11">
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
        <EmailChangeSettings
          email={session.user.email}
          isVerified={false}
          mode="read-only"
        >
          <FieldDescription>
            Your email identifies this account.
          </FieldDescription>
        </EmailChangeSettings>
        <PasswordChangeSettings
          minLength={15}
          maxLength={1024}
          onChangePassword={async ({ currentPassword, newPassword }) => {
            await api("/auth/password", {
              currentPassword,
              password: newPassword,
            });
            toast.success("Password changed.");
            onRefresh();
          }}
        />
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
  const [pending, setPending] = useState<{
    action: () => Promise<void>;
    onComplete?: () => void;
    onCancel?: () => void;
  } | null>(null);
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(
    null,
  );
  const [totpMode, setTotpMode] = useState<"idle" | "disable" | "recovery">(
    "idle",
  );
  const [code, setCode] = useState("");
  const [totpError, setTotpError] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const totpPending = useRef(false);
  const securityPending = useRef(false);
  const [codes, setCodes] = useState<string[]>([]);
  async function refresh() {
    onRefresh();
    await keys.refresh();
  }
  function secure(action: () => Promise<void>) {
    if (securityPending.current) return;
    securityPending.current = true;
    setPending({ action });
  }
  function securePasskey(action: () => Promise<void>) {
    if (securityPending.current)
      return Promise.reject(
        new Error("Complete the current security change first."),
      );
    securityPending.current = true;
    return new Promise<void>((resolve, reject) => {
      setPending({
        action,
        onComplete: resolve,
        onCancel: () => reject(new Error("Identity confirmation canceled.")),
      });
    });
  }
  async function verifyAuthenticator() {
    if (totpPending.current) return;
    totpPending.current = true;
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
      totpPending.current = false;
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
        <div className="min-w-0">
          <ListState
            loaded={keys.items !== null}
            error={keys.error}
            retry={() => void keys.refresh()}
            noun="passkeys"
          >
            <PasskeySettings
              items={keys.items ?? []}
              formatDate={(value) => (
                <RelativeDateTime
                  value={value}
                  timeZone={session.user.timeZone}
                />
              )}
              onAdd={(name) =>
                securePasskey(async () => {
                  const options = await api<{
                    challengeId: string;
                    options: PublicKeyCredentialCreationOptionsJSON;
                  }>("/auth/passkeys/register/options", { name });
                  const response = await startRegistration({
                    optionsJSON: options.options,
                  });
                  await api("/auth/passkeys/register/verify", {
                    challengeId: options.challengeId,
                    response,
                    name,
                  });
                })
              }
              onRemove={(id) =>
                securePasskey(async () => {
                  await api(`/auth/passkeys/${id}`, {}, "DELETE");
                })
              }
            />
          </ListState>
        </div>
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
                  <CodeBlock>
                    <CodeBlock.Header>
                      <span className="text-sm text-muted">Setup key</span>
                      <CodeBlock.CopyButton
                        aria-label="Copy setup key"
                        code={totp.secret}
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
          onClose={() => {
            pending.onCancel?.();
            securityPending.current = false;
            setPending(null);
          }}
          onConfirmed={async () => {
            await pending.action();
            await refresh();
            pending.onComplete?.();
            securityPending.current = false;
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
  const [revoked, setRevoked] = useState<Set<string>>(() => new Set());
  async function revoke(id: string) {
    try {
      await api(`/auth/sessions/${id}`, {}, "DELETE");
    } catch (cause) {
      let remaining: { items: SessionRow[] };
      try {
        remaining = await api("/auth/sessions");
      } catch {
        throw cause;
      }
      if (remaining.items.some((item) => item.id === id)) throw cause;
    }
    setRevoked((old) => new Set(old).add(id));
    onRefresh();
    await sessions.refresh();
  }
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
      <ListState
        loaded={sessions.items !== null}
        error={sessions.error}
        retry={() => void sessions.refresh()}
        noun="sessions"
      >
        <SessionsSettings
          items={(sessions.items ?? [])
            .filter((item) => !revoked.has(item.id))
            .map((item) => ({
              id: item.id,
              name: item.current
                ? "This browser"
                : sessionDevice(item.userAgent),
              lastActive: item.lastSeenAt,
              expiresAt: item.expiresAt,
              current: item.current,
            }))}
          formatDate={(value) => (
            <RelativeDateTime value={value} timeZone={session.user.timeZone} />
          )}
          onRevoke={revoke}
        />
      </ListState>
    </section>
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
  const requestPending = useRef(false);
  const passkeyPending = useRef(false);
  const ceremony = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      ceremony.current?.abort();
    };
  }, []);
  function dismiss() {
    if (requestPending.current && !passkeyPending.current) return;
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
  async function passkey(value: IdentityChallenge, fromConfirmation = false) {
    if (requestPending.current && !fromConfirmation) return;
    requestPending.current = true;
    passkeyPending.current = true;
    setBusy(true);
    setPasskeyBusy(true);
    setError("");
    const controller = new AbortController();
    ceremony.current = controller;
    try {
      await verifyPasskey(value.challengeId, controller.signal);
      if (!active.current) return;
      passkeyPending.current = false;
      setPasskeyBusy(false);
      await complete();
    } catch (cause) {
      if (active.current) setError(passkeyError(cause));
    } finally {
      requestPending.current = false;
      passkeyPending.current = false;
      if (active.current) {
        setBusy(false);
        setPasskeyBusy(false);
      }
    }
  }
  async function confirm() {
    if (requestPending.current) return;
    requestPending.current = true;
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
          if (result.preferredMethod === "passkey") await passkey(result, true);
        } else await complete();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      requestPending.current = false;
      setBusy(false);
    }
  }
  const canSubmit =
    verified ||
    !challenge ||
    challenge.methods.some((m) => m === "totp" || m === "recovery");
  return (
    <ConfirmIdentityDialog
      isOpen
      method="custom"
      isPending={busy}
      isDismissDisabled={busy && !passkeyBusy}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
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
        </div>
      </form>
    </ConfirmIdentityDialog>
  );
}
function RecoveryCodesDialog({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  return (
    <Dialog
      open={codes.length > 0}
      onClose={onClose}
      title="Save your recovery codes"
      size="sm"
    >
      <RecoveryCodes
        codes={codes}
        filename="mill-recovery-codes.txt"
        onContinue={onClose}
      />
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
