// Adapted from Towbar's public Apache-2.0 security-settings, passkey-settings,
// reauthentication-dialog, and settings-pages compositions.
import {
  useCallback,
  useEffect,
  useId,
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
  Dialog,
  ErrorMessage,
  FieldDescription,
  FieldGroup,
  TextField,
  Widget,
  toast,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Key01Icon,
  LockKeyholeIcon,
  MonitorIcon,
  Notification02Icon,
  SecurityCheckIcon,
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
  icon: ReactNode;
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
  return loaded ? children : null;
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
  useEffect(() => {
    document.title = `${section === "profile" ? "Profile" : "Account security"} · Mill`;
  }, [section]);
  return section === "profile" ? (
    <ProfileSettings session={session} onRefresh={onRefresh} />
  ) : (
    <SecuritySettings session={session} onRefresh={onRefresh} />
  );
}
function ProfileSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const [name, setName] = useState(session.user.name);
  const [zone, setZone] = useState(session.user.timeZone);
  const [assignments, setAssignments] = useState(
    session.user.notificationPreferences.assignments !== false,
  );
  const [mentions, setMentions] = useState(
    session.user.notificationPreferences.mentions !== false,
  );
  const [busy, setBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [notificationError, setNotificationError] = useState("");
  async function save(part: "profile" | "notifications") {
    if (busy) return;
    setBusy(true);
    const setError =
      part === "profile" ? setProfileError : setNotificationError;
    setError("");
    try {
      await api(
        "/auth/profile",
        part === "profile"
          ? { name, timeZone: zone }
          : { notificationPreferences: { assignments, mentions } },
        "PATCH",
      );
      toast.success(
        part === "profile" ? "Preferences saved." : "Notifications saved.",
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
        title="Profile"
        icon={<HugeiconsIcon icon={UserAccountIcon} />}
        description="Manage your name, time zone, and notifications."
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget
          title="Profile details"
          icon={<HugeiconsIcon icon={UserAccountIcon} />}
        >
          <form
            className="content-grid"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void save("profile");
            }}
          >
            <Avatar
              email={session.user.email}
              name={session.user.name}
              size="md"
            />
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
              <Choice
                label="Time zone"
                value={zone}
                onChange={setZone}
                disabled={busy}
                search
                items={[
                  ...new Set([
                    "UTC",
                    session.user.timeZone,
                    ...Intl.supportedValuesOf("timeZone"),
                  ]),
                ].map((id) => ({ id, name: id }))}
              />
            </FieldGroup>
            <ErrorMessage>{profileError}</ErrorMessage>
            <div>
              <Button type="submit" isDisabled={busy}>
                <Save />
                {busy ? "Saving…" : "Save preferences"}
              </Button>
            </div>
          </form>
        </AccountWidget>
        <AccountWidget
          title="Notifications"
          icon={<HugeiconsIcon icon={Notification02Icon} />}
        >
          <form
            className="content-grid"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void save("notifications");
            }}
          >
            <p className="text-xs text-muted">
              Choose which in-app notifications you receive.
            </p>
            <div className="grid gap-3">
              <Checkbox
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
function SecuritySettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const keys = useAccountList<Passkey>("/auth/passkeys");
  const sessions = useAccountList<SessionRow>("/auth/sessions");
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionError, setSessionError] = useState("");
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
    await Promise.all([keys.refresh(), sessions.refresh()]);
  }
  function secure(action: () => Promise<void>) {
    setPending(() => action);
  }
  async function runSession(action: () => Promise<void>) {
    setBusy(true);
    setSessionError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setSessionError(errorText(cause));
    } finally {
      setBusy(false);
    }
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
        title="Account security"
        icon={<HugeiconsIcon icon={SecurityCheckIcon} />}
        description="Manage your sign-in methods and active devices."
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <AccountWidget
          title="Passkeys"
          icon={<HugeiconsIcon icon={Key01Icon} />}
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
          <p className="text-xs text-muted">
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
                      isDisabled={busy || !!pending || keys.pending}
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
              <p className="text-xs text-muted">No passkeys added.</p>
            )}
          </ListState>
          <div>
            <Button
              variant="secondary"
              isDisabled={busy || !!pending}
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
          icon={<HugeiconsIcon icon={SecurityCheckIcon} />}
          status={
            <Chip color={session.user.totpEnabled ? "success" : "default"}>
              {session.user.totpEnabled
                ? "Authenticator enabled"
                : "Not enabled"}
            </Chip>
          }
        >
          <p className="text-xs text-muted">
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
                  <FieldDescription>
                    Add this setup key to your authenticator app, then enter its
                    six-digit code.
                  </FieldDescription>
                  <code className="secret block break-all rounded-lg bg-default p-3 font-mono text-sm">
                    {totp.secret}
                  </code>
                  <a
                    href={totp.uri}
                    className="w-fit text-xs text-muted underline underline-offset-4"
                  >
                    Open authenticator app
                  </a>
                </>
              )}
              {!totp && (
                <FieldDescription>
                  {totpMode === "disable"
                    ? "Future sign-ins will use your remaining sign-in methods."
                    : "Your previous recovery codes will stop working."}{" "}
                  Enter a fresh authenticator code.
                </FieldDescription>
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
                    isDisabled={busy || !!pending}
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
                    isDisabled={busy || !!pending}
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
                  isDisabled={busy || !!pending}
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
        <AccountWidget
          title="Password"
          icon={<HugeiconsIcon icon={LockKeyholeIcon} />}
        >
          <p className="text-xs text-muted">
            Use a unique password with at least 15 characters.
          </p>
          <PasswordChange onChanged={refresh} />
        </AccountWidget>
        <AccountWidget
          title="Sessions"
          icon={<HugeiconsIcon icon={MonitorIcon} />}
          busy={sessions.pending}
          status={
            sessions.items && !sessions.error ? (
              <Chip>{sessions.items.length} active</Chip>
            ) : undefined
          }
        >
          <p className="text-xs text-muted">
            Review devices signed in to your account. Signing out a device
            revokes its session.
          </p>
          <ErrorMessage>{sessionError}</ErrorMessage>
          <ListState
            loaded={sessions.items !== null}
            error={sessions.error}
            retry={() => void sessions.refresh()}
            noun="sessions"
          >
            {sessions.items?.length ? (
              <ul className="divide-y divide-separator">
                {sessions.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium break-words">
                        {item.current
                          ? "This device"
                          : sessionDevice(item.userAgent)}
                      </p>
                      <RelativeDateTime
                        value={item.lastSeenAt}
                        timeZone={session.user.timeZone}
                        label="Last active"
                        prefix="Last active"
                        compact
                        className="text-muted"
                      />
                    </div>
                    {item.current ? (
                      <Chip>Current</Chip>
                    ) : (
                      <Button
                        variant="danger"
                        isDisabled={busy || sessions.pending}
                        onPress={() =>
                          void runSession(async () => {
                            await api(
                              `/auth/sessions/${item.id}`,
                              {},
                              "DELETE",
                            );
                            toast.success("Session revoked.");
                          })
                        }
                      >
                        Sign out
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No active sessions.</p>
            )}
          </ListState>
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
function PasswordChange({ onChanged }: { onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(form: HTMLFormElement) {
    if (busy) return;
    const values = new FormData(form);
    setError("");
    if (values.get("next") !== values.get("confirmation")) {
      setError("The passwords do not match.");
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
        <FieldDescription>
          {verified
            ? "Your identity is confirmed. Continue with the security change."
            : "Confirm your identity before changing account security."}
        </FieldDescription>
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
          <p role="status" className="text-xs text-muted">
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
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
  }, [codes]);
  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success("Recovery codes copied.");
    } catch {
      setError(
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
        <p className="text-xs text-muted">
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
          <Button
            variant="secondary"
            onPress={() => {
              setError("");
              void copyCodes();
            }}
          >
            Copy codes
          </Button>
        </div>
        <ErrorMessage>{error}</ErrorMessage>
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
