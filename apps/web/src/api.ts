export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      "Mill could not be reached. Check your connection and try again.",
    );
  }
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an unexpected response." }));
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
      data.error ?? "Unable to complete this request.",
    );
  }
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
    email?: boolean;
  };
  totpEnabled: boolean;
  passkeyCount: number;
};
export type Workspace = { id: string; name: string };
export type Session = { user: User; workspace: Workspace };
