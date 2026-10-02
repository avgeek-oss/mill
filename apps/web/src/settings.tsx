import { useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  ButtonLink,
  ErrorMessage,
  Widget,
  FieldGroup,
  FieldLabel,
  Input,
  toast,
} from "@mill/web-design-system";
import { Settings2, Save } from "./icons.js";
import { PageHeading } from "./page-heading.js";
import type { Board, Member } from "../../../packages/contracts/src/index.js";
import { api, errorText, type Session } from "./api.js";
import { AccountSettings } from "./account-settings.js";
import { PeopleSettings } from "./people-settings.js";
import { AgentSettings } from "./agent-settings.js";
import { AgentsSettings } from "./agents-settings.js";

export function SettingsPage({
  section,
  session,
  boards,
  onRefresh,
}: {
  section: string;
  session: Session;
  members: Member[];
  boards: Board[];
  onRefresh: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const title =
    (
      {
        profile: "Profile",
        security: "Account security",
        members: "People",
        agents: "Agents",
        "api-keys": "API keys",
        workspace: "Team settings",
      } as Record<string, string>
    )[section] ?? "Settings";
  useEffect(() => {
    document.title = `${title} · Mill`;
  }, [section]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      onRefresh();
      toast.success("Team settings updated.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (section === "profile" || section === "security")
    return (
      <AccountSettings
        key={section}
        section={section}
        session={session}
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
  if (section === "agents") return <AgentsSettings session={session} />;
  if (section === "api-keys")
    return (
      <AgentSettings session={session} boards={boards} onRefresh={onRefresh} />
    );
  return (
    <section className="settings-page">
      {section === "workspace" ? (
        <PageHeading title={title} icon={<Settings2 />} />
      ) : (
        <header>
          <h1>{title}</h1>
          <p className="muted">Manage your workspace and account.</p>
        </header>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      {section === "workspace" && (
        <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
          <Widget>
            <Widget.Content>
              <form
                className="content-grid"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void run(async () => {
                    await api(
                      "/workspace",
                      { name: data.get("name") },
                      "PATCH",
                    );
                  });
                }}
              >
                <FieldGroup>
                  <div className="grid w-full gap-1.5">
                    <FieldLabel htmlFor="workspace-name" isRequired>
                      Name
                    </FieldLabel>
                    <Input
                      id="workspace-name"
                      name="name"
                      defaultValue={session.workspace.name}
                      required
                      maxLength={120}
                      variant="secondary"
                    />
                  </div>
                </FieldGroup>
                <div className="flex items-center gap-3">
                  <Button type="submit" isDisabled={busy}>
                    <Save />
                    Update
                  </Button>
                </div>
              </form>
            </Widget.Content>
          </Widget>
        </div>
      )}
    </section>
  );
}
