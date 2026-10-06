import { ArrowDown01Icon, ClipboardListIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  Autocomplete,
  BreadcrumbTrail,
  Dropdown,
  Link,
  ListBox,
  SearchField,
  Select,
} from "@mill/web-design-system";
import type { Board } from "../../../packages/contracts/src/index.js";
import { navigate } from "./api.js";
import {
  accountSections,
  teamSections,
  isAccountSection,
  settingsTitles,
} from "./settings-navigation.js";

export function AppBreadcrumbs({
  boards,
  boardsHref,
  boardId,
  boardName,
  taskId,
  taskIdentifier,
  settingsSection,
  admin,
  search,
  fallback,
}: {
  boards: Board[];
  boardsHref: string;
  boardId?: string;
  boardName: string;
  taskId?: string;
  taskIdentifier?: string;
  settingsSection?: string;
  admin: boolean;
  search: string;
  fallback: string;
}) {
  // An interrupted exit must not reuse a blurred overlay whose autofocus already ran.
  const owner = boardId ? `board:${boardId}` : `settings:${settingsSection}`;
  const [popover, setPopover] = useState({
    owner,
    isOpen: false,
    presentation: 0,
  });
  function onOpenChange(isOpen: boolean) {
    setPopover((previous) =>
      previous.owner === owner && previous.isOpen === isOpen
        ? previous
        : {
            owner,
            isOpen,
            presentation: previous.presentation + Number(isOpen),
          },
    );
  }
  if (boardId) {
    const boardHref = `/boards/${boardId}${search}`;
    const options = boards.some((board) => board.id === boardId)
      ? boards
      : [{ id: boardId, name: boardName }, ...boards];
    const switcher = (
      <Select
        isOpen={popover.owner === owner && popover.isOpen}
        onOpenChange={onOpenChange}
        className="min-w-0"
        aria-label="Switch board"
        selectedKey={boardId}
        onSelectionChange={(key) => {
          if (
            typeof key === "string" &&
            key !== boardId &&
            boards.some((board) => board.id === key)
          )
            navigate(`/boards/${key}`);
        }}
      >
        <Select.Trigger
          className="breadcrumb-board-trigger"
          aria-label={taskId ? `Switch board: ${boardName}` : undefined}
        >
          {!taskId && (
            <Select.Value className="min-w-0 truncate">
              {boardName}
            </Select.Value>
          )}
          <Select.Indicator className="static size-3 shrink-0 text-muted" />
        </Select.Trigger>
        <Select.Popover
          key={popover.presentation}
          className="breadcrumb-popover w-72 max-w-[calc(100vw-2rem)] overflow-hidden"
        >
          <Autocomplete.Filter
            filter={(text, query) =>
              text
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase())
            }
          >
            <SearchField
              aria-label="Search boards"
              className="px-2 pt-2"
              variant="secondary"
            >
              <SearchField.Group className="rounded-md">
                <SearchField.SearchIcon />
                <SearchField.Input
                  placeholder="Search boards…"
                  maxLength={200}
                />
                <SearchField.ClearButton aria-label="Clear board search" />
              </SearchField.Group>
            </SearchField>
            <ListBox
              className="max-h-80 overflow-y-auto"
              renderEmptyState={() => (
                <p className="px-3 py-4 text-sm text-muted">
                  No matching boards.
                </p>
              )}
            >
              {options.map((board) => (
                <ListBox.Item
                  key={board.id}
                  id={board.id}
                  textValue={board.name}
                >
                  <HugeiconsIcon
                    aria-hidden
                    icon={ClipboardListIcon}
                    size={16}
                    className="shrink-0 text-muted"
                  />
                  <span className="min-w-0 flex-1 truncate">{board.name}</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Autocomplete.Filter>
        </Select.Popover>
      </Select>
    );
    return (
      <BreadcrumbTrail
        items={[
          { label: "Boards", href: boardsHref },
          {
            label: boardName,
            content: taskId ? (
              <span className="flex min-w-0 items-center gap-1">
                <Link
                  href={boardHref}
                  className="min-w-0 truncate text-sm font-normal text-muted hover:text-foreground"
                >
                  {boardName}
                </Link>
                {switcher}
              </span>
            ) : (
              switcher
            ),
          },
          ...(taskId ? [{ label: taskIdentifier ?? "Task" }] : []),
        ]}
      />
    );
  }
  if (settingsSection && settingsTitles[settingsSection]) {
    const account = isAccountSection(settingsSection);
    const category = account ? "Account" : "Team";
    const sections = account
      ? accountSections.flatMap((group) => group.items)
      : admin
        ? teamSections.flatMap((group) => group.items)
        : [];
    return (
      <BreadcrumbTrail
        items={[
          {
            label: category,
            content: (
              <Dropdown
                isOpen={popover.owner === owner && popover.isOpen}
                onOpenChange={onOpenChange}
              >
                <Dropdown.Trigger
                  aria-label={`Navigate ${category.toLowerCase()} pages`}
                  className="flex min-w-0 items-center gap-1 rounded-sm text-sm text-muted outline-none hover:text-foreground"
                >
                  {category}
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    aria-hidden
                    className="shrink-0"
                  />
                </Dropdown.Trigger>
                <Dropdown.Popover
                  key={popover.presentation}
                  placement="bottom start"
                  className="breadcrumb-popover w-56 max-w-[calc(100vw-2rem)]"
                >
                  <Dropdown.Menu aria-label={`${category} pages`}>
                    {sections.map((section) => (
                      <Dropdown.Item
                        key={section.id}
                        id={section.id}
                        href={`/settings/${section.id}`}
                        textValue={section.label}
                      >
                        <HugeiconsIcon
                          aria-hidden
                          icon={section.icon}
                          size={16}
                          className="size-4 shrink-0 text-muted"
                        />
                        {section.label}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            ),
          },
          { label: settingsTitles[settingsSection] },
        ]}
      />
    );
  }
  return <BreadcrumbTrail items={[{ label: fallback }]} />;
}
