// Setu — database layer
//
// SQLite via better-sqlite3, replacing the JSONL audit ledger and the
// in-memory mandate store. WAL mode is enabled so the MCP server and the
// HTTP server can read and write concurrently from separate processes
// without blocking each other — the same concurrency guarantee the JSONL
// file gave, but with indexed queries instead of full-file scans.
//
// Pure infrastructure. This file knows about tables and connections, not
// about mandates or audit rules — those stay in mandate.js and audit.js,
// which import from here.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default database location: next to this file, same directory as the old
// audit-log.jsonl. SETU_DB_PATH overrides it so tests can run against a
// throwaway database, same as SETU_AUDIT_LOG did for the old ledger.
const DEFAULT_DB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "setu.db",
);

let _db = null;

/** The path the database is stored at. Resolved lazily so tests can set SETU_DB_PATH after import. */
export function getDbPath() {
  return process.env.SETU_DB_PATH ?? DEFAULT_DB_PATH;
}

/**
 * Open (or create) the database and run all migrations. Idempotent — calling
 * it twice returns the same connection. Every module that needs the database
 * calls this; the first call wins and creates the tables.
 */
export function getDb() {
  if (_db !== null) return _db;

  _db = new Database(getDbPath());

  // WAL mode: readers never block writers, writers never block readers.
  // Critical because the MCP server and the HTTP server may still be
  // separate processes (until Phase 1.2 merges them).
  _db.pragma("journal_mode = WAL");

  // Foreign keys off — we don't use them, and they cost a check per insert.
  // Busy timeout: if another process holds a write lock, wait up to 5s
  // instead of failing immediately.
  _db.pragma("busy_timeout = 5000");

  migrate(_db);

  return _db;
}

/**
 * Close the database. Called by tests for cleanup; production processes
 * leave it open until exit.
 */
export function closeDb() {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------
//
// Each migration runs inside a transaction. The `user_version` pragma tracks
// which migrations have run — it's an integer that SQLite stores in the file
// header, not in a table, so it survives even if the schema is empty.

function migrate(db) {
  const version = db.pragma("user_version", { simple: true });

  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_entries (
          id          TEXT PRIMARY KEY,
          timestamp   TEXT NOT NULL,
          status      TEXT NOT NULL,
          intent      TEXT,
          amount      INTEGER,
          product_id  TEXT,

          -- Mandate verdict, flattened from the nested object. Stored as it
          -- applied at the time — re-running today's rules over yesterday's
          -- decisions would launder exactly the discrepancy an audit exists
          -- to surface.
          mandate_id       TEXT,
          mandate_approved INTEGER,  -- 0 or 1 (SQLite has no boolean)
          mandate_code     TEXT,
          mandate_reason   TEXT,

          order_id    TEXT,
          payment_id  TEXT,
          detail      TEXT
        );

        -- The three query patterns that already exist in audit.js:
        CREATE INDEX IF NOT EXISTS idx_audit_order_id
          ON audit_entries(order_id) WHERE order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_audit_mandate_id
          ON audit_entries(mandate_id) WHERE mandate_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_audit_status
          ON audit_entries(status);

        CREATE TABLE IF NOT EXISTS mandates (
          id                 TEXT PRIMARY KEY,
          max_amount         INTEGER NOT NULL,
          per_txn_cap        INTEGER NOT NULL,
          category_allowlist TEXT NOT NULL,  -- JSON array
          expiry             TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );
      `);
      db.pragma("user_version = 1");
    })();
  }

  if (version < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_payment_id
          ON audit_entries(payment_id) WHERE payment_id IS NOT NULL;
      `);
      db.pragma("user_version = 2");
    })();
  }

  if (version < 3) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE audit_entries ADD COLUMN agent_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_audit_agent_id
          ON audit_entries(agent_id) WHERE agent_id IS NOT NULL;
      `);
      db.pragma("user_version = 3");
    })();
  }
}

