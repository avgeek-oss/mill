import { migrate } from "./migrate.js";
import { closeDatabase } from "./index.js";
try {
  await migrate();
  console.log("Database migrations complete");
} finally {
  await closeDatabase();
}
