import { sql } from "../../../../packages/database/src/index.js";
import { attachmentStorage } from "./storage.js";

export async function cleanupAttachmentBatch(shouldContinue = () => true) {
  const storage = attachmentStorage();
  if (!storage) return 0;
  await sql`DELETE FROM task_attachments WHERE state='pending' AND upload_expires_at<=now()`;
  let processed = 0;
  for (let n = 0; n < 10 && shouldContinue(); n++) {
    const handled = await sql.begin(async (tx) => {
      const [row] = await tx<
        {
          storageOrigin: string;
          storageBucket: string;
          objectKey: string;
          recheckAt: Date | null;
        }[]
      >`
        SELECT * FROM attachment_cleanup WHERE available_at<=now() AND storage_origin=${storage.origin} AND storage_bucket=${storage.bucket}
        ORDER BY available_at,object_key FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!row || !shouldContinue()) return false;
      try {
        await storage.delete(row);
        if (row.recheckAt && row.recheckAt.getTime() > Date.now())
          await tx`UPDATE attachment_cleanup SET available_at=recheck_at,recheck_at=null WHERE storage_origin=${row.storageOrigin} AND storage_bucket=${row.storageBucket} AND object_key=${row.objectKey}`;
        else
          await tx`DELETE FROM attachment_cleanup WHERE storage_origin=${row.storageOrigin} AND storage_bucket=${row.storageBucket} AND object_key=${row.objectKey}`;
      } catch {
        await tx`UPDATE attachment_cleanup SET available_at=now()+interval '1 minute' WHERE storage_origin=${row.storageOrigin} AND storage_bucket=${row.storageBucket} AND object_key=${row.objectKey}`;
      }
      return true;
    });
    if (!handled) break;
    processed++;
  }
  return processed;
}
export function startAttachmentCleanup() {
  let stopped = false;
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = cleanupAttachmentBatch(() => !stopped)
      .catch(() => console.error("Attachment cleanup could not complete"))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
