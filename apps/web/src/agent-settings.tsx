// Adapted from Towbar's public Apache-2.0 API/MCP settings composition.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Board } from "../../../packages/contracts/src/index.js";
import {
  Button,
  Chip,
  Choice,
  Dialog,
  EmptyState,
  ErrorMessage,
  Table,
  TextField,
  Widget,
  Link,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Key01Icon,
  Link01Icon,
  Copy01Icon,
  ShieldBanIcon,
} from "@hugeicons/core-free-icons";
import { Plus } from "./icons.js";
import {
  api,
  createRetryKey,
  errorText,
  isResponseObject,
  type Session,
} from "./api.js";
import { PageHeading } from "./page-heading.js";
import { useBoardDirectory } from "./board-directory.js";

type Credential = {
  id: string;
  name: string;
  scopes: string[];
  boardIds: string[] | null;
  tokenType: "api-key" | "oauth";
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
type CredentialPage = {
  items: Credential[];
  hasMore: boolean;
  nextCursor: string | null;
};
function validCreationResponse(value: unknown) {
  if (!isResponseObject(value) || !isResponseObject(value.credential))
    return false;
  const credential = value.credential;
  return (
    typeof value.token === "string" &&
    /^mill_[A-Za-z0-9_-]{43}$/.test(value.token) &&
    typeof credential.id === "string" &&
    credential.id.length > 0 &&
    typeof credential.name === "string" &&
    credential.name.length > 0 &&
    Array.isArray(credential.scopes) &&
    credential.scopes.includes("read") &&
    credential.scopes.every((scope) => scope === "read" || scope === "write") &&
    (credential.boardIds === null ||
      (Array.isArray(credential.boardIds) &&
        credential.boardIds.every((id) => typeof id === "string"))) &&
    credential.tokenType === "api-key" &&
    typeof credential.expiresAt === "string" &&
    Number.isFinite(Date.parse(credential.expiresAt)) &&
    typeof credential.createdAt === "string" &&
    Number.isFinite(Date.parse(credential.createdAt)) &&
    credential.lastUsedAt === null &&
    credential.revokedAt === null
  );
}
function stateOf(credential: Credential) {
  return credential.revokedAt
    ? "Revoked"
    : Date.parse(credential.expiresAt) <= Date.now()
      ? "Expired"
      : "Active";
}

function CreateCredential({
  session,
  boards,
  onClose,
  onCreated,
  boardsPending,
  boardsError,
  onRetryBoards,
}: {
  session: Session;
  boards: Board[];
  onClose: () => void;
  onCreated: (credential: Credential) => void;
  boardsPending: boolean;
  boardsError: string;
  onRetryBoards: () => void;
}) {
  const formId = useId();
  const [retryKey] = useState(createRetryKey);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState("read");
  const [boardId, setBoardId] = useState("all");
  const [expiry, setExpiry] = useState("30");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  function close() {
    if (pending) return;
    setToken("");
    retryKey.reset();
    onClose();
  }
  async function create() {
    if (pending || boardsPending || boardsError) return;
    const payload = {
      name: name.trim(),
      scopes: permission === "write" ? ["read", "write"] : ["read"],
      ...(boardId === "all" ? {} : { boardIds: [boardId] }),
      expiresInDays: Number(expiry),
    };
    setPending(true);
    setError("");
    try {
      const result = await api<{ credential: Credential; token: string }>(
        "/credentials",
        payload,
        "POST",
        {
          validateResponse: validCreationResponse,
          headers: {
            "Idempotency-Key": retryKey.forRequest("/credentials", payload),
          },
        },
      );
      setToken(result.token);
      retryKey.reset();
      onCreated(result.credential);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("Copy failed. Select the credential and copy it manually.");
    }
  }
  return (
    <Dialog
      open
      title={token ? "Copy your credential" : "Create credential"}
      onClose={close}
      isDismissDisabled={pending}
      footer={
        token ? (
          <>
            <Button variant="secondary" onPress={() => void copy()}>
              <HugeiconsIcon icon={Copy01Icon} size={16} />{" "}
              {copied ? "Copied" : "Copy credential"}
            </Button>
            <Button onPress={close}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" isDisabled={pending} onPress={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              isDisabled={pending || boardsPending || Boolean(boardsError)}
            >
              {pending ? "Creating…" : "Create credential"}
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="content-grid">
          <p className="text-sm text-muted">
            Save this credential in your agent’s secret storage. It is shown
            only in this dialog and cannot be viewed again after you close it.
          </p>
          <TextField
            label="Credential"
            className="max-md:text-base!"
            value={token}
            readOnly
            autoComplete="off"
          />
          <ErrorMessage>{error}</ErrorMessage>
          {copied && (
            <p role="status" className="text-sm text-success">
              Credential copied.
            </p>
          )}
        </div>
      ) : (
        <form
          id={formId}
          className="content-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <TextField
            label="Name"
            className="max-md:text-base!"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example, release assistant"
            required
            maxLength={120}
            disabled={pending}
          />
          <Choice
            label="Access"
            value={permission}
            onChange={setPermission}
            disabled={pending}
            items={[
              { id: "read", name: "Read only" },
              ...(session.user.role === "viewer"
                ? []
                : [{ id: "write", name: "Read and write" }]),
            ]}
          />
          <p className="text-sm text-muted">
            Agents inherit your current workspace role. Credentials cannot
            manage members, workspace settings, or other credentials.
          </p>
          <Choice
            label="Board access"
            value={boardId}
            onChange={setBoardId}
            search
            disabled={pending || boardsPending || Boolean(boardsError)}
            items={[
              { id: "all", name: "All boards" },
              ...boards
                .filter((board) => !board.deletedAt)
                .map((board) => ({
                  id: board.id,
                  name: board.archived
                    ? `${board.name} (archived)`
                    : board.name,
                })),
            ]}
          />
          {boardsPending && (
            <p role="status" className="text-sm text-muted">
              Loading boards…
            </p>
          )}
          {boardsError && (
            <div className="content-grid">
              <ErrorMessage>{boardsError}</ErrorMessage>
              <Button variant="secondary" onPress={onRetryBoards}>
                Retry loading boards
              </Button>
            </div>
          )}
          <p className="text-sm text-muted">
            All boards includes boards created later. Choose a board to limit
            this credential to its tasks and discussion.
          </p>
          <TextField
            label="Expires in days"
            className="max-md:text-base!"
            type="number"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            min={1}
            max={365}
            step={1}
            required
            disabled={pending}
            description="Choose 1–365 days. Access ends automatically at expiry; you can revoke it sooner."
          />
          <ErrorMessage>{error}</ErrorMessage>
        </form>
      )}
    </Dialog>
  );
}

function RevokeCredential({
  credential,
  onClose,
  onRevoked,
}: {
  credential: Credential;
  onClose: () => void;
  onRevoked: (id: string) => void;
}) {
  const [retryKey] = useState(createRetryKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  function close() {
    if (!pending) onClose();
  }
  async function revoke() {
    if (pending) return;
    setPending(true);
    setError("");
    const path = `/credentials/${credential.id}`;
    try {
      await api(path, undefined, "DELETE", {
        validateResponse: (value) =>
          isResponseObject(value) && value.revoked === true,
        headers: {
          "Idempotency-Key": retryKey.forRequest(path, undefined, "DELETE"),
        },
      });
      retryKey.reset();
      onRevoked(credential.id);
      setComplete(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title="Revoke credential?"
      onClose={close}
      isDismissDisabled={pending}
      footer={
        complete ? (
          <Button onPress={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onPress={close} isDisabled={pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onPress={() => void revoke()}
              isDisabled={pending}
            >
              {pending ? "Revoking…" : "Revoke credential"}
            </Button>
          </>
        )
      }
    >
      <div className="content-grid">
        <p className="text-sm">
          {complete ? (
            <>
              <strong>{credential.name}</strong> has been revoked. Its access
              has ended.
            </>
          ) : (
            <>
              Agents using <strong>{credential.name}</strong> will lose access
              immediately. You can create a new credential if they need access
              again.
            </>
          )}
        </p>
        <ErrorMessage>{error}</ErrorMessage>
        {complete && (
          <p role="status" className="text-sm text-success">
            Credential revoked.
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function AgentSettings({
  session,
  onRefresh,
}: {
  session: Session;
  boards: Board[];
  onRefresh: () => void;
}) {
  const [items, setItems] = useState<Credential[] | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [morePending, setMorePending] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Credential | null>(null);
  const {
    boards: knownBoards,
    pending: boardsPending,
    error: boardsError,
    reload: loadBoards,
  } = useBoardDirectory(`${session.user.id}:${session.user.role}`);
  const [endpointNotice, setEndpointNotice] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setPending(true);
    setError("");
    setMorePending(false);
    setNextCursor(null);
    setMoreError("");
    try {
      const page = await api<CredentialPage>("/credentials");
      if (current === generation.current) {
        setItems(page.items);
        setNextCursor(page.nextCursor);
      }
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    } finally {
      if (current === generation.current) setPending(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  async function more() {
    if (!nextCursor || morePending) return;
    const current = generation.current;
    setMorePending(true);
    setMoreError("");
    try {
      const page = await api<CredentialPage>(
        `/credentials?cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (current === generation.current) {
        setItems((previous) => {
          const existing = new Set(previous?.map((item) => item.id));
          return [
            ...(previous ?? []),
            ...page.items.filter((item) => !existing.has(item.id)),
          ];
        });
        setNextCursor(page.nextCursor);
      }
    } catch (cause) {
      if (current === generation.current) setMoreError(errorText(cause));
    } finally {
      if (current === generation.current) setMorePending(false);
    }
  }
  async function reconcile() {
    const current = generation.current;
    try {
      const page = await api<CredentialPage>("/credentials");
      if (current === generation.current) {
        const fresh = new Set(page.items.map((item) => item.id));
        setItems((previous) => [
          ...page.items,
          ...(previous ?? []).filter((item) => !fresh.has(item.id)),
        ]);
        setNextCursor((previous) => previous ?? page.nextCursor);
        setError("");
      }
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    }
  }
  function date(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: session.user.timeZone,
    }).format(new Date(value));
  }
  const endpoint = `${window.location.origin}/mcp`;
  return (
    <div className="content-grid min-w-0">
      <PageHeading
        title="Agent access"
        icon={<HugeiconsIcon icon={Key01Icon} size={24} />}
        description="Manage how external agents connect to Mill."
        actions={
          <Button onPress={() => setCreating(true)}>
            <Plus /> Create credential
          </Button>
        }
      />
      <section
        className="min-w-0 space-y-3"
        aria-label="Credentials"
        role="region"
      >
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <HugeiconsIcon icon={Key01Icon} size={16} />
          Credentials
        </h2>
        <div className="min-w-0">
          {pending && items === null ? (
            <p role="status" className="text-sm text-muted">
              Loading credentials…
            </p>
          ) : error && items === null ? (
            <div className="content-grid">
              <ErrorMessage>{error}</ErrorMessage>
              <Button variant="secondary" onPress={() => void refresh()}>
                Retry loading credentials
              </Button>
            </div>
          ) : items?.length ? (
            <Table>
              <Table.ScrollContainer>
                <Table.Content
                  aria-label="Credentials"
                  className="max-md:w-full! max-md:table-fixed!"
                >
                  <Table.Header>
                    <Table.Column isRowHeader>Credential</Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Status
                    </Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Expires
                    </Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Last used
                    </Table.Column>
                    <Table.Column className="hidden md:table-cell">
                      Action
                    </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {items.map((credential) => {
                      const state = stateOf(credential);
                      const status = (
                        <Chip
                          size="small"
                          variant={
                            state === "Active"
                              ? "success"
                              : state === "Expired"
                                ? "warning"
                                : "secondary"
                          }
                        >
                          {state}
                        </Chip>
                      );
                      const revoke =
                        state === "Active" ? (
                          <Button
                            variant="ghost"
                            aria-label={`Revoke ${credential.name}`}
                            onPress={() => setRevoking(credential)}
                          >
                            <HugeiconsIcon icon={ShieldBanIcon} size={16} />
                            Revoke
                          </Button>
                        ) : null;
                      const boardNames = credential.boardIds
                        ? credential.boardIds
                            .map(
                              (id) =>
                                knownBoards.find((board) => board.id === id)
                                  ?.name ?? "Unavailable board",
                            )
                            .join(", ")
                        : "All boards";
                      return (
                        <Table.Row key={credential.id} id={credential.id}>
                          <Table.Cell className="whitespace-normal!">
                            <div className="min-w-0 space-y-1 md:max-w-xs">
                              <p className="text-sm font-medium break-words">
                                {credential.name}
                              </p>
                              <p className="text-sm text-muted break-words">
                                {credential.scopes.includes("write")
                                  ? "Read and write"
                                  : "Read only"}{" "}
                                · {boardNames}
                              </p>
                              {credential.tokenType === "oauth" && (
                                <p className="text-sm text-muted">
                                  OAuth connection
                                </p>
                              )}
                              <div className="text-sm text-muted md:hidden">
                                <p>Expires {date(credential.expiresAt)}</p>
                                <p>
                                  {credential.lastUsedAt
                                    ? `Last used ${date(credential.lastUsedAt)}`
                                    : "Never used"}
                                </p>
                              </div>
                              <div className="flex items-center justify-between gap-3 pt-1 md:hidden">
                                {status}
                                {revoke}
                              </div>
                            </div>
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            {status}
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            <span className="text-sm text-muted">
                              {date(credential.expiresAt)}
                            </span>
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            <span className="text-sm text-muted">
                              {credential.lastUsedAt
                                ? date(credential.lastUsedAt)
                                : "Never used"}
                            </span>
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            {revoke ?? (
                              <span className="text-sm text-muted">—</span>
                            )}
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          ) : (
            <EmptyState>
              <EmptyState.Header>
                <EmptyState.Title>No credentials yet</EmptyState.Title>
                <EmptyState.Description>
                  Create a credential to give an external agent access to Mill.
                </EmptyState.Description>
              </EmptyState.Header>
            </EmptyState>
          )}
          {items !== null && error && (
            <div className="content-grid">
              <ErrorMessage>{error}</ErrorMessage>
              <Button variant="secondary" onPress={() => void refresh()}>
                Retry loading credentials
              </Button>
            </div>
          )}
        </div>
        {nextCursor && (
          <div>
            <div className="content-grid">
              <ErrorMessage>{moreError}</ErrorMessage>
              <Button
                variant="secondary"
                isDisabled={morePending}
                onPress={() => void more()}
              >
                {morePending
                  ? "Loading more…"
                  : moreError
                    ? "Retry loading more"
                    : "Load more credentials"}
              </Button>
            </div>
          </div>
        )}
      </section>
      <Widget className="min-w-0" aria-label="Remote MCP" role="region">
        <Widget.Header>
          <Widget.Title
            icon={<HugeiconsIcon icon={Link01Icon} size={16} />}
            help={false}
          >
            <h2 className="text-sm font-medium">Remote MCP</h2>
          </Widget.Title>
        </Widget.Header>
        <Widget.Content>
          <div className="content-grid">
            <p className="text-sm text-muted">
              Add this endpoint to your agent’s MCP settings. Use HTTPS for a
              remote instance.
            </p>
            <p className="text-sm">
              <Link
                href="/guides/agents.html"
                className="underline underline-offset-2"
                target="_blank"
                rel="noopener noreferrer"
              >
                Agent setup guide
              </Link>
            </p>
            <TextField
              label="MCP endpoint"
              className="max-md:text-base!"
              value={endpoint}
              readOnly
            />
            <div>
              <Button
                variant="secondary"
                onPress={() => {
                  void navigator.clipboard.writeText(endpoint).then(
                    () => setEndpointNotice("Endpoint copied."),
                    () =>
                      setEndpointNotice(
                        "Copy failed. Select the endpoint and copy it manually.",
                      ),
                  );
                }}
              >
                <HugeiconsIcon icon={Copy01Icon} size={16} /> Copy endpoint
              </Button>
            </div>
            {endpointNotice && (
              <p role="status" className="text-sm text-muted">
                {endpointNotice}
              </p>
            )}
          </div>
        </Widget.Content>
      </Widget>
      {creating && (
        <CreateCredential
          session={session}
          boards={knownBoards}
          boardsPending={boardsPending}
          boardsError={boardsError}
          onRetryBoards={() => void loadBoards()}
          onClose={() => setCreating(false)}
          onCreated={(credential) => {
            setItems((previous) => [
              credential,
              ...(previous ?? []).filter((item) => item.id !== credential.id),
            ]);
            if (items === null) void refresh();
            else void reconcile();
            onRefresh();
          }}
        />
      )}
      {revoking && (
        <RevokeCredential
          credential={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(id) => {
            setItems(
              (previous) =>
                previous?.map((item) =>
                  item.id === id
                    ? { ...item, revokedAt: new Date().toISOString() }
                    : item,
                ) ?? null,
            );
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
