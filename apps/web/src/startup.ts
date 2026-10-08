import {
  api,
  ApiError,
  hasSessionResponse,
  isResponseObject,
  type Session,
} from "./api.js";

export function isBackendUnavailable(error: unknown) {
  return (
    (error instanceof ApiError && [0, 502, 503, 504].includes(error.status)) ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

export async function readStartup(signal: AbortSignal) {
  const status = await api<{
    setupRequired: boolean;
    emailDeliveryConfigured: boolean;
  }>("/auth/status", undefined, "GET", {
    signal,
    validateResponse: (value) =>
      isResponseObject(value) &&
      typeof value.setupRequired === "boolean" &&
      typeof value.emailDeliveryConfigured === "boolean",
  });
  let session: Session | null = null;
  if (!status.setupRequired) {
    try {
      session = await api<Session>("/auth/me", undefined, "GET", {
        signal,
        validateResponse: hasSessionResponse,
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
  }
  return { status, session };
}
