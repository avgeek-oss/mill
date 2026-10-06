// Adapted from Towbar's Apache-2.0 account-menu composition.
import {
  BookOpen01Icon,
  GithubIcon,
  Key01Icon,
  Mail01Icon,
  Message01Icon,
  News01Icon,
  Settings01Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Dropdown, Header } from "@mill/web-design-system";

const repository = "https://github.com/avgeek-inc/mill";

export function AccountMenuItems() {
  return (
    <>
      <Dropdown.Section aria-label="Account" className="w-full">
        <Header className="px-2 py-1.5 text-xs font-medium text-muted">
          Account
        </Header>
        {[
          { id: "profile", label: "Profile", icon: UserAccountIcon },
          { id: "preferences", label: "Preferences", icon: Settings01Icon },
          { id: "email-password", label: "Auth & Security", icon: Mail01Icon },
          { id: "api-keys", label: "My API Keys", icon: Key01Icon },
        ].map((item) => (
          <Dropdown.Item
            key={item.id}
            id={`account-${item.id}`}
            href={`/settings/${item.id}`}
            textValue={item.label}
          >
            <HugeiconsIcon
              aria-hidden
              icon={item.icon}
              className="size-4 shrink-0 text-muted"
            />
            {item.label}
          </Dropdown.Item>
        ))}
      </Dropdown.Section>
      <Dropdown.Section
        aria-label="Mill"
        className="mt-1.5 w-full border-t border-separator pt-1.5"
      >
        <Header className="px-2 py-1.5 text-xs font-medium text-muted">
          Mill
        </Header>
        {[
          {
            id: "changelog",
            label: "Changelog",
            icon: News01Icon,
            href: `${repository}/blob/main/CHANGELOG.md`,
          },
          {
            id: "documentation",
            label: "Documentation",
            icon: BookOpen01Icon,
            href: "https://mill.fyi",
          },
          {
            id: "feedback",
            label: "Feedback",
            icon: Message01Icon,
            href: `${repository}/issues/new/choose`,
          },
          {
            id: "contribute",
            label: "Repo / Contribute",
            icon: GithubIcon,
            href: `${repository}/blob/main/CONTRIBUTING.md`,
          },
        ].map((item) => (
          <Dropdown.Item
            key={item.id}
            id={item.id}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            textValue={item.label}
          >
            <HugeiconsIcon
              aria-hidden
              icon={item.icon}
              className="size-4 shrink-0 text-muted"
            />
            {item.label}
          </Dropdown.Item>
        ))}
      </Dropdown.Section>
    </>
  );
}
