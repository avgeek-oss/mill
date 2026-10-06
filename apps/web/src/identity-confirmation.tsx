import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActionConfirmation,
  ConfirmIdentityDialog,
} from "@avgeek-oss/design-system";
import { useAppSuspended } from "@mill/web-design-system";
import { api, ApiError } from "./api.js";
import {
  passkeyError,
  verifyPasskey,
  type IdentityChallenge,
} from "./identity-ui.js";

export function useIdentityConfirmation() {
  const appSuspended = useAppSuspended();
  const lifetime = useMemo(() => ({ active: false }), [appSuspended]);
  const [request, setRequest] = useState<{
    resolve: (approved: boolean) => void;
  } | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const resolver = useRef<((approved: boolean) => void) | null>(null);
  useLayoutEffect(() => {
    lifetime.active = !appSuspended;
    if (appSuspended) setRequest(null);
    return () => {
      lifetime.active = false;
      resolver.current?.(false);
      resolver.current = null;
      pending.current = null;
    };
  }, [appSuspended, lifetime]);
  const confirmIdentity = useCallback(() => {
    if (!lifetime.active) return Promise.resolve(false);
    if (pending.current) return pending.current;
    pending.current = new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setRequest({ resolve });
    });
    return pending.current;
  }, [lifetime]);
  function finish(approved: boolean) {
    resolver.current?.(approved && lifetime.active);
    pending.current = null;
    resolver.current = null;
    setRequest(null);
  }
  return {
    confirmIdentity,
    confirmation:
      request && !appSuspended ? (
        <ReauthenticationDialog
          onClose={() => finish(false)}
          onConfirmed={async () => finish(true)}
        />
      ) : null,
  };
}

export function ReauthenticationDialog({
  onClose,
  onConfirmed,
}: {
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [challenge, setChallenge] = useState<IdentityChallenge | null>(null);
  const [retrySecurityChange, setRetrySecurityChange] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const active = useRef(true);
  const ceremony = useRef<AbortController | null>(null);
  const passwordRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      passwordRequest.current?.abort();
      ceremony.current?.abort();
    };
  }, []);
  function dismiss() {
    active.current = false;
    passwordRequest.current?.abort();
    ceremony.current?.abort();
    onClose();
  }
  async function complete() {
    if (!active.current) return;
    try {
      await onConfirmed();
    } catch (cause) {
      if (!active.current) return;
      if (
        cause instanceof ApiError &&
        cause.code === "REAUTHENTICATION_REQUIRED"
      ) {
        setChallenge(null);
        setRetrySecurityChange(false);
      } else setRetrySecurityChange(true);
      throw cause;
    }
  }
  async function passkey(value: IdentityChallenge) {
    if (!active.current) return;
    const controller = new AbortController();
    ceremony.current = controller;
    setPasskeyBusy(true);
    try {
      await verifyPasskey(value.challengeId, controller.signal, () => {
        if (active.current) setPasskeyBusy(false);
      });
    } catch (cause) {
      if (!active.current || controller.signal.aborted) return;
      throw new Error(passkeyError(cause));
    } finally {
      if (active.current) setPasskeyBusy(false);
    }
    if (!active.current || controller.signal.aborted) return;
    await complete();
  }
  if (retrySecurityChange)
    return (
      <ActionConfirmation
        isOpen
        title="Retry security change?"
        confirmLabel="Retry"
        variant="primary"
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
        onConfirm={complete}
      />
    );
  return challenge ? (
    <ConfirmIdentityDialog
      isOpen
      method="passkey"
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      onCancelRequest={
        passkeyBusy ? () => ceremony.current?.abort() : undefined
      }
      onConfirm={() => passkey(challenge)}
    />
  ) : (
    <ConfirmIdentityDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      onConfirm={async ({ password }) => {
        if (!active.current) return;
        const controller = new AbortController();
        passwordRequest.current = controller;
        try {
          const result = await api<IdentityChallenge | { ok: true }>(
            "/auth/reauth",
            { password },
            "POST",
            { signal: controller.signal },
          );
          if (!active.current || controller.signal.aborted) return;
          if ("requiresSecondFactor" in result) {
            if (!result.methods.includes("passkey"))
              throw new Error(
                "Passkey verification is unavailable. Contact the person who runs your Mill installation to recover access.",
              );
            setChallenge(result);
            await passkey(result);
          } else await complete();
        } catch (cause) {
          if (!active.current || controller.signal.aborted) return;
          throw cause;
        } finally {
          if (passwordRequest.current === controller)
            passwordRequest.current = null;
        }
      }}
    />
  );
}
