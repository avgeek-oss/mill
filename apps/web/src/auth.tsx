import { QueryFeedback } from "./query-feedback.js";
import { useEffect, useRef, useState } from "react";
import {
  InvitationPasswordSetup,
  InvitationUnavailable,
  AuthScreen,
  Button,
  PasskeyVerification,
  PasskeyRecoveryVerification,
  PasswordSetup,
  QueryLoading,
  SignIn,
  TeamSetup,
} from "@avgeek-oss/design-system";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { api, errorText, type Session } from "./api.js";
import { MillMark } from "./brand.js";
import { dateTimePreferenceOptions } from "./date-time-preferences.js";
import {
  passkeyError,
  verifyPasskey,
  type IdentityChallenge,
} from "./identity-ui.js";

type Mode = "login" | "forgot" | "reset" | "invite" | "passkey" | "recovery";
type Invitation = { email: string; role: string; workspaceName: string };
export function AuthBrand() {
  return (
    <a
      href="/"
      aria-label="Mill sign in"
      className="inline-flex w-fit items-center gap-2 font-medium"
    >
      <MillMark />
      Mill
    </a>
  );
}

export function Auth({
  setup,
  onSession,
  focusEmail = false,
}: {
  setup: boolean;
  onSession: (session: Session) => void;
  focusEmail?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(() =>
    window.location.pathname.startsWith("/invite")
      ? "invite"
      : window.location.pathname.startsWith("/recover")
        ? "reset"
        : "login",
  );
  const [token] = useState(
    () => new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [email, setEmail] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [invitationError, setInvitationError] = useState("");
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [challenge, setChallenge] = useState<IdentityChallenge | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyCancellable, setPasskeyCancellable] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const ceremony = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      ceremony.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (mode !== "invite") return;
    let current = true;
    setInvitation(null);
    setInvitationError("");
    if (!token) return;
    void api<{ invitation: Invitation }>(
      `/auth/invitation?token=${encodeURIComponent(token)}`,
    )
      .then((result) => {
        if (current) setInvitation(result.invitation);
      })
      .catch((cause) => {
        if (current) setInvitationError(errorText(cause));
      });
    return () => {
      current = false;
    };
  }, [mode, token, lookupAttempt]);
  useEffect(() => {
    document.title = `${setup ? "Set up your team" : mode === "invite" ? "Join your workspace" : mode === "reset" ? "Choose a new password" : mode === "login" ? "Sign in" : "Verify your sign-in"} · Mill`;
  }, [setup, mode]);
  useEffect(() => {
    if (
      !focusEmail ||
      mode !== "login" ||
      setup ||
      window.matchMedia("(pointer: coarse)").matches
    )
      return;
    document.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
  }, [focusEmail, mode, setup]);
  function backToSignIn() {
    if (passkeyBusy && !passkeyCancellable) return;
    ceremony.current?.abort();
    setChallenge(null);
    setMode("login");
    window.history.replaceState(window.history.state, "", "/");
  }
  async function passkey(challengeId?: string) {
    if (pending.current) return;
    pending.current = true;
    setMode("passkey");
    setPasskeyBusy(true);
    setPasskeyCancellable(true);
    const controller = new AbortController();
    ceremony.current = controller;
    try {
      const result = await verifyPasskey<Session>(
        challengeId,
        controller.signal,
        () => setPasskeyCancellable(false),
      );
      if (active.current && !controller.signal.aborted) onSession(result);
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        toast.danger(passkeyError(cause));
    } finally {
      pending.current = false;
      if (active.current) {
        setPasskeyBusy(false);
        setPasskeyCancellable(false);
      }
    }
  }
  async function signIn(identifier: string, password: string) {
    if (pending.current) return;
    pending.current = true;
    setCredentialsBusy(true);
    setEmail(identifier);
    try {
      const result = await api<Session | IdentityChallenge>("/auth/login", {
        email: identifier,
        password,
      });
      if (!active.current) return;
      if ("requiresSecondFactor" in result) {
        setChallenge(result);
        if (!result.methods.includes("passkey"))
          throw new Error(
            "Passkey verification is unavailable. Contact the person who runs your Mill installation to recover access.",
          );
        pending.current = false;
        await passkey(result.challengeId);
      } else onSession(result);
    } finally {
      pending.current = false;
      if (active.current) setCredentialsBusy(false);
    }
  }
  const brand = <AuthBrand />;
  if (setup)
    return (
      <TeamSetup
        brand={brand}
        preferenceOptions={dateTimePreferenceOptions}
        onSubmit={async ({ team, ...values }) => {
          onSession(
            await api<Session>("/auth/setup", {
              workspaceName: team,
              ...values,
            }),
          );
        }}
      />
    );
  if (mode === "login")
    return (
      <SignIn
        brand={brand}
        defaultEmail={email}
        isPending={credentialsBusy}
        onSubmit={({ identifier, password }) => signIn(identifier, password)}
        onForgotPassword={() => setMode("forgot")}
        onPasskeySignIn={() => void passkey()}
      />
    );
  if (mode === "forgot")
    return (
      <AuthScreen
        brand={brand}
        title="Recover your account"
        description="Contact the person who runs your Mill installation. They can create a one-time recovery link."
      >
        <Button variant="secondary" onPress={backToSignIn}>
          ← Back to Sign In
        </Button>
      </AuthScreen>
    );
  if (mode === "reset")
    return token ? (
      <PasswordSetup
        brand={brand}
        onBackToSignIn={backToSignIn}
        onSubmit={async ({ password }) => {
          await api("/auth/recovery/reset", { token, password });
          toast.success("Password reset. Sign in to continue.");
          backToSignIn();
        }}
      />
    ) : (
      <AuthScreen brand={brand} title="Choose a new password">
        <QueryFeedback message="This recovery link is incomplete. Contact the person who runs your Mill installation for a new link." />
        <Button variant="secondary" onPress={backToSignIn}>
          ← Back to Sign In
        </Button>
      </AuthScreen>
    );
  if (mode === "invite") {
    if (!token)
      return (
        <InvitationUnavailable brand={brand} onBackToSignIn={backToSignIn} />
      );
    if (invitationError)
      return (
        <AuthScreen brand={brand} title="Join your workspace">
          <QueryFeedback
            message={invitationError}
            onRetry={() => setLookupAttempt((value) => value + 1)}
          />
          <Button variant="secondary" onPress={backToSignIn}>
            ← Back to Sign In
          </Button>
        </AuthScreen>
      );
    if (!invitation)
      return (
        <AuthScreen brand={brand} title="Join your workspace">
          <QueryLoading className="sr-only">
            Checking your invitation…
          </QueryLoading>
        </AuthScreen>
      );
    return (
      <InvitationPasswordSetup
        brand={brand}
        teamName={invitation.workspaceName}
        email={invitation.email}
        role={invitation.role}
        maxNameLength={100}
        minPasswordLength={15}
        maxPasswordLength={1024}
        onBackToSignIn={backToSignIn}
        onSubmit={async ({ name, password }) => {
          onSession(
            await api<Session>("/auth/accept-invitation", {
              token,
              name,
              password,
            }),
          );
        }}
      />
    );
  }

  if (mode === "recovery")
    return (
      <PasskeyRecoveryVerification
        brand={brand}
        onSubmit={async ({ code }) => {
          if (!challenge?.recoveryAvailable)
            throw new Error("Start again from sign in.");
          onSession(
            await api<Session>("/auth/passkeys/recovery/verify", {
              challengeId: challenge.challengeId,
              code,
            }),
          );
        }}
        onPasskeyVerification={() => setMode("passkey")}
        onBackToSignIn={backToSignIn}
      />
    );
  return (
    <PasskeyVerification
      brand={brand}
      isPending={passkeyBusy}
      onRetry={() => void passkey(challenge?.challengeId)}
      onCancelRequest={
        passkeyCancellable
          ? () => {
              ceremony.current?.abort();
              toast.danger(
                "Passkey verification was cancelled. Try your passkey again.",
              );
            }
          : undefined
      }
      onBackToSignIn={backToSignIn}
      onRecoverySignIn={
        challenge?.recoveryAvailable ? () => setMode("recovery") : undefined
      }
    />
  );
}
