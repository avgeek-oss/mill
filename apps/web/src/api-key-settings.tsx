import { useOverlaySuspension } from "@avgeek-oss/design-system/overlays/overlay-suspension";
import { QueryFeedback } from "./query-feedback.js";
// Adapted from Towbar's public Apache-2.0 API/MCP settings composition.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../../../packages/contracts/src/index.js";
import { Button, QueryLoading, toast } from "@mill/web-design-system";
import {
  ApiKeysSettings as SharedApiKeysSettings,
  AuthorizedClientsTable,
  AsyncActionButton,
  CreateApiKeyDialog,
  type ApiKey,
  type AuthorizedClient,
} from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { Plus } from "./icons.js";
import {
  api,
  createRetryKey,
  errorText,
  isResponseObject,
  type Session,
} from "./api.js";
import { PageHeading } from "./page-heading.js";
import { RelativeDateTime } from "./relative-date-time.js";

type Credential = {
  id: string;
  name: string;
  scopes: string[];
  boardIds: string[] | null;
  tokenType: "api-key" | "oauth";
  tokenPrefix?: string;
  oauthClientId?: string | null;
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
  return Date.parse(credential.expiresAt) <= Date.now() ? "Expired" : "Active";
}

function CreateCredential({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (credential: Credential) => void;
}) {
  const overlay = useOverlaySuspension();
  const [retryKey] = useState(createRetryKey);
  return (
    <CreateApiKeyDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) {
          retryKey.reset();
          onClose();
        }
      }}
      expiryOptions={[30, 60, 90, 365].map((days) => ({
        id: String(days),
        label: `${days} days`,
      }))}
      defaultExpiry="30"
      onCreate={async ({ name, expiry }) => {
        const isCurrent = overlay.capture();
        const payload = { name: name.trim(), expiresInDays: Number(expiry) };
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
        if (!isCurrent())
          throw new DOMException("The operation was canceled.", "AbortError");
        retryKey.reset();
        onCreated(result.credential);
        toast.success("API key created.");
        return { token: result.token };
      }}
    >
      <p className="text-xs text-muted">
        This key uses your current permissions. Keep it private; you can revoke
        it at any time.
      </p>
    </CreateApiKeyDialog>
  );
}

