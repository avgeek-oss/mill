import {
  BookOpen01Icon,
  Key01Icon,
  Link01Icon,
  Mail01Icon,
  MonitorIcon,
  FingerPrintIcon,
  Settings01Icon,
  UserAccountIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { settingsPageLabels } from "@avgeek-oss/design-system";
import { navigate } from "./api.js";
import { HugeiconsIcon } from "@hugeicons/react";
import { SecondaryItems } from "@avgeek-oss/design-system/navigation/secondary-sidebar";

type SettingsGroup = {
  title: string;
  items: { id: string; label: string; icon: typeof UserAccountIcon }[];
};

export const accountSections: SettingsGroup[] = [
  {
    title: "Account",
    items: [
      {
        id: "profile",
        label: settingsPageLabels["profile"],
        icon: UserAccountIcon,
      },
      {
        id: "preferences",
        label: settingsPageLabels["preferences"],
        icon: Settings01Icon,
      },
    ],
  },
  {
    title: "Security",
    items: [
      {
        id: "email-password",
        label: settingsPageLabels["email-password"],
        icon: Mail01Icon,
      },
      {
        id: "passkeys",
        label: settingsPageLabels["passkeys"],
        icon: FingerPrintIcon,
      },
      {
        id: "sessions",
        label: settingsPageLabels["sessions"],
        icon: MonitorIcon,
      },
    ],
  },
  {
    title: "API & MCP",
    items: [
      {
        id: "api-keys",
        label: settingsPageLabels["api-keys"],
        icon: Key01Icon,
      },
      {
        id: "mcp-connections",
        label: settingsPageLabels["mcp-connections"],
        icon: Link01Icon,
      },
      { id: "mcp", label: settingsPageLabels["mcp"], icon: BookOpen01Icon },
    ],
  },
];

export const teamSections: SettingsGroup[] = [
  {
    title: "Team",
    items: [
      {
        id: "general",
        label: settingsPageLabels.general,
        icon: Settings01Icon,
      },
      {
        id: "members",
        label: settingsPageLabels["members"],
        icon: UserGroupIcon,
      },
    ],
  },
];

export const settingsTitles: Record<string, string> = {
  ...Object.fromEntries(
    [...accountSections, ...teamSections].flatMap((group) =>
      group.items.map((item) => [item.id, item.label]),
    ),
  ),
  workspace: settingsPageLabels.general,
  security: settingsPageLabels["email-password"],
  "two-factor": settingsPageLabels.passkeys,
};

export const canonicalSettingsSection = (section: string) =>
  section === "security"
    ? "email-password"
    : section === "two-factor"
      ? "passkeys"
      : section === "workspace"
        ? "general"
        : section;

export function isAccountSection(section?: string) {
  return (
    !!section &&
    accountSections.some((group) =>
      group.items.some((item) => item.id === canonicalSettingsSection(section)),
    )
  );
}

export function settingsHref(section: string) {
  const canonical = canonicalSettingsSection(section);
  return `${isAccountSection(canonical) ? "/settings" : "/team-settings"}/${canonical}`;
}

export function settingsRoute(path: string) {
  if (path === "/settings" || path === "/settings/") return "profile";
  if (path === "/team-settings" || path === "/team-settings/") return "general";
  const match = path.match(/^\/(settings|team-settings)\/([^/]+)\/?$/);
  if (!match) return undefined;
  const section = canonicalSettingsSection(match[2]!);
  if (!Object.hasOwn(settingsTitles, section)) return undefined;
  if (match[1] === "team-settings" && isAccountSection(section))
    return undefined;
  return section;
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
          onSelect={(id) => navigate(settingsHref(id))}
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
