export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
    public requestId?: string,
  ) {
    super(message);
  }
}
export type ApiOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  validateResponse?: (data: unknown) => boolean;
  onReauthenticationRequired?: () => Promise<boolean>;
};

export function responseError(
  status: number,
  data: unknown,
  requestId?: string,
) {
  const result = isResponseObject(data) ? data : {};
  const error = isResponseObject(result.error) ? result.error : {};
  return new ApiError(
    status,
    typeof error.message === "string"
      ? error.message
      : typeof result.error_description === "string"
        ? result.error_description
        : typeof result.error === "string"
          ? result.error
          : "Unable to complete this request.",
    typeof error.code === "string"
      ? error.code
      : typeof result.code === "string"
        ? result.code
        : typeof result.error_description === "string" &&
            typeof result.error === "string"
          ? result.error
          : "REQUEST_FAILED",
    typeof error.requestId === "string" ? error.requestId : requestId,
  );
}

export function isResponseObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasResponseRecord(value: unknown, key: string) {
  return (
    isResponseObject(value) &&
    isResponseObject(value[key]) &&
    typeof value[key].id === "string" &&
    value[key].id.length > 0
  );
}

export function hasStatusAcknowledgement(value: unknown) {
  return (
    isResponseObject(value) && value.status === true && !("error" in value)
  );
}
export function hasOkAcknowledgement(value: unknown) {
  return isResponseObject(value) && value.ok === true && !("error" in value);
}
export function hasSessionResponse(value: unknown): value is Session {
  if (
    !isResponseObject(value) ||
    !isResponseObject(value.user) ||
    !isResponseObject(value.workspace)
  )
    return false;
  const { user, workspace } = value;
  return (
    typeof user.id === "string" &&
    !!user.id &&
    typeof user.name === "string" &&
    typeof user.email === "string" &&
    !!user.email &&
    typeof user.emailVerified === "boolean" &&
    ["admin", "member", "viewer"].includes(String(user.role)) &&
    typeof user.timeZone === "string" &&
    !!user.timeZone &&
    [
      "day-short-month-year",
      "short-month-day-year",
      "day-month-year",
      "month-day-year",
      "year-month-day",
    ].includes(String(user.dateFormat)) &&
    ["24-hour", "12-hour", "24-hour-seconds", "12-hour-seconds"].includes(
      String(user.timeFormat),
    ) &&
    Number.isSafeInteger(user.passkeyCount) &&
    Number(user.passkeyCount) >= 0 &&
    isResponseObject(user.notificationPreferences) &&
    typeof workspace.id === "string" &&
    !!workspace.id &&
    typeof workspace.name === "string"
  );
}
export function hasIdentityChallengeResponse(value: unknown) {
  return (
    isResponseObject(value) &&
    value.requiresSecondFactor === true &&
    typeof value.challengeId === "string" &&
    !!value.challengeId &&
    Array.isArray(value.methods) &&
    value.methods.length === 1 &&
    value.methods[0] === "passkey" &&
    value.preferredMethod === "passkey" &&
    typeof value.recoveryAvailable === "boolean"
  );
}

