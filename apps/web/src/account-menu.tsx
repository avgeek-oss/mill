import {
  BookOpen01Icon,
  Key01Icon,
  Mail01Icon,
  Message01Icon,
  News01Icon,
  Logout01Icon,
  Settings01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SidebarAccountMenu } from "@avgeek-oss/design-system";
import { navigate } from "./api.js";

const repository = "https://github.com/avgeek-oss/mill";
const externalLinks: Record<string, string> = {
  changelog: `${repository}/blob/main/CHANGELOG.md`,
  documentation: "https://mill.fyi",
  feedback: `${repository}/issues/new/choose`,
};

export function AccountMenu({
  name,
  email,
  teamName,
  onLogout,
}: {
  name: string;
  email: string;
  teamName: string;
  onLogout: () => void;
}) {
  return (
    <SidebarAccountMenu
      name={name}
      email={email}
      teamName={teamName}
      groups={[
        {
          id: "account",
          label: "Account",
          items: [
            { id: "profile", label: "Profile", icon: UserAccountIcon },
            { id: "preferences", label: "Preferences", icon: Settings01Icon },
            {
              id: "email-password",
              label: "Email & Password",
              icon: Mail01Icon,
            },
            { id: "api-keys", label: "API Keys", icon: Key01Icon },
          ].map((item) => ({
            ...item,
            id: `account-${item.id}`,
            icon: <HugeiconsIcon icon={item.icon} aria-hidden />,
          })),
        },
        {
          id: "mill",
          label: "Mill",
          items: [
            { id: "changelog", label: "Changelog", icon: News01Icon },
            {
              id: "documentation",
              label: "Documentation",
              icon: BookOpen01Icon,
            },
            { id: "feedback", label: "Leave Feedback", icon: Message01Icon },
          ].map((item) => ({
            ...item,
            icon: <HugeiconsIcon icon={item.icon} aria-hidden />,
          })),
        },
        {
          id: "session",
          label: "Session",
          items: [
            {
              id: "logout",
              label: "Sign out",
              icon: <HugeiconsIcon icon={Logout01Icon} aria-hidden />,
              destructive: true,
            },
          ],
        },
      ]}
      onAction={(id) => {
        if (id === "logout") onLogout();
        else if (id.startsWith("account-"))
          navigate(`/settings/${id.slice(8)}`);
        else {
          const href = externalLinks[id];
          if (href) window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
    />
  );
}
