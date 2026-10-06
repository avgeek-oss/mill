---
title: "Security"
description: "Protect an installation and report a vulnerability privately."
---

Use HTTPS for every remote installation and keep the Mill HTTP service and PostgreSQL private behind the reverse proxy. Protect `.env`, the Docker host, and full database backups. A backup contains account data and credentials; keep the original `MILL_SECRET` with your recovery plan because encrypted authenticator values need it after restore.

Grant people and external clients only the access they need. Review active sessions, API keys, OAuth connections when access changes. Mill does not execute external code or connect to an LLM provider. The server checks authorization for UI, REST, and MCP requests; a hidden control is not an access boundary.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/avgeek-inc/mill/security/advisories/new) once the repository is public and the reporting form is enabled. If that form is unavailable, contact a repository owner through their GitHub profile and request a private reporting channel. Include the affected version, a reproduction with secrets removed, and likely impact. Do not post exploit details, passwords, tokens, recovery links, or backups in a public issue.

For detailed controls, see [accounts and team access](/authentication), [configuration](/configuration), and [backup and recovery](/backup).

## In the app

### Two-factor Auth

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/security-light.png"
            alt="Two-factor Auth in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/security-dark.png"
            alt="Two-factor Auth in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/security-mobile-light.png"
            alt="Two-factor Auth in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/security-mobile-dark.png"
            alt="Two-factor Auth in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
