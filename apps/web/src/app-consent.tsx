import { apiOrigin, apiUrl } from "./runtime-config.js";
import { useIdentityConfirmation } from "./identity-confirmation.js";
import { QueryFeedback } from "./query-feedback.js";
import { useEffect, useRef, useState } from "react";
import { Choice, toast } from "@mill/web-design-system";
import {
  AuthScreen,
  ButtonLink,
  McpAuthorization,
  QueryLoading,
} from "@avgeek-oss/design-system";
import { AuthBrand } from "./auth.js";
import {
  ApiError,
  errorText,
  isResponseObject,
  responseError,
  type Session,
} from "./api.js";
import { useBoardDirectory } from "./board-directory.js";

type ConsentDetails = {
  clientName: string;
  clientId: string;
  clientTrust: "unverified" | "metadata-document";
  redirectUri: string;
  scope: string;
  canApprove: boolean;
  expiresIn: number;
  user: { name: string; role: "admin" | "member" | "viewer" };
};
type ConnectionState =
  | { phase: "pending" }
  | { phase: "failed"; error: string }
  | { phase: "ready"; details: ConsentDetails };

function validDetails(value: unknown): value is ConsentDetails {
  if (!isResponseObject(value) || !isResponseObject(value.user)) return false;
  if (
    typeof value.clientName !== "string" ||
    !value.clientName.trim() ||
    typeof value.clientId !== "string" ||
    !value.clientId ||
    typeof value.clientTrust !== "string" ||
    !["unverified", "metadata-document"].includes(value.clientTrust) ||
    typeof value.redirectUri !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.canApprove !== "boolean" ||
    !Number.isSafeInteger(value.expiresIn) ||
    Number(value.expiresIn) <= 0 ||
    typeof value.user.name !== "string" ||
    typeof value.user.role !== "string" ||
    !["admin", "member", "viewer"].includes(value.user.role)
  )
    return false;
  try {
    const redirect = new URL(value.redirectUri);
    return (
      !redirect.username &&
      !redirect.password &&
      !redirect.hash &&
      (redirect.protocol === "https:" ||
        (redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))
    );
  } catch {
    return false;
  }
}

function decisionRedirect(
  value: unknown,
  details: ConsentDetails,
  allow: boolean,
) {
  if (!isResponseObject(value) || typeof value.redirectTo !== "string")
    return null;
  try {
    const target = new URL(value.redirectTo);
    const expected = new URL(details.redirectUri);
    const oauthKeys = new Set(["code", "error", "state", "iss"]);
    const callbackParams = (url: URL) =>
      [...url.searchParams.entries()].filter(([key]) => !oauthKeys.has(key));
    if (
      target.username ||
      target.password ||
      target.hash ||
      target.origin !== expected.origin ||
      target.pathname !== expected.pathname ||
      JSON.stringify(callbackParams(target)) !==
        JSON.stringify(callbackParams(expected)) ||
      target.searchParams.get("iss") !== apiOrigin() ||
      (allow
        ? !target.searchParams.get("code")?.trim()
        : target.searchParams.get("error") !== "access_denied")
    )
      return null;
    return target;
  } catch {
    return null;
  }
}

async function consentRequest(
  id: string,
  signal: AbortSignal,
  decision?: { allow: boolean; boardIds?: string[] },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(apiUrl(`/oauth/consent/${encodeURIComponent(id)}`), {
      method: decision ? "POST" : "GET",
      credentials: "include",
      signal,
      ...(decision
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(decision),
          }
        : {}),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(
      0,
      "Mill could not be reached. Check your connection and try again.",
    );
  }
  if (response.status === 401) {
    const current = await fetch(apiUrl("/auth/me"), {
      credentials: "include",
      signal,
    });
    if (current.status === 401 && !signal.aborted)
      window.dispatchEvent(new Event("mill:expired"));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "The server response could not be read. Try again.",
    );
  }
  if (!response.ok)
    throw responseError(
      response.status,
      body,
      response.headers.get("x-request-id") ?? undefined,
    );
  return body;
}

