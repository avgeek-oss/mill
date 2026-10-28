import { reportInstallationSetupSecret } from "./auth/setup-secret.js";
import { serve } from "@hono/node-server";
import { validateConfiguration } from "./config.js";
import { migrate } from "../../../packages/database/src/migrate.js";
import { closeDatabase } from "../../../packages/database/src/index.js";
import { app } from "./app.js";
import { startEmailWorker } from "./auth/email-outbox.js";
import { startAttachmentCleanup } from "./attachments/cleanup.js";

const configuration = validateConfiguration();
await migrate();
await reportInstallationSetupSecret();
const stopEmailWorker = startEmailWorker();
const stopAttachmentCleanup = startAttachmentCleanup();
const server = serve(
  { fetch: app.fetch, port: configuration.PORT, hostname: "0.0.0.0" },
  (info) =>
    console.log(
      `Mill API ready at ${configuration.MILL_API_URL} (port ${info.port})`,
    ),
);
async function shutdown() {
  await stopEmailWorker();
  await stopAttachmentCleanup();
  await closeDatabase();
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () =>
    // close() takes a plain callback, so the shutdown promise is settled here.
    server.close(() => {
      shutdown().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error("Mill API could not shut down cleanly", error);
          process.exit(1);
        },
      );
    }),
  );
