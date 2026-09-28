import type { Activity } from "../../../packages/contracts/src/index.js";

const labels: Record<string, string> = {
  "workspace.setup": "Set up the workspace",
  "workspace.updated": "Updated the workspace",
  "workspace.exported": "Exported workspace data",
  "workspace.imported": "Imported workspace data",
  "board.created": "Created a board",
  "board.updated": "Updated a board",
  "board.deleted": "Deleted a board",
  "board.restored": "Restored a board",
  "column.created": "Added a status",
  "column.updated": "Updated a status",
  "column.deleted": "Deleted a status",
  "task.created": "Created a task",
  "task.updated": "Updated a task",
  "task.moved": "Moved a task",
  "task.deleted": "Deleted a task",
  "task.restored": "Restored a task",
  "comment.created": "Added a comment",
  "comment.updated": "Edited a comment",
  "comment.deleted": "Deleted a comment",
  "account.sign-in": "Signed in",
  "account.password-changed": "Changed their password",
  "account.passkey-added": "Added a passkey",
  "account.passkey-removed": "Removed a passkey",
  "account.authenticator-enabled": "Enabled authenticator verification",
  "account.authenticator-disabled": "Disabled authenticator verification",
  "account.recovery-codes-replaced": "Replaced their recovery codes",
  "account.operator-recovery-issued": "Issued an account recovery link",
  "account.operator-recovered": "Recovered an account",
  "session.revoked": "Revoked a session",
  "member.invited": "Invited a person",
  "member.invitation-revoked": "Revoked an invitation",
  "member.joined": "Joined the workspace",
  "member.role-changed": "Changed a person's role",
  "member.removed": "Removed a person",
  "credential.created": "Created an agent credential",
  "credential.revoked": "Revoked an agent credential",
  "oauth.consented": "Approved agent access",
  "oauth.denied": "Denied agent access",
  "oauth.token-issued": "Granted agent access",
  "oauth.revoked": "Revoked agent access",
  "oauth.code-replay-revoked":
    "Revoked agent access after authorization was reused",
};

function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (
    !text ||
    text.length > 300 ||
    /\p{Cc}/u.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      text,
    ) ||
    /\bmill_[a-zA-Z0-9_-]{20,}\b|\bBearer\s|[?&](?:token|secret|code|challenge)=/i.test(
      text,
    )
  )
    return undefined;
  return text;
}
function details(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function taskTarget(detail: Record<string, unknown>) {
  const identifier =
    typeof detail.identifier === "string" &&
    /^[A-Z][A-Z0-9]{1,11}-[1-9][0-9]*$/.test(detail.identifier) &&
    detail.identifier.length <= 64
      ? detail.identifier
      : undefined;
  const title = displayText(detail.title);
  if (identifier) return `task ${identifier}${title ? ` · ${title}` : ""}`;
  if (title) return `task “${title}”`;
  return "a task";
}

export function auditActionLabel(event: Pick<Activity, "action" | "detail">) {
  const base = Object.hasOwn(labels, event.action)
    ? labels[event.action]
    : undefined;
  if (!base) return "Recorded workspace activity";
  const detail = details(event.detail);
  if (event.action.startsWith("task.")) {
    const verb = base.split(" ")[0];
    const destination =
      event.action === "task.moved" ? displayText(detail.status) : undefined;
    return `${verb} ${taskTarget(detail)}${destination ? ` to “${destination}”` : ""}`;
  }
  if (
    event.action.startsWith("board.") ||
    event.action.startsWith("column.") ||
    event.action.startsWith("credential.")
  ) {
    const name = displayText(detail.name);
    return name
      ? `${base.replace(" a ", " ").replace(" an ", " ")} “${name}”`
      : base;
  }
  if (event.action === "workspace.updated") {
    const name = displayText(detail.name);
    return name ? `Updated workspace “${name}”` : base;
  }
  if (event.action === "workspace.imported") {
    const name = displayText(detail.sourceWorkspace);
    return name ? `Imported workspace data from “${name}”` : base;
  }
  if (
    event.action === "member.invited" ||
    event.action === "member.invitation-revoked"
  ) {
    const email = displayText(detail.email);
    if (
      email &&
      email.length <= 254 &&
      /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    )
      return event.action === "member.invited"
        ? `Invited ${email}`
        : `Revoked the invitation for ${email}`;
  }
  if (event.action === "member.role-changed") {
    const role =
      detail.role === "admin"
        ? "Admin"
        : detail.role === "member"
          ? "Member"
          : detail.role === "viewer"
            ? "Viewer"
            : undefined;
    return role ? `${base} to ${role}` : base;
  }
  return base;
}
