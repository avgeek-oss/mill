import { useOverlaySuspension } from "@avgeek-oss/design-system/overlays/overlay-suspension";
import { QueryFeedback } from "./query-feedback.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  QueryLoading,
  MembersTable,
  InvitationsTable,
  InviteMemberDialog,
  MemberEditDialog,
  RemoveMemberDialog,
  RevokeInvitationDialog,
} from "@avgeek-oss/design-system";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import type { ChoiceOption } from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
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
import {
  ApiError,
  api,
  errorText,
  isResponseObject,
  type Session,
} from "./api.js";
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
  const peopleSection = useRef<HTMLElement>(null);
  const actionRegion = useRef<string | null>(null);
  const [action, setAction] = useState<
    | { kind: "role"; member: Member }
    | { kind: "remove"; member: Member }
    | { kind: "revoke"; invitation: Invitation }
    | null
  >(null);
  const adminCount = members.items.filter(
    (member) => member.role === "admin",
  ).length;
  const completeDirectory =
    !members.loading && !members.error && !members.hasMore;
  useEffect(() => {
    if (action && actionTrigger.current) {
      actionRegion.current =
        action.kind === "revoke" ? "Invitations" : "Workspace members";
    }
    if (!action && actionTrigger.current) {
      const key = actionTrigger.current;
      const region = actionRegion.current;
      let frame = 0;
      let stopped = false;
      const isRestoredGridFocus = (element: Element | null) =>
        Boolean(
          element?.matches('[role="grid"], [role="row"], [role="gridcell"]') &&
          peopleSection.current?.contains(element) &&
          element.closest('[role="region"]')?.getAttribute("aria-label") ===
            region,
        );
      function stop() {
        stopped = true;
        cancelAnimationFrame(frame);
        document.removeEventListener("focusin", onFocus);
        document.removeEventListener("pointerdown", stop, true);
        document.removeEventListener("keydown", stop, true);
      }
      function restore() {
        if (stopped) return;
        actionTrigger.current = null;
        actionRegion.current = null;
        const focused = document.activeElement;
        if (focused !== document.body && !isRestoredGridFocus(focused)) return;
        const trigger = actionButtons.current.get(key);
        if (
          trigger?.isConnected &&
          !trigger.disabled &&
          trigger.getAttribute("aria-disabled") !== "true"
        ) {
          trigger.focus();
        } else {
          inviteTrigger.current?.focus();
        }
      }
      function onFocus(event: FocusEvent) {
        const focused = event.target instanceof Element ? event.target : null;
        if (isRestoredGridFocus(focused)) {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(restore);
        } else if (
          focused !== document.body &&
          focused !== actionButtons.current.get(key) &&
          focused !== inviteTrigger.current
        ) {
          stop();
        }
      }
      // The grid can resume focus after its rows reconcile following deletion.
      document.addEventListener("focusin", onFocus);
      document.addEventListener("pointerdown", stop, true);
      document.addEventListener("keydown", stop, true);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(restore);
      });
      return stop;
    }
  }, [action]);
  function rememberAction(key: string) {
    return (element: HTMLButtonElement | null) => {
      if (element) actionButtons.current.set(key, element);
      else actionButtons.current.delete(key);
    };
  }
  useEffect(() => {
    if (!inviteOpen && inviteWasOpened.current) {
      const frame = requestAnimationFrame(() => {
        inviteWasOpened.current = false;
        inviteTrigger.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
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
    <section ref={peopleSection} className="settings-page">
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
            <QueryLoading className="sr-only">Loading people</QueryLoading>
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
                items={members.items.map((member) => ({
                  ...member,
                  accountStatus: { label: "Active", color: "success" as const },
                }))}
                roles={sharedRoleOptions}
                currentUserId={session.user.id}
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
            <QueryLoading className="sr-only">Loading invitations</QueryLoading>
          )}
          {invitations.error && (
            <QueryFeedback
              message={invitations.error}
              onRetry={() => void invitations.retry()}
            />
          )}
          {(!invitations.loading || visibleInvitations.length > 0) &&
            !(!visibleInvitations.length && invitations.error) && (
              <InvitationsTable
                items={visibleInvitations.map((invitation) => ({
                  ...invitation,
                  status: {
                    ...invitationStatus(invitation),
                    icon: (
                      <HugeiconsIcon icon={invitationStatus(invitation).icon} />
                    ),
                  },
                }))}
                roles={sharedRoleOptions}
                formatDate={(value) => (
                  <RelativeDateTime
                    value={value}
                    dateFormat={session.user.dateFormat}
                    timeFormat={session.user.timeFormat}
                    timeZone={session.user.timeZone}
                    label="Invitation expires"
                    prefix="Expires"
                    showAbsolute={false}
                    compact
                  />
                )}
                actions={(invitation) =>
                  invitationStatus(invitation).label === "Pending" ? (
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
                  ) : null
                }
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
  const overlay = useOverlaySuspension();
  const [emailDelivery, setEmailDelivery] = useState<
    "queued" | "unavailable"
  >();
  return (
    <InviteMemberDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      roles={sharedRoleOptions}
      defaultRole="member"
      resultGuidance={
        <p className="text-sm text-muted">
          {emailDelivery === "queued"
            ? "The invitation email is queued. You can also copy the link to share it directly."
            : "Email delivery is not configured. Copy the link to share it directly."}{" "}
          The invitation expires after seven days.
        </p>
      }
      onInvite={async (values) => {
        const isCurrent = overlay.capture();
        const invitation = await api<{
          inviteUrl: string;
          emailDelivery: "queued" | "unavailable";
        }>("/auth/invitations", values, "POST", {
          validateResponse: (value) =>
            isResponseObject(value) &&
            !("error" in value) &&
            typeof value.inviteUrl === "string" &&
            URL.canParse(value.inviteUrl) &&
            (value.emailDelivery === "queued" ||
              value.emailDelivery === "unavailable"),
        });
        if (!isCurrent())
          throw new DOMException("The operation was canceled.", "AbortError");
        setEmailDelivery(invitation.emailDelivery);
        toast.success(
          invitation.emailDelivery === "queued"
            ? "Invitation created and email queued."
            : "Invitation created.",
        );
        onCreated();
        return invitation;
      }}
    />
  );
}

type PeopleAction =
  | { kind: "role"; member: Member }
  | { kind: "remove"; member: Member }
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
  const overlay = useOverlaySuspension();
  if (action.kind === "role")
    return (
      <MemberEditDialog
        isOpen
        mode="role-only"
        member={action.member}
        roles={sharedRoleOptions}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onSave={async ({ role }) => {
          const isCurrent = overlay.capture();
          await api(`/auth/members/${action.member.id}`, { role }, "PATCH");
          if (!isCurrent())
            throw new DOMException("The operation was canceled.", "AbortError");
          await onSaved();
          if (!isCurrent())
            throw new DOMException("The operation was canceled.", "AbortError");
          toast.success("Role updated.");
        }}
      />
    );
  return (
    <PeopleRemovalDialog
      action={
        action.kind === "remove"
          ? { kind: "remove", member: action.member }
          : action
      }
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
function PeopleRemovalDialog({
  action,
  onClose,
  onSaved,
}: {
  action:
    | { kind: "remove"; member: Member }
    | { kind: "revoke"; invitation: Invitation };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const overlay = useOverlaySuspension();
  const changeOpen = (open: boolean) => {
    if (!open) onClose();
  };
  async function save() {
    const isCurrent = overlay.capture();
    if (action.kind === "revoke")
      await api(`/auth/invitations/${action.invitation.id}`, {}, "DELETE");
    else await api(`/auth/members/${action.member.id}`, {}, "DELETE");
    if (!isCurrent())
      throw new DOMException("The operation was canceled.", "AbortError");
    await onSaved();
    if (!isCurrent())
      throw new DOMException("The operation was canceled.", "AbortError");
    toast.success(
      action.kind === "remove"
        ? "Workspace access removed."
        : "Invitation revoked.",
    );
  }
  return action.kind === "remove" ? (
    <RemoveMemberDialog
      isOpen
      member={action.member}
      onOpenChange={changeOpen}
      onRemove={save}
    />
  ) : (
    <RevokeInvitationDialog
      isOpen
      email={action.invitation.email}
      onOpenChange={changeOpen}
      onRevoke={save}
    />
  );
}
