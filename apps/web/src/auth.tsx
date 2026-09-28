import { useEffect, useState, type FormEvent } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  Button,
  Choice,
  ErrorMessage,
  TextField,
} from "@mill/web-design-system";
import { api, errorText, type Session } from "./api.js";
type Challenge = {
  requiresSecondFactor: true;
  challengeId: string;
  methods: string[];
  preferredMethod: string;
};
export function Auth({
  setup,
  onSession,
}: {
  setup: boolean;
  onSession: (session: Session) => void;
}) {
  const [mode, setMode] = useState<"login" | "recover" | "reset" | "invite">(
    window.location.pathname.startsWith("/invite")
      ? "invite"
      : window.location.pathname.startsWith("/recover")
        ? "reset"
        : "login",
  );
  const [form, setForm] = useState({
    workspaceName: "",
    name: "",
    email: "",
    password: "",
    token: new URLSearchParams(window.location.search).get("token") ?? "",
    code: "",
  });
  const [invitation, setInvitation] = useState<{
    email: string;
    role: string;
    workspaceName: string;
  } | null>(null);
  useEffect(() => {
    if (mode === "invite" && form.token)
      void api<{
        invitation: { email: string; role: string; workspaceName: string };
      }>(`/auth/invitation?token=${encodeURIComponent(form.token)}`)
        .then((result) => setInvitation(result.invitation))
        .catch((e) => setError(errorText(e)));
  }, [mode]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [method, setMethod] = useState("totp");
  function field(key: keyof typeof form, label: string, type = "text") {
    return (
      <TextField
        label={label}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        required
        type={type}
        autoComplete={
          key === "password"
            ? setup || mode !== "login"
              ? "new-password"
              : "current-password"
            : key === "email"
              ? "username"
              : key === "name"
                ? "name"
                : "off"
        }
        minLength={key === "password" ? 15 : undefined}
        maxLength={key === "password" ? 1024 : 200}
      />
    );
  }
  async function passkey(challengeId?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        challengeId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>("/auth/passkeys/authenticate/options", { challengeId });
      const response = await startAuthentication({
        optionsJSON: result.options,
      });
      onSession(
        await api<Session>("/auth/passkeys/authenticate/verify", {
          challengeId: result.challengeId,
          response,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (challenge) {
        onSession(
          await api<Session>("/auth/second-factor", {
            challengeId: challenge.challengeId,
            method,
            code: form.code,
          }),
        );
      } else if (mode === "recover") {
        setNotice(
          "Contact the person who runs your Mill installation. They can create a one-time recovery link using the recovery command. Open that link to choose a new password.",
        );
      } else if (mode === "reset") {
        await api("/auth/recovery/reset", {
          token: form.token,
          password: form.password,
        });
        setMode("login");
        setNotice("Your password has been reset. Sign in to continue.");
      } else if (mode === "invite") {
        onSession(
          await api<Session>("/auth/accept-invitation", {
            token: form.token,
            name: form.name,
            password: form.password,
          }),
        );
      } else {
        const result = await api<Session | Challenge>(
          setup ? "/auth/setup" : "/auth/login",
          setup ? form : { email: form.email, password: form.password },
        );
        if ("requiresSecondFactor" in result) {
          setChallenge(result);
          setMethod(result.methods.includes("totp") ? "totp" : "recovery");
          if (result.preferredMethod === "passkey")
            await passkey(result.challengeId);
        } else onSession(result);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    document.title = setup ? "Set up Mill" : "Sign in · Mill";
  }, [setup]);
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <span className="mark">M</span>
        <span>Mill</span>
      </div>
      <section className="auth-card">
        <h1>
          {setup
            ? "Create your workspace"
            : challenge
              ? "Verify your sign-in"
              : mode === "invite"
                ? "Join your workspace"
                : mode === "recover"
                  ? "Recover your account"
                  : mode === "reset"
                    ? "Choose a new password"
                    : "Sign in to Mill"}
        </h1>
        <p className="muted">
          {setup
            ? "Create your workspace and the first administrator account."
            : challenge
              ? "Use a passkey or your second verification method."
              : mode === "recover"
                ? "Contact the person who runs your Mill installation. They can create a one-time recovery link."
                : mode === "reset"
                  ? "Choose a unique password to regain access to your account."
                  : mode === "invite" && invitation
                    ? `Join ${invitation.workspaceName} as ${invitation.email} (${invitation.role}).`
                    : "A clear place for your team’s tasks."}
        </p>
        <form className="stack" onSubmit={(e) => void submit(e)}>
          {setup && field("workspaceName", "Workspace name")}
          {(setup || mode === "invite") && field("name", "Your name")}
          {!challenge && mode === "login" && field("email", "Email", "email")}
          {!challenge &&
            mode !== "recover" &&
            field("password", "Password", "password")}
          {(setup || mode === "invite" || mode === "reset") && (
            <p className="muted small">
              Use at least 15 characters. A password manager can help.
            </p>
          )}
          {mode === "invite" && field("token", "Invitation code")}
          {mode === "reset" && field("token", "Recovery code")}
          {challenge && (
            <>
              {challenge.methods.includes("passkey") && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => void passkey(challenge.challengeId)}
                >
                  Use passkey
                </Button>
              )}
              <Choice
                label="Other verification method"
                value={method}
                onChange={setMethod}
                items={challenge.methods
                  .filter((m) => m !== "passkey")
                  .map((id) => ({
                    id,
                    name:
                      id === "totp" ? "Authenticator code" : "Recovery code",
                  }))}
              />
              {field(
                "code",
                method === "totp" ? "Six-digit code" : "Recovery code",
              )}
            </>
          )}
          <ErrorMessage>{error}</ErrorMessage>
          {notice && (
            <p role="status" className="success-message">
              {notice}
            </p>
          )}
          {mode !== "recover" && (
            <Button type="submit" isDisabled={busy}>
              {busy
                ? "Please wait…"
                : setup
                  ? "Create workspace"
                  : challenge
                    ? "Verify"
                    : mode === "reset"
                      ? "Reset password"
                      : mode === "invite"
                        ? "Accept invitation"
                        : "Sign in"}
            </Button>
          )}
        </form>
        {!setup && !challenge && mode === "login" && (
          <div className="auth-actions">
            <Button
              variant="ghost"
              onPress={() => void passkey()}
              isDisabled={busy}
            >
              Sign in with a passkey
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                setMode("recover");
                setError("");
              }}
            >
              Forgot password?
            </Button>
          </div>
        )}
        {mode === "recover" && (
          <Button variant="ghost" onPress={() => setMode("login")}>
            Back to sign in
          </Button>
        )}
      </section>
      <p className="auth-footer muted small">
        Self-hosted. Open source. Yours.
      </p>
    </main>
  );
}
