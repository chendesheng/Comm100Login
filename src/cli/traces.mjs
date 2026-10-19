import { chmod, mkdir, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bridgeConfigDirectory } from './bridge.mjs';
import { FILTER_ANY, normalizeDomain, normalizeSiteId } from '../shared/storage.js';

export const TRACE_LIMIT = 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS traces (
    url TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    request_headers TEXT NOT NULL,
    request_body TEXT NOT NULL,
    response_headers TEXT NOT NULL,
    response_body TEXT NOT NULL,
    time INTEGER NOT NULL
  ) STRICT;
`;

// Databases written before the time column existed keep their rows; only new rows carry a time.
const ADD_TIME = 'ALTER TABLE traces ADD COLUMN time INTEGER NOT NULL DEFAULT 0';

const INSERT = `
  INSERT INTO traces
    (url, method, status_code, request_headers, request_body, response_headers, response_body, time)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const PRUNE = `
  DELETE FROM traces
  WHERE rowid NOT IN (SELECT rowid FROM traces ORDER BY time DESC, rowid DESC LIMIT 1000)
`;

const LIST = `
  SELECT time, method, status_code AS statusCode, url
  FROM traces ORDER BY time DESC, rowid DESC LIMIT 1000
`;

// Reading a database written before the time column keeps printing rows; they show no time.
const LEGACY_LIST = `
  SELECT 0 AS time, method, status_code AS statusCode, url
  FROM traces ORDER BY rowid DESC LIMIT 1000
`;

export const traceDatabasePath = () => (process.env.COMM100_TRACES_DB
  ? resolve(process.env.COMM100_TRACES_DB)
  : join(bridgeConfigDirectory(), 'traces.sqlite'));

async function loadDatabase() {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('SQLite tracing requires Node 22.13+ or 23.4+ (node:sqlite).');
  }
  const Database = sqlite.Database || sqlite.DatabaseSync;
  if (!Database) throw new Error('SQLite tracing requires Node 22.13+ or 23.4+ (node:sqlite).');
  return Database;
}

async function setMode(path, mode) {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (platform() !== 'win32') throw error;
  }
}

function headersJson(headers) {
  return JSON.stringify(Array.isArray(headers) ? headers : []);
}

function validate(trace) {
  if (!trace || typeof trace !== 'object') throw new Error('Trace must be an object.');
  try {
    new URL(trace.url);
  } catch {
    throw new Error('Trace URL must be absolute.');
  }
  if (typeof trace.method !== 'string' || !/^[A-Z]+$/.test(trace.method)) {
    throw new Error('Trace method must be uppercase letters.');
  }
  if (!Number.isInteger(trace.statusCode) || trace.statusCode < 0 || trace.statusCode > 599) {
    throw new Error('Trace status code must be an integer from 0 to 599.');
  }
  if (!Number.isInteger(trace.time) || trace.time < 0) {
    throw new Error('Trace time must be epoch milliseconds.');
  }
}

export async function openTraceWriter() {
  const Database = await loadDatabase();
  const path = traceDatabasePath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await setMode(directory, 0o700);
  const db = new Database(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    const columns = db.prepare('PRAGMA table_info(traces)').all().map((column) => column.name);
    if (!columns.includes('time')) db.exec(ADD_TIME);
    await setMode(path, 0o600);
    const insertStatement = db.prepare(INSERT);
    const pruneStatement = db.prepare(PRUNE);
    return {
      insert(trace) {
        validate(trace);
        db.exec('BEGIN IMMEDIATE');
        try {
          insertStatement.run(
            trace.url,
            trace.method,
            trace.statusCode,
            headersJson(trace.requestHeaders),
            String(trace.requestBody ?? ''),
            headersJson(trace.responseHeaders),
            String(trace.responseBody ?? ''),
            trace.time
          );
          pruneStatement.run();
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* keep the original failure */ }
          throw error;
        }
      },
      close() {
        insertStatement.close?.();
        pruneStatement.close?.();
        db.close();
      }
    };
  } catch (error) {
    try { db.close(); } catch { /* keep the original failure */ }
    throw error;
  }
}

/** The trace-side counterpart of `filterAccounts`: a dashboard is the URL host, a site is a query value. */
function keepsTrace(row, { domain, siteId, from }) {
  if (from !== undefined && !(row.time >= from)) return false;
  if (domain === FILTER_ANY && siteId === FILTER_ANY) return true;
  let url;
  try {
    url = new URL(row.url);
  } catch {
    return false;
  }
  if (domain !== FILTER_ANY && normalizeDomain(url.host) !== normalizeDomain(domain)) return false;
  if (siteId !== FILTER_ANY) {
    const wanted = normalizeSiteId(siteId);
    let found = false;
    for (const [name, value] of url.searchParams) {
      if (name.toLowerCase() === 'siteid' && normalizeSiteId(value) === wanted) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

export async function listTraces({ domain = FILTER_ANY, siteId = FILTER_ANY, from } = {}) {
  const path = traceDatabasePath();
  try {
    await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const Database = await loadDatabase();
  const db = new Database(path);
  let statement;
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    const columns = db.prepare('PRAGMA table_info(traces)').all().map((column) => column.name);
    statement = db.prepare(columns.includes('time') ? LIST : LEGACY_LIST);
    return statement.all().filter((row) => keepsTrace(row, { domain, siteId, from }));
  } catch (error) {
    if (String(error?.message).includes('no such table: traces')) return [];
    throw error;
  } finally {
    statement?.close?.();
    db.close();
  }
}
