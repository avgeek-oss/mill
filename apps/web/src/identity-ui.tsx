// Adapted from Towbar's public Apache-2.0 identity-web-ui and identity challenge components.
import { useId, type ComponentProps, type ReactNode } from "react";
import {
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  Button,
  Choice,
  Field,
  FieldDescription,
  FieldLabel,
  PasswordInput,
  TextField,
  TypographyHeading,
  TypographyParagraph,
} from "@mill/web-design-system";
import { api } from "./api.js";
import { MillMark } from "./brand.js";

export type IdentityChallenge = {
  requiresSecondFactor: true;
  challengeId: string;
  methods: string[];
  preferredMethod: string;
};
export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main data-slot="identity-auth-shell" className="flex min-h-dvh w-full">
      <div
        data-slot="identity-auth-form-panel"
        className="flex min-w-0 flex-1 justify-center px-4 py-8 sm:items-center sm:px-6 sm:py-12"
      >
        <div
          data-slot="identity-auth-content"
          className="grid w-full gap-8 sm:max-w-sm"
        >
          <div className="content-grid">
            <a
              href="/"
              aria-label="Mill sign in"
              className="inline-flex w-fit items-center gap-2 font-medium"
            >
              <MillMark />
              Mill
            </a>
            <header data-slot="identity-auth-heading" className="grid gap-3">
              <div
                data-slot="identity-auth-heading-copy"
                className="grid gap-1"
              >
                <TypographyHeading elementType="h1" level={2}>
                  {title}
                </TypographyHeading>
                <TypographyParagraph color="muted" size="sm">
                  {description}
                </TypographyParagraph>
              </div>
            </header>
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
export function PasswordField({
  label,
  description,
  ...props
}: ComponentProps<typeof PasswordInput> & {
  label: string;
  description?: ReactNode;
}) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <Field>
      <FieldLabel htmlFor={id} isRequired={props.required}>
        {label}
      </FieldLabel>
      <PasswordInput
        {...props}
        id={id}
        aria-label={label}
        variant="secondary"
        aria-describedby={description ? `${id}-description` : undefined}
      />
      {description && (
        <FieldDescription id={`${id}-description`}>
          {description}
        </FieldDescription>
      )}
    </Field>
  );
}
export function passkeySupported() {
  return (
    window.isSecureContext && typeof window.PublicKeyCredential !== "undefined"
  );
}
export async function verifyPasskey<T>(
  challengeId?: string,
  signal?: AbortSignal,
): Promise<T> {
  if (!passkeySupported())
    throw new Error(
      "Passkeys require a supported browser on HTTPS or localhost. Open Mill on a device where your passkey is available.",
    );
  const result = await api<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/auth/passkeys/authenticate/options", { challengeId });
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
export function ChallengeFields({
  challenge,
  method,
  onMethod,
  code,
  onCode,
  busy,
  passkeyBusy,
  onPasskey,
  methodLabel = "Other verification method",
  codeLabel = "Six-digit code",
}: {
  challenge: IdentityChallenge;
  method: string;
  onMethod: (method: string) => void;
  code: string;
  onCode: (code: string) => void;
  busy: boolean;
  passkeyBusy: boolean;
  onPasskey: () => void;
  methodLabel?: string;
  codeLabel?: string;
}) {
  const alternatives = challenge.methods.filter(
    (m) => m === "totp" || m === "recovery",
  );
  return (
    <div className="content-grid">
      {challenge.methods.includes("passkey") && (
        <div className="grid gap-2">
          <Button
            className="w-full"
            variant="secondary"
            isDisabled={busy || !passkeySupported()}
            onPress={onPasskey}
          >
            {passkeyBusy ? "Waiting for your passkey…" : "Try passkey again"}
          </Button>
          {passkeyBusy && (
            <Button
              variant="secondary"
              onPress={() => WebAuthnAbortService.cancelCeremony()}
            >
              Cancel passkey request
            </Button>
          )}
          <TypographyParagraph size="sm" color="muted">
            {passkeySupported()
              ? "Use the device or password manager where you saved your passkey."
              : "Passkeys require a supported browser on HTTPS or localhost. Open Mill on a device where your passkey is available."}
          </TypographyParagraph>
          {alternatives.length === 0 && (
            <TypographyParagraph size="sm" color="muted">
              If your passkey is unavailable, contact the person who runs your
              Mill installation for help recovering access.
            </TypographyParagraph>
          )}
        </div>
      )}
      {alternatives.length > 0 && (
        <>
          <Choice
            label={methodLabel}
            value={method}
            onChange={onMethod}
            disabled={busy}
            items={alternatives.map((id) => ({
              id,
              name: id === "totp" ? "Authenticator code" : "Recovery code",
            }))}
          />
          <TextField
            label={method === "totp" ? codeLabel : "Recovery code"}
            value={code}
            onChange={(e) => onCode(e.target.value)}
            required
            disabled={busy}
            autoComplete="one-time-code"
            inputMode={method === "totp" ? "numeric" : "text"}
            maxLength={method === "totp" ? 6 : 30}
            pattern={method === "totp" ? "[0-9]{6}" : undefined}
          />
        </>
      )}
    </div>
  );
}
