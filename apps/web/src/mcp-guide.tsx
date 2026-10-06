import { BookOpen01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ButtonLink,
  Choice,
  CodeBlock,
  TypographyParagraph,
  Link,
  Widget,
} from "@mill/web-design-system";
import { useState } from "react";
import { McpClientLogo } from "./mcp-client-logo.js";
import { PageHeading } from "./page-heading.js";

const clients = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["vscode", "VS Code"],
  ["other", "Other clients"],
] as const;

export function McpGuide() {
  const endpoint = `${window.location.origin}/mcp`;
  const [client, setClient] = useState("cursor");
  const configs = {
    codex: {
      title: "~/.codex/config.toml",
      code: `[mcp_servers.mill]\nurl = ${JSON.stringify(endpoint)}`,
      help: (
        <>
          Save the configuration, then run <code>codex mcp login mill</code> to
          sign in.
        </>
      ),
    },
    claude: {
      title: "Claude Code",
      code: `claude mcp add --transport http mill '${endpoint}'`,
      help: (
        <>
          Run the command, then open <code>/mcp</code> in Claude Code and select
          Mill to sign in.
        </>
      ),
    },
    cursor: {
      title: ".cursor/mcp.json",
      code: JSON.stringify(
        { mcpServers: { mill: { url: endpoint } } },
        null,
        2,
      ),
    },
    vscode: {
      title: ".vscode/mcp.json",
      code: JSON.stringify(
        { servers: { mill: { type: "http", url: endpoint } } },
        null,
        2,
      ),
    },
    other: {
      title: "Connection details",
      code: `Transport: Streamable HTTP\nURL: ${endpoint}\nAuthentication: OAuth`,
    },
  };
  const config = configs[client as keyof typeof configs];

  return (
    <section className="min-w-0">
      <PageHeading
        title="MCP Guide"
        icon={<HugeiconsIcon icon={BookOpen01Icon} />}
      />
      <Widget aria-label="Connect your MCP client" role="region">
        <Widget.Header>
          <Widget.Title>
            <h2>Connect your MCP client</h2>
          </Widget.Title>
        </Widget.Header>
        <Widget.Content>
          <div className="content-grid min-w-0">
            <div className="max-w-sm">
              <Choice
                label="Client"
                value={client}
                onChange={setClient}
                items={clients.map(([id, name]) => ({
                  id,
                  name,
                  startContent: (
                    <McpClientLogo client={id} className="size-5" />
                  ),
                }))}
              />
            </div>
            <CodeBlock>
              <CodeBlock.Header
                endContent={
                  <CodeBlock.CopyButton key={client} code={config.code} />
                }
              >
                <CodeBlock.Filename>{config.title}</CodeBlock.Filename>
              </CodeBlock.Header>
              <CodeBlock.Code
                code={config.code}
                tabIndex={0}
                aria-label="MCP configuration"
              />
            </CodeBlock>
            {"help" in config ? (
              <TypographyParagraph
                size="sm"
                color="muted"
                className="leading-relaxed"
              >
                {config.help}
              </TypographyParagraph>
            ) : null}
            <TypographyParagraph
              size="sm"
              color="muted"
              className="leading-relaxed"
            >
              To connect by signing in, add the MCP URL to your app, sign in to
              Mill and approve access. Reconnect after 30 days. You can revoke
              access in your personal{" "}
              <Link href="/settings/api-keys" className="text-sm">
                API keys
              </Link>
              . The configurations above use OAuth.
            </TypographyParagraph>
            <ButtonLink
              href="https://mill.fyi/clients"
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              className="w-fit"
            >
              <HugeiconsIcon aria-hidden="true" icon={BookOpen01Icon} />
              MCP setup and troubleshooting
            </ButtonLink>
          </div>
        </Widget.Content>
      </Widget>
    </section>
  );
}
