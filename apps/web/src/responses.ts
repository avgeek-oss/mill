import { hasResponseRecord, isResponseObject } from "./api.js";

function record(value: unknown, key: string) {
  return hasResponseRecord(value, key) &&
    isResponseObject(value) &&
    isResponseObject(value[key])
    ? value[key]
    : null;
}
function version(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
export function hasOkResponse(value: unknown) {
  return isResponseObject(value) && value.ok === true;
}
export function hasBoardResponse(value: unknown) {
  const board = record(value, "board");
  return (
    !!board &&
    typeof board.name === "string" &&
    board.name.length > 0 &&
    typeof board.prefix === "string" &&
    typeof board.description === "string" &&
    typeof board.position === "number" &&
    Number.isFinite(board.position) &&
    version(board.version)
  );
}
export function hasBoardsResponse(value: unknown) {
  return (
    isResponseObject(value) &&
    Array.isArray(value.items) &&
    value.items.every((board) => hasBoardResponse({ board })) &&
    typeof value.hasMore === "boolean" &&
    (value.hasMore
      ? typeof value.nextCursor === "string" && value.nextCursor.length > 0
      : value.nextCursor === null)
  );
}
export function hasTaskResponse(value: unknown) {
  const task = record(value, "task");
  return (
    !!task &&
    ["title", "identifier", "boardId", "columnId"].every(
      (key) => typeof task[key] === "string" && task[key].length > 0,
    ) &&
    version(task.version)
  );
}
export function hasCommentResponse(value: unknown) {
  const comment = record(value, "comment");
  return (
    !!comment &&
    ["body", "authorId", "createdAt", "updatedAt"].every(
      (key) => typeof comment[key] === "string",
    ) &&
    (comment.authorName === undefined ||
      typeof comment.authorName === "string") &&
    version(comment.version)
  );
}
