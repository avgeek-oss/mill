import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Agent, Member } from "../../../packages/contracts/src/index.js";
import {
  Button,
  Checkbox,
  Chip,
  Choice,
  Dialog,
  EmptyState,
  ErrorMessage,
  Table,
  TextField,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import {
  api,
  ApiError,
  createRetryKey,
  errorText,
  isResponseObject,
  type Session,
} from "./api.js";
import { PageHeading } from "./page-heading.js";
import { Plus, Trash2 } from "./icons.js";

export type { Agent } from "../../../packages/contracts/src/index.js";
export function validAgent(value: unknown): value is Agent {
  return (
    isResponseObject(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.name === "string" &&
    !!value.name.trim() &&
    (value.scope === "personal" || value.scope === "team") &&
    typeof value.creatorId === "string" &&
    Array.isArray(value.memberIds) &&
    value.memberIds.every((id) => typeof id === "string") &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}
function validAgentResponse(value: unknown) {
  return isResponseObject(value) && validAgent(value.agent);
}
export function useAgentDirectory(key: string | null, manage = false) {
  const generation = useRef(0);
  const [state, setState] = useState({
    key,
    items: [] as Agent[],
    pending: !!key,
    error: "",
  });
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setState((previous) => ({
      key,
      items: previous.key === key ? previous.items : [],
      pending: !!key,
      error: "",
    }));
    if (!key) return;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const items = new Map<string, Agent>();
          const cursors = new Set<string>();
          let cursor: string | null = null;
          do {
            const query = new URLSearchParams({ limit: "100" });
            if (manage) query.set("manage", "true");
            if (cursor) query.set("cursor", cursor);
            const page: {
              items: Agent[];
              hasMore: boolean;
              nextCursor: string | null;
            } = await api<{
              items: Agent[];
              hasMore: boolean;
              nextCursor: string | null;
            }>(`/agents?${query}`, undefined, "GET", {
              validateResponse: (value) =>
                isResponseObject(value) &&
                Array.isArray(value.items) &&
                value.items.every(validAgent) &&
                typeof value.hasMore === "boolean" &&
                (value.hasMore
                  ? typeof value.nextCursor === "string" && !!value.nextCursor
                  : value.nextCursor === null),
            });
            if (current !== generation.current) return;
            for (const agent of page.items) items.set(agent.id, agent);
            cursor = page.nextCursor;
            if (cursor) {
              if (cursors.has(cursor))
                throw new Error(
                  "The agent list could not be completed. Try again.",
                );
              cursors.add(cursor);
            }
          } while (cursor);
          setState({
            key,
            items: [...items.values()],
            pending: false,
            error: "",
          });
          return;
        } catch (cause) {
          if (!(
            cause instanceof ApiError &&
            cause.status === 409 &&
            attempt < 2
          ))
            throw cause;
          if (current !== generation.current) return;
        }
      }
    } catch (cause) {
      if (current === generation.current)
        setState({ key, items: [], pending: false, error: errorText(cause) });
    }
  }, [key, manage]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return {
    ...(state.key === key ? state : { items: [], pending: !!key, error: "" }),
    reload,
  };
}