export function createRetryKey() {
  const unresolved = new Map<string, string>();
  return {
    forRequest(path: string, body: unknown, method = "POST") {
      const payload = JSON.stringify({ path, method, body });
      let key = unresolved.get(payload);
      if (!key) {
        key = crypto.randomUUID();
        unresolved.set(payload, key);
      }
      return key;
    },
    reset() {
      unresolved.clear();
    },
  };
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  options: ApiOptions = {},
): Promise<T> {
  return request<T>(path, body, method, options, false);
}
async function request<T>(
  path: string,
  body: unknown,
  method: string,
  options: ApiOptions,
  retried: boolean,
): Promise<T> {
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
      method,
      credentials: "same-origin",
      signal: options.signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new ApiError(
      0,
      "Mill could not be reached. Check your connection and try again.",
    );
  }
  options.signal?.throwIfAborted();
  if (response.ok && [204, 205].includes(response.status)) {
    if (options.validateResponse && !options.validateResponse(undefined))
      throw new ApiError(
        response.status,
        "The server response was incomplete. Try again.",
      );
    return undefined as T;
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (response.ok)
      throw new ApiError(
        response.status,
        "The server response could not be read. Try again.",
      );
    data = { error: "The server returned an unexpected response." };
  }
  options.signal?.throwIfAborted();
  if (response.ok && (data === null || typeof data !== "object"))
    throw new ApiError(
      response.status,
      "The server response could not be read. Try again.",
    );
  if (!response.ok) {
    const failure = responseError(
      response.status,
      data,
      response.headers.get("X-Request-Id") ?? undefined,
    );
    if (
      response.status === 403 &&
      failure.code === "REAUTHENTICATION_REQUIRED" &&
      !retried &&
      options.onReauthenticationRequired &&
      (await options.onReauthenticationRequired())
    )
      return request<T>(path, body, method, options, true);
    if (
      response.status === 401 &&
      path !== "/auth/me" &&
      ![
        "/auth/login",
        "/auth/passkeys/recovery/verify",
        "/auth/passkeys/authenticate/options",
        "/auth/passkeys/authenticate/verify",
        "/auth/recovery/reset",
        "/auth/accept-invitation",
        "/auth/password-reset/request",
        "/auth/verification-email",
        "/auth/email-verification/confirm",
        "/auth/email-change/confirm",
        "/auth/invitation/verification/request",
        "/auth/invitation/verification/confirm",
      ].includes(path)
    ) {
      const active = await fetch("/api/auth/me", {
        credentials: "same-origin",
        signal: options.signal,
      }).catch(() => null);
      options.signal?.throwIfAborted();
      if (active?.status === 401)
        window.dispatchEvent(new Event("mill:expired"));
    }
    throw failure;
  }
  if (options.validateResponse && !options.validateResponse(data))
    throw new ApiError(
      response.status,
      "The server response was incomplete. Try again.",
    );
  return data as T;
}
export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to complete this request.";
}
export type NavigationRequest = {
  path: string;
  resume: () => void;
  waitUntil: (save: Promise<boolean>) => void;
};
export function navigationIndex() {
  const value = window.history.state?.millNavigationIndex;
  return Number.isSafeInteger(value) ? (value as number) : null;
}
export function initializeNavigation() {
  if (navigationIndex() === null)
    window.history.replaceState(
      { ...window.history.state, millNavigationIndex: 0 },
      "",
    );
}
let navigationAttempt = 0;
export function requestNavigation(path: string, resume: () => void) {
  const attempt = ++navigationAttempt;
  const saves: Promise<boolean>[] = [];
  const event = new CustomEvent("mill:before-navigate", {
    cancelable: true,
    detail: {
      path,
      resume,
      waitUntil: (save) => saves.push(save),
    } satisfies NavigationRequest,
  });
  const allowed = window.dispatchEvent(event);
  if (!allowed && saves.length)
    void Promise.all(saves).then((results) => {
      if (attempt === navigationAttempt && results.every(Boolean)) resume();
    });
  return allowed;
}
export function navigate(path: string) {
  initializeNavigation();
  const commit = () => {
    window.history.pushState(
      { millNavigationIndex: (navigationIndex() ?? 0) + 1 },
      "",
      path,
    );
    window.dispatchEvent(new Event("mill:navigate"));
  };
  if (requestNavigation(path, commit)) commit();
}
export type User = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: "admin" | "member" | "viewer";
  timeZone: string;
  dateFormat:
    | "day-short-month-year"
    | "short-month-day-year"
    | "day-month-year"
    | "month-day-year"
    | "year-month-day";
  timeFormat: "24-hour" | "12-hour" | "24-hour-seconds" | "12-hour-seconds";
  notificationPreferences: {
    assignments?: boolean;
    mentions?: boolean;
  };
  passkeyCount: number;
};
export type Workspace = { id: string; name: string };
export type Session = { user: User; workspace: Workspace };
