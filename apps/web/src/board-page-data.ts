import type { Board } from "../../../packages/contracts/src/index.js";
import { api } from "./api.js";
import { hasBoardResponse } from "./responses.js";
import type { BoardUrlState } from "./board-url.js";
import type { TaskListPage } from "./navigation-cache.js";

export function boardTaskQuery(state: BoardUrlState) {
  const params = new URLSearchParams({
    limit: String(state.limit),
    sort: state.sort,
    page: String(state.page),
  });
  if (state.q) params.set("q", state.q);
  for (const key of ["assigneeId", "priority", "status"] as const)
    if (state[key]) params.set(key, state[key]);
  return params;
}
export async function readBoardPage(
  boardId: string,
  state: BoardUrlState,
  signal: AbortSignal,
) {
  const [info, tasks] = await Promise.all([
    api<{ board: Board }>(`/boards/${boardId}`, undefined, "GET", {
      signal,
      validateResponse: hasBoardResponse,
    }),
    api<TaskListPage>(
      `/boards/${boardId}/tasks?${boardTaskQuery(state)}`,
      undefined,
      "GET",
      { signal },
    ),
  ]);
  return { board: info.board, tasks };
}
