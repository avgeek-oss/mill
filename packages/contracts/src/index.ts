export type Role = "admin" | "member" | "viewer";
export type Actor = {
  userId: string;
  name: string;
  role: Role;
  kind: "human" | "oauth" | "team";
  scopes: string[];
  includeAdmin?: boolean;
  credentialId?: string;
  credentialType?: "api-key" | "oauth";
  boardIds?: string[];
};
export type Board = {
  id: string;
  name: string;
  prefix: string;
  description: string;
  version: number;
};
export type BoardSummary = Board & {
  backlogCount: number;
  activeCount: number;
  inProgressCount: number;
  todoCount: number;
};
export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "wont_do",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_TYPES = ["task", "bug"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type Task = {
  id: string;
  boardId: string;
  type: TaskType;
  status: TaskStatus;
  statusChangedAt: string;
  identifier: string;
  title: string;
  description: string;
  assigneeId: string | null;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  startDate: string | null;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  timeZone: string;
  passkeyEnabled: boolean;
};
export type Activity = {
  id: string;
  taskId: string;
  boardId: string;
  actorId: string;
  actorName: string;
  actorKind: "human" | "oauth" | "team";
  action: string;
  detail: unknown;
  createdAt: string;
};
export type Comment = {
  id: string;
  taskId: string;
  authorId: string | null;
  authorKind: "human" | "oauth" | "team";
  authorName: string;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Notification = {
  id: string;
  userId: string;
  taskId: string;
  boardId: string;
  kind: "assignment" | "mention";
  actorName: string;
  identifier: string;
  title: string;
  readAt: string | null;
  createdAt: string;
};
export type NotificationPage = {
  items: Notification[];
  unreadCount: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type AuthStatus = {
  setupRequired: boolean;
  emailDeliveryConfigured: boolean;
};
export type UserEmailState = {
  email: string;
  emailVerified: boolean;
};
export type PendingEmailChange = {
  email: string;
  expiresAt: string;
};
export type EmailRequestReceipt = { status: true };
export type EmailResendReceipt = EmailRequestReceipt & {
  resendAvailableAt: number;
};
export type InvitationCodeReceipt = EmailResendReceipt & {
  expiresAt: string;
};
export type InvitationVerificationProof = { verificationToken: string };

export const ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export type Attachment = {
  id: string;
  taskId: string;
  fileName: string;
  contentType: AttachmentContentType;
  sizeBytes: number;
  createdBy: string | null;
  createdAt: string;
};
export type AttachmentConfiguration = {
  enabled: boolean;
  maxBytes: number;
  contentTypes: readonly AttachmentContentType[];
};
export type AttachmentPage = {
  items: Attachment[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type AttachmentUpload = {
  attachmentId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};
export type AttachmentDownload = { url: string; expiresAt: string };
