import { loadEnvConfig } from "@next/env";
import { ValidationStore, validationDirectory } from "../lib/server/knowledge-validation-store";
import { processValidationQueue } from "../lib/server/knowledge-validation-queue";

async function main() {
  loadEnvConfig(process.cwd());
  const directory = process.env.EDUFLOW_VALIDATION_DIRECTORY || validationDirectory();
  const store = new ValidationStore(directory), token = store.claimWorker();
  if (!token) { store.close(); return; }
  try {
    while (store.jobs().some(job => ["queued", "processing", "waiting"].includes(job.state))) {
      store.renewWorker(token);
      const processed = await processValidationQueue(directory);
      store.renewWorker(token);
      await new Promise(resolve => setTimeout(resolve, processed ? 2000 : 15000));
    }
  } finally { store.releaseWorker(token); store.close(); }
}
main().catch(() => { process.exitCode = 1; });
