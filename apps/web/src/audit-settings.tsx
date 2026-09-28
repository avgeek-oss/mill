// Adapted from Towbar's Apache-2.0 team-audit-logs table composition.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Chip,
  EmptyState,
  ErrorMessage,
  Spinner,
  Table,
  Widget,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { Audit01Icon } from "@hugeicons/core-free-icons";
import type { Activity } from "../../../packages/contracts/src/index.js";
import { auditActionLabel } from "./audit-label.js";
import { api, errorText, type Session } from "./api.js";
import { PageHeading } from "./page-heading.js";

type AuditPage = {
  items: Activity[];
  hasMore: boolean;
  nextCursor: string | null;
};
type AuditState = {
  items: Activity[];
  loading: boolean;
  error: string;
  nextCursor: string | null;
};
const initialState: AuditState = {
  items: [],
  loading: true,
  error: "",
  nextCursor: null,
};

export function AuditSettings({ session }: { session: Session }) {
  const [state, setState] = useState(initialState);
  const sequence = useRef(0);
  const pending = useRef(false);
  const attemptedCursor = useRef<string | undefined>(undefined);
  const isAdmin = session.user.role === "admin";
  const load = useCallback(
    async (cursor?: string) => {
      if (!isAdmin || pending.current) return;
      pending.current = true;
      const request = ++sequence.current;
      attemptedCursor.current = cursor;
      setState((previous) => ({ ...previous, loading: true, error: "" }));
      try {
        const result = await api<AuditPage>(
          `/audit?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (request !== sequence.current) return;
        if (!Array.isArray(result.items))
          throw new Error("Activity could not be read. Try again.");
        setState((previous) => ({
          items: cursor ? [...previous.items, ...result.items] : result.items,
          loading: false,
          error: "",
          nextCursor: result.hasMore ? result.nextCursor : null,
        }));
      } catch (error) {
        if (request !== sequence.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: errorText(error),
        }));
      } finally {
        if (request === sequence.current) pending.current = false;
      }
    },
    [isAdmin, session.user.id],
  );
  useEffect(() => {
    document.title = "Audit history · Mill";
    setState(initialState);
    attemptedCursor.current = undefined;
    pending.current = false;
    void load();
    return () => {
      sequence.current++;
      pending.current = false;
    };
  }, [load]);

  const icon = <HugeiconsIcon icon={Audit01Icon} size={16} />;
  return (
    <section className="settings-page">
      <PageHeading title="Audit history" icon={icon} />
      {!isAdmin ? (
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>Administrator access required</EmptyState.Title>
            <EmptyState.Description>
              Only administrators can view workspace activity.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : (
        <div
          role="region"
          aria-label="Workspace activity"
          aria-busy={state.loading}
          className="content-grid min-w-0"
        >
          <Widget.Title icon={icon} help={false}>
            <h2 className="text-sm font-medium">Workspace activity</h2>
          </Widget.Title>
          {!state.items.length ? (
            <Widget className="min-w-0">
              <Widget.Content>
                {state.loading && (
                  <div
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted"
                  >
                    <Spinner size="sm" />
                    <span>Loading activity…</span>
                  </div>
                )}
                <ErrorMessage>{state.error}</ErrorMessage>
                {!state.loading && state.error && (
                  <div>
                    <Button
                      variant="secondary"
                      onPress={() => void load(attemptedCursor.current)}
                    >
                      Retry loading activity
                    </Button>
                  </div>
                )}
                {!state.loading && !state.error && (
                  <EmptyState>
                    <EmptyState.Header>
                      <EmptyState.Title>
                        No workspace activity yet
                      </EmptyState.Title>
                      <EmptyState.Description>
                        Activity appears here when people or agents make
                        changes.
                      </EmptyState.Description>
                    </EmptyState.Header>
                  </EmptyState>
                )}
              </Widget.Content>
            </Widget>
          ) : (
            <>
              {state.loading && (
                <div
                  role="status"
                  className="flex items-center gap-2 text-sm text-muted"
                >
                  <Spinner size="sm" />
                  <span>Loading older activity…</span>
                </div>
              )}
              <ErrorMessage>{state.error}</ErrorMessage>
              {!state.loading && state.error && (
                <div>
                  <Button
                    variant="secondary"
                    onPress={() => void load(attemptedCursor.current)}
                  >
                    Retry loading older activity
                  </Button>
                </div>
              )}
              <Table>
                <Table.ScrollContainer>
                  <Table.Content
                    aria-label="Audit history"
                    className="!w-full !table-fixed"
                  >
                    <Table.Header>
                      <Table.Column isRowHeader>Event</Table.Column>
                      <Table.Column className="w-32 sm:w-48">
                        Recorded
                      </Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {state.items.map((event) => (
                        <Table.Row key={event.id} id={event.id}>
                          <Table.Cell className="!whitespace-normal">
                            <div className="grid min-w-0 gap-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="text-sm font-medium [overflow-wrap:anywhere]">
                                  {event.actorName}
                                </span>
                                {event.actorKind === "agent" && (
                                  <Chip variant="secondary" size="small">
                                    Agent
                                  </Chip>
                                )}
                              </div>
                              <span className="text-sm text-muted [overflow-wrap:anywhere]">
                                {auditActionLabel(event)}
                              </span>
                            </div>
                          </Table.Cell>
                          <Table.Cell className="!whitespace-normal align-top">
                            <time
                              dateTime={event.createdAt}
                              className="text-xs text-muted"
                            >
                              {new Date(event.createdAt).toLocaleString(
                                undefined,
                                {
                                  timeZone: session.user.timeZone,
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                },
                              )}
                            </time>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
          {!!state.items.length && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted">
                {state.items.length.toLocaleString()} events shown.
                {!state.nextCursor && !state.loading && " All activity loaded."}
              </p>
              {state.nextCursor && !state.error && (
                <Button
                  variant="secondary"
                  isDisabled={state.loading}
                  onPress={() => void load(state.nextCursor ?? undefined)}
                >
                  {state.loading ? "Loading…" : "Load older activity"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
