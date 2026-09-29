// Adapted from Towbar's Apache-2.0 team-settings and ResourceTable compositions.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Avatar,
  Button,
  Chip,
  Choice,
  Dialog,
  EmptyState,
  ErrorMessage,
  Spinner,
  Table,
  TableCellStack,
  TableCellDescription,
  Tooltip,
  TextField,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  CrownIcon,
  EyeIcon,
  UserShield01Icon,
  Clock01Icon,
  CheckmarkCircle01Icon,
  InformationCircleIcon,
  Mail01Icon,
  PencilEdit02Icon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { Member, Role } from "../../../packages/contracts/src/index.js";
import { api, errorText, type Session } from "./api.js";
import { Check, Trash2 } from "./icons.js";
import { PageHeading } from "./page-heading.js";

type Invitation = {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};
const roleNames: Record<Role, string> = {
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};
const roleOptions = Object.entries(roleNames).map(([id, name]) => ({
  id,
  name,
}));
type ListState<T> = {
  items: T[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  nextCursor: string | null;
};

function usePeopleList<T>(path: string) {
  const [state, setState] = useState<ListState<T>>({
    items: [],
    loading: true,
    error: "",
    hasMore: false,
    nextCursor: null,
  });
  const sequence = useRef(0);
  const attemptedCursor = useRef<string | undefined>(undefined);
  const load = useCallback(
    async (cursor?: string) => {
      const request = ++sequence.current;
      attemptedCursor.current = cursor;
      setState((previous) => ({ ...previous, loading: true, error: "" }));
      try {
        const result = await api<{
          items: T[];
          hasMore?: boolean;
          nextCursor?: string | null;
        }>(`${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (request !== sequence.current) return;
        setState((previous) => ({
          items: cursor ? [...previous.items, ...result.items] : result.items,
          loading: false,
          error: "",
          hasMore: result.hasMore ?? false,
          nextCursor: result.nextCursor ?? null,
        }));
      } catch (error) {
        if (request !== sequence.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: errorText(error),
        }));
      }
    },
    [path],
  );
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  return { ...state, load, retry: () => load(attemptedCursor.current) };
}

function PeopleSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section role="region" aria-label={label} className="content-grid min-w-0">
      {children}
    </section>
  );
}
function RoleChip({ role }: { role: Role }) {
  return (
    <Chip
      variant="secondary"
      icon={
        <HugeiconsIcon
          icon={
            role === "admin"
              ? CrownIcon
              : role === "member"
                ? UserShield01Icon
                : EyeIcon
          }
        />
      }
    >
      {roleNames[role]}
    </Chip>
  );
}
function RemovalHint({
  name,
  isProtected,
  children,
}: {
  name: string;
  isProtected: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!isProtected) return children;
  return (
    <Tooltip isOpen={open} onOpenChange={setOpen}>
      <Tooltip.Trigger<"span">
        role="group"
        aria-label={`Removal unavailable for ${name}`}
        tabIndex={0}
        className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus [&_button]:pointer-events-none"
        onFocus={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content
        placement="top"
        showArrow
        className="max-w-[min(16rem,calc(100vw-2rem))] whitespace-normal text-xs"
      >
        <Tooltip.Arrow />
        This is the last administrator. Make another person an administrator
        before removing access.
      </Tooltip.Content>
    </Tooltip>
  );
}

function LoadingPeople({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-2 text-xs text-muted">
      <Spinner size="sm" />
      <span>{children}</span>
    </div>
  );
}
function invitationStatus(invitation: Invitation) {
  if (invitation.acceptedAt)
    return {
      label: "Accepted",
      variant: "success" as const,
      icon: CheckmarkCircle01Icon,
    };
  if (invitation.revokedAt)
    return {
      label: "Revoked",
      variant: "secondary" as const,
      icon: InformationCircleIcon,
    };
  if (Date.parse(invitation.expiresAt) <= Date.now())
    return {
      label: "Expired",
      variant: "secondary" as const,
      icon: InformationCircleIcon,
    };
  return { label: "Pending", variant: "warning" as const, icon: Clock01Icon };
}

export function PeopleSettings({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => void;
}) {
  const members = usePeopleList<Member>("/auth/members");
  const invitations = usePeopleList<Invitation>("/auth/invitations");
  const [inviteOpen, setInviteOpen] = useState(false);
  const inviteTrigger = useRef<HTMLButtonElement>(null);
  const inviteWasOpened = useRef(false);
  const actionButtons = useRef(new Map<string, HTMLButtonElement>());
  const actionTrigger = useRef<string | null>(null);
  const [action, setAction] = useState<
    | { kind: "role" | "remove"; member: Member }
    | { kind: "revoke"; invitation: Invitation }
    | null
  >(null);
  const adminCount = members.items.filter(
    (member) => member.role === "admin",
  ).length;
  const completeDirectory = members.items.length < 1000;
  useEffect(() => {
    if (!action && actionTrigger.current) {
      const trigger = actionButtons.current.get(actionTrigger.current);
      actionTrigger.current = null;
      if (
        trigger?.isConnected &&
        !trigger.disabled &&
        trigger.getAttribute("aria-disabled") !== "true"
      ) {
        trigger.focus();
        return;
      }
      inviteTrigger.current?.focus();
    }
  }, [action]);
  function rememberAction(key: string) {
    return (element: HTMLButtonElement | null) => {
      if (element) actionButtons.current.set(key, element);
      else actionButtons.current.delete(key);
    };
  }
  useLayoutEffect(() => {
    if (!inviteOpen && inviteWasOpened.current) {
      inviteWasOpened.current = false;
      inviteTrigger.current?.focus();
    }
  }, [inviteOpen]);
  useEffect(() => {
    document.title = "People · Mill";
  }, []);
  function changed() {
    if (action?.kind === "revoke") void invitations.load();
    else {
      void members.load();
      onRefresh();
    }
  }
  return (
    <section className="settings-page">
      <PageHeading
        title="People"
        icon={<HugeiconsIcon icon={UserMultipleIcon} size={20} />}
        actions={
          <Button
            ref={inviteTrigger}
            onPress={() => {
              inviteWasOpened.current = true;
              setInviteOpen(true);
            }}
          >
            <HugeiconsIcon icon={Mail01Icon} size={16} />
            Invite a person
          </Button>
        }
      />
      <div className="content-grid min-w-0">
        <PeopleSection label="Workspace members">
          <ErrorMessage>{members.error}</ErrorMessage>
          {members.error && (
            <div>
              <Button
                variant="secondary"
                isDisabled={members.loading}
                onPress={() => void members.retry()}
              >
                Retry people
              </Button>
            </div>
          )}
          {members.loading && <LoadingPeople>Loading people…</LoadingPeople>}
          {!members.loading && !members.error && !members.items.length && (
            <EmptyState>
              <EmptyState.Header>
                <EmptyState.Title>No people to show</EmptyState.Title>
                <EmptyState.Description>
                  Invite a person to join this workspace.
                </EmptyState.Description>
              </EmptyState.Header>
            </EmptyState>
          )}
          {!!members.items.length && (
            <Table>
              <Table.ScrollContainer>
                <Table.Content
                  aria-label="Workspace members"
                  className="w-full max-md:w-full! max-md:table-fixed!"
                >
                  <Table.Header>
                    <Table.Column isRowHeader>Person</Table.Column>
                    <Table.Column className="hidden w-28 md:table-cell">
                      Role
                    </Table.Column>
                    <Table.Column className="w-24 text-right max-md:w-20!">
                      Actions
                    </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {members.items.map((member) => {
                      const lastAdmin =
                        completeDirectory &&
                        member.role === "admin" &&
                        adminCount === 1;
                      return (
                        <Table.Row key={member.id} id={member.id}>
                          <Table.Cell className="whitespace-normal!">
                            <div className="flex min-w-0 items-start gap-3">
                              <Avatar
                                email={member.email}
                                name={member.name}
                                size="sm"
                                className="shrink-0"
                              />
                              <TableCellStack
                                as="div"
                                className="whitespace-normal"
                              >
                                <span className="break-words">
                                  {member.name}
                                  {member.id === session.user.id && (
                                    <span className="font-normal text-muted">
                                      {" "}
                                      (you)
                                    </span>
                                  )}
                                </span>
                                <TableCellDescription className="break-all">
                                  {member.email}
                                </TableCellDescription>
                                <div className="pt-1 md:hidden">
                                  <RoleChip role={member.role} />
                                </div>
                              </TableCellStack>
                            </div>
                          </Table.Cell>
                          <Table.Cell className="hidden align-middle md:table-cell">
                            <RoleChip role={member.role} />
                          </Table.Cell>
                          <Table.Cell className="align-top max-md:w-20! md:align-middle">
                            <div className="flex flex-col items-end gap-1 md:flex-row md:justify-end">
                              <Button
                                ref={rememberAction(`role:${member.id}`)}
                                onFocus={(event) => {
                                  event.stopPropagation();
                                }}
                                variant="secondary"
                                isIconOnly
                                aria-label={`Edit role for ${member.name}`}
                                isDisabled={members.loading || lastAdmin}
                                onPress={() => {
                                  actionTrigger.current = `role:${member.id}`;
                                  setAction({ kind: "role", member });
                                }}
                              >
                                <HugeiconsIcon
                                  icon={PencilEdit02Icon}
                                  size={16}
                                />
                              </Button>
                              <RemovalHint
                                name={member.name}
                                isProtected={lastAdmin}
                              >
                                <Button
                                  ref={rememberAction(`remove:${member.id}`)}
                                  onFocus={(event) => {
                                    event.stopPropagation();
                                  }}
                                  variant="danger"
                                  isIconOnly
                                  aria-label={`Remove ${member.name}`}
                                  isDisabled={members.loading || lastAdmin}
                                  onPress={() => {
                                    actionTrigger.current = `remove:${member.id}`;
                                    setAction({ kind: "remove", member });
                                  }}
                                >
                                  <Trash2 />
                                </Button>
                              </RemovalHint>
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
          {!completeDirectory && (
            <p className="text-xs text-muted">
              This directory shows the first 1,000 people.
            </p>
          )}
        </PeopleSection>
        <PeopleSection label="Invitations">
          <ErrorMessage>{invitations.error}</ErrorMessage>
          {invitations.error && (
            <div>
              <Button
                variant="secondary"
                isDisabled={invitations.loading}
                onPress={() => void invitations.retry()}
              >
                Retry invitations
              </Button>
            </div>
          )}
          {invitations.loading && (
            <LoadingPeople>
              {invitations.items.length
                ? "Loading more invitations…"
                : "Loading invitations…"}
            </LoadingPeople>
          )}
          {!invitations.loading &&
            !invitations.error &&
            !invitations.items.length && (
              <EmptyState>
                <EmptyState.Header>
                  <EmptyState.Title>No invitations yet</EmptyState.Title>
                  <EmptyState.Description>
                    Choose Invite a person to share access to your workspace.
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            )}
          {!!invitations.items.length && (
            <Table>
              <Table.ScrollContainer>
                <Table.Content
                  aria-label="Workspace invitations"
                  className="w-full max-md:w-full! max-md:table-fixed!"
                >
                  <Table.Header>
                    <Table.Column isRowHeader>Invitation</Table.Column>
                    <Table.Column className="hidden w-28 md:table-cell">
                      Role
                    </Table.Column>
                    <Table.Column className="hidden w-24 md:table-cell">
                      Status
                    </Table.Column>
                    <Table.Column className="w-20 text-right max-md:w-20!">
                      Actions
                    </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {invitations.items.map((invitation) => {
                      const status = invitationStatus(invitation);
                      return (
                        <Table.Row key={invitation.id} id={invitation.id}>
                          <Table.Cell className="whitespace-normal!">
                            <TableCellStack
                              as="div"
                              className="whitespace-normal"
                            >
                              <span className="break-all">
                                {invitation.email}
                              </span>
                              <TableCellDescription>
                                Expires{" "}
                                {new Date(
                                  invitation.expiresAt,
                                ).toLocaleDateString(undefined, {
                                  timeZone: session.user.timeZone,
                                })}
                              </TableCellDescription>
                              <div className="flex flex-wrap gap-1 pt-1 md:hidden">
                                <RoleChip role={invitation.role} />
                                <Chip
                                  variant={status.variant}
                                  icon={<HugeiconsIcon icon={status.icon} />}
                                >
                                  {status.label}
                                </Chip>
                              </div>
                            </TableCellStack>
                          </Table.Cell>
                          <Table.Cell className="hidden align-middle md:table-cell">
                            <RoleChip role={invitation.role} />
                          </Table.Cell>
                          <Table.Cell className="hidden align-middle md:table-cell">
                            <Chip
                              variant={status.variant}
                              icon={<HugeiconsIcon icon={status.icon} />}
                            >
                              {status.label}
                            </Chip>
                          </Table.Cell>
                          <Table.Cell className="align-top max-md:w-20! md:align-middle">
                            <div className="flex justify-end">
                              {status.label === "Pending" && (
                                <Button
                                  ref={rememberAction(
                                    `revoke:${invitation.id}`,
                                  )}
                                  onFocus={(event) => {
                                    event.stopPropagation();
                                  }}
                                  variant="danger"
                                  isIconOnly
                                  aria-label={`Revoke invitation for ${invitation.email}`}
                                  onPress={() => {
                                    actionTrigger.current = `revoke:${invitation.id}`;
                                    setAction({ kind: "revoke", invitation });
                                  }}
                                >
                                  <Trash2 />
                                </Button>
                              )}
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
          {invitations.hasMore && (
            <div>
              <Button
                variant="secondary"
                isDisabled={invitations.loading}
                onPress={() =>
                  void invitations.load(invitations.nextCursor ?? undefined)
                }
              >
                Load more invitations
              </Button>
            </div>
          )}
        </PeopleSection>
      </div>
      {inviteOpen && (
        <InvitePersonDialog
          onClose={() => setInviteOpen(false)}
          onCreated={() => void invitations.load()}
        />
      )}
      {action && (
        <PeopleActionDialog
          key={
            action.kind === "revoke" ? action.invitation.id : action.member.id
          }
          action={action}
          onClose={() => setAction(null)}
          onSaved={changed}
        />
      )}
    </section>
  );
}

function InvitePersonDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    inviteUrl: string;
    emailDelivery: "unavailable" | "sent" | "failed";
  } | null>(null);
  const [copied, setCopied] = useState(false);
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      setResult(await api("/auth/invitations", { email, role }));
      onCreated();
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(result!.inviteUrl);
      setCopied(true);
      setError("");
    } catch {
      setError(
        "The link could not be copied. Select the invitation link and copy it manually.",
      );
    }
  }
  return (
    <Dialog
      open
      title={result ? "Invitation created" : "Invite a person"}
      onClose={onClose}
      isDismissDisabled={busy}
      size="sm"
      footer={
        result ? (
          <>
            <Button variant="secondary" onPress={() => void copy()}>
              {copied ? (
                <Check />
              ) : (
                <HugeiconsIcon icon={Copy01Icon} size={16} />
              )}
              {copied ? "Copied" : "Copy invitation link"}
            </Button>
            <Button onPress={onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" isDisabled={busy} onPress={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="invite-person-form" isDisabled={busy}>
              {busy ? "Creating invitation…" : "Create invitation"}
            </Button>
          </>
        )
      }
    >
      <div className="content-grid">
        <ErrorMessage>{error}</ErrorMessage>
        {result ? (
          <>
            <p className="text-xs">
              Share this private link with {email}. It expires after seven days.
            </p>
            <TextField
              label="Invitation link"
              value={result.inviteUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="text-xs text-muted">
              {result.emailDelivery === "sent"
                ? "Invitation email sent."
                : result.emailDelivery === "failed"
                  ? "The invitation email could not be sent. Share the link directly."
                  : "Email delivery is not configured. Copy the link to share it directly."}
            </p>
            {copied && (
              <p role="status" className="text-xs text-success-soft-foreground">
                Invitation link copied.
              </p>
            )}
          </>
        ) : (
          <form
            id="invite-person-form"
            className="content-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={320}
              required
              disabled={busy}
              autoFocus
            />
            <Choice
              label="Role"
              value={role}
              onChange={setRole}
              items={roleOptions}
              disabled={busy}
            />
            <p className="text-xs text-muted">
              Members can change tasks. Viewers can read boards. Administrators
              can manage access.
            </p>
            {busy && (
              <p role="status" className="text-xs text-muted">
                Creating the invitation…
              </p>
            )}
          </form>
        )}
      </div>
    </Dialog>
  );
}

type PeopleAction =
  | { kind: "role" | "remove"; member: Member }
  | { kind: "revoke"; invitation: Invitation };
function PeopleActionDialog({
  action,
  onClose,
  onSaved,
}: {
  action: PeopleAction;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState(
    action.kind === "revoke" ? action.invitation.role : action.member.role,
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const title =
    action.kind === "revoke"
      ? `Revoke invitation for ${action.invitation.email}?`
      : action.kind === "role"
        ? `Edit role for ${action.member.name}`
        : `Remove ${action.member.name}?`;
  const label =
    action.kind === "role"
      ? "Update role"
      : action.kind === "remove"
        ? "Remove access"
        : "Revoke invitation";
  async function save() {
    if (pending.current || saved) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "revoke")
        await api(`/auth/invitations/${action.invitation.id}`, {}, "DELETE");
      else
        await api(
          `/auth/members/${action.member.id}`,
          action.kind === "role" ? { role } : {},
          action.kind === "role" ? "PATCH" : "DELETE",
        );
      setSaved(true);
      onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      size="sm"
      isDismissDisabled={busy}
      footer={
        saved ? (
          <Button onPress={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" isDisabled={busy} onPress={onClose}>
              Cancel
            </Button>
            <Button
              variant={action.kind === "role" ? "primary" : "danger"}
              isDisabled={
                busy || (action.kind === "role" && role === action.member.role)
              }
              onPress={() => void save()}
            >
              {busy ? "Updating…" : label}
            </Button>
          </>
        )
      }
    >
      <div className="content-grid">
        <ErrorMessage>{error}</ErrorMessage>
        {saved ? (
          <p role="status" className="text-xs text-success-soft-foreground">
            {action.kind === "role"
              ? "Role updated."
              : action.kind === "remove"
                ? "Workspace access removed."
                : "Invitation revoked."}
          </p>
        ) : action.kind === "role" ? (
          <>
            <p className="break-all text-xs text-muted">
              {action.member.email}
            </p>
            <Choice
              label={`Role for ${action.member.name}`}
              value={role}
              onChange={(value) => setRole(value as Role)}
              items={roleOptions}
              disabled={busy}
            />
          </>
        ) : (
          <p className="text-xs">
            {action.kind === "remove"
              ? `${action.member.name} will lose workspace access. Their comments and activity stay in the history.`
              : "This invitation will no longer grant workspace access."}
          </p>
        )}
        {busy && (
          <p role="status" className="text-xs text-muted">
            {action.kind === "role"
              ? "Updating the role…"
              : action.kind === "remove"
                ? "Removing access…"
                : "Revoking the invitation…"}
          </p>
        )}
      </div>
    </Dialog>
  );
}
