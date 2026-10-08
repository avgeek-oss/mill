import type { TaskStatus } from "../../../packages/contracts/src/index.js";
const labels: Record<string, string> = {
  "task.created": "created this task",
  "task.updated": "updated this task",
  "task.moved": "changed the task status",
  "task.deleted": "deleted this task",
  "comment.created": "added a comment",
  "comment.updated": "edited a comment",
  "comment.deleted": "deleted a comment",
};

export function activityLabel(action: string) {
  return labels[action] ?? "made a change";
}

const statusLabels: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  wont_do: "Won't Do",
};

export function taskStatusLabel(status: TaskStatus) {
  return statusLabels[status];
}
