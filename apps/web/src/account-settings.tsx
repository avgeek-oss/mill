import {
  ReauthenticationDialog,
  useIdentityConfirmation,
} from "./identity-confirmation.js";
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
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import {
  Button,
  Checkbox,
  ErrorMessage,
  QueryLoading,
  Widget,
  toast,
} from "@mill/web-design-system";
import {
  ProfileSettings as SharedProfileSettings,
  PreferencesSettings,
  PasswordChangeSettings,
  SessionsSettings,
  ProfileImageSettings,
  PasskeySettings,
  EmailChangeSettings,
} from "@avgeek-oss/design-system";
import {
  dateTimePreferenceOptions,
  dateTimePreview,
} from "./date-time-preferences.js";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Mail01Icon,
  MonitorIcon,
  Settings01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { Save } from "./icons.js";
import { PageHeading } from "./page-heading.js";
import { RelativeDateTime } from "./relative-date-time.js";
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
    passkeys: "Passkeys",
    "two-factor": "Passkeys",
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
    case "passkeys":
      return <PasskeysSettings session={session} onRefresh={onRefresh} />;
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
        <ProfileImageSettings
          email={session.user.email}
          name={session.user.name}
        />
        <SharedProfileSettings
          value={session.user.name}
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
  const identity = useIdentityConfirmation();
  return (
    <section className="min-w-0">
      {identity.confirmation}
      <PageHeading
        title="Email & Password"
        icon={<HugeiconsIcon icon={Mail01Icon} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <EmailChangeSettings
          email={session.user.email}
          isVerified={false}
          mode="read-only"
        />
        <PasswordChangeSettings
          minLength={15}
          maxLength={1024}
          onChangePassword={async ({ currentPassword, newPassword }) => {
            await api(
              "/auth/password",
              { currentPassword, password: newPassword },
              "POST",
              { onReauthenticationRequired: identity.confirmIdentity },
            );
            toast.success("Password changed.");
            onRefresh();
          }}
        />
      </div>
    </section>
  );
}
function PasskeysSettings({
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
  const securityPending = useRef(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  async function refresh() {
    onRefresh();
    await keys.refresh();
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
  return (
    <section className="min-w-0">
      {keys.items === null && <PageHeading title="Passkeys" />}
      <div className="content-grid min-w-0">
        <div className="min-w-0">
          <ListState
            loaded={keys.items !== null}
            error={keys.error}
            retry={() => void keys.refresh()}
            noun="passkeys"
          >
            <PasskeySettings
              items={keys.items ?? []}
              maxNameLength={100}
              recoveryCodes={recoveryCodes}
              recoveryCodesFilename="mill-recovery-codes.txt"
              onDismissRecoveryCodes={() => setRecoveryCodes([])}
              onReplaceRecoveryCodes={() =>
                securePasskey(async () => {
                  const result = await api<{ recoveryCodes: string[] }>(
                    "/auth/passkeys/recovery-codes",
                    {},
                  );
                  setRecoveryCodes(result.recoveryCodes);
                })
              }
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
                  const result = await api<{ recoveryCodes?: string[] }>(
                    "/auth/passkeys/register/verify",
                    {
                      challengeId: options.challengeId,
                      response,
                      name,
                    },
                  );
                  if (result.recoveryCodes)
                    setRecoveryCodes(result.recoveryCodes);
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
      </div>
      {pending && (
        <ReauthenticationDialog
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
