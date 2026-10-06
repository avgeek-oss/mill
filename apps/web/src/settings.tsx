import { useEffect } from "react";
import { ButtonLink, TeamGeneralSettings } from "@avgeek-oss/design-system";
import { EmptyState } from "@avgeek-oss/design-system/data-display/empty-state";
import { Settings2 } from "./icons.js";
import { PageHeading } from "./page-heading.js";
import type { Board, Member } from "../../../packages/contracts/src/index.js";
import { api, type Session } from "./api.js";
import { AccountSettings } from "./account-settings.js";
import { PeopleSettings } from "./people-settings.js";
import { ApiKeySettings } from "./api-key-settings.js";
import { isAccountSection, settingsTitles } from "./settings-navigation.js";
import { McpGuide } from "./mcp-guide.js";

export function SettingsPage({
  section,
  session,
  emailDeliveryConfigured,
  boards,
  onRefresh,
}: {
  section: string;
  session: Session;
  emailDeliveryConfigured: boolean;
  members: Member[];
  boards: Board[];
  onRefresh: () => void;
}) {
  const title = settingsTitles[section] ?? "Settings";
  useEffect(() => {
    document.title = `${title} · Mill`;
  }, [title]);
  if (isAccountSection(section) && !["api-keys", "mcp"].includes(section))
    return (
      <AccountSettings
        key={`${section}:${session.user.id}`}
        section={section}
        session={session}
        emailDeliveryConfigured={emailDeliveryConfigured}
        onRefresh={onRefresh}
      />
    );
  if (
    ["members", "workspace"].includes(section) &&
    session.user.role !== "admin"
  )
    return (
      <section className="settings-page">
        <PageHeading title={title} icon={<Settings2 />} />
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Title>Administrator access required</EmptyState.Title>
            <EmptyState.Description>
              Ask your workspace administrator to manage this setting.
            </EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <ButtonLink href="/">Go to boards</ButtonLink>
          </EmptyState.Content>
        </EmptyState>
      </section>
    );
  if (section === "members")
    return <PeopleSettings session={session} onRefresh={onRefresh} />;
  if (section === "api-keys")
    return (
      <ApiKeySettings session={session} boards={boards} onRefresh={onRefresh} />
    );
  if (section === "mcp") return <McpGuide />;
  return (
    <section className="settings-page">
      <PageHeading title={title} icon={<Settings2 />} />
      {section === "workspace" && (
        <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
          <TeamGeneralSettings
            value={session.workspace.name}
            maxLength={120}
            onSave={async (name) => {
              await api("/workspace", { name }, "PATCH");
              onRefresh();
            }}
          />
        </div>
      )}
    </section>
  );
}
