import {
  BookOpen01Icon,
  Key01Icon,
  Mail01Icon,
  MonitorIcon,
  SecurityCheckIcon,
  Settings01Icon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { navigate } from "./api.js";
import { HugeiconsIcon } from "@hugeicons/react";
import { SecondaryItems } from "@avgeek-oss/design-system/navigation/secondary-sidebar";

export const accountSections = [
  {
    title: "Account",
    items: [
      { id: "profile", label: "Profile", icon: UserAccountIcon },
      { id: "preferences", label: "Preferences", icon: Settings01Icon },
    ],
  },
  {
    title: "Security",
    items: [
      { id: "email-password", label: "Email & Password", icon: Mail01Icon },
      { id: "two-factor", label: "Two-factor Auth", icon: SecurityCheckIcon },
      { id: "sessions", label: "Sessions", icon: MonitorIcon },
    ],
  },
  {
    title: "API & MCP",
    items: [
      { id: "api-keys", label: "API Keys", icon: Key01Icon },
      { id: "mcp", label: "MCP Guide", icon: BookOpen01Icon },
    ],
  },
];

export const teamSections = [
  {
    title: "Team",
    items: [
      { id: "workspace", label: "General", icon: Settings01Icon },
      { id: "members", label: "Members", icon: UserGroupIcon },
    ],
  },
];

export const settingsTitles: Record<string, string> = {
  ...Object.fromEntries(
    [...accountSections, ...teamSections].flatMap((group) =>
      group.items.map((item) => [item.id, item.label]),
    ),
  ),
  "api-keys": "API keys",
  members: "People",
  security: "Email & Password",
};

export const canonicalSettingsSection = (section: string) =>
  section === "security" ? "email-password" : section;

export function isAccountSection(section?: string) {
  return (
    !!section &&
    accountSections.some((group) =>
      group.items.some((item) => item.id === canonicalSettingsSection(section)),
    )
  );
}

export function SettingsNavigation({ section }: { section: string }) {
  const account = isAccountSection(section);
  return (
    <>
      {(account ? accountSections : teamSections).map((group) => (
        <SecondaryItems
          key={group.title}
          title={group.title}
          selected={canonicalSettingsSection(section)}
          onSelect={(id) => navigate(`/settings/${id}`)}
          items={group.items.map((item) => ({
            id: item.id,
            label: item.label,
            icon: <HugeiconsIcon aria-hidden icon={item.icon} />,
          }))}
        />
      ))}
    </>
  );
}
