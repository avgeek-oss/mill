import { useState } from "react";
import { ChoiceField, HistoryFilter } from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar03Icon,
  Clock01Icon,
  HistoryIcon,
  Layers01Icon,
  SortingAZ01Icon,
  Task01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Avatar, Button, Dialog } from "@mill/web-design-system";
import type { Member } from "../../../packages/contracts/src/index.js";
import type { BoardUrlState } from "./board-url.js";
import { PriorityIcon, priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";

type TaskFilters = Pick<BoardUrlState, "assigneeId" | "priority" | "status">;

export function BoardFiltersDialog({
  filters,
  members,
  onApply,
  onClose,
}: {
  filters: TaskFilters;
  members: Member[];
  onApply: (filters: TaskFilters) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TaskFilters>(() => ({
    assigneeId: filters.assigneeId,
    priority: filters.priority,
    status: filters.status,
  }));
  return (
    <Dialog
      open
      onClose={onClose}
      title="Filter tasks"
      footer={
        <>
          <Button
            variant="secondary"
            className="mr-auto"
            isDisabled={!draft.assigneeId && !draft.priority && !draft.status}
            onPress={() =>
              setDraft({ assigneeId: "", priority: "", status: "" })
            }
          >
            Clear filters
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button onPress={() => onApply(draft)}>Apply filters</Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-4">
        <HistoryFilter
          label="Assignee"
          value={draft.assigneeId}
          onChange={(assigneeId) =>
            setDraft((current) => ({ ...current, assigneeId }))
          }
          allIcon={<HugeiconsIcon icon={UserGroupIcon} size={16} aria-hidden />}
          searchPlaceholder="Search assignees…"
          options={[
            {
              id: "unassigned",
              label: "Unassigned",
              icon: (
                <HugeiconsIcon icon={UserGroupIcon} size={16} aria-hidden />
              ),
            },
            ...members.map((member) => ({
              id: member.id,
              label: member.name,
              searchText: `${member.name} ${member.email}`,
              icon: (
                <Avatar
                  email={member.email}
                  name={member.name}
                  size="sm"
                  className="size-6 [&_[data-slot=avatar-fallback]]:text-[10px]"
                />
              ),
            })),
          ]}
        />
        <HistoryFilter
          label="Priority"
          value={draft.priority}
          onChange={(priority) =>
            setDraft((current) => ({ ...current, priority }))
          }
          allIcon={<PriorityIcon />}
          options={priorityOptions.map((option) => ({
            id: option.id,
            label: option.name,
            icon: option.startContent,
          }))}
        />
        <HistoryFilter
          label="Status"
          value={draft.status}
          onChange={(status) => setDraft((current) => ({ ...current, status }))}
          allIcon={<HugeiconsIcon icon={Layers01Icon} size={16} aria-hidden />}
          options={statusOptions.map((option) => ({
            id: option.id,
            label: option.name,
            icon: option.startContent,
          }))}
        />
      </div>
    </Dialog>
  );
}

export function BoardSortDialog({
  sort,
  onApply,
  onClose,
}: {
  sort: string;
  onApply: (sort: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(sort);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Sort tasks"
      footer={
        <>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button onPress={() => onApply(draft)}>Apply sort</Button>
        </>
      }
    >
      <ChoiceField
        label="Sort order"
        value={draft}
        onChange={setDraft}
        options={[
          {
            id: "createdAt",
            label: "Newest first",
            icon: <HugeiconsIcon icon={Clock01Icon} size={16} aria-hidden />,
          },
          {
            id: "title",
            label: "Title",
            icon: (
              <HugeiconsIcon icon={SortingAZ01Icon} size={16} aria-hidden />
            ),
          },
          {
            id: "updatedAt",
            label: "Recently updated",
            icon: <HugeiconsIcon icon={HistoryIcon} size={16} aria-hidden />,
          },
          {
            id: "dueDate",
            label: "Due date",
            icon: <HugeiconsIcon icon={Calendar03Icon} size={16} aria-hidden />,
          },
          { id: "priority", label: "Priority", icon: <PriorityIcon /> },
          {
            id: "status",
            label: "Status",
            icon: <HugeiconsIcon icon={Task01Icon} size={16} aria-hidden />,
          },
        ]}
      />
    </Dialog>
  );
}
