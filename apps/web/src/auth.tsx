import { QueryFeedback } from "./query-feedback.js";
import { useEffect, useRef, useState } from "react";
import {
  InvitationPasswordSetup,
  AcceptInvitation,
  InvitationVerification,
  ForgotPassword,
  ResetLinkSent,
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
import {
  api,
  errorText,
  hasIdentityChallengeResponse,
  hasOkAcknowledgement,
  hasSessionResponse,
  hasStatusAcknowledgement,
  isResponseObject,
  type Session,
} from "./api.js";
import { MillMark } from "./brand.js";
import { dateTimePreferenceOptions } from "./date-time-preferences.js";
import {
  passkeyError,
  verifyPasskey,
  type IdentityChallenge,
} from "./identity-ui.js";

type Mode =
  | "login"
  | "forgot"
  | "reset-sent"
  | "reset"
  | "invite"
  | "invite-code"
  | "invite-password"
  | "passkey"
  | "recovery";
type Invitation = {
  email: string;
  role: string;
  workspaceName: string;
  verificationRequired: boolean;
};
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
  onIdentityChanged,
  focusEmail = false,
  emailDeliveryConfigured,
}: {
  setup: boolean;
  emailDeliveryConfigured: boolean;
  onSession: (session: Session) => void;
  onIdentityChanged: () => Promise<void>;
  focusEmail?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(() =>
    window.location.pathname.startsWith("/invite")
      ? "invite"
      : window.location.pathname.startsWith("/recover")
        ? "reset"
        : "login",
  );
  const [token] = useState(() =>
    window.location.pathname.startsWith("/recover") && window.location.hash
      ? window.location.hash.slice(1)
      : (new URLSearchParams(window.location.search).get("token") ?? ""),
  );
  const [email, setEmail] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [invitationError, setInvitationError] = useState("");
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [invitationRequest, setInvitationRequest] = useState<{
    resendAvailableAt: number;
    expiresAt: string;
  } | null>(null);
  const [invitationProof, setInvitationProof] = useState<{
    name: string;
    verificationToken: string;
  } | null>(null);
  const [challenge, setChallenge] = useState<IdentityChallenge | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyCancellable, setPasskeyCancellable] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const ceremony = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    if (
      window.location.pathname.startsWith("/recover") &&
      window.location.hash
    ) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
    }
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
    void api<{ invitation: Invitation; verificationRequired: boolean }>(
      `/auth/invitation?token=${encodeURIComponent(token)}`,
      undefined,
      "GET",
      {
        validateResponse: (value) =>
          isResponseObject(value) &&
          isResponseObject(value.invitation) &&
          typeof value.invitation.email === "string" &&
          ["admin", "member", "viewer"].includes(
            String(value.invitation.role),
          ) &&
          typeof value.invitation.workspaceName === "string" &&
          typeof value.verificationRequired === "boolean",
      },
    )
      .then((result) => {
        if (current)
          setInvitation({
            ...result.invitation,
            verificationRequired: result.verificationRequired,
          });
      })
      .catch((cause) => {
        if (current) setInvitationError(errorText(cause));
      });
    return () => {
      current = false;
    };
  }, [mode, token, lookupAttempt]);
  useEffect(() => {
    const titles: Record<Mode, string> = {
      login: "Sign in",
      forgot: "Reset your password",
      "reset-sent": "Reset your password",
      reset: "Choose a new password",
      invite: "Join your workspace",
      "invite-code": "Join your workspace",
      "invite-password": "Choose your password",
      passkey: "Verify your sign-in",
      recovery: "Verify your sign-in",
    };
    document.title = `${setup && mode === "login" ? "Set up your team" : titles[mode]} · Mill`;
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
    if (
      credentialsBusy ||
      (pending.current && !(passkeyBusy && passkeyCancellable))
    )
      return;
    ceremony.current?.abort();
    setChallenge(null);
    setMode("login");
    window.history.replaceState(window.history.state, "", "/");
    window.dispatchEvent(new Event("mill:navigate"));
  }
  async function credentialsRequest<T>(request: () => Promise<T>) {
    if (pending.current)
      throw new Error("Wait for the current request to finish.");
    pending.current = true;
    setCredentialsBusy(true);
    try {
      return await request();
    } finally {
      pending.current = false;
      if (active.current) setCredentialsBusy(false);
    }
  }
  async function requestInvitationCode() {
    if (pending.current) return;
    pending.current = true;
    setCredentialsBusy(true);
    try {
      const result = await api<{
        resendAvailableAt: number;
        expiresAt: string;
      }>("/auth/invitation/verification/request", { token }, "POST", {
        validateResponse: (value) =>
          hasStatusAcknowledgement(value) &&
          isResponseObject(value) &&
          Number.isSafeInteger(value.resendAvailableAt) &&
          Number(value.resendAvailableAt) > 0 &&
          typeof value.expiresAt === "string" &&
          Number.isFinite(Date.parse(value.expiresAt)),
      });
      if (!active.current) return;
      setInvitationRequest(result);
      toast.success("Verification code requested.");
      setMode("invite-code");
    } finally {
      pending.current = false;
      if (active.current) setCredentialsBusy(false);
    }
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
      if (!hasSessionResponse(result))
        throw new Error("The server response was incomplete. Try again.");
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
      const result = await api<Session | IdentityChallenge>(
        "/auth/login",
        { email: identifier, password },
        "POST",
        {
          validateResponse: (value) =>
            hasSessionResponse(value) || hasIdentityChallengeResponse(value),
        },
      );
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
  if (setup && mode === "login")
    return (
      <TeamSetup
        brand={brand}
        preferenceOptions={dateTimePreferenceOptions}
        onSubmit={async ({ team, ...values }) => {
          const result = await credentialsRequest(() =>
            api<Session>(
              "/auth/setup",
              {
                workspaceName: team,
                ...values,
              },
              "POST",
              { validateResponse: hasSessionResponse },
            ),
          );
          if (active.current) onSession(result);
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
  if (mode === "forgot" && emailDeliveryConfigured)
    return (
      <ForgotPassword
        brand={brand}
        defaultEmail={email}
        onBackToSignIn={backToSignIn}
        onSubmit={async ({ email: address }) => {
          setCredentialsBusy(true);
          try {
            await api(
              "/auth/password-reset/request",
              { email: address },
              "POST",
              { validateResponse: hasStatusAcknowledgement },
            );
            if (!active.current) return;
            setEmail(address);
            toast.success("Password reset request received.");
            setMode("reset-sent");
          } finally {
            if (active.current) setCredentialsBusy(false);
          }
        }}
      />
    );
  if (mode === "reset-sent")
    return <ResetLinkSent brand={brand} onBackToSignIn={backToSignIn} />;
  if (mode === "forgot" && !emailDeliveryConfigured)
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
          await credentialsRequest(() =>
            api("/auth/recovery/reset", { token, password }, "POST", {
              validateResponse: hasOkAcknowledgement,
            }),
          );
          if (!active.current) return;
          toast.success("Password reset. Sign in to continue.");
          try {
            await onIdentityChanged();
          } catch (cause) {
            if (active.current) toast.danger(errorText(cause));
          }
          if (active.current) backToSignIn();
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
        <AuthScreen brand={brand} title="Join your workspace">
          <QueryFeedback message="This invitation link is incomplete. Ask your administrator for a new link." />
          <Button variant="secondary" onPress={backToSignIn}>
            ← Back to Sign In
          </Button>
        </AuthScreen>
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
    if (invitation.verificationRequired)
      return (
        <AcceptInvitation
          brand={brand}
          teamName={invitation.workspaceName}
          role={invitation.role}
          isPending={credentialsBusy}
          onVerifyEmail={() => {
            void requestInvitationCode().catch((cause) => {
              if (active.current) toast.danger(errorText(cause));
            });
          }}
          onBackToSignIn={backToSignIn}
        />
      );
    return (
      <InvitationPasswordSetup
        brand={brand}
        teamName={invitation.workspaceName}
        email={invitation.email}
        role={invitation.role}
        maxNameLength={120}
        minPasswordLength={15}
        maxPasswordLength={1024}
        onBackToSignIn={backToSignIn}
        onSubmit={async ({ name, password }) => {
          const result = await credentialsRequest(() =>
            api<Session>(
              "/auth/accept-invitation",
              {
                token,
                name,
                password,
              },
              "POST",
              { validateResponse: hasSessionResponse },
            ),
          );
          if (active.current) onSession(result);
        }}
      />
    );
  }

  if (mode === "invite-code" && invitation && invitationRequest)
    return (
      <InvitationVerification
        brand={brand}
        teamName={invitation.workspaceName}
        maxNameLength={120}
        onSubmit={async ({ name, code }) => {
          const result = await credentialsRequest(() =>
            api<{ verificationToken: string }>(
              "/auth/invitation/verification/confirm",
              { token, name, code },
              "POST",
              {
                validateResponse: (value) =>
                  isResponseObject(value) &&
                  typeof value.verificationToken === "string" &&
                  /^[A-Za-z0-9_-]{43}$/.test(value.verificationToken),
              },
            ),
          );
          if (!active.current) return;
          setInvitationProof({ name: name.trim(), ...result });
          toast.success("Email verified.");
          setMode("invite-password");
        }}
      />
    );
  if (mode === "invite-password" && invitationProof)
    return (
      <PasswordSetup
        brand={brand}
        mode="first"
        onBackToSignIn={backToSignIn}
        onSubmit={async ({ password }) => {
          const result = await credentialsRequest(() =>
            api<Session>(
              "/auth/accept-invitation",
              { token, ...invitationProof, password },
              "POST",
              { validateResponse: hasSessionResponse },
            ),
          );
          if (active.current) onSession(result);
        }}
      />
    );

  if (mode === "recovery")
    return (
      <PasskeyRecoveryVerification
        brand={brand}
        onSubmit={async ({ code }) => {
          if (!challenge?.recoveryAvailable)
            throw new Error("Start again from sign in.");
          const result = await credentialsRequest(() =>
            api<Session>(
              "/auth/passkeys/recovery/verify",
              {
                challengeId: challenge.challengeId,
                code,
              },
              "POST",
              { validateResponse: hasSessionResponse },
            ),
          );
          if (active.current) onSession(result);
        }}
        onPasskeyVerification={() => {
          if (!pending.current) setMode("passkey");
        }}
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