export function ApiKeySettings({
  session,
  boards,
  onRefresh,
}: {
  session: Session;
  boards: Board[];
  onRefresh: () => void;
}) {
  const overlay = useOverlaySuspension();
  const [items, setItems] = useState<Credential[] | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [morePending, setMorePending] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [creating, setCreating] = useState(false);
  const revokeKeys = useRef(
    new Map<string, ReturnType<typeof createRetryKey>>(),
  );
  const generation = useRef(0);
  const revokedIds = useRef(new Set<string>());
  const visibleCredentials = useCallback(
    (credentials: Credential[]) =>
      credentials.filter(
        (credential) =>
          !credential.revokedAt && !revokedIds.current.has(credential.id),
      ),
    [],
  );
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
        setItems(visibleCredentials(page.items));
        setNextCursor(page.nextCursor);
      }
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    } finally {
      if (current === generation.current) setPending(false);
    }
  }, [visibleCredentials]);
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
            ...visibleCredentials(page.items).filter(
              (item) => !existing.has(item.id),
            ),
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
    setError("");
    try {
      const page = await api<CredentialPage>("/credentials");
      if (current === generation.current) {
        const fresh = new Set(page.items.map((item) => item.id));
        setItems((previous) => [
          ...visibleCredentials(page.items),
          ...(previous ?? []).filter((item) => !fresh.has(item.id)),
        ]);
        setNextCursor((previous) => previous ?? page.nextCursor);
        setError("");
      }
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    }
  }
  async function revoke(id: string) {
    const isCurrent = overlay.capture();
    const path = `/credentials/${id}`;
    let retryKey = revokeKeys.current.get(id);
    if (!retryKey) {
      retryKey = createRetryKey();
      revokeKeys.current.set(id, retryKey);
    }
    await api(path, undefined, "DELETE", {
      validateResponse: (value) =>
        isResponseObject(value) && value.revoked === true,
      headers: {
        "Idempotency-Key": retryKey.forRequest(path, undefined, "DELETE"),
      },
    });
    if (!isCurrent())
      throw new DOMException("The operation was canceled.", "AbortError");
    revokeKeys.current.delete(id);
    revokedIds.current.add(id);
    setItems((previous) => previous?.filter((item) => item.id !== id) ?? null);
    toast.success("Access revoked.");
    onRefresh();
  }
  function keyRecord(credential: Credential): ApiKey {
    const state = stateOf(credential);
    return {
      id: credential.id,
      name: credential.name,
      expiresAt: credential.expiresAt,
      tokenHint: credential.tokenPrefix,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
      permissions: "Your current REST permissions",
      status: {
        label: state,
        color: state === "Active" ? "success" : "warning",
      },
    };
  }
  function authorizedRecord(credential: Credential): AuthorizedClient {
    const boardNames = credential.boardIds
      ?.map((id) => boards.find((board) => board.id === id)?.name)
      .filter((name): name is string => !!name);
    const permissions = credential.scopes.includes("write")
      ? "Read and edit"
      : "Read only";
    return {
      ...keyRecord(credential),
      client: {
        name: credential.name,
        ...(credential.oauthClientId ? { id: credential.oauthClientId } : {}),
      },
      permissions: `${permissions}${credential.boardIds ? (boardNames?.length ? ` · ${boardNames.join(", ")}` : " · Approved boards") : " · All boards"}`,
    };
  }
  const apiKeys = (items ?? [])
    .filter((item) => item.tokenType === "api-key")
    .map(keyRecord);
  const authorizedClients = (items ?? [])
    .filter((item) => item.tokenType === "oauth")
    .map(authorizedRecord);
  const formatDate = (value: string) => (
    <RelativeDateTime
      value={value}
      dateFormat={session.user.dateFormat}
      timeFormat={session.user.timeFormat}
      timeZone={session.user.timeZone}
    />
  );
  return (
    <section className="settings-page min-w-0">
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
        className="content-grid min-w-0"
        aria-label="API keys"
        role="region"
        aria-busy={pending || morePending}
      >
        {error ? (
          <QueryFeedback message={error} onRetry={() => void refresh()} />
        ) : null}
        {pending && items === null ? (
          <QueryLoading className="sr-only">Loading API keys</QueryLoading>
        ) : items !== null ? (
          <>
            <SharedApiKeysSettings
              items={apiKeys}
              formatDate={formatDate}
              emptyDescription="Create a personal key to use Mill through the REST API."
              onRevoke={revoke}
            />
            <h2 className="text-lg font-medium">Authorized clients</h2>
            <AuthorizedClientsTable
              items={authorizedClients}
              formatDate={formatDate}
              emptyDescription="Connect an MCP client by signing in and approving its access."
              actions={(item) => (
                <AsyncActionButton
                  variant="danger"
                  onAction={() => revoke(item.id)}
                  confirmation={{
                    title: `Revoke ${item.client.name}?`,
                    description:
                      "This client will lose access immediately. Sign in from the client again to reconnect.",
                    confirmLabel: "Revoke access",
                  }}
                >
                  Revoke
                </AsyncActionButton>
              )}
            />
          </>
        ) : null}
        {nextCursor ? (
          <div className="content-grid">
            {moreError ? (
              <QueryFeedback message={moreError} onRetry={() => void more()} />
            ) : null}
            <div>
              <Button
                variant="secondary"
                isDisabled={morePending}
                onPress={() => void more()}
              >
                {morePending ? "Loading…" : "Load more credentials"}
              </Button>
            </div>
          </div>
        ) : null}
      </section>
      {creating && (
        <CreateCredential
          onClose={() => setCreating(false)}
          onCreated={(credential) => {
            setItems((previous) => [
              ...visibleCredentials([credential]),
              ...(previous ?? []).filter((item) => item.id !== credential.id),
            ]);
            if (items === null) void refresh();
            else void reconcile();
            onRefresh();
          }}
        />
      )}
    </section>
  );
}
