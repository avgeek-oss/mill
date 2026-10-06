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
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SecondaryLinks,
  SecondarySection,
  SecondarySidebar,
} from "@mill/web-design-system";

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
    <SecondarySidebar
      title={account ? "Account settings" : "Team settings"}
      hideTitle
      items={[]}
    >
      {(account ? accountSections : teamSections).map((group) => (
        <SecondarySection key={group.title} title={group.title}>
          <SecondaryLinks
            items={group.items.map((item) => ({
              id: item.id,
              href: `/settings/${item.id}`,
              label: item.label,
              icon: (
                <HugeiconsIcon
                  aria-hidden
                  icon={item.icon}
                  size={16}
                  className="size-4 shrink-0"
                />
              ),
              active: canonicalSettingsSection(section) === item.id,
            }))}
          />
        </SecondarySection>
      ))}
    </SecondarySidebar>
  );
}
