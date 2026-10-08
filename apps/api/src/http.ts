import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ZodError } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Actor } from "../../../packages/contracts/src/index.js";
export type Env = {
  Bindings: { incoming?: IncomingMessage; outgoing?: ServerResponse };
  Variables: { actor: Actor; requestId: string };
};
export const requestContext = new AsyncLocalStorage<string>();
export class HttpError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly responseHeaders: Record<string, string> = {},
  ) {
    super(status, { message });
  }
}
export function requestId(value?: string) {
  return value && value.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : randomUUID();
}
export function statusErrorCode(status: number) {
  return (
    (
      {
        400: "BAD_REQUEST",
        401: "UNAUTHORIZED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        409: "CONFLICT",
        410: "GONE",
        413: "PAYLOAD_TOO_LARGE",
        422: "UNPROCESSABLE",
        429: "RATE_LIMITED",
        503: "SERVICE_UNAVAILABLE",
      } as Record<number, string>
    )[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED")
  );
}
export function errorResponse(
  c: Context<Env>,
  status: ContentfulStatusCode,
  message: string,
  code = statusErrorCode(status),
) {
  const id = c.get("requestId") ?? requestId();
  c.header("X-Request-Id", id);
  c.header("Cache-Control", "no-store");
  return c.json({ error: { code, message, requestId: id } }, status);
}
export function handleError(error: Error, c: Context<Env>) {
  if (error instanceof HttpError) {
    for (const [name, value] of Object.entries(error.responseHeaders))
      c.header(name, value);
    return errorResponse(c, error.status, error.message, error.code);
  }
  if (error instanceof HTTPException)
    return errorResponse(c, error.status, error.message);
  if (error instanceof ZodError)
    return errorResponse(
      c,
      400,
      error.issues[0]?.message ?? "Request is invalid",
      "INVALID_REQUEST",
    );
  if (error instanceof SyntaxError)
    return errorResponse(
      c,
      400,
      "Request must contain valid JSON",
      "MALFORMED_JSON",
    );
  console.error("Request failed", c.get("requestId"), error.name);
  return errorResponse(
    c,
    500,
    "Mill could not complete this request. Try again.",
  );
}
export function actor(c: Context<Env>): Actor {
  const value = c.get("actor");
  if (!value) throw new HTTPException(401, { message: "Sign in to continue" });
  return value;
}
export function requireRole(
  c: Context<Env>,
  min: "viewer" | "member" | "admin" = "viewer",
  boardId?: string,
): Actor {
  const a = actor(c);
  const ranks = { viewer: 0, member: 1, admin: 2 };
  if (ranks[a.role] < ranks[min])
    throw new HTTPException(403, {
      message: "You do not have permission for this action",
    });
  if (
    a.credentialId &&
    ((min === "admin" && !a.includeAdmin) ||
      !a.scopes.includes(min === "viewer" ? "read" : "write") ||
      (boardId && a.boardIds && !a.boardIds.includes(boardId)))
  )
    throw new HTTPException(403, {
      message: "This credential does not permit this action",
    });
  return a;
}
export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}
export function conflict(
  message = "This item changed. Reload it before saving.",
): never {
  throw new HTTPException(409, { message });
}

export function requireHuman(c: Context<Env>): Actor {
  const a = actor(c);
  if (a.kind !== "human" || a.credentialId)
    throw new HTTPException(403, {
      message: "Sign in with a personal account for this action",
    });
  return a;
}

export function clientAddress(c: Context<Env>): string {
  return (
    c.env?.incoming?.socket?.remoteAddress?.replace(/^::ffff:/, "") ??
    "in-process"
  );
}
