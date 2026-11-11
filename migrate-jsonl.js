// Setu — one-time migration from audit-log.jsonl to SQLite (setu.db)
//
// Safe to run repeatedly: uses INSERT OR IGNORE keyed on `id` inside a single
// transaction. Validates each line through auditEntrySchema before inserting.
//
// Usage:
//   node migrate-jsonl.js [path/to/audit-log.jsonl]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditEntrySchema } from "./audit.js";
import { getDb, closeDb, getDbPath } from "./db.js";

const DEFAULT_JSONL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "audit-log.jsonl",
);
const jsonlPath = process.argv[2] ?? process.env.SETU_AUDIT_LOG ?? DEFAULT_JSONL;

if (!fs.existsSync(jsonlPath)) {
  console.log(`[setu] no JSONL file found at ${jsonlPath} — nothing to migrate.`);
  process.exit(0);
}

const lines = fs
  .readFileSync(jsonlPath, "utf8")
  .split("\n")
  .map((line, i) => ({ line: line.trim(), number: i + 1 }))
  .filter(({ line }) => line.length > 0);

const entries = lines.map(({ line, number }) => {
  try {
    return auditEntrySchema.parse(JSON.parse(line));
  } catch (err) {
    throw new Error(`${jsonlPath} line ${number} failed validation: ${err.message}`);
  }
});

const db = getDb();
const insert = db.prepare(`
  INSERT OR IGNORE INTO audit_entries
    (id, timestamp, status, intent, amount, product_id,
     mandate_id, mandate_approved, mandate_code, mandate_reason,
     order_id, payment_id, detail)
  VALUES
    (@id, @timestamp, @status, @intent, @amount, @product_id,
     @mandate_id, @mandate_approved, @mandate_code, @mandate_reason,
     @order_id, @payment_id, @detail)
`);

let inserted = 0;
db.transaction(() => {
  for (const e of entries) {
    const res = insert.run({
      id: e.id,
      timestamp: e.timestamp,
      status: e.status,
      intent: e.intent,
      amount: e.amount,
      product_id: e.product_id,
      mandate_id: e.mandate?.mandate_id ?? null,
      mandate_approved: e.mandate ? (e.mandate.approved ? 1 : 0) : null,
      mandate_code: e.mandate?.code ?? null,
      mandate_reason: e.mandate?.reason ?? null,
      order_id: e.order_id,
      payment_id: e.payment_id,
      detail: e.detail,
    });
    inserted += res.changes;
  }
})();

closeDb();
console.log(
  `[setu] migrated ${inserted} new entry/entries (${entries.length} read from ${jsonlPath}) into ${getDbPath()}`,
);
