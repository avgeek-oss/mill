const labels: Record<string, string> = {
  "task.created": "created this task",
  "task.updated": "updated this task",
  "task.moved": "moved this task",
  "task.deleted": "deleted this task",
  "task.restored": "restored this task",
  "comment.created": "added a comment",
  "comment.updated": "edited a comment",
  "comment.deleted": "deleted a comment",
  "board.created": "created this board",
  "board.updated": "updated this board",
  "board.deleted": "deleted this board",
  "board.restored": "restored this board",
  "column.created": "added a status",
  "column.updated": "updated a status",
  "column.deleted": "deleted a status",
};

export function activityLabel(action: string) {
  return labels[action] ?? "made a change";
}
