import { serve } from "@hono/node-server";
import { validateConfiguration } from "./config.js";
import { migrate } from "../../../packages/database/src/migrate.js";
import { closeDatabase } from "../../../packages/database/src/index.js";
import { app } from "./app.js";
import { startEmailWorker } from "./auth/email-outbox.js";

const configuration = validateConfiguration();
await migrate();
const stopEmailWorker = startEmailWorker();
const server = serve(
  { fetch: app.fetch, port: configuration.PORT, hostname: "0.0.0.0" },
  (info) =>
    console.log(
      `Mill API ready at ${configuration.MILL_API_URL} (port ${info.port})`,
    ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () =>
    server.close(async () => {
      await stopEmailWorker();
      await closeDatabase();
      process.exit(0);
    }),
  );