function AgentEditor({
  session,
  agent,
  onClose,
  onSaved,
}: {
  session: Session;
  agent?: Agent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const [current, setCurrent] = useState(agent);
  const [name, setName] = useState(agent?.name ?? "");
  const [scope, setScope] = useState(agent?.scope ?? "personal");
  const [memberIds, setMemberIds] = useState(agent?.memberIds ?? []);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  const [membersPending, setMembersPending] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [complete, setComplete] = useState(false);
  const [retryKey] = useState(createRetryKey);
  const memberGeneration = useRef(0);
  const loadMembers = useCallback(async () => {
    const request = ++memberGeneration.current;
    setMembersPending(true);
    setMembersError("");
    try {
      const people: Member[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: { items: Member[]; nextCursor?: string | null } =
          await api<{ items: Member[]; nextCursor?: string | null }>(
            `/auth/members${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
        if (request !== memberGeneration.current) return;
        people.push(...page.items);
        cursor = page.nextCursor ?? null;
        if (cursor) {
          if (cursors.has(cursor))
            throw new Error(
              "The people list could not be completed. Try again.",
            );
          cursors.add(cursor);
        }
      } while (cursor);
      setMembers(people);
    } catch (cause) {
      if (request === memberGeneration.current)
        setMembersError(errorText(cause));
    } finally {
      if (request === memberGeneration.current) setMembersPending(false);
    }
  }, []);
  useEffect(() => {
    if (scope === "team") void loadMembers();
    return () => {
      memberGeneration.current++;
    };
  }, [scope, loadMembers]);
  async function save() {
    if (pending || (scope === "team" && (membersPending || membersError)))
      return;
    setPending(true);
    setError("");
    setConflict(false);
    const path = current ? `/agents/${current.id}` : "/agents";
    const payload = {
      name: name.trim(),
      ...(current ? { version: current.version } : { scope }),
      ...(scope === "team" ? { memberIds } : {}),
    };
    const method = current ? "PATCH" : "POST";
    try {
      await api(path, payload, method, {
        validateResponse: validAgentResponse,
        headers: {
          "Idempotency-Key": retryKey.forRequest(path, payload, method),
        },
      });
      retryKey.reset();
      setComplete(true);
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
      setConflict(cause instanceof ApiError && cause.status === 409);
    } finally {
      setPending(false);
    }
  }
  async function reload() {
    if (!current || pending) return;
    setPending(true);
    try {
      const result = await api<{ agent: Agent }>(
        `/agents/${current.id}?manage=true`,
        undefined,
        "GET",
        { validateResponse: validAgentResponse },
      );
      setCurrent(result.agent);
      setName(result.agent.name);
      setMemberIds(result.agent.memberIds);
      setConflict(false);
      setError("");
      retryKey.reset();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title={agent ? "Edit agent" : "Create agent"}
      onClose={() => {
        if (!pending) onClose();
      }}
      isDismissDisabled={pending}
      footer={
        complete ? (
          <Button onPress={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" isDisabled={pending} onPress={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              isPending={pending}
              isDisabled={
                conflict ||
                (scope === "team" && (membersPending || !!membersError))
              }
            >
              {pending ? "Saving…" : agent ? "Save changes" : "Create agent"}
            </Button>
          </>
        )
      }
    >
      {complete ? (
        <p role="status" className="text-sm text-success">
          Agent {agent ? "updated" : "created"}.
        </p>
      ) : (
        <form
          id={formId}
          className="content-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            disabled={pending}
            className="max-md:text-base!"
          />
          <Choice
            label="Access"
            value={scope}
            onChange={(value) => setScope(value as "personal" | "team")}
            disabled={pending || !!agent}
            items={[
              { id: "personal", name: "Personal" },
              ...(session.user.role === "admin"
                ? [{ id: "team", name: "Team" }]
                : []),
            ]}
          />
          <p className="text-sm text-muted">
            {scope === "personal"
              ? "Only you can use this agent."
              : "Choose the people who can use this agent. Administrators manage its access."}
          </p>
          {scope === "team" && (
            <div className="content-grid">
              {membersPending && (
                <p role="status" className="text-sm text-muted">
                  Loading people…
                </p>
              )}
              <ErrorMessage>{membersError}</ErrorMessage>
              {membersError && (
                <Button variant="secondary" onPress={() => void loadMembers()}>
                  Retry people
                </Button>
              )}
              {!membersPending && !membersError && (
                <>
                  <TextField
                    label="Search people"
                    type="search"
                    value={memberQuery}
                    onChange={(event) => setMemberQuery(event.target.value)}
                    className="max-md:text-base!"
                  />
                  <div
                    role="group"
                    aria-label="Assigned people"
                    className="grid max-h-64 gap-2 overflow-y-auto"
                  >
                    {members
                      .filter((member) =>
                        `${member.name} ${member.email}`
                          .toLowerCase()
                          .includes(memberQuery.toLowerCase()),
                      )
                      .map((member) => (
                        <Checkbox
                          key={member.id}
                          className="min-h-11"
                          isSelected={memberIds.includes(member.id)}
                          isDisabled={pending}
                          onChange={(selected) =>
                            setMemberIds((previous) =>
                              selected
                                ? [...new Set([...previous, member.id])]
                                : previous.filter((id) => id !== member.id),
                            )
                          }
                          aria-label={`${member.name} (${member.email})`}
                        >
                          <Checkbox.Content className="min-w-0">
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                            <span className="min-w-0 text-sm break-words">
                              {member.name}
                              <span className="block text-muted break-all">
                                {member.email}
                              </span>
                            </span>
                          </Checkbox.Content>
                        </Checkbox>
                      ))}
                  </div>
                  <p className="text-sm text-muted">
                    {memberIds.length
                      ? `${memberIds.length} ${memberIds.length === 1 ? "person" : "people"} assigned.`
                      : "No people assigned. This agent cannot be used until someone is assigned."}
                  </p>
                </>
              )}
            </div>
          )}
          <ErrorMessage>{error}</ErrorMessage>
          {conflict && (
            <Button
              variant="secondary"
              isPending={pending}
              onPress={() => void reload()}
            >
              Reload agent
            </Button>
          )}
        </form>
      )}
    </Dialog>
  );
}

function DeleteAgent({
  agent,
  onClose,
  onDeleted,
}: {
  agent: Agent;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [current, setCurrent] = useState(agent);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [retryKey] = useState(createRetryKey);
  async function remove() {
    if (pending || conflict) return;
    setPending(true);
    setError("");
    const path = `/agents/${agent.id}`;
    const payload = { version: current.version };
    try {
      await api(path, payload, "DELETE", {
        validateResponse: (value) =>
          isResponseObject(value) && value.ok === true,
        headers: {
          "Idempotency-Key": retryKey.forRequest(path, payload, "DELETE"),
        },
      });
      retryKey.reset();
      setComplete(true);
      onDeleted();
    } catch (cause) {
      setError(errorText(cause));
      setConflict(cause instanceof ApiError && cause.status === 409);
    } finally {
      setPending(false);
    }
  }
  async function reload() {
    if (pending) return;
    setPending(true);
    try {
      const result = await api<{ agent: Agent }>(
        `/agents/${agent.id}?manage=true`,
        undefined,
        "GET",
        { validateResponse: validAgentResponse },
      );
      setCurrent(result.agent);
      setConflict(false);
      setError("");
      retryKey.reset();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title="Delete agent?"
      onClose={() => {
        if (!pending) onClose();
      }}
      isDismissDisabled={pending}
      footer={
        complete ? (
          <Button onPress={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" isDisabled={pending} onPress={onClose}>
              Keep agent
            </Button>
            <Button
              variant="danger"
              isPending={pending}
              isDisabled={conflict}
              onPress={() => void remove()}
            >
              {pending ? "Deleting…" : "Delete agent"}
            </Button>
          </>
        )
      }
    >
      <div className="content-grid">
        <p className="text-sm">
          {complete ? (
            <>
              <strong>{current.name}</strong> has been deleted.
            </>
          ) : (
            <>
              Delete <strong>{current.name}</strong>? Its keys and connections
              will lose access. Task history stays available.
            </>
          )}
        </p>
        <ErrorMessage>{error}</ErrorMessage>
        {conflict && (
          <Button
            variant="secondary"
            isPending={pending}
            onPress={() => void reload()}
          >
            Reload agent
          </Button>
        )}
        {complete && (
          <p role="status" className="text-sm text-success">
            Agent deleted.
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function AgentsSettings({ session }: { session: Session }) {
  const directory = useAgentDirectory(
    `${session.user.id}:${session.user.role}`,
    session.user.role !== "viewer",
  );
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const actions = useRef(new Map<string, HTMLButtonElement>());
  const activeAction = useRef<string | null>(null);
  useEffect(() => {
    document.title = "Agents · Mill";
  }, []);
  useEffect(() => {
    if (editing || deleting || !activeAction.current) return;
    const trigger = actions.current.get(activeAction.current);
    activeAction.current = null;
    (trigger?.isConnected ? trigger : createButton.current)?.focus();
  }, [editing, deleting]);
  const canCreate = session.user.role !== "viewer";
  const canManage = (agent: Agent) =>
    agent.scope === "team"
      ? session.user.role === "admin"
      : agent.creatorId === session.user.id && canCreate;
  return (
    <section className="settings-page">
      <PageHeading
        title="Agents"
        icon={<HugeiconsIcon icon={BotIcon} size={20} />}
        actions={
          canCreate ? (
            <Button
              ref={createButton}
              onPress={() => {
                activeAction.current = "create";
                setEditing("new");
              }}
            >
              <Plus />
              Create agent
            </Button>
          ) : undefined
        }
      />
      <div className="content-grid min-w-0">
        {directory.pending && (
          <p role="status" className="text-sm text-muted">
            Loading agents…
          </p>
        )}
        <ErrorMessage>{directory.error}</ErrorMessage>
        {directory.error && (
          <Button variant="secondary" onPress={() => void directory.reload()}>
            Retry agents
          </Button>
        )}
        {!directory.pending && !directory.error && !directory.items.length && (
          <EmptyState>
            <EmptyState.Header>
              <EmptyState.Title>No agents yet</EmptyState.Title>
              <EmptyState.Description>
                {canCreate
                  ? "Create an agent to give your tools a name in Mill."
                  : "Ask an administrator to assign you to a team agent."}
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        )}
        {!!directory.items.length && (
          <Table>
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Agents"
                className="w-full max-md:w-full! max-md:table-fixed!"
              >
                <Table.Header>
                  <Table.Column isRowHeader>Agent</Table.Column>
                  <Table.Column className="hidden md:table-cell">
                    Access
                  </Table.Column>
                  <Table.Column className="w-40 text-right max-md:w-24!">
                    Actions
                  </Table.Column>
                </Table.Header>
                <Table.Body>
                  {directory.items.map((agent) => (
                    <Table.Row key={agent.id} id={agent.id}>
                      <Table.Cell className="whitespace-normal!">
                        <p className="text-sm font-medium break-words">
                          {agent.name}
                        </p>
                        <p className="text-sm text-muted">
                          {agent.scope === "personal"
                            ? "Only you"
                            : `${agent.memberIds.length} ${agent.memberIds.length === 1 ? "person" : "people"} assigned`}
                        </p>
                        <span className="md:hidden">
                          <Chip size="small" variant="secondary">
                            {agent.scope === "personal" ? "Personal" : "Team"}
                          </Chip>
                        </span>
                      </Table.Cell>
                      <Table.Cell className="hidden md:table-cell">
                        <Chip size="small" variant="secondary">
                          {agent.scope === "personal" ? "Personal" : "Team"}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        {canManage(agent) && (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              aria-label={`Edit ${agent.name}`}
                              ref={(element) => {
                                if (element)
                                  actions.current.set(
                                    `edit:${agent.id}`,
                                    element,
                                  );
                                else actions.current.delete(`edit:${agent.id}`);
                              }}
                              onPress={() => {
                                activeAction.current = `edit:${agent.id}`;
                                setEditing(agent);
                              }}
                            >
                              <HugeiconsIcon
                                icon={PencilEdit02Icon}
                                size={16}
                              />
                              <span className="hidden md:inline">Edit</span>
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={`Delete ${agent.name}`}
                              ref={(element) => {
                                if (element)
                                  actions.current.set(
                                    `delete:${agent.id}`,
                                    element,
                                  );
                                else
                                  actions.current.delete(`delete:${agent.id}`);
                              }}
                              onPress={() => {
                                activeAction.current = `delete:${agent.id}`;
                                setDeleting(agent);
                              }}
                            >
                              <Trash2 />
                              <span className="hidden md:inline">Delete</span>
                            </Button>
                          </div>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </div>
      {editing && (
        <AgentEditor
          session={session}
          agent={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void directory.reload()}
        />
      )}
      {deleting && (
        <DeleteAgent
          agent={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => void directory.reload()}
        />
      )}
    </section>
  );
}
