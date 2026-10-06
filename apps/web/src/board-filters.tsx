import { SecondarySection } from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { ChoiceField, HistoryFilter } from "@avgeek-oss/design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  FilterResetIcon,
  Flag01Icon,
  Layers01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Avatar, Button, useAppSuspended } from "@mill/web-design-system";
import type { Member } from "../../../packages/contracts/src/index.js";
import type { BoardUrlState } from "./board-url.js";
import { priorityOptions } from "./task-priority.js";
import { statusOptions } from "./task-status.js";

export function BoardFilters({
  filters,
  members,
  hasFilters,
  onChange,
  onClear,
}: {
  filters: BoardUrlState;
  members: Member[];
  hasFilters: boolean;
  onChange: (value: Partial<BoardUrlState>) => void;
  onClear: () => void;
}) {
  const suspended = useAppSuspended();
  if (suspended) return null;
  return (
    <div className="grid min-w-0 gap-3" aria-label="Task filters">
      <SecondarySection title="Sort tasks">
        <ChoiceField
          label="Sort order"
          value={filters.sort}
          onChange={(sort) => onChange({ sort, page: 1 })}
          options={[
            { id: "createdAt", label: "Newest first" },
            { id: "title", label: "Title" },
            { id: "updatedAt", label: "Recently updated" },
            { id: "dueDate", label: "Due date" },
            { id: "priority", label: "Priority" },
            { id: "status", label: "Status" },
          ].map((item) => ({
            ...item,
            icon: <HugeiconsIcon icon={Layers01Icon} size={16} aria-hidden />,
          }))}
        />
      </SecondarySection>
      <SecondarySection title="Filter tasks">
        <div className="grid min-w-0 gap-4">
          <HistoryFilter
            label="Assignee"
            value={filters.assigneeId}
            onChange={(assigneeId) => onChange({ assigneeId, page: 1 })}
            allIcon={
              <HugeiconsIcon icon={UserGroupIcon} size={16} aria-hidden />
            }
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
                    className="size-5"
                  />
                ),
              })),
            ]}
          />
          <HistoryFilter
            label="Priority"
            value={filters.priority}
            onChange={(priority) => onChange({ priority, page: 1 })}
            allIcon={<HugeiconsIcon icon={Flag01Icon} size={16} aria-hidden />}
            options={priorityOptions.map((option) => ({
              id: option.id,
              label: option.name,
              icon: option.startContent,
            }))}
          />
          <HistoryFilter
            label="Status"
            value={filters.status}
            onChange={(status) => onChange({ status, page: 1 })}
            allIcon={
              <HugeiconsIcon icon={Layers01Icon} size={16} aria-hidden />
            }
            options={statusOptions.map((option) => ({
              id: option.id,
              label: option.name,
              icon: option.startContent,
            }))}
          />
          {(hasFilters || filters.sort !== "createdAt") && (
            <Button variant="secondary" onPress={onClear}>
              <HugeiconsIcon icon={FilterResetIcon} aria-hidden="true" />
              Clear filters
            </Button>
          )}
        </div>
      </SecondarySection>
    </div>
  );
}
