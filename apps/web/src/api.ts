export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type ApiOptions = {
  headers?: Record<string, string>;
  validateResponse?: (data: unknown) => boolean;
};

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
  let response: Response;
  try {
    response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      "Mill could not be reached. Check your connection and try again.",
    );
  }
  if (response.ok && [204, 205].includes(response.status)) {
    if (options.validateResponse && !options.validateResponse(undefined))
      throw new ApiError(
        response.status,
        "The server response was incomplete. Try again.",
      );
    return undefined as T;
  }
  let data: { error?: string };
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
  if (response.ok && (data === null || typeof data !== "object"))
    throw new ApiError(
      response.status,
      "The server response could not be read. Try again.",
    );
  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== "/auth/me" &&
      ![
        "/auth/login",
        "/auth/second-factor",
        "/auth/passkeys/authenticate/options",
        "/auth/passkeys/authenticate/verify",
        "/auth/recovery/reset",
        "/auth/accept-invitation",
      ].includes(path)
    ) {
      const active = await fetch("/api/auth/me", {
        credentials: "same-origin",
      }).catch(() => null);
      if (active?.status === 401)
        window.dispatchEvent(new Event("mill:expired"));
    }
    throw new ApiError(
      response.status,
      data?.error ?? "Unable to complete this request.",
    );
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
export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("mill:navigate"));
}
export type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
  timeZone: string;
  notificationPreferences: {
    assignments?: boolean;
    mentions?: boolean;
  };
  totpEnabled: boolean;
  passkeyCount: number;
};
export type Workspace = { id: string; name: string };
export type Session = { user: User; workspace: Workspace };
