import { ClipboardListIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { AppShellBreadcrumbItems } from "@avgeek-oss/design-system/layouts/application-shell-types";
import {
  Autocomplete,
  Link,
  ListBox,
  SearchField,
} from "@mill/web-design-system";
import {
  BreadcrumbDropdown,
  BreadcrumbSelect,
} from "@avgeek-oss/design-system/navigation/breadcrumbs";
import type { Board } from "../../../packages/contracts/src/index.js";
import { navigate } from "./api.js";
import {
  accountSections,
  teamSections,
  isAccountSection,
  settingsTitles,
} from "./settings-navigation.js";

const BreadcrumbContext = createContext<AppShellBreadcrumbItems>([
  { label: "Mill", href: "/boards" },
]);
export const usePageBreadcrumbs = () => useContext(BreadcrumbContext);

function SettingsBreadcrumb({
  category,
  sections,
  section,
}: {
  category: string;
  sections: (typeof accountSections)[number]["items"];
  section: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => setIsOpen(false), [section]);
  return (
    <BreadcrumbDropdown.Root isOpen={isOpen} onOpenChange={setIsOpen}>
      <BreadcrumbDropdown.Trigger
        aria-label={`Navigate ${category.toLowerCase()} pages`}
        className="transition-colors focus-visible:[box-shadow:none]! focus-visible:outline-none!"
      >
        {category}
      </BreadcrumbDropdown.Trigger>
      <BreadcrumbDropdown.Popover
        placement="bottom start"
        className="breadcrumb-popover w-56 max-w-[calc(100vw-2rem)]"
      >
        <BreadcrumbDropdown.Menu aria-label={`${category} pages`}>
          {sections.map((item) => (
            <BreadcrumbDropdown.Item
              key={item.id}
              id={item.id}
              href={`/settings/${item.id}`}
              textValue={item.label}
            >
              <HugeiconsIcon
                aria-hidden
                icon={item.icon}
                size={16}
                className="size-4 shrink-0 text-muted"
              />
              {item.label}
            </BreadcrumbDropdown.Item>
          ))}
        </BreadcrumbDropdown.Menu>
      </BreadcrumbDropdown.Popover>
    </BreadcrumbDropdown.Root>
  );
}

function breadcrumbItems({
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
}): AppShellBreadcrumbItems {
  if (boardId) {
    const boardHref = `/boards/${boardId}${search}`;
    const options = boards.some((board) => board.id === boardId)
      ? boards
      : [{ id: boardId, name: boardName }, ...boards];
    const switcher = (
      <BreadcrumbSelect.Root
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
        <BreadcrumbSelect.Trigger
          className="transition-colors focus-visible:[box-shadow:none]! focus-visible:outline-none!"
          aria-label={taskId ? `Switch board: ${boardName}` : undefined}
        >
          {!taskId && (
            <BreadcrumbSelect.Value>{boardName}</BreadcrumbSelect.Value>
          )}
        </BreadcrumbSelect.Trigger>
        <BreadcrumbSelect.Popover className="breadcrumb-popover w-72 max-w-[calc(100vw-2rem)] overflow-hidden">
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
        </BreadcrumbSelect.Popover>
      </BreadcrumbSelect.Root>
    );
    return [
      { label: "Boards", href: boardsHref },
      {
        label: boardName,
        contentKey: JSON.stringify({
          boardId,
          taskId,
          boardName,
          search,
          options: options.map(({ id, name }) => ({ id, name })),
        }),
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
    ];
  }
  if (settingsSection && settingsTitles[settingsSection]) {
    const account = isAccountSection(settingsSection);
    const category = account ? "Account" : "Team";
    const sections = account
      ? accountSections.flatMap((group) => group.items)
      : admin
        ? teamSections.flatMap((group) => group.items)
        : [];
    return [
      {
        label: category,
        contentKey: `${category}:${admin}`,
        content: (
          <SettingsBreadcrumb
            category={category}
            sections={sections}
            section={settingsSection}
          />
        ),
      },
      { label: settingsTitles[settingsSection] },
    ];
  }
  return [{ label: fallback }];
}

export function AppBreadcrumbs({
  children,
  ...props
}: Parameters<typeof breadcrumbItems>[0] & { children: ReactNode }) {
  const items = breadcrumbItems(props);
  return (
    <BreadcrumbContext.Provider value={items}>
      {children}
    </BreadcrumbContext.Provider>
  );
}
