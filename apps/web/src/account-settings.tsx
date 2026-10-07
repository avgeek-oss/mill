import { useSettingsMutation } from "./use-settings-mutation.js";
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
  WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import {
  Button,
  Checkbox,
  ErrorMessage,
  QueryLoading,
  useAppSuspended,
  Widget,
  toast,
} from "@mill/web-design-system";
import {
  useOverlaySuspension,
  ProfileSettings as SharedProfileSettings,
  PreferencesSettings,
  PasswordChangeSettings,
  SessionsSettings,
  ProfileImageSettings,
  PasskeySettings,
  EmailChangeSettings,
  type PendingEmailChange,
} from "@avgeek-oss/design-system";
import {
  dateTimePreferenceOptions,
  dateTimePreview,
} from "./date-time-preferences.js";
import { Save } from "./icons.js";
import { SettingsHeading } from "./settings-heading.js";
import { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import { usePageBreadcrumbs } from "./app-breadcrumbs.js";
import { RelativeDateTime, useCurrentTime } from "./relative-date-time.js";
import {
  api,
  ApiError,
  errorText,
  isResponseObject,
  type Session,
} from "./api.js";

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
  const appSuspended = useAppSuspended();
  const [state, setState] = useState<{
    items: T[] | null;
    pending: boolean;
    error: string;
  }>({ items: null, pending: true, error: "" });
  const generation = useRef(0);
  const active = useRef(!appSuspended);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!active.current) return;
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState((old) => ({ ...old, pending: true, error: "" }));
    try {
      const result = await api<{ items: T[] }>(path, undefined, "GET", {
        signal: request.signal,
      });
      if (
        active.current &&
        !request.signal.aborted &&
        current === generation.current
      )
        setState({ items: result.items, pending: false, error: "" });
    } catch (cause) {
      if (
        active.current &&
        !request.signal.aborted &&
        current === generation.current
      )
        setState((old) => ({
          ...old,
          pending: false,
          error: errorText(cause),
        }));
    } finally {
      if (controller.current === request) controller.current = null;
    }
  }, [path]);
  useEffect(() => {
    active.current = !appSuspended;
    if (appSuspended)
      setState((old) => ({ ...old, pending: false, error: "" }));
    else void refresh();
    return () => {
      active.current = false;
      generation.current++;
      controller.current?.abort();
      controller.current = null;
    };
  }, [appSuspended, refresh]);
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
  emailDeliveryConfigured,
  onRefresh,
}: {
  section: string;
  session: Session;
  emailDeliveryConfigured: boolean;
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
      return (
        <EmailPasswordSettings
          key={`${session.user.id}:${session.user.email}`}
          session={session}
          emailDeliveryConfigured={emailDeliveryConfigured}
          onRefresh={onRefresh}
        />
      );
  }
}
function ProfileSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const suspension = useOverlaySuspension();
  const mutate = useSettingsMutation(
    `${session.user.id}:${session.workspace.id}`,
  );
  return (
    <section className="min-w-0">
      <SettingsHeading section="profile" />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <ProfileImageSettings
          email={session.user.email}
          name={session.user.name}
        />
        <SharedProfileSettings
          value={session.user.name}
          maxLength={120}
          onSave={async (name) => {
            const isCurrent = suspension.capture();
            await mutate((signal) =>
              api("/auth/profile", { name }, "PATCH", { signal }),
            );
            if (isCurrent()) onRefresh();
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
  const suspension = useOverlaySuspension();
  const mutate = useSettingsMutation(
    `${session.user.id}:${session.workspace.id}`,
  );
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
    if (notificationPending.current || suspension.isSuspended) return;
    const isCurrent = suspension.capture();
    notificationPending.current = true;
    setBusy(true);
    setNotificationError("");
    try {
      await mutate((signal) =>
        api(
          "/auth/profile",
          { notificationPreferences: { assignments, mentions } },
          "PATCH",
          { signal },
        ),
      );
      if (isCurrent()) {
        toast.success("Notifications saved.");
        onRefresh();
      }
    } catch (cause) {
      if (isCurrent()) setNotificationError(errorText(cause));
    } finally {
      notificationPending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0">
      <SettingsHeading section="preferences" />
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
            const isCurrent = suspension.capture();
            await mutate((signal) =>
              api(
                "/auth/profile",
                {
                  ...(preferences.dateFormat !== session.user.dateFormat && {
                    dateFormat: preferences.dateFormat,
                  }),
                  ...(preferences.timeFormat !== session.user.timeFormat && {
                    timeFormat: preferences.timeFormat,
                  }),
                  ...(preferences.timeZone !== session.user.timeZone && {
                    timeZone: preferences.timeZone,
                  }),
                },
                "PATCH",
                { signal },
              ),
            );
            if (isCurrent()) onRefresh();
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
type EmailChangeResponse = { pending: PendingEmailChange | null };
function isEmailChangeResponse(value: unknown): value is EmailChangeResponse {
  if (!isResponseObject(value)) return false;
  const pending = value.pending;
  return (
    pending === null ||
    (isResponseObject(pending) &&
      typeof pending.email === "string" &&
      pending.email.length > 0 &&
      typeof pending.expiresAt === "string" &&
      Number.isFinite(Date.parse(pending.expiresAt)))
  );
}
function uncertainResponse(cause: unknown) {
  return (
    cause instanceof ApiError &&
    (cause.status === 0 || (cause.status >= 200 && cause.status < 300))
  );
}
function EmailPasswordSettings({
  session,
  emailDeliveryConfigured,
  onRefresh,
}: {
  session: Session;
  emailDeliveryConfigured: boolean;
  onRefresh: () => void;
}) {
  const suspension = useOverlaySuspension();
  const identity = useIdentityConfirmation();
  const appSuspended = useAppSuspended();
  const captureSuspension = useRef(suspension.capture);
  useEffect(() => {
    captureSuspension.current = suspension.capture;
  }, [suspension.capture]);
  const emailIdentityHeaders = useMemo(
    () => ({ "X-Mill-User-Id": session.user.id }),
    [session.user.id],
  );
  const currentTime = useCurrentTime();
  const [emailChange, setEmailChange] = useState<{
    value: EmailChangeResponse | null;
    error: string;
  }>({ value: null, error: "" });
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [pending, setPending] = useState<{
    action: () => Promise<void>;
    resolve: () => void;
    reject: (cause: Error) => void;
  } | null>(null);
  const pendingRef = useRef(pending);
  const mutationPending = useRef(false);
  const generation = useRef(0);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = !appSuspended;
    if (appSuspended) {
      controller.current?.abort();
      pendingRef.current?.reject(new Error("Identity confirmation canceled."));
      pendingRef.current = null;
      controller.current = null;
      mutationPending.current = false;
      setPending(null);
    }
    return () => {
      active.current = false;
      generation.current++;
      controller.current?.abort();
      pendingRef.current?.reject(new Error("Identity confirmation canceled."));
      pendingRef.current = null;
    };
  }, [appSuspended]);
  const loadEmailChange = useCallback(async () => {
    const isCurrent = captureSuspension.current();
    const request = ++generation.current;
    setEmailChange((old) => ({ ...old, error: "" }));
    try {
      const value = await api<EmailChangeResponse>(
        "/auth/email-change",
        undefined,
        "GET",
        {
          headers: emailIdentityHeaders,
          validateResponse: isEmailChangeResponse,
        },
      );
      if (isCurrent() && active.current && request === generation.current)
        setEmailChange({ value, error: "" });
    } catch (cause) {
      if (isCurrent() && active.current && request === generation.current)
        setEmailChange((old) => ({ ...old, error: errorText(cause) }));
    }
  }, [emailIdentityHeaders]);
  useEffect(() => {
    if (emailDeliveryConfigured && !appSuspended) void loadEmailChange();
    return () => {
      generation.current++;
    };
  }, [emailDeliveryConfigured, appSuspended, loadEmailChange]);
  function updateEmailChange(value: EmailChangeResponse) {
    generation.current++;
    if (active.current) setEmailChange({ value, error: "" });
  }
  async function emailMutation(action: (signal: AbortSignal) => Promise<void>) {
    if (!active.current)
      throw new Error("Sign in again to change your email address.");
    if (mutationPending.current)
      throw new Error("Complete the current email change first.");
    mutationPending.current = true;
    const request = new AbortController();
    controller.current = request;
    try {
      await action(request.signal);
    } catch (cause) {
      if (active.current && !request.signal.aborted) throw cause;
    } finally {
      if (controller.current === request) {
        mutationPending.current = false;
        controller.current = null;
      }
    }
  }
  function securePasskey(action: (signal: AbortSignal) => Promise<void>) {
    if (!active.current)
      return Promise.reject(
        new Error("Sign in again to change your email address."),
      );
    if (mutationPending.current)
      return Promise.reject(
        new Error("Complete the current email change first."),
      );
    mutationPending.current = true;
    const request = new AbortController();
    controller.current = request;
    return new Promise<void>((resolve, reject) => {
      const confirmation = {
        action: async () => {
          if (!active.current || request.signal.aborted) return;
          try {
            await action(request.signal);
          } catch (cause) {
            if (active.current && !request.signal.aborted) throw cause;
          }
        },
        resolve,
        reject,
      };
      pendingRef.current = confirmation;
      setPending(confirmation);
    });
  }
  function closeConfirmation() {
    controller.current?.abort();
    pendingRef.current?.reject(new Error("Identity confirmation canceled."));
    pendingRef.current = null;
    controller.current = null;
    mutationPending.current = false;
    setPending(null);
  }
  async function requestEmailChange(email: string, signal: AbortSignal) {
    const isCurrent = suspension.capture();
    const normalized = email.trim().toLowerCase();
    let result: EmailChangeResponse;
    try {
      result = await api<EmailChangeResponse>(
        "/auth/email-change",
        { email },
        "POST",
        {
          signal,
          headers: emailIdentityHeaders,
          validateResponse: (value) =>
            isEmailChangeResponse(value) && value.pending?.email === normalized,
        },
      );
    } catch (cause) {
      if (!uncertainResponse(cause) || signal.aborted) throw cause;
      try {
        result = await api<EmailChangeResponse>(
          "/auth/email-change",
          undefined,
          "GET",
          {
            signal,
            headers: emailIdentityHeaders,
            validateResponse: isEmailChangeResponse,
          },
        );
      } catch {
        throw cause;
      }
      if (
        result.pending?.email !== normalized ||
        Date.parse(result.pending.expiresAt) <= Date.now()
      )
        throw cause;
    }
    if (!isCurrent() || signal.aborted) return;
    updateEmailChange(result);
    if (active.current)
      toast.success("Confirmation email queued. Check your new address.");
  }
  return (
    <section className="min-w-0">
      {identity.confirmation}
      {!appSuspended && pending && (
        <ReauthenticationDialog
          onClose={closeConfirmation}
          onConfirmed={async () => {
            if (!active.current || pendingRef.current !== pending) return;
            await pending.action();
            if (!active.current || pendingRef.current !== pending) return;
            pending.resolve();
            pendingRef.current = null;
            controller.current = null;
            mutationPending.current = false;
            setPending(null);
          }}
        />
      )}
      <SettingsHeading section="email-password" />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        {emailDeliveryConfigured ? (
          <ListState
            loaded={emailChange.value !== null}
            error={emailChange.error}
            retry={() => void loadEmailChange()}
            noun="email settings"
          >
            <EmailChangeSettings
              email={session.user.email}
              isVerified={session.user.emailVerified}
              pendingChange={
                emailChange.value?.pending &&
                Date.parse(emailChange.value.pending.expiresAt) > currentTime
                  ? emailChange.value.pending
                  : null
              }
              resendAvailableAt={resendAvailableAt}
              formatDate={(value) =>
                new Intl.DateTimeFormat(undefined, {
                  timeZone: session.user.timeZone,
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(value))
              }
              onRequestChange={(email) =>
                securePasskey((signal) => requestEmailChange(email, signal))
              }
              onCancelChange={() =>
                emailMutation(async (signal) => {
                  const isCurrent = suspension.capture();
                  try {
                    await api("/auth/email-change", {}, "DELETE", {
                      signal,
                      headers: emailIdentityHeaders,
                      validateResponse: (value) =>
                        isResponseObject(value) && value.ok === true,
                    });
                  } catch (cause) {
                    if (!uncertainResponse(cause) || signal.aborted)
                      throw cause;
                    let result: EmailChangeResponse;
                    try {
                      result = await api(
                        "/auth/email-change",
                        undefined,
                        "GET",
                        {
                          signal,
                          headers: emailIdentityHeaders,
                          validateResponse: isEmailChangeResponse,
                        },
                      );
                    } catch {
                      throw cause;
                    }
                    if (result.pending !== null) throw cause;
                  }
                  if (!isCurrent() || signal.aborted) return;
                  updateEmailChange({ pending: null });
                  if (active.current) toast.success("Email change canceled.");
                })
              }
              onResendVerification={() =>
                emailMutation(async (signal) => {
                  const isCurrent = suspension.capture();
                  const result = await api<{
                    status: true;
                    resendAvailableAt: number;
                  }>("/auth/email-verification/request", {}, "POST", {
                    signal,
                    headers: emailIdentityHeaders,
                    validateResponse: (value) =>
                      isResponseObject(value) &&
                      value.status === true &&
                      typeof value.resendAvailableAt === "number" &&
                      Number.isFinite(value.resendAvailableAt),
                  });
                  if (!isCurrent() || signal.aborted) return;
                  if (active.current)
                    setResendAvailableAt(result.resendAvailableAt);
                  if (active.current)
                    toast.success("Verification email queued.");
                })
              }
            />
          </ListState>
        ) : (
          <EmailChangeSettings
            email={session.user.email}
            isVerified={session.user.emailVerified}
            mode="read-only"
          >
            <p className="text-xs text-muted">
              Email changes and verification are unavailable until email
              delivery is configured for this installation.
            </p>
          </EmailChangeSettings>
        )}
        <PasswordChangeSettings
          minLength={15}
          maxLength={1024}
          onChangePassword={async ({ currentPassword, newPassword }) => {
            const isCurrent = suspension.capture();
            await api(
              "/auth/password",
              { currentPassword, password: newPassword },
              "POST",
              { onReauthenticationRequired: identity.confirmIdentity },
            );
            if (!isCurrent())
              throw new DOMException("Account action canceled.", "AbortError");
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
  const breadcrumbs = usePageBreadcrumbs();
  const appSuspended = useAppSuspended();
  const keys = useAccountList<Passkey>("/auth/passkeys");
  const [pending, setPending] = useState<{
    action: () => Promise<void>;
    onComplete?: () => void;
    onCancel?: () => void;
  } | null>(null);
  const securityPending = useRef(false);
  const pendingRef = useRef(pending);
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  useEffect(() => {
    active.current = !appSuspended;
    if (appSuspended) {
      controller.current?.abort();
      pendingRef.current?.onCancel?.();
      pendingRef.current = null;
      controller.current = null;
      securityPending.current = false;
      setPending(null);
    }
    return () => {
      active.current = false;
      controller.current?.abort();
      pendingRef.current?.onCancel?.();
      pendingRef.current = null;
    };
  }, [appSuspended]);
  async function refresh() {
    onRefresh();
    await keys.refresh();
  }
  function securePasskey(action: (signal: AbortSignal) => Promise<void>) {
    if (!active.current)
      return Promise.reject(
        new Error("Sign in again to change your passkeys."),
      );
    if (securityPending.current)
      return Promise.reject(
        new Error("Complete the current security change first."),
      );
    securityPending.current = true;
    const request = new AbortController();
    controller.current = request;
    return new Promise<void>((resolve, reject) => {
      const confirmation = {
        action: async () => {
          if (!active.current || request.signal.aborted) return;
          try {
            const current = await api<{
              user: { id: string };
              workspace: { id: string };
            }>("/auth/me", undefined, "GET", {
              signal: request.signal,
              validateResponse: (value) =>
                isResponseObject(value) &&
                isResponseObject(value.user) &&
                typeof value.user.id === "string" &&
                isResponseObject(value.workspace) &&
                typeof value.workspace.id === "string",
            });
            if (
              current.user.id !== session.user.id ||
              current.workspace.id !== session.workspace.id
            )
              throw new Error(
                "Your account changed. Sign in again before changing passkeys.",
              );
            request.signal.throwIfAborted();
            await action(request.signal);
          } catch (cause) {
            if (active.current && !request.signal.aborted) throw cause;
          }
        },
        onComplete: resolve,
        onCancel: () => reject(new Error("Identity confirmation canceled.")),
      };
      pendingRef.current = confirmation;
      setPending(confirmation);
    });
  }
  return (
    <section className="min-w-0">
      <AppShellBreadcrumb items={breadcrumbs} title="Passkeys" />
      {keys.items === null && <SettingsHeading section="passkeys" />}
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
              maxNameLength={120}
              recoveryCodes={recoveryCodes}
              recoveryCodesFilename="mill-recovery-codes.txt"
              onDismissRecoveryCodes={() => setRecoveryCodes([])}
              onReplaceRecoveryCodes={() =>
                securePasskey(async (signal) => {
                  const result = await api<{ recoveryCodes: string[] }>(
                    "/auth/passkeys/recovery-codes",
                    {},
                    "POST",
                    { signal },
                  );
                  if (active.current && !signal.aborted)
                    setRecoveryCodes(result.recoveryCodes);
                })
              }
              formatDate={(value) => (
                <RelativeDateTime
                  value={value}
                  dateFormat={session.user.dateFormat}
                  timeFormat={session.user.timeFormat}
                  timeZone={session.user.timeZone}
                />
              )}
              onAdd={(name) =>
                securePasskey(async (signal) => {
                  const options = await api<{
                    challengeId: string;
                    options: PublicKeyCredentialCreationOptionsJSON;
                  }>("/auth/passkeys/register/options", { name }, "POST", {
                    signal,
                  });
                  signal.throwIfAborted();
                  const cancelRegistration = () =>
                    WebAuthnAbortService.cancelCeremony();
                  signal.addEventListener("abort", cancelRegistration, {
                    once: true,
                  });
                  let response;
                  try {
                    response = await startRegistration({
                      optionsJSON: options.options,
                    });
                  } finally {
                    signal.removeEventListener("abort", cancelRegistration);
                  }
                  signal.throwIfAborted();
                  const result = await api<{ recoveryCodes?: string[] }>(
                    "/auth/passkeys/register/verify",
                    {
                      challengeId: options.challengeId,
                      response,
                      name,
                    },
                    "POST",
                    { signal },
                  );
                  if (active.current && !signal.aborted && result.recoveryCodes)
                    setRecoveryCodes(result.recoveryCodes);
                })
              }
              onRemove={(id) =>
                securePasskey(async (signal) => {
                  await api(`/auth/passkeys/${id}`, {}, "DELETE", { signal });
                })
              }
            />
          </ListState>
        </div>
      </div>
      {!appSuspended && pending && (
        <ReauthenticationDialog
          onClose={() => {
            controller.current?.abort();
            pendingRef.current?.onCancel?.();
            pendingRef.current = null;
            controller.current = null;
            securityPending.current = false;
            setPending(null);
          }}
          onConfirmed={async () => {
            if (!active.current || pendingRef.current !== pending) return;
            await pending.action();
            if (!active.current || pendingRef.current !== pending) return;
            await refresh();
            if (!active.current || pendingRef.current !== pending) return;
            pending.onComplete?.();
            pendingRef.current = null;
            controller.current = null;
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
      <SettingsHeading section="sessions" />
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
            <RelativeDateTime
              value={value}
              dateFormat={session.user.dateFormat}
              timeFormat={session.user.timeFormat}
              timeZone={session.user.timeZone}
            />
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
