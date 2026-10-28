import type { Role } from "../../../../packages/contracts/src/index.js";

export const supportedScopes = ["read", "write", "admin"] as const;
export type Scope = (typeof supportedScopes)[number];

const accessByRole = {
  viewer: ["read"],
  member: ["read", "write"],
  admin: supportedScopes,
} as const satisfies Record<Role, readonly Scope[]>;

export const allowedAccess = (role: Role): readonly Scope[] =>
  accessByRole[role];

export const scopeForAccess = (level: Scope) =>
  supportedScopes.slice(0, supportedScopes.indexOf(level) + 1).join(" ");

type ApiKeyAccess = "read" | "edit";

export const apiKeyScopes = (access: ApiKeyAccess): Scope[] =>
  access === "edit" ? ["read", "write"] : ["read"];

export const apiKeyRole = (
  access: ApiKeyAccess,
  includeAdmin: boolean,
): Role => (includeAdmin ? "admin" : access === "edit" ? "member" : "viewer");
