import { createOperatorRecovery } from "./recovery.js";
import { appOrigin } from "./security.js";
import { closeDatabase } from "../../../../packages/database/src/index.js";

const args = process.argv.slice(2);
const emailIndex = args.indexOf("--email");
try {
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm recover-account --email person@example.com [--reset-mfa]",
    );
    console.log(
      "Creates a private, one-time account recovery link valid for 30 minutes.",
    );
  } else {
    if (emailIndex < 0 || !args[emailIndex + 1])
      throw new Error(
        "Usage: pnpm recover-account --email person@example.com [--reset-mfa]",
      );
    const origin = appOrigin();
    const token = await createOperatorRecovery(
      args[emailIndex + 1],
      args.includes("--reset-mfa"),
    );
    console.log(
      `One-time recovery link (expires in 30 minutes):\n${origin}/recover?token=${token}`,
    );
    console.log(
      "Share this link privately with the account owner. It grants account access.",
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Account recovery failed",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
