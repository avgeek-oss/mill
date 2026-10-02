export type BoardUrlState = {
  q: string;
  assigneeId: string;
  agentId: string;
  priority: string;
  status: string;
  sort: string;
  page: number;
  limit: number;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const priorities = new Set(["urgent", "high", "medium", "low", "none"]);
const statuses = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "wont_do",
]);
const sorts = new Set([
  "createdAt",
  "title",
  "updatedAt",
  "dueDate",
  "priority",
  "status",
]);
const pageSizes = new Set([10, 25, 50, 100]);

export function parseBoardUrl(path: string): BoardUrlState {
  const queryStart = path.indexOf("?");
  const params = new URLSearchParams(
    queryStart < 0 ? "" : path.slice(queryStart + 1),
  );
  function identity(key: string) {
    const value = params.get(key) ?? "";
    return value === "unassigned" || uuid.test(value)
      ? value.toLowerCase()
      : "";
  }
  const pageRaw = params.get("page") ?? "1";
  const page = Number(pageRaw);
  const limitRaw = params.get("limit") ?? "25";
  const limit = Number(limitRaw);
  const priority = params.get("priority") ?? "";
  const status = params.get("status") ?? "";
  const sort = params.get("sort") ?? "createdAt";
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    assigneeId: identity("assigneeId"),
    agentId: identity("agentId"),
    priority: priorities.has(priority) ? priority : "",
    status: statuses.has(status) ? status : "",
    sort: sorts.has(sort) ? sort : "createdAt",
    page:
      /^\d+$/.test(pageRaw) && Number.isSafeInteger(page) && page > 0
        ? page
        : 1,
    limit: /^\d+$/.test(limitRaw) && pageSizes.has(limit) ? limit : 25,
  };
}

export function boardUrl(boardId: string, state: BoardUrlState, search = "") {
  const params = new URLSearchParams(search);
  for (const key of [
    "q",
    "assigneeId",
    "agentId",
    "priority",
    "status",
  ] as const) {
    params.delete(key);
    if (state[key]) params.set(key, state[key]);
  }
  params.delete("sort");
  params.delete("page");
  params.delete("limit");
  if (state.sort !== "createdAt") params.set("sort", state.sort);
  if (state.page !== 1) params.set("page", String(state.page));
  if (state.limit !== 25) params.set("limit", String(state.limit));
  const query = params.toString();
  return `/boards/${boardId}${query ? `?${query}` : ""}`;
}
