import type { Role } from "../../../../packages/contracts/src/index.js";

export const supportedScopes = ["viewer", "member", "admin"] as const;
export type Scope = (typeof supportedScopes)[number];
export const consentAccessLevels = ["read", "write", "admin"] as const;
export type ConsentAccess = (typeof consentAccessLevels)[number];

const accessByRole = {
  viewer: ["read"],
  member: ["read", "write"],
  admin: consentAccessLevels,
} as const satisfies Record<Role, readonly ConsentAccess[]>;

export const allowedAccess = (role: Role): readonly ConsentAccess[] =>
  accessByRole[role];

const scopeByAccess: Record<ConsentAccess, Scope> = {
  read: "viewer",
  write: "member",
  admin: "admin",
};

export const scopeForAccess = (level: ConsentAccess) =>
  supportedScopes
    .slice(0, supportedScopes.indexOf(scopeByAccess[level]) + 1)
    .join(" ");

export const isCanonicalScope = (value: string) =>
  consentAccessLevels.some((level) => scopeForAccess(level) === value);

type ApiKeyAccess = "read" | "edit";

export const apiKeyScopes = (access: ApiKeyAccess): Scope[] =>
  access === "edit" ? ["viewer", "member"] : ["viewer"];

export const apiKeyRole = (
  access: ApiKeyAccess,
  includeAdmin: boolean,
): Role => (includeAdmin ? "admin" : access === "edit" ? "member" : "viewer");

export const credentialRole = (
  liveRole: Role,
  access: ApiKeyAccess,
  includeAdmin: boolean,
): Role => {
  const ceiling = apiKeyRole(access, includeAdmin);
  const rank = { viewer: 0, member: 1, admin: 2 };
  return rank[liveRole] <= rank[ceiling] ? liveRole : ceiling;
};
