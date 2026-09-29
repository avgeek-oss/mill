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
  TableCellStack,
  TableCellDescription,
  TextField,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Key01Icon,
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

type Credential = {
  id: string;
  name: string;
  agentId: string | null;
  agentName: string | null;
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
    credential.agentId === null &&
    credential.agentName === null &&
    Array.isArray(credential.scopes) &&
    credential.scopes.length === 0 &&
    credential.boardIds === null &&
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
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (credential: Credential) => void;
}) {
  const formId = useId();
  const [retryKey] = useState(createRetryKey);
  const [name, setName] = useState("");
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
    if (pending) return;
    const payload = {
      name: name.trim(),
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
      setError("Copy failed. Select the key and copy it manually.");
    }
  }
  return (
    <Dialog
      open
      title={token ? "Copy your API key" : "Create API key"}
      onClose={close}
      isDismissDisabled={pending}
      footer={
        token ? (
          <>
            <Button variant="secondary" onPress={() => void copy()}>
              <HugeiconsIcon icon={Copy01Icon} size={16} />{" "}
              {copied ? "Copied" : "Copy API key"}
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
              isDisabled={pending || !name.trim()}
            >
              {pending ? "Creating…" : "Create API key"}
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="content-grid">
          <p className="text-xs font-normal text-muted">
            Save this key in your secret storage. It is shown only in this
            dialog and cannot be viewed again after you close it.
          </p>
          <TextField
            label="API key"
            className="max-md:text-base!"
            value={token}
            readOnly
            autoComplete="off"
          />
          <ErrorMessage>{error}</ErrorMessage>
          {copied && (
            <p
              role="status"
              className="text-xs font-normal text-success-soft-foreground"
            >
              API key copied.
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
            label="Expiry"
            value={expiry}
            onChange={setExpiry}
            disabled={pending}
            items={[30, 60, 90, 365].map((days) => ({
              id: String(days),
              name: `${days} days`,
            }))}
          />
          <p className="text-xs font-normal text-muted">
            This key uses your current permissions. Keep it private; you can
            revoke it at any time.
          </p>
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
      title="Revoke API key?"
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
              {pending ? "Revoking…" : "Revoke API key"}
            </Button>
          </>
        )
      }
    >
      <div className="content-grid">
        <p className="text-xs font-normal text-muted">
          {complete ? (
            <>
              <strong className="font-normal text-foreground">
                {credential.name}
              </strong>{" "}
              has been revoked. Its access has ended.
            </>
          ) : (
            <>
              Tools using{" "}
              <strong className="font-normal text-foreground">
                {credential.name}
              </strong>{" "}
              will lose access immediately. You can create a new key if they
              need access again.
            </>
          )}
        </p>
        <ErrorMessage>{error}</ErrorMessage>
        {complete && (
          <p
            role="status"
            className="text-xs font-normal text-success-soft-foreground"
          >
            API key revoked.
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
  return (
    <div className="content-grid min-w-0">
      <PageHeading
        title="API keys"
        icon={<HugeiconsIcon icon={Key01Icon} size={20} />}

        actions={
          <Button onPress={() => setCreating(true)}>
            <Plus /> Create API key
          </Button>
        }
      />
      <section
        className="min-w-0 space-y-3"
        aria-label="API keys"
        role="region"
      >
        <div className="min-w-0">
          {pending && items === null ? (
            <p role="status" className="text-xs font-normal text-muted">
              Loading API keys…
            </p>
          ) : error && items === null ? (
            <div className="content-grid">
              <ErrorMessage>{error}</ErrorMessage>
              <Button variant="secondary" onPress={() => void refresh()}>
                Retry loading API keys
              </Button>
            </div>
          ) : items?.length ? (
            <Table>
              <Table.ScrollContainer>
                <Table.Content
                  aria-label="API keys"
                  className="max-md:w-full! max-md:table-fixed!"
                >
                  <Table.Header>
                    <Table.Column isRowHeader>API key</Table.Column>
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
                            variant="danger-soft"
                            aria-label={`Revoke ${credential.name}`}
                            onPress={() => setRevoking(credential)}
                          >
                            <HugeiconsIcon icon={ShieldBanIcon} size={16} />
                            Revoke
                          </Button>
                        ) : null;
                      return (
                        <Table.Row key={credential.id} id={credential.id}>
                          <Table.Cell className="whitespace-normal!">
                            <TableCellStack className="md:max-w-xs">
                              <span className="break-words">
                                {credential.name}
                              </span>
                              <Chip size="small" variant="secondary">
                                {credential.tokenType === "oauth"
                                  ? "OAuth"
                                  : "API key"}
                              </Chip>
                              <div className="grid gap-0.5 md:hidden">
                                <TableCellDescription>
                                  Expires {date(credential.expiresAt)}
                                </TableCellDescription>
                                <TableCellDescription>
                                  {credential.lastUsedAt
                                    ? `Last used ${date(credential.lastUsedAt)}`
                                    : "Never used"}
                                </TableCellDescription>
                              </div>
                              <div className="flex items-center justify-between gap-3 pt-1 md:hidden">
                                {status}
                                {revoke}
                              </div>
                            </TableCellStack>
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            {status}
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            <span className="text-sm font-normal">
                              {date(credential.expiresAt)}
                            </span>
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            <span className="text-sm font-normal">
                              {credential.lastUsedAt
                                ? date(credential.lastUsedAt)
                                : "Never used"}
                            </span>
                          </Table.Cell>
                          <Table.Cell className="hidden md:table-cell">
                            {revoke ?? (
                              <span className="text-sm font-normal text-muted">
                                —
                              </span>
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
                <EmptyState.Title>No API keys yet</EmptyState.Title>
                <EmptyState.Description>
                  Create a personal key to use Mill through the REST API.
                </EmptyState.Description>
              </EmptyState.Header>
            </EmptyState>
          )}
          {items !== null && error && (
            <div className="content-grid">
              <ErrorMessage>{error}</ErrorMessage>
              <Button variant="secondary" onPress={() => void refresh()}>
                Retry loading API keys
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
                    : "Load more API keys"}
              </Button>
            </div>
          </div>
        )}
      </section>
      {creating && (
        <CreateCredential
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
