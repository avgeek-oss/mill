import type { Board } from "../../../packages/contracts/src/index.js";
import { api } from "./api.js";
import { usePageRead } from "./page-navigation.js";
import { hasBoardResponse } from "./responses.js";
import { readTaskPreview } from "./use-task-editor.js";

export function useTaskPagePreparation(
  boardId: string,
  taskId: string,
  sessionRevision: number,
) {
  const prepared = usePageRead(
    `task-page:${boardId}:${taskId}:${sessionRevision}`,
    (signal) =>
      Promise.allSettled([
        api<{ board: Board }>(`/boards/${boardId}`, undefined, "GET", {
          signal,
          validateResponse: hasBoardResponse,
        }),
        readTaskPreview(taskId, signal),
      ]),
  );
  return {
    board: prepared?.status === "fulfilled" ? prepared.value[0] : prepared,
    task: prepared?.status === "fulfilled" ? prepared.value[1] : prepared,
  };
}
