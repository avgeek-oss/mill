// Adapted from Towbar's public Apache-2.0 identity-web-ui and identity challenge components.
import {
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api } from "./api.js";

export type IdentityChallenge = {
  requiresSecondFactor: true;
  challengeId: string;
  methods: string[];
  preferredMethod: string;
  recoveryAvailable?: boolean;
};
export function passkeySupported() {
  return (
    window.isSecureContext && typeof window.PublicKeyCredential !== "undefined"
  );
}
export async function verifyPasskey<T>(
  challengeId?: string,
  signal?: AbortSignal,
  onVerificationStart?: () => void,
): Promise<T> {
  if (!passkeySupported())
    throw new Error(
      "Passkeys require a supported browser on HTTPS or localhost. Open Mill on a device where your passkey is available.",
    );
  const result = await api<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/auth/passkeys/authenticate/options", { challengeId }, "POST", {
    signal,
  });
  signal?.throwIfAborted();
  const cancel = () => WebAuthnAbortService.cancelCeremony();
  signal?.addEventListener("abort", cancel, { once: true });
  let response;
  try {
    response = await startAuthentication({ optionsJSON: result.options });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  signal?.throwIfAborted();
  onVerificationStart?.();
  return api<T>("/auth/passkeys/authenticate/verify", {
    challengeId: result.challengeId,
    response,
  });
}
export function passkeyError(cause: unknown) {
  if (
    cause instanceof Error &&
    ["NotAllowedError", "AbortError"].includes(cause.name)
  )
    return "Passkey verification was cancelled. Try your passkey again.";
  return cause instanceof Error
    ? cause.message
    : "Your passkey could not be verified. Try again.";
}
