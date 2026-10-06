import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { config } from "./config.js";
import type { Actor } from "../../../packages/contracts/src/index.js";
export type Env = {
  Bindings: { incoming?: IncomingMessage; outgoing?: ServerResponse };
  Variables: { actor: Actor };
};
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
    a.kind === "oauth" &&
    (min === "admin" ||
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
  const peer =
    c.env?.incoming?.socket?.remoteAddress?.replace(/^::ffff:/, "") ??
    "in-process";
  const trusted = config()
    .MILL_TRUSTED_PROXY_IPS.split(",")
    .map((ip) => ip.trim());
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return trusted.includes(peer) && forwarded && isIP(forwarded)
    ? forwarded
    : peer;
}
