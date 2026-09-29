export type Role = "admin" | "member" | "viewer";
export type Actor = {
  userId: string;
  name: string;
  role: Role;
  kind: "human" | "agent";
  scopes: string[];
  credentialId?: string;
  agentId?: string;
  boardIds?: string[];
};
export type Agent = {
  id: string;
  name: string;
  scope: "personal" | "team";
  creatorId: string;
  memberIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type Board = {
  id: string;
  name: string;
  prefix: string;
  description: string;
  version: number;
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
export type ChecklistItem = { id: string; text: string; done: boolean };
export type Task = {
  id: string;
  boardId: string;
  status: TaskStatus;
  identifier: string;
  title: string;
  description: string;
  assigneeId: string | null;
  agentId: string | null;
  agentName: string | null;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  dueDate: string | null;
  checklist: ChecklistItem[];
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
};
export type Activity = {
  id: string;
  taskId: string;
  boardId: string;
  actorId: string;
  actorName: string;
  actorKind: "human" | "agent";
  action: string;
  detail: unknown;
  createdAt: string;
};
export type Comment = {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
