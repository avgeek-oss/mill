export type Role = "admin" | "member" | "viewer";
export type Actor = {
  userId: string;
  name: string;
  role: Role;
  kind: "human" | "agent";
  scopes: string[];
  credentialId?: string;
  boardIds?: string[];
};
export type Board = {
  id: string;
  name: string;
  prefix: string;
  description: string;
  position: number;
  version: number;
  archived: boolean;
  deletedAt: string | null;
};
export type Column = {
  id: string;
  boardId: string;
  name: string;
  color: string;
  position: number;
  version: number;
};
export type ChecklistItem = { id: string; text: string; done: boolean };
export type Task = {
  id: string;
  boardId: string;
  columnId: string;
  identifier: string;
  title: string;
  description: string;
  assigneeId: string | null;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  labels: string[];
  dueDate: string | null;
  checklist: ChecklistItem[];
  parentId: string | null;
  position: number;
  version: number;
  archived: boolean;
  deletedAt: string | null;
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
  taskId: string | null;
  boardId: string | null;
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
