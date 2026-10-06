import { QueryFeedback } from "./query-feedback.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Choice,
  Dialog,
  ErrorMessage,
  TextField,
} from "@mill/web-design-system";
import {
  Button,
  QueryLoading,
  MembersTable,
  ResourceTable,
  StatusIndicator,
} from "@avgeek-oss/design-system";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { UserAvatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import type { ChoiceOption } from "@avgeek-oss/design-system";
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
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { Member, Role } from "../../../packages/contracts/src/index.js";
import { ApiError, api, errorText, type Session } from "./api.js";
import { PageHeading } from "./page-heading.js";
import { RelativeDateTime, useCurrentTime } from "./relative-date-time.js";

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
const roleIcons = {
  admin: CrownIcon,
  member: UserShield01Icon,
  viewer: EyeIcon,
} satisfies Record<Role, typeof CrownIcon>;
const roleOptions = Object.entries(roleNames).map(([id, name]) => ({
  id,
  name,
  startContent: (
    <HugeiconsIcon
      icon={roleIcons[id as Role]}
      className="size-4 shrink-0"
      aria-hidden="true"
    />
  ),
}));
const sharedRoleOptions: ChoiceOption<Role>[] = Object.entries(roleNames).map(
  ([id, label]) => ({
    id: id as Role,
    label,
    icon: <HugeiconsIcon icon={roleIcons[id as Role]} aria-hidden />,
  }),
);
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
        let activeCursor = cursor;
        let result: {
          items: T[];
          hasMore?: boolean;
          nextCursor?: string | null;
        } | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            result = await api<{
              items: T[];
              hasMore?: boolean;
              nextCursor?: string | null;
            }>(
              `${path}${activeCursor ? `?cursor=${encodeURIComponent(activeCursor)}` : ""}`,
            );
            break;
          } catch (cause) {
            if (
              !(cause instanceof ApiError && cause.status === 409) ||
              !activeCursor ||
              attempt > 0
            )
              throw cause;
            activeCursor = undefined;
            attemptedCursor.current = undefined;
          }
        }
        if (!result)
          throw new Error("The people list could not be completed. Try again.");
        if (request !== sequence.current) return;
        setState((previous) => ({
          items: activeCursor
            ? [...previous.items, ...result.items]
            : result.items,
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
  busy,
  children,
}: {
  label: string;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <section
      role="region"
      aria-label={label}
      aria-busy={busy}
      className="content-grid min-w-0"
    >
      {children}
    </section>
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

function invitationStatus(invitation: Invitation) {
  if (invitation.acceptedAt)
    return {
      label: "Accepted",
      color: "success" as const,
      icon: CheckmarkCircle01Icon,
    };
  if (invitation.revokedAt)
    return {
      label: "Revoked",
      color: "default" as const,
      icon: InformationCircleIcon,
    };
  return { label: "Pending", color: "warning" as const, icon: Clock01Icon };
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
  const now = useCurrentTime();
  const visibleInvitations = invitations.items.filter(
    (invitation) => Date.parse(invitation.expiresAt) > now,
  );
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
  const completeDirectory =
    !members.loading && !members.error && !members.hasMore;
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
      requestAnimationFrame(() => {
        if (!actionTrigger.current && document.activeElement === document.body)
          inviteTrigger.current?.focus();
      });
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
  async function changed() {
    if (action?.kind === "revoke") await invitations.load();
    else {
      await members.load();
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
        <PeopleSection label="Workspace members" busy={members.loading}>
          {members.loading && !members.items.length && (
            <QueryLoading>Loading people</QueryLoading>
          )}
          {members.error && (
            <QueryFeedback
              message={members.error}
              onRetry={() => void members.retry()}
            />
          )}
          {(!members.loading || members.items.length > 0) &&
            !(!members.items.length && members.error) && (
              <MembersTable
                items={members.items}
                roles={sharedRoleOptions}
                emptyDescription="Invite a person to join this workspace."
                actions={(member) => {
                  const lastAdmin =
                    completeDirectory &&
                    member.role === "admin" &&
                    adminCount === 1;
                  return (
                    <>
                      <Button
                        ref={rememberAction(`role:${member.id}`)}
                        variant="secondary"
                        aria-label={`Edit role for ${member.name}`}
                        isDisabled={!completeDirectory || lastAdmin}
                        onPress={() => {
                          actionTrigger.current = `role:${member.id}`;
                          setAction({ kind: "role", member });
                        }}
                      >
                        Edit
                      </Button>
                      <RemovalHint name={member.name} isProtected={lastAdmin}>
                        <Button
                          ref={rememberAction(`remove:${member.id}`)}
                          variant="danger"
                          aria-label={`Remove ${member.name}`}
                          isDisabled={!completeDirectory || lastAdmin}
                          onPress={() => {
                            actionTrigger.current = `remove:${member.id}`;
                            setAction({ kind: "remove", member });
                          }}
                        >
                          Remove
                        </Button>
                      </RemovalHint>
                    </>
                  );
                }}
              />
            )}
          {!members.error && members.hasMore && members.nextCursor && (
            <div className="grid justify-items-start gap-2">
              <p className="text-sm text-muted">
                Load the full directory before changing roles or removing
                people.
              </p>
              <Button
                variant="secondary"
                isDisabled={members.loading}
                onPress={() => void members.load(members.nextCursor!)}
              >
                {members.loading ? "Loading people…" : "Load more people"}
              </Button>
            </div>
          )}
        </PeopleSection>
        <PeopleSection label="Invitations" busy={invitations.loading}>
          {invitations.loading && !invitations.items.length && (
            <QueryLoading>Loading invitations</QueryLoading>
          )}
          {invitations.error && (
            <QueryFeedback
              message={invitations.error}
              onRetry={() => void invitations.retry()}
            />
          )}
          {(!invitations.loading || visibleInvitations.length > 0) &&
            !(!visibleInvitations.length && invitations.error) && (
              <ResourceTable
                ariaLabel="Pending invitations"
                items={visibleInvitations}
                getRowKey={(invitation) => invitation.id}
                emptyTitle="No pending invitations"
                emptyDescription="Invite a person to share access to your workspace."
                columns={[
                  {
                    key: "email",
                    header: "Invitation",
                    cell: (invitation) => (
                      <div className="flex min-w-0 items-center gap-2">
                        <UserAvatar email={invitation.email} aria-hidden />
                        <span className="break-words">{invitation.email}</span>
                      </div>
                    ),
                  },
                  {
                    key: "role",
                    header: "Role",
                    cell: (invitation) => (
                      <StatusIndicator
                        label={roleNames[invitation.role]}
                        icon={
                          <HugeiconsIcon icon={roleIcons[invitation.role]} />
                        }
                      />
                    ),
                  },
                  {
                    key: "expires",
                    header: "Expires",
                    cell: (invitation) => (
                      <RelativeDateTime
                        value={invitation.expiresAt}
                        timeZone={session.user.timeZone}
                        label="Invitation expires"
                        prefix="Expires"
                        showAbsolute={false}
                        compact
                      />
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    cell: (invitation) => {
                      const status = invitationStatus(invitation);
                      return (
                        <StatusIndicator
                          label={status.label}
                          color={status.color}
                          icon={<HugeiconsIcon icon={status.icon} />}
                        />
                      );
                    },
                  },
                  {
                    key: "actions",
                    header: "Actions",
                    headerClassName: "text-right",
                    cell: (invitation) =>
                      invitationStatus(invitation).label === "Pending" ? (
                        <div className="flex justify-end">
                          <Button
                            ref={rememberAction(`revoke:${invitation.id}`)}
                            variant="danger"
                            aria-label={`Revoke invitation for ${invitation.email}`}
                            onPress={() => {
                              actionTrigger.current = `revoke:${invitation.id}`;
                              setAction({ kind: "revoke", invitation });
                            }}
                          >
                            Revoke
                          </Button>
                        </div>
                      ) : null,
                  },
                ]}
              />
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
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const invitation = await api<{
        inviteUrl: string;
        emailDelivery: "unavailable" | "sent" | "failed";
      }>("/auth/invitations", { email, role });
      setResult(invitation);
      toast.success(
        invitation.emailDelivery === "sent"
          ? "Invitation created and email sent."
          : "Invitation created.",
      );
      if (invitation.emailDelivery === "failed")
        toast.danger(
          "The invitation email could not be sent. Share the link directly.",
        );
      onCreated();
    } catch (error) {
      setError(errorText(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(result!.inviteUrl);
      toast.success("Invitation link copied.");
      setError("");
    } catch {
      toast.danger(
        "The link could not be copied. Select the invitation link and copy it manually.",
      );
    }
  }
  return (
    <Dialog
      open
      title={result ? "Invitation link" : "Invite a person"}
      onClose={onClose}
      isDismissDisabled={busy}
      size="sm"
      footer={
        result ? (
          <>
            <Button variant="secondary" onPress={() => void copy()}>
              <HugeiconsIcon icon={Copy01Icon} size={16} />
              Copy invitation link
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
            <p className="text-sm">
              Share this private link with {email}. It expires after seven days.
            </p>
            <TextField
              label="Invitation link"
              value={result.inviteUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            {result.emailDelivery === "unavailable" && (
              <p className="text-sm text-muted">
                Email delivery is not configured. Copy the link to share it
                directly.
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
              <p role="status" className="text-sm text-muted">
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
  onSaved: () => Promise<void>;
}) {
  const [role, setRole] = useState(
    action.kind === "revoke" ? action.invitation.role : action.member.role,
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
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
    if (pending.current) return;
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
      await onSaved();
      toast.success(
        action.kind === "role"
          ? "Role updated."
          : action.kind === "remove"
            ? "Workspace access removed."
            : "Invitation revoked.",
      );
      onClose();
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
      }
    >
      <div className="content-grid">
        <ErrorMessage>{error}</ErrorMessage>
        {action.kind === "role" ? (
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
          <p className="text-sm">
            {action.kind === "remove"
              ? `${action.member.name} will lose workspace access. Their comments and activity stay in the history.`
              : "This invitation will no longer grant workspace access."}
          </p>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted">
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
