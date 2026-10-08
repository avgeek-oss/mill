import type { ReactNode } from "react";
import {
  SettingsPageTitle,
  settingsPageLabels,
  type CommonSettingsSection,
} from "@avgeek-oss/design-system";
import { PageHeading } from "./page-heading.js";

export function SettingsHeading({
  section,
  actions,
}: {
  section: CommonSettingsSection;
  actions?: ReactNode;
}) {
  return (
    <PageHeading
      title={settingsPageLabels[section]}
      titleContent={<SettingsPageTitle section={section} />}
      actions={actions}
    />
  );
}
