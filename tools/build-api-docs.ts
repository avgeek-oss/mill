import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import type { Endpoint } from "./docs-reference-data.js";
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const { illustrations, supplementalEndpoints } =
  await import("./docs-reference-data.js");
const { tools } = await import("../apps/api/src/external/tools.js");
const { app } = await import("../apps/api/src/app.js");
const { closeDatabase } = await import("../packages/database/src/index.js");
const check = process.argv.includes("--check");
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  description?: string;
  enum?: unknown[];
  format?: string;
  [key: string]: unknown;
};
const canonical = (path: string) => path.replace(/:[A-Za-z]+|\{[^}]+\}/g, "{}");
const openPath = (path: string) => path.replace(/:([A-Za-z]+)/g, "{$1}");
const slug = (method: string, path: string) =>
  `${method.toLowerCase()}_${path
    .replace(/:([A-Za-z]+)/g, "by_$1")
    .replace(/[/.-]+/g, "_")
    .replace(/^_|_$/g, "")}`;
const jsonSchema = (schema: z.ZodType): Schema => {
  const value = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  const { $schema: _, ...rest } = value;
  return rest as Schema;
};
const block = (language: string, value: unknown) =>
  `\n\`\`\`${language}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const describe = (schema: Schema) =>
  schema.description ??
  (schema.enum
    ? schema.enum.map(String).join(", ")
    : (schema.format ??
      (Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type) ??
      "JSON value"));
const markdownProse = (value: string) =>
  value
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part
        : part.replace(
            /@\[[^\]]+\]\(user:[^)]+\)|@email|user:UUID|\b(?:idempotencyKey|Idempotency-Key|parentId|mentionIds|replyCount|acceptanceCriteria|assigneeId|startDate|dueDate|statusChangedAt|nextCursor|hasMore|commentLimit|activityLimit|commentsPage|activityPage|structuredContent|isError|unreadCount|BOARD_PREFIX_TAKEN|COMMENT_DEPTH_LIMIT|UPLOAD_EXPIRED|member_list_changed|board_list_changed|task_list_changed)\b/g,
            (token) => "`" + token + "`",
          ),
    )
    .join("");
const restProse = (value: string) =>
  value.replace(/\bidempotencyKey\b/g, "the Idempotency-Key header");
const authText: Record<Endpoint["auth"], string> = {
  public:
    "No signed-in session is required. Endpoint-specific tokens, setup secrets or challenges may still be required.",
  session:
    "A signed-in human session is required. API keys and MCP bearer credentials cannot replace that session.",
  recent:
    "A signed-in human session with recent authentication is required. Complete password/passkey reauthentication when requested.",
  "admin-session":
    "A signed-in human administrator is required. API keys and MCP credentials cannot replace that session. Sensitive operations can also require recent authentication.",
  read: "Read access: a read-enabled personal or team REST API key, or a signed-in user. OAuth clients use the corresponding MCP tool through /mcp.",
  write:
    "Write access: a member/administrator with a write-enabled credential, or an authorized signed-in user.",
  admin:
    "Administrator access with explicit administrator permission on a personal or team REST API key, or a signed-in administrator. OAuth tokens cannot call this HTTP operation.",
  "oauth-client":
    "Authenticate the OAuth client using its registered method: none, client_secret_basic or client_secret_post. Client credentials are distinct from a user's API key.",
  mcp: "An OAuth bearer token issued for this installation's MCP resource is required. Static REST API keys cannot access /mcp.",
};
const argumentDescriptions: Record<string, string> = {
  version: "Latest row version; stale mutations return HTTP 409.",
  idempotencyKey:
    "One logical mutation key, reused unchanged on retries. MCP forwards it as the REST Idempotency-Key header.",
  boardId: "Board UUID, not its task prefix.",
  taskId: "Task UUID, not its human identifier such as ENG-1.",
  parentId:
    "Same-task comment UUID for replies, or root when listing top-level comments. Omit to list all comments.",
  assigneeId:
    "Active member UUID; null clears an assignment on mutation, unassigned filters unassigned tasks when listing.",
  acceptanceCriteria:
    "Independent Markdown acceptance criteria, at most 100,000 characters.",
  startDate: "Optional calendar date YYYY-MM-DD; null clears it.",
  dueDate: "Optional calendar date YYYY-MM-DD; null clears it.",
  cursor:
    "Opaque nextCursor from the preceding response with identical filters.",
  revision:
    "Revision returned by the task list; send with numbered pages to reject concurrent list changes.",
};
const groupFor = (path: string) =>
  path.includes("attachment")
    ? "Attachments"
    : path.includes("comments") || path.includes("activity")
      ? "Comments and activity"
      : path.includes("/tasks")
        ? "Tasks"
        : path.includes("/boards")
          ? "Boards"
          : path.includes("notifications")
            ? "Notifications"
            : "Members";
const snapshot = tools.map((tool) => ({
  name: tool.name,
  method: tool.method,
  path: tool.path,
  description: tool.description,
  readOnly: tool.readOnly,
  administrator: Boolean(tool.admin),
  input: z.toJSONSchema(tool.input, { unrepresentable: "any" }),
}));
const generated = new Map<string, string>();
const emit = async (
  path: string,
  body: string,
  parser: "mdx" | "json" = "mdx",
) => {
  const formatted = await format(body, { parser });
  generated.set(path, formatted);
};
const mcpNavigation = new Map<string, string[]>();
const endpoints: (Endpoint & {
  toolName?: string;
  inputExample?: Record<string, unknown>;
})[] = [...supplementalEndpoints];
for (const tool of tools) {
  const group = groupFor(tool.path);
  mcpNavigation.set(group, [
    ...(mcpNavigation.get(group) ?? []),
    `mcp-reference/${tool.name}`,
  ]);
  const example = illustrations[tool.name];
  assert(example, `Missing illustration for ${tool.name}`);
  tool.input.parse(example.input);
  const pathNames = [...tool.path.matchAll(/:([A-Za-z]+)/g)].map(
    (match) => match[1]!,
  );
  let schema = z
    .object(
      Object.fromEntries(
        Object.entries(tool.input.shape).filter(
          ([name]) => !pathNames.includes(name) && name !== "idempotencyKey",
        ),
      ),
    )
    .strict();
  // MCP retry keys are headers in REST, and task previews have different defaults.
  if (tool.name === "get_task")
    schema = schema.extend({
      commentLimit: z.number().int().min(0).max(100).default(100),
      activityLimit: z.number().int().min(0).max(100).default(100),
    });
  if (tool.name === "add_comment")
    schema = schema.extend({
      body: z.string().trim().min(1).max(10000),
      mentionIds: z.array(z.uuid()).max(50).default([]),
    });
  if (tool.name === "create_board" || tool.name === "update_board")
    schema = schema.extend({
      name: z.string().trim().min(1).max(100).optional(),
      prefix: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{1,9}$/)
        .optional(),
    });
  if (tool.name === "create_board")
    schema = schema.extend({
      name: z.string().trim().min(1).max(100),
      description: z.string().max(10000).default(""),
    });
  if (tool.name === "list_boards")
    schema = schema.extend({
      directory: z.boolean().optional(),
      cursor: z.string().max(1000).optional(),
    });
  const inputExample = Object.fromEntries(
    Object.entries(example.input).filter(
      ([key]) => !pathNames.includes(key) && key !== "idempotencyKey",
    ),
  );
  endpoints.push({
    method: tool.method,
    path: tool.path,
    title: example.title,
    group,
    auth: tool.admin ? "admin" : tool.readOnly ? "read" : "write",
    description: restProse(`${tool.description}\n\n${example.note}`),
    ...(tool.method === "GET"
      ? { query: schema }
      : Object.keys(schema.shape).length
        ? { body: schema }
        : {}),
    result: example.result,
    toolName: tool.name,
    inputExample,
    status: [
      "create_board",
      "create_task",
      "add_comment",
      "create_attachment_upload",
    ].includes(tool.name)
      ? 201
      : 200,
  });
  const input = jsonSchema(tool.input);
  const fields = Object.entries(input.properties ?? {})
    .map(
      ([name, field]) =>
        `| \`${name}\` | ${input.required?.includes(name) ? "Yes" : "No"} | ${(argumentDescriptions[name] ?? describe(field)).replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  const flow = example.workflow
    .map(
      (step, i) =>
        `  step${i}["${step}"]${i < example.workflow.length - 1 ? ` --> step${i + 1}` : ""}`,
    )
    .join("\n");
  await emit(
    `docs/mcp-reference/${tool.name}.mdx`,
    `---\ntitle: ${JSON.stringify(tool.name)}\ndescription: ${JSON.stringify(example.title + " with Mill MCP.")}\nicon: "plug"\n---\n\n${markdownProse(tool.description)}\n\n## Workflow\n\n${block("mermaid", `flowchart LR\n${flow}`)}\n\n## Access and behavior\n\n${tool.admin ? "Administrator consent and a current administrator team role are required." : tool.readOnly ? "A Read-only, Write or Administrator OAuth grant can call this tool within the user’s current team role." : "Write or Administrator OAuth consent and a member/administrator team role are required."} Tools are listed and callable only when the current grant and role permit them.\n\n${markdownProse(example.note)}\n\n${tool.destructive ? "<Warning>Confirm the exact target and consequence with the user before calling this tool.</Warning>\n\n" : ""}## Arguments\n\n| Argument | Required | Type or meaning |\n| --- | --- | --- |\n${fields || "| None | No | Pass an empty object. |"}\n\n<Accordion title="Complete input schema">\n${block("json", input)}\n</Accordion>\n\n## Example call\n\nThe client initializes the MCP connection before sending this JSON-RPC call. Example records are fictional.\n${block("json", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: example.input } })}\n\n## Example result\n\nMill returns this object in \`structuredContent\` and normally a JSON text content block (large responses may shorten the text block). A tool failure sets \`isError\`; never treat an error as a completed mutation.\n${block("json", example.result)}\n\n## Related reference\n\n[HTTP operation](/api-reference/${slug(tool.method, tool.path)}) · [Connect an MCP client](/mcp-connections) · [Request conventions](/api-reference/overview)\n`,
  );
}
const expected = new Set(
  app.routes
    .filter((route) =>
      ["GET", "POST", "PATCH", "DELETE", "PUT"].includes(route.method),
    )
    .map((route) => `${route.method} ${canonical(route.path)}`),
);
for (const method of ["POST", "GET", "DELETE"]) expected.add(`${method} /mcp`);
const actual = new Set(
  endpoints.map((route) => `${route.method} ${canonical(route.path)}`),
);
assert.equal(actual.size, endpoints.length, "Duplicate endpoint documentation");
assert.deepEqual(
  [...actual].sort(),
  [...expected].sort(),
  "Every registered HTTP operation must have exactly one reference page",
);
const paths: Record<string, Record<string, unknown>> = {};
const pathSpellings = new Map<string, string>();
for (const endpoint of endpoints) {
  const normalized = canonical(endpoint.path);
  const previous = pathSpellings.get(normalized);
  assert(
    !previous || previous === endpoint.path,
    `Conflicting OpenAPI path parameter names: ${previous} and ${endpoint.path}`,
  );
  pathSpellings.set(normalized, endpoint.path);
}
assert.deepEqual(
  Object.keys(illustrations).sort(),
  tools.map((tool) => tool.name).sort(),
  "Every illustration must belong to a runtime tool",
);
const resultSchema = (value: unknown): Schema => {
  if (value === null) return { type: ["string", "null"] };
  if (Array.isArray(value))
    return { type: "array", items: value.length ? resultSchema(value[0]) : {} };
  if (typeof value === "object")
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, field]) => [
          key,
          resultSchema(field),
        ]),
      ),
      additionalProperties: true,
    };
  return {
    type:
      typeof value === "number"
        ? Number.isInteger(value)
          ? "integer"
          : "number"
        : typeof value,
  };
};
const navigation = new Map<string, string[]>();
for (const endpoint of endpoints) {
  if (endpoint.inputExample && endpoint.body)
    endpoint.body.parse(endpoint.inputExample);
  const operationId = slug(endpoint.method, endpoint.path);
  const route = `api-reference/${operationId}`;
  navigation.set(endpoint.group, [
    ...(navigation.get(endpoint.group) ?? []),
    route,
  ]);
  const bodySchema = endpoint.body ? jsonSchema(endpoint.body) : undefined;
  const querySchema = endpoint.query ? jsonSchema(endpoint.query) : undefined;

  const parameters: Record<string, unknown>[] = [
    ...endpoint.path.matchAll(/:([A-Za-z]+)/g),
  ].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: {
      type: "string",
      ...(endpoint.path.includes("/passkeys/") ? {} : { format: "uuid" }),
    },
    description: `The ${match[1]} from the corresponding list, record or authorization response.`,
  }));
  for (const [name, schema] of Object.entries(querySchema?.properties ?? {}))
    parameters.push({
      name,
      in: "query",
      required: querySchema?.required?.includes(name) ?? false,
      schema,
      description: describe(schema),
    });
  if (
    ["session", "recent", "admin-session", "read", "write", "admin"].includes(
      endpoint.auth,
    ) &&
    endpoint.method !== "GET"
  )
    parameters.push({
      name: "Origin",
      in: "header",
      required: ["session", "recent", "admin-session"].includes(endpoint.auth),
      schema: { type: "string", format: "uri" },
      description:
        "The exact configured Mill UI origin. Required for browser mutations carrying session cookies.",
    });
  if (endpoint.path === "/mcp")
    parameters.push({
      name: "Accept",
      in: "header",
      required: true,
      schema: { type: "string" },
      description:
        endpoint.method === "GET"
          ? "text/event-stream"
          : "application/json, text/event-stream",
    });
  const status = String(endpoint.status ?? 200);
  const response = {
    ...(endpoint.mediaType
      ? {
          content: {
            [endpoint.mediaType]: {
              schema: { type: "string", format: "binary" },
            },
          },
        }
      : {}),
    description: ["302", "308"].includes(status)
      ? "Redirect to the authorization, consent or UI destination."
      : status === "405"
        ? "This stateless MCP transport does not support the requested session operation."
        : "Successful response. Examples are illustrative; field values vary by record.",
    ...(endpoint.path === "/mcp" && endpoint.method === "GET"
      ? { content: { "text/event-stream": { schema: { type: "string" } } } }
      : {}),
    ...(endpoint.result
      ? {
          content: {
            "application/json": {
              schema: {
                ...resultSchema(endpoint.result),
                description:
                  "Illustrative response shape. Fields can be absent in alternate successful flows; see the operation description and example.",
              },
              example: endpoint.result,
            },
          },
        }
      : {}),
    ...(["302", "308"].includes(status)
      ? {
          headers: {
            Location: {
              schema: { type: "string", format: "uri" },
              description: "Redirect destination",
            },
          },
        }
      : {}),
  };
  const responses: Record<string, unknown> = { [status]: response };
  const oauth =
    endpoint.path.startsWith("/oauth/") ||
    endpoint.path.startsWith("/api/oauth/");
  responses.default = {
    description: oauth
      ? "OAuth failure with error and error_description. Consent/session authority may also return the standard Mill error envelope."
      : "Request failure. Inspect code, message and requestId; respect Retry-After on HTTP 429.",
    content: {
      "application/json": {
        schema: oauth
          ? {
              type: "object",
              properties: {
                error: { type: "string" },
                error_description: { type: "string" },
              },
            }
          : { $ref: "#/components/schemas/Error" },
      },
    },
  };
  const security =
    endpoint.auth === "public"
      ? []
      : endpoint.auth === "oauth-client"
        ? [{ oauthClientBasic: [] }, {}]
        : endpoint.auth === "mcp"
          ? [{ mcpBearer: [] }]
          : ["session", "recent", "admin-session"].includes(endpoint.auth)
            ? [{ sessionCookie: [] }]
            : [{ bearerAuth: [] }, { sessionCookie: [] }];
  if (
    endpoint.path.startsWith("/api/") &&
    !endpoint.path.startsWith("/api/auth/") &&
    ["POST", "PATCH", "DELETE"].includes(endpoint.method)
  )
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      schema: {
        type: "string",
        minLength: 8,
        maxLength: 128,
        pattern: "^[A-Za-z0-9._:-]+$",
      },
      description:
        "Reuse the same key and exact request bytes for retries of one logical mutation; different content conflicts.",
    });
  const operation = {
    operationId,
    summary: endpoint.title,
    description: markdownProse(
      `${endpoint.description}\n\n${authText[endpoint.auth]}`,
    ),
    tags: [endpoint.group],
    security,
    ...(parameters.length ? { parameters } : {}),
    ...(bodySchema
      ? {
          requestBody: {
            required: true,
            content: {
              [endpoint.form
                ? "application/x-www-form-urlencoded"
                : "application/json"]: {
                schema: bodySchema,
                ...(endpoint.inputExample
                  ? { example: endpoint.inputExample }
                  : {}),
              },
            },
          },
        }
      : {}),
    responses,
  };
  const path = openPath(endpoint.path);
  paths[path] ??= {};
  paths[path]![endpoint.method.toLowerCase()] = operation;
  await emit(
    `docs/${route}.mdx`,
    `---\ntitle: ${JSON.stringify(endpoint.title)}\ndescription: ${JSON.stringify(markdownProse(endpoint.description.split("\n")[0]))}\nplayground: simple\nopenapi: ${JSON.stringify(`/api-reference/openapi.json ${endpoint.method} ${path}`)}\n---\n\n${authText[endpoint.auth]}\n\n${markdownProse(endpoint.description)}\n\n${endpoint.toolName ? `MCP clients can use [\`${endpoint.toolName}\`](/mcp-reference/${endpoint.toolName}) for this operation.\n\n` : ""}[Request conventions](/api-reference/overview) · [API keys](/api-keys) · [MCP connections](/mcp-connections)\n`,
  );
}
const version = JSON.parse(await readFile("package.json", "utf8"))
  .version as string;
const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Mill HTTP API",
    version,
    description:
      "All registered task-board, account, OAuth, MCP transport and health operations. MCP tool schemas come from runtime validators; account operations follow their server handlers. Example data is fictional. Generation imports routes without issuing requests or connecting to a database.",
  },
  servers: [{ url: "https://mill-api.example.com" }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Personal or team Mill REST API key",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "mill_session",
        description:
          "Signed-in human browser session; mutation requests also need the exact UI Origin",
      },
      mcpBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "OAuth bearer token issued for /mcp; REST API keys are not accepted",
      },
      oauthClientBasic: {
        type: "http",
        scheme: "basic",
        description:
          "Registered OAuth client authentication, when client_secret_basic is selected",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "requestId"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              requestId: { type: "string" },
            },
          },
        },
      },
    },
  },
};
await emit("docs/api-reference/openapi.json", JSON.stringify(openapi), "json");
await emit("docs/mcp-reference/tools.json", JSON.stringify(snapshot), "json");
await emit(
  "docs/reference-navigation.json",
  JSON.stringify({
    api: [...navigation].map(([group, pages]) => ({ group, pages })),
    mcp: [...mcpNavigation].map(([group, pages]) => ({ group, pages })),
  }),
  "json",
);
await emit(
  "docs/api-reference/overview.mdx",
  `---
title: "HTTP API reference"
description: "Every Mill HTTP operation, with request schemas and response examples."
---

Use [API keys](/api-keys) for REST clients and [MCP connections](/mcp-connections) for OAuth clients. This reference covers ${endpoints.length} registered HTTP operations. The [OpenAPI document](/api-reference/openapi.json) uses fictional example data and the installation URL \`https://mill-api.example.com\`.

## Requests and authorization

REST API keys use the \`Authorization: Bearer\` header. Personal grants remain bounded by current active membership; team grants use stored team policy. OAuth bearer tokens authorize \`/mcp\` only. Human account, security and credential-management routes require a signed-in browser session. Browser mutations carrying cookies require the exact configured UI \`Origin\`. Public setup, email and passkey flows can still require private endpoint-specific tokens or challenges.

Use a resource's UUID in its path. Human task identifiers such as \`ENG-1\` are labels. Send a current version on protected edits; a stale edit returns 409 and leaves the operation unchanged. Prefix changes preserve UUID links while renaming existing task identifiers.

## Retry safety

For \`POST\`, \`PATCH\` and \`DELETE\` below \`/api\` outside human authentication, send \`Idempotency-Key\` with 8–128 letters, digits or \`._:-\` without spaces. Reuse the key with the exact same request bytes for one logical retry. A changed payload conflicts. Saved responses last 24 hours and replay with \`Idempotency-Replayed: true\`. Permanent deletion invalidates saved work responses; a terminal \`410 retry_invalidated\` must not be retried as a new create.

## Pagination and dates

Continue lists with \`nextCursor\` and identical filters until \`hasMore: false\`. Do not interpret cursors. Changed board, task or member collections can return 409; restart without the old cursor. Task lists also support numbered pages with a returned revision. Task sorting defaults to \`priority\`. Done and Won't Do tasks leave default lists after 24 hours in their current status; an explicit status filter includes older records. Start and due dates are nullable \`YYYY-MM-DD\` calendar dates without time zones.

## Failures and limits

Generic JSON errors use \`{error:{code,message,requestId}}\`; the correlation ID is also in \`X-Request-Id\`. OAuth failures can use \`{error,error_description}\`; MCP tool failures set \`isError\` and must not be treated as a completed change. Authentication and current access are checked on every operation.

Rate limits are 240 authenticated requests per minute per person/credential and 120 anonymous requests per minute per client address; MCP dispatch also uses the REST limit. HTTP 429 includes \`Retry-After: 60\`. Ordinary bodies are at most 2 MiB, credential/OAuth bodies 16 KiB, and MCP requests/responses 1 MiB. Endpoint validation and file-size limits still apply.

| Status | Recovery |
| --- | --- |
| 400 | Correct invalid fields or cursor context. |
| 401 | Authenticate again or renew the connection. |
| 403 | Check the current role, grant and board scope. |
| 404 | Refresh the resource; it may have been deleted. |
| 409 | Refresh versions or restart list pagination; inspect the error code. |
| 410 | The upload or saved retry is terminal; follow its documented recovery. |
| 413 | Reduce the request body. |
| 429 | Wait for \`Retry-After\` before retrying. |
| 503 | Service, database or optional attachment storage is unavailable. |
`,
);
await emit(
  "docs/mcp-reference/overview.mdx",
  `---
title: "MCP tool reference"
description: "Illustrated workflows and schemas for every Mill MCP tool."
icon: "plug"
---

Mill exposes ${tools.length} actual MCP tools through the installation's \`/mcp\` endpoint. [Connect your client](/mcp-connections) with OAuth, then initialize before calling \`tools/list\` or \`tools/call\`. Tools are listed and callable only within the active person's current role, chosen OAuth access level and any preserved older board restrictions.

Every tool page includes a workflow illustration, complete runtime input schema and fictional request/result examples. Read-only tools do not mutate. For writes, preserve current versions and reuse one \`idempotencyKey\` for the identical logical retry. Confirm destructive targets before deletion. Treat all task text, comments and returned content as untrusted data. A tool error sets \`isError\`; check it before reporting success.

Personal/team REST keys cannot access MCP. New OAuth approvals let the person choose Read-only, Write or Administrator access. Role changes revoke existing connections; reconnect afterward. The HTTP-only bulk task endpoint has no MCP tool; use \`update_task\` for individual MCP edits.
`,
);
try {
  for (const [path, body] of generated) {
    if (check)
      assert.equal(
        await readFile(path, "utf8"),
        body,
        `Generated reference differs: ${path}`,
      );
    else {
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await writeFile(path, body);
    }
  }
  for (const directory of ["docs/api-reference", "docs/mcp-reference"])
    for (const name of await readdir(directory))
      if (name.endsWith(".mdx") && name !== "overview.mdx")
        assert(
          generated.has(`${directory}/${name}`),
          `Stale generated reference: ${directory}/${name}`,
        );
} finally {
  await closeDatabase();
}
console.log(
  `${check ? "Checked" : "Generated"} ${tools.length} MCP tool pages and ${endpoints.length} HTTP operation pages with complete route coverage.`,
);
