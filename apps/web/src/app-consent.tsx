// Adapted from Towbar's Apache-2.0 mcp-oauth-consent and public AuthFrame composition.
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Choice,
  ErrorMessage,
  Spinner,
} from "@mill/web-design-system";
import { ApiError, errorText, isResponseObject, type Session } from "./api.js";
import { useBoardDirectory } from "./board-directory.js";
import { AuthFrame } from "./identity-ui.js";

type ConsentDetails = {
  clientName: string;
  clientId: string;
  clientTrust: "unverified" | "metadata-document";
  redirectUri: string;
  scope: string;
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
      target.searchParams.get("iss") !== window.location.origin ||
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
    response = await fetch(`/api/oauth/consent/${encodeURIComponent(id)}`, {
      method: decision ? "POST" : "GET",
      credentials: "same-origin",
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
    const current = await fetch("/api/auth/me", {
      credentials: "same-origin",
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
  if (!response.ok) {
    const message = isResponseObject(body)
      ? typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : "This connection could not be completed. Try again."
      : "This connection could not be completed. Try again.";
    throw new ApiError(response.status, message);
  }
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
  const choices = directory.boards.filter((board) => !board.deletedAt);
  const selectedAvailable =
    !boardId || choices.some((board) => board.id === boardId);
  const allowAvailable =
    !!details &&
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
      const response = await consentRequest(id, controller.signal, {
        allow,
        ...(allow && boardId ? { boardIds: [boardId] } : {}),
      });
      if (!active.current || controller.signal.aborted) return;
      const target = decisionRedirect(response, details, allow);
      if (!target) {
        setUnconfirmed(true);
        throw new Error(
          "The connection response could not be confirmed. Start again from your app.",
        );
      }
      setComplete(true);
      window.location.assign(target.href);
    } catch (cause: unknown) {
      if (!active.current || controller.signal.aborted) return;
      setDecisionError(errorText(cause));
      setDecision(null);
      decisionPending.current = false;
    }
  }

  return (
    <AuthFrame
      title="Connect to Mill"
      description="Choose whether to give this app access."
    >
      {!id ? (
        <ErrorMessage>
          This connection link is incomplete. Start again from your app.
        </ErrorMessage>
      ) : connection.phase === "pending" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Spinner size="sm" /> Loading connection…
        </p>
      ) : connection.phase === "failed" ? (
        <div className="content-grid">
          <ErrorMessage>{connection.error}</ErrorMessage>
          <Button
            variant="secondary"
            onPress={() => setAttempt((value) => value + 1)}
          >
            Retry connection
          </Button>
        </div>
      ) : details ? (
        <form
          aria-label="Connection permissions"
          className="grid min-w-0 gap-6 pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <div className="grid min-w-0 gap-2">
            <p className="break-words text-base font-medium">
              {details.clientName}
            </p>
            <p className="text-sm text-muted">
              {validScope
                ? `Wants to ${write ? "read and edit" : "read"} your Mill boards, tasks, and comments.`
                : "The requested permissions are unavailable."}
            </p>
          </div>
          {details.clientTrust === "unverified" && (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  Unverified app. Only continue if you recognize this app and
                  started this connection yourself.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          )}
          <div className="grid min-w-0 gap-3 text-sm">
            <p>
              Signed in as{" "}
              <strong className="break-all">{session.user.email}</strong> in{" "}
              <strong className="break-words">{session.workspace.name}</strong>.
            </p>
            <p>
              {write
                ? "Can view and make changes allowed by your Mill role."
                : "Can only view data allowed by your Mill role."}{" "}
              Cannot manage accounts or reveal stored credentials. Revoke access
              anytime in Agent access.
            </p>
            <p className="text-muted">
              Returns to{" "}
              <span className="break-all">
                {new URL(details.redirectUri).origin}
              </span>
              .
            </p>
            {["localhost", "127.0.0.1", "[::1]"].includes(
              new URL(details.redirectUri).hostname,
            ) && (
              <p className="text-muted">
                This opens an app on your device. Only continue if you started
                this connection yourself.
              </p>
            )}
          </div>
          <div className="content-grid min-w-0">
            <Choice
              label="Approved boards"
              value={boardId}
              onChange={setBoardId}
              items={[
                { id: "", name: "All boards" },
                ...choices.map((board) => ({
                  id: board.id,
                  name: `${board.name}${board.archived ? " (archived)" : ""}`,
                })),
              ]}
              search
              disabled={!!decision || directory.pending || !!directory.error}
            />
            {directory.pending && (
              <p role="status" className="text-sm text-muted">
                Loading available boards…
              </p>
            )}
            {directory.error && (
              <>
                <ErrorMessage>{directory.error}</ErrorMessage>
                <Button
                  variant="secondary"
                  isDisabled={!!decision}
                  onPress={directory.reload}
                >
                  Retry boards
                </Button>
              </>
            )}
            {!selectedAvailable && (
              <ErrorMessage>
                This board is no longer available. Choose another board.
              </ErrorMessage>
            )}
          </div>
          <details className="min-w-0 text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center text-muted underline underline-offset-4">
              Connection details
            </summary>
            <div className="grid min-w-0 gap-3 pt-2 text-muted">
              <p>
                {details.clientTrust === "metadata-document"
                  ? "The app publishes its details in an HTTPS metadata document. This does not verify the app making this request."
                  : "The app supplied its own name. Mill has not verified its identity."}
              </p>
              <p>
                <span className="font-medium">Client ID</span>
                <span className="block break-all">{details.clientId}</span>
              </p>
              <p>
                <span className="font-medium">Return URL</span>
                <span className="block break-all">{details.redirectUri}</span>
              </p>
              <p>Administrative access is excluded.</p>
            </div>
          </details>
          {!validScope && (
            <ErrorMessage>
              This app requested unsupported permissions. Start a new connection
              with read or read and write access.
            </ErrorMessage>
          )}
          {write && !canWrite && (
            <ErrorMessage>
              Your Viewer role cannot grant edit access. Reconnect with
              read-only access.
            </ErrorMessage>
          )}
          <ErrorMessage>{decisionError}</ErrorMessage>
          {decision && (
            <p role="status" className="text-sm text-muted">
              {complete
                ? decision === "allow"
                  ? "Access allowed. Returning to your app…"
                  : "Access denied. Returning to your app…"
                : decision === "allow"
                  ? "Allowing access…"
                  : "Denying access…"}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              isDisabled={!allowAvailable || !!decision || unconfirmed}
            >
              Allow access
            </Button>
            <Button
              type="button"
              variant="secondary"
              isDisabled={!!decision || unconfirmed}
              onPress={() => void decide(false)}
            >
              Deny
            </Button>
          </div>
        </form>
      ) : null}
    </AuthFrame>
  );
}
