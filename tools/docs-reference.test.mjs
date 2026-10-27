import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const root = new URL("../", import.meta.url);
const read = async (path) => readFile(new URL(path, root), "utf8");
const openapi = JSON.parse(await read("docs/api-reference/openapi.json"));
const tools = JSON.parse(await read("docs/mcp-reference/tools.json"));
const navigation = JSON.parse(await read("docs/reference-navigation.json"));

test("REST distinguishes retry headers and preview defaults from MCP arguments", () => {
  for (const operations of Object.values(openapi.paths))
    for (const operation of Object.values(operations)) {
      const properties =
        operation.requestBody?.content?.["application/json"]?.schema
          ?.properties;
      assert.equal(
        properties?.idempotencyKey,
        undefined,
        operation.operationId,
      );
    }
  const detail = openapi.paths["/api/tasks/{taskId}"].get;
  for (const name of ["commentLimit", "activityLimit"])
    assert.equal(
      detail.parameters.find((item) => item.name === name).schema.default,
      100,
    );
  const getTask = tools.find((tool) => tool.name === "get_task");
  assert.equal(getTask.input.properties.commentLimit.default, 0);
  assert.equal(getTask.input.properties.activityLimit.default, 0);
  const create = openapi.paths["/api/boards/{boardId}/tasks"].post;
  assert(
    create.parameters.some(
      (item) => item.name === "Idempotency-Key" && item.in === "header",
    ),
  );
});

test("reference schemas include acceptance criteria, bulk clearing and nested replies", () => {
  const body = (path, method) =>
    openapi.paths[path][method].requestBody.content["application/json"].schema;
  for (const [path, method] of [
    ["/api/boards/{boardId}/tasks", "post"],
    ["/api/tasks/{taskId}", "patch"],
  ])
    assert.equal(
      body(path, method).properties.acceptanceCriteria.maxLength,
      100000,
    );
  const bulk = body("/api/boards/{boardId}/tasks/bulk", "patch");
  assert.equal(bulk.properties.tasks.maxItems, 100);
  assert.deepEqual(bulk.properties.tasks.items.required, ["id", "version"]);
  for (const key of ["assigneeId", "startDate", "dueDate"])
    assert(
      bulk.properties.changes.properties[key].anyOf.some(
        (schema) => schema.type === "null",
      ),
      key,
    );
  assert(body("/api/tasks/{taskId}/comments", "post").properties.parentId);
  assert(body("/api/boards/{boardId}", "patch").properties.prefix.pattern);
});

test("every HTTP operation and MCP tool has a reachable individual page and example", async () => {
  const apiPages = navigation.api.flatMap((group) => group.pages);
  const mcpPages = navigation.mcp.flatMap((group) => group.pages);
  const operations = Object.values(openapi.paths).flatMap(Object.values);
  assert.equal(new Set(apiPages).size, operations.length);
  assert.equal(new Set(mcpPages).size, tools.length);
  for (const operation of operations) {
    const path = `api-reference/${operation.operationId}`;
    assert(apiPages.includes(path), path);
    assert.match(await read(`docs/${path}.mdx`), /openapi:/);
  }
  for (const tool of tools) {
    const path = `mcp-reference/${tool.name}`;
    assert(mcpPages.includes(path), path);
    const source = await read(`docs/${path}.mdx`);
    assert.match(source, /```mermaid\nflowchart LR/);
    const examples = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map(
      (match) => JSON.parse(match[1]),
    );
    const call = examples.find((example) => example.method === "tools/call");
    assert.equal(call?.params.name, tool.name);
    assert(examples.length >= 3, path);
  }
});

test("rendered reference treats mention syntax as code and REST retries as headers", async () => {
  const mcp = await read("docs/mcp-reference/add_comment.mdx");
  assert(mcp.includes("`@[Name](user:UUID)`"));
  const rest = await read(
    "docs/api-reference/post_api_tasks_by_taskId_comments.mdx",
  );
  assert(rest.includes("`@[Name](user:UUID)`"));
  assert(rest.includes("the `Idempotency-Key` header"));
  assert(!/\bidempotencyKey\b/.test(rest));
  assert(
    tools
      .find((tool) => tool.name === "add_comment")
      .description.includes("Reuse idempotencyKey on retries."),
  );
  assert(
    tools
      .find((tool) => tool.name === "add_comment")
      .description.includes(
        "Mention with @email, @[Name](user:UUID), or mentionIds.",
      ),
  );
});
