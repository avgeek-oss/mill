import { apiOrigin } from "./runtime-config.js";
import { McpGuideSettings } from "@avgeek-oss/design-system";
import { McpClientLogo } from "./mcp-client-logo.js";
import { SettingsHeading } from "./settings-heading.js";

export function McpGuide() {
  const endpoint = `${apiOrigin()}/mcp`;
  const configurations = [
    {
      id: "codex",
      label: "Codex",
      filename: "~/.codex/config.toml",
      code: `[mcp_servers.mill]\nurl = ${JSON.stringify(endpoint)}`,
    },
    {
      id: "claude",
      label: "Claude Code",
      filename: "Claude Code",
      code: `claude mcp add --transport http mill '${endpoint}'`,
    },
    {
      id: "cursor",
      label: "Cursor",
      filename: ".cursor/mcp.json",
      code: JSON.stringify(
        { mcpServers: { mill: { url: endpoint } } },
        null,
        2,
      ),
    },
    {
      id: "vscode",
      label: "VS Code",
      filename: ".vscode/mcp.json",
      code: JSON.stringify(
        { servers: { mill: { type: "http", url: endpoint } } },
        null,
        2,
      ),
    },
    {
      id: "other",
      label: "Other clients",
      filename: "Connection details",
      code: `Transport: Streamable HTTP\nURL: ${endpoint}\nAuthentication: OAuth`,
    },
  ];
  return (
    <section className="min-w-0">
      <SettingsHeading section="mcp" />
      <McpGuideSettings
        configurations={configurations.map((configuration) => ({
          ...configuration,
          icon: <McpClientLogo client={configuration.id} className="size-5" />,
        }))}
        documentationUrl="https://mill.fyi/clients"
      />
    </section>
  );
}
