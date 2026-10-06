import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Button,
  ErrorMessage,
  FieldGroup,
  TextField,
  toast,
} from "@mill/web-design-system";
import { api, errorText, type Session } from "./api.js";
import {
  AuthFrame,
  ChallengeFields,
  PasswordField,
  passkeyError,
  verifyPasskey,
  type IdentityChallenge,
} from "./identity-ui.js";

type Mode = "login" | "recover" | "reset" | "invite";
type Invitation = { email: string; role: string; workspaceName: string };
export function Auth({
  setup,
  onSession,
  focusEmail = false,
}: {
  setup: boolean;
  onSession: (session: Session) => void;
  focusEmail?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(
    window.location.pathname.startsWith("/invite")
      ? "invite"
      : window.location.pathname.startsWith("/recover")
        ? "reset"
        : "login",
  );
  const [token] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [form, setForm] = useState({
    workspaceName: "",
    name: "",
    email: "",
    password: "",
    confirmation: "",
    code: "",
  });
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [invitationState, setInvitationState] = useState<
    "pending" | "ready" | "failed"
  >("pending");
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<IdentityChallenge | null>(null);
  const [method, setMethod] = useState("");
  const ceremony = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
      ceremony.current?.abort();
    },
    [],
  );
  const creating = setup || mode === "invite" || mode === "reset";
  useEffect(() => {
    if (mode !== "invite") return;
    let active = true;
    setInvitationState("pending");
    setError("");
    setInvitation(null);
    if (!token) {
      setInvitationState("failed");
      setError(
        "This invitation link is incomplete. Ask your administrator for a new link.",
      );
      return;
    }
    void api<{ invitation: Invitation }>(
      `/auth/invitation?token=${encodeURIComponent(token)}`,
    )
      .then((result) => {
        if (active) {
          setInvitation(result.invitation);
          setInvitationState("ready");
        }
      })
      .catch((cause) => {
        if (active) {
          setError(errorText(cause));
          setInvitationState("failed");
        }
      });
    return () => {
      active = false;
    };
  }, [mode, token, lookupAttempt]);
  const title = challenge
    ? "Verify your sign-in"
    : mode === "invite"
      ? "Join your workspace"
      : mode === "recover"
        ? "Recover your account"
        : mode === "reset"
          ? "Choose a new password"
          : setup
            ? "Create your workspace"
            : "Sign in to Mill";
  useEffect(() => {
    document.title = `${title} · Mill`;
  }, [title]);
  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function field(
    key: "workspaceName" | "name" | "email",
    label: string,
    type = "text",
  ) {
    return (
      <TextField
        label={label}
        value={form[key]}
        onChange={(e) => update(key, e.target.value)}
        required
        disabled={busy}
        autoFocus={
          key === "email" &&
          focusEmail &&
          !window.matchMedia("(pointer: coarse)").matches
        }
        type={type}
        autoComplete={
          key === "email"
            ? "username"
            : key === "name"
              ? "name"
              : "organization"
        }
        maxLength={200}
      />
    );
  }
  async function passkey(challengeId?: string) {
    setBusy(true);
    setPasskeyBusy(true);
    setError("");
    const controller = new AbortController();
    ceremony.current = controller;
    try {
      const result = await verifyPasskey<Session>(
        challengeId,
        controller.signal,
      );
      if (active.current) onSession(result);
    } catch (cause) {
      if (active.current) setError(passkeyError(cause));
    } finally {
      setBusy(false);
      setPasskeyBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (creating && form.password !== form.confirmation) {
      setError("");
      toast.danger("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (challenge) {
        if (!challenge.methods.includes(method)) return;
        onSession(
          await api<Session>("/auth/second-factor", {
            challengeId: challenge.challengeId,
            method,
            code: form.code,
          }),
        );
      } else if (mode === "reset") {
        await api("/auth/recovery/reset", { token, password: form.password });
        setMode("login");
        update("password", "");
        update("confirmation", "");
        window.history.replaceState(window.history.state, "", "/");
        toast.success("Password reset. Sign in to continue.");
      } else if (mode === "invite") {
        if (invitationState !== "ready") return;
        onSession(
          await api<Session>("/auth/accept-invitation", {
            token,
            name: form.name,
            password: form.password,
          }),
        );
      } else {
        const result = await api<Session | IdentityChallenge>(
          setup ? "/auth/setup" : "/auth/login",
          setup
            ? {
                workspaceName: form.workspaceName,
                name: form.name,
                email: form.email,
                password: form.password,
              }
            : { email: form.email, password: form.password },
        );
        if ("requiresSecondFactor" in result) {
          setChallenge(result);
          setMethod(
            result.methods.find((m) => m === "totp" || m === "recovery") ?? "",
          );
          if (result.preferredMethod === "passkey")
            await passkey(result.challengeId);
        } else onSession(result);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  function backToSignIn() {
    setMode("login");
    setChallenge(null);
    setError("");
    window.history.replaceState(window.history.state, "", "/");
  }
  const description = challenge
    ? challenge.methods.includes("passkey")
      ? challenge.methods.some((method) => method !== "passkey")
        ? "Use your passkey to verify your sign-in, or choose another available method."
        : "Use your passkey to finish signing in."
      : "Enter the code from your authenticator app or an unused recovery code."
    : mode === "invite" && invitation
      ? `Join ${invitation.workspaceName} as ${invitation.email} (${invitation.role}).`
      : mode === "invite"
        ? "Check your invitation before joining this workspace."
        : mode === "recover"
          ? "Contact the person who runs your Mill installation. They can create a one-time recovery link."
          : mode === "reset"
            ? "Choose a unique password to regain access to your account."
            : setup
              ? "Create your workspace and the first administrator account."
              : "Sign in to your workspace.";
  const formReady =
    mode !== "recover" &&
    (mode !== "invite" || invitationState === "ready") &&
    (mode !== "reset" || !!token);
  return (
    <AuthFrame title={title} description={description}>
      {mode === "invite" && invitationState === "pending" && (
        <p role="status" className="text-sm text-muted">
          Checking your invitation…
        </p>
      )}
      {mode === "invite" && invitationState === "failed" && (
        <div className="content-grid">
          <ErrorMessage>{error}</ErrorMessage>
          {token && (
            <Button
              variant="secondary"
              onPress={() => setLookupAttempt((n) => n + 1)}
            >
              Retry invitation lookup
            </Button>
          )}
          <p className="text-sm text-muted">
            Ask your workspace administrator for a new invitation if this link
            has expired or was revoked.
          </p>
        </div>
      )}
      {mode === "reset" && !token && (
        <ErrorMessage>
          This recovery link is incomplete. Contact the person who runs your
          Mill installation for a new link.
        </ErrorMessage>
      )}
      {formReady && (
        <form
          className="grid gap-5"
          onSubmit={(event) => void submit(event)}
          aria-busy={busy}
        >
          <FieldGroup>
            {!challenge && (
              <>
                {setup && field("workspaceName", "Workspace name")}
                {(setup || mode === "invite") && field("name", "Your name")}
                {mode === "login" && field("email", "Email", "email")}
                <PasswordField
                  label="Password"
                  value={form.password}
                  onChange={(e) => update("password", e.target.value)}
                  required
                  disabled={busy}
                  autoComplete={creating ? "new-password" : "current-password"}
                  minLength={creating ? 15 : undefined}
                  maxLength={1024}
                  description={
                    creating
                      ? "Use at least 15 characters. A password manager can help."
                      : undefined
                  }
                />
                {creating && (
                  <PasswordField
                    label="Confirm password"
                    value={form.confirmation}
                    onChange={(e) => update("confirmation", e.target.value)}
                    required
                    disabled={busy}
                    autoComplete="new-password"
                    maxLength={1024}
                  />
                )}
              </>
            )}
            {challenge && (
              <ChallengeFields
                challenge={challenge}
                method={method}
                onMethod={setMethod}
                code={form.code}
                onCode={(value) => update("code", value)}
                busy={busy}
                passkeyBusy={passkeyBusy}
                onPasskey={() => void passkey(challenge.challengeId)}
              />
            )}
          </FieldGroup>
          <ErrorMessage>{error}</ErrorMessage>
          {(!challenge ||
            challenge.methods.some(
              (m) => m === "totp" || m === "recovery",
            )) && (
            <Button className="w-full" type="submit" isDisabled={busy}>
              {busy
                ? "Please wait…"
                : challenge
                  ? "Verify"
                  : mode === "reset"
                    ? "Reset password"
                    : mode === "invite"
                      ? "Accept invitation"
                      : setup
                        ? "Create workspace"
                        : "Sign in"}
            </Button>
          )}
        </form>
      )}
      {!setup && !challenge && mode === "login" && (
        <div className="grid gap-2">
          <Button
            className="w-full"
            variant="secondary"
            onPress={() => void passkey()}
            isDisabled={busy}
          >
            Sign in with a passkey
          </Button>
          <Button
            variant="secondary"
            onPress={() => {
              setMode("recover");
              setError("");
            }}
            isDisabled={busy}
          >
            Forgot password?
          </Button>
        </div>
      )}
      {(mode !== "login" || challenge) && (
        <Button
          className="w-fit"
          variant="secondary"
          onPress={backToSignIn}
          isDisabled={busy}
        >
          Back to sign in
        </Button>
      )}
    </AuthFrame>
  );
}