function useRequestId() {
  const read = () => new URLSearchParams(window.location.search).get("request");
  const [id, setId] = useState(read);
  useEffect(() => {
    const update = () => setId(read());
    window.addEventListener("popstate", update);
    window.addEventListener("mill:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("mill:navigate", update);
    };
  }, []);
  return id;
}

export function AppConsent({
  session,
  requestId,
}: {
  session: Session;
  requestId?: string | null;
}) {
  const locationId = useRequestId();
  const id = requestId === undefined ? locationId : requestId;
  return (
    <ConsentRequest
      key={`${session.user.id}:${session.user.role}:${id ?? "missing"}`}
      id={id}
      session={session}
    />
  );
}

function ConsentRequest({
  id,
  session,
}: {
  id: string | null;
  session: Session;
}) {
  const identity = useIdentityConfirmation();
  const [connection, setConnection] = useState<ConnectionState>({
    phase: "pending",
  });
  const [attempt, setAttempt] = useState(0);
  const [boardId, setBoardId] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);
  const [complete, setComplete] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const decisionPending = useRef(false);
  const decisionController = useRef<AbortController | null>(null);
  const active = useRef(true);
  const directory = useBoardDirectory(
    id ? `${session.user.id}:${session.user.role}:${id}` : null,
  );
  const [previousBoards, setPreviousBoards] = useState<typeof directory.boards>(
    [],
  );
  useEffect(() => {
    if (!directory.pending && !directory.error)
      setPreviousBoards(directory.boards);
  }, [directory.boards, directory.pending, directory.error]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      decisionController.current?.abort();
    };
  }, []);
  useEffect(() => {
    document.title = "Connect to Mill · Mill";
    if (!id) return;
    const controller = new AbortController();
    setConnection({ phase: "pending" });
    setDecisionError("");
    void consentRequest(id, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!validDetails(value))
          throw new Error("The connection details were incomplete. Try again.");
        setConnection({ phase: "ready", details: value });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setConnection({ phase: "failed", error: errorText(cause) });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const details = connection.phase === "ready" ? connection.details : null;
  const scopes = details?.scope.trim().split(/\s+/) ?? [];
  const validScope =
    scopes.includes("read") &&
    scopes.every((scope) => scope === "read" || scope === "write");
  const write = scopes.includes("write");
  const canWrite =
    details?.user.role !== "viewer" && session.user.role !== "viewer";
  const choices = directory.boards;
  const displayedBoards =
    directory.pending || directory.error ? previousBoards : choices;
  const selectedAvailable =
    !boardId || choices.some((board) => board.id === boardId);
  const allowAvailable =
    !!details &&
    details.canApprove &&
    validScope &&
    (!write || canWrite) &&
    !directory.pending &&
    !directory.error &&
    selectedAvailable;

  async function decide(allow: boolean) {
    if (
      !id ||
      !details ||
      unconfirmed ||
      decisionPending.current ||
      (allow && !allowAvailable)
    )
      return;
    decisionPending.current = true;
    setDecision(allow ? "allow" : "deny");
    setDecisionError("");
    const controller = new AbortController();
    decisionController.current = controller;
    try {
      const selection = {
        allow,
        ...(allow && boardId ? { boardIds: [boardId] } : {}),
      };
      let response: unknown;
      try {
        response = await consentRequest(id, controller.signal, selection);
      } catch (cause) {
        if (!(
          allow &&
          cause instanceof ApiError &&
          cause.code === "REAUTHENTICATION_REQUIRED" &&
          (await identity.confirmIdentity())
        ))
          throw cause;
        if (!active.current || controller.signal.aborted) return;
        response = await consentRequest(id, controller.signal, selection);
      }
      if (!active.current || controller.signal.aborted) return;
      const target = decisionRedirect(response, details, allow);
      if (!target) {
        setUnconfirmed(true);
        throw new Error(
          "The connection response could not be confirmed. Start again from your app.",
        );
      }
      setComplete(true);
      toast.success(allow ? "Access allowed." : "Access denied.");
      window.location.assign(target.href);
    } catch (cause: unknown) {
      if (!active.current || controller.signal.aborted) return;
      setDecisionError(errorText(cause));
      if (
        allow &&
        cause instanceof ApiError &&
        [400, 403, 404].includes(cause.status)
      )
        void directory.reload();
      setDecision(null);
      decisionPending.current = false;
    }
  }

  const blockedReason = !validScope ? (
    "This app requested unsupported permissions. Start a new connection with read or read and write access."
  ) : write && !canWrite ? (
    "Your Viewer role cannot grant edit access. Reconnect with read-only access."
  ) : !details?.canApprove ? (
    "Your account cannot grant the requested access."
  ) : directory.pending ? (
    "Wait for your available boards to load."
  ) : directory.error || !selectedAvailable ? (
    <span className="text-muted">
      Access requires a confirmed connection and an available board selection.
    </span>
  ) : undefined;
  if (!id)
    return (
      <AuthScreen brand={<AuthBrand />} title="Connect to Mill">
        <QueryFeedback message="This connection link is incomplete. Start again from your app." />
      </AuthScreen>
    );
  if (connection.phase === "pending")
    return (
      <AuthScreen brand={<AuthBrand />} title="Connect to Mill">
        <QueryLoading className="sr-only">
          Loading connection request…
        </QueryLoading>
      </AuthScreen>
    );
  if (connection.phase === "failed")
    return (
      <AuthScreen brand={<AuthBrand />} title="Connect to Mill">
        <QueryFeedback
          message={connection.error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </AuthScreen>
    );
  if (unconfirmed)
    return (
      <AuthScreen
        brand={<AuthBrand />}
        title="Connect to Mill"
        description="Start a new connection from your app to request access."
      >
        <QueryFeedback message={decisionError} />
        <ButtonLink href="/boards" variant="secondary">
          Back to Mill
        </ButtonLink>
      </AuthScreen>
    );
  if (!details) return null;
  const redirect = new URL(details.redirectUri);
  return (
    <>
      {identity.confirmation}
      <McpAuthorization
        brand={<AuthBrand />}
        productName="Mill"
        isPending={!!decision || complete}
        error={decisionError || undefined}
        approvalBlockedReason={blockedReason}
        onAllow={() => void decide(true)}
        onDeny={() => void decide(false)}
        details={{
          clientName: details.clientName,
          clientId: details.clientId,
          clientTrust: details.clientTrust,
          identityDescription:
            details.clientTrust === "metadata-document"
              ? "The app publishes its details in an HTTPS metadata document. This does not verify the app making this request."
              : "The app supplied its own name. Mill has not verified its identity.",
          redirectUri: details.redirectUri,
          account: {
            email: session.user.email,
            name: session.user.name,
            teamName: session.workspace.name,
            role: session.user.role,
          },
          permissionSummary: validScope
            ? `Wants to ${write ? "read and write to" : "read"} your Mill boards, tasks, and comments.`
            : "Requested permissions are unsupported.",
          accessDescription: `${write ? "Can view and make changes allowed by your Mill role." : "Can only view data allowed by your Mill role."} Cannot manage accounts or reveal stored credentials.`,
          accessLifetime:
            details.expiresIn % 86400 === 0
              ? `${details.expiresIn / 86400} days`
              : `${details.expiresIn} seconds`,
          revocationDescription: "Revoke access anytime in API keys.",
          restrictions:
            "Administrative access is excluded. Access remains limited by your current membership, role, and approved boards.",
          deviceConnectionNotice: ["localhost", "127.0.0.1", "[::1]"].includes(
            redirect.hostname,
          )
            ? "This opens an app on your device. Only continue if you started this connection yourself."
            : undefined,
        }}
      >
        <div className="content-grid min-w-0" aria-busy={directory.pending}>
          <Choice
            label="Approved boards"
            value={boardId}
            onChange={setBoardId}
            items={[
              { id: "", name: "All allowed boards" },
              ...displayedBoards.map((board) => ({
                id: board.id,
                name: board.name,
              })),
            ]}
            search
            disabled={!!decision || directory.pending || !!directory.error}
          />
          {directory.error && (
            <QueryFeedback
              message={directory.error}
              onRetry={() => void directory.reload()}
            />
          )}
        </div>
      </McpAuthorization>
    </>
  );
}
