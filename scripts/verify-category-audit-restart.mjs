// Run after npm run build. Uses only synthetic data and a temporary directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "ynab-restart-"));
const moduleUrl = new URL("../dist/audit/fileCategoryAudit.js", import.meta.url).href;
const operationId = "00000000-0000-4000-8000-000000000001";
const record = {
  version: 1, operation_id: operationId, phase: "prepared",
  recorded_at: "2026-10-03T00:00:00Z", plan_id: "synthetic",
  dry_run: false, undo_manifest: [], rows: [],
};
const setup = `import { FileCategoryAuditStore } from ${JSON.stringify(moduleUrl)};
const store = new FileCategoryAuditStore(${JSON.stringify(directory)});`;
try {
  execFileSync(process.execPath, ["--input-type=module", "-e", `${setup}
await store.write(${JSON.stringify(record)});`]);
  execFileSync(process.execPath, ["--input-type=module", "-e", `${setup}
import { strict as assert } from 'node:assert';
assert.deepEqual(await store.read(${JSON.stringify(operationId)}, 'prepared'), ${JSON.stringify(record)});`]);
  console.log("PASS: prepared audit persisted across two independent Node processes");
} finally {
  await rm(directory, { recursive: true, force: true });
}
