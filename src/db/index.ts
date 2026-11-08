import fs from 'fs';
import path from 'path';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';
import { migrations } from './migrations';

let pool: Pool | null = null;
let embeddedPg: any = null;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

export const getPool = (): Pool => {
  if (!pool) throw new Error('Database has not been initialised (call connectDB first)');
  return pool;
};

/** Run a parameterised query. Always use $1, $2... placeholders, never string concatenation. */
export const query = async <T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> => {
  const result = await getPool().query<T>(text, params as any[]);
  return result.rows;
};

export const queryOne = async <T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> => {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
};

export type Tx = Pick<PoolClient, 'query'>;

/** Runs `fn` inside a transaction; rolls back if it throws. */
export const withTransaction = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

const describeUrl = (url: string): string => url.replace(/(postgres(?:ql)?:\/\/[^:/@]+:)([^@]+)(@)/, '$1****$3');

const buildPool = (connectionString: string): Pool => {
  const sslMode = config.databaseSsl;
  return new Pool({
    connectionString,
    max: config.databasePoolSize,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    // Hosted providers (Render external URL, Neon, Supabase) need TLS
    ssl: sslMode === 'require' ? { rejectUnauthorized: false } : sslMode === 'verify' ? { rejectUnauthorized: true } : undefined,
  });
};

/**
 * Development fallback when DATABASE_URL points at this PC but no PostgreSQL is running:
 * starts a real PostgreSQL bundled with the project (embedded-postgres) that keeps its
 * data in backend/.local-pg, so accounts and chats survive restarts.
 */
const startEmbeddedPostgres = async (url: URL): Promise<void> => {
  // embedded-postgres is an ES module (and only a dev dependency); load it with a real dynamic import
  const esmImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
  const { default: EmbeddedPostgres } = await esmImport('embedded-postgres');
  const dataDir = path.resolve(__dirname, '..', '..', config.localDbDir);
  const user = decodeURIComponent(url.username || 'postgres');
  const password = decodeURIComponent(url.password || 'postgres');
  const port = parseInt(url.port || '5432', 10);
  const dbName = url.pathname.replace(/^\//, '') || 'heartlink';
  const firstRun = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));

  embeddedPg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
    // Without this, Windows initialises the cluster in WIN1252 and emoji/non-Latin text fail
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: (msg: unknown) => {
      const text = String(msg ?? '').trim();
      if (text && !/^\s*$/.test(text)) console.error('[DB:pg]', text);
    },
  });

  if (firstRun) {
    console.log(`[DB] Creating the local PostgreSQL data folder (first run only): ${dataDir}`);
    await embeddedPg.initialise();
  }
  await embeddedPg.start();
  await ensureUtf8Database(url, dbName);
  console.log(`[DB] Bundled PostgreSQL started on 127.0.0.1:${port} (data folder: ${dataDir})`);
};

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Makes sure the bundled server has the app database in UTF-8. Creates it if missing;
 * an existing non-UTF-8 database is rebuilt only when it holds no users yet.
 */
const ensureUtf8Database = async (url: URL, dbName: string): Promise<void> => {
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const { rows } = await admin.query(
      `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    const createSql = `CREATE DATABASE ${quoteIdent(dbName)} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`;
    if (rows.length === 0) {
      await admin.query(createSql);
      return;
    }
    if (rows[0].encoding === 'UTF8') return;

    // Created by an older version in the wrong encoding: rebuild it if it's still empty
    const check = new Pool({ connectionString: url.toString(), max: 1 });
    let userCount = 0;
    try {
      const r = await check.query(`SELECT to_regclass('public.users') IS NOT NULL AS has_users_table`);
      if (r.rows[0].has_users_table) {
        userCount = Number((await check.query('SELECT count(*) FROM users')).rows[0].count);
      }
    } finally {
      await check.end();
    }
    if (userCount > 0) {
      console.warn(`[DB] ⚠ Local database "${dbName}" uses ${rows[0].encoding}, not UTF-8: emoji may fail to save.`);
      return;
    }
    console.log(`[DB] Rebuilding empty local database "${dbName}" as UTF-8 (was ${rows[0].encoding})...`);
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName]
    );
    await admin.query(`DROP DATABASE ${quoteIdent(dbName)}`);
    await admin.query(createSql);
  } finally {
    await admin.end();
  }
};

const isConnectionRefused = (err: any): boolean =>
  err?.code === 'ECONNREFUSED' || (Array.isArray(err?.errors) && err.errors.some((e: any) => e?.code === 'ECONNREFUSED'));

/** Applies pending migrations. A Postgres advisory lock prevents two instances migrating at once. */
export const runMigrations = async (): Promise<void> => {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
    );
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      console.log(`[DB] Applying migration ${m.version}_${m.name}...`);
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
};

export const connectDB = async (): Promise<void> => {
  const url = new URL(config.databaseUrl);
  const isLocal = LOCAL_HOSTS.includes(url.hostname);
  console.log(`[DB] Connecting to PostgreSQL at ${describeUrl(config.databaseUrl)}...`);

  pool = buildPool(config.databaseUrl);
  try {
    await pool.query('SELECT 1');
    console.log('[DB] Connected to PostgreSQL.');
  } catch (err: any) {
    await pool.end().catch(() => undefined);
    pool = null;

    const canUseBundled = isLocal && isConnectionRefused(err) && config.allowLocalDbFallback;
    if (!canUseBundled) {
      console.error(`[DB] ❌ Could not connect to PostgreSQL: ${err.message}`);
      if (err?.code === '28P01') console.error('[DB]    Wrong username/password in DATABASE_URL.');
      if (err?.code === '3D000') console.error('[DB]    The database in DATABASE_URL does not exist.');
      if (err?.code === 'ENOTFOUND') console.error('[DB]    Host in DATABASE_URL not found (typo?).');
      throw err;
    }

    console.log(`[DB] No PostgreSQL installed/running at ${url.hostname}:${url.port || 5432} (that's fine).`);
    console.log('[DB] Starting the bundled PostgreSQL (your data is kept between restarts)...');
    await startEmbeddedPostgres(url);
    pool = buildPool(config.databaseUrl);
    await pool.query('SELECT 1');
    console.log('[DB] Connected to bundled PostgreSQL.');
  }

  const { rows: enc } = await pool.query('SHOW server_encoding');
  if (enc[0]?.server_encoding !== 'UTF8') {
    if (isLocal && config.allowLocalDbFallback) {
      // Local dev database in the wrong encoding (e.g. created by an earlier version): repair if empty
      await pool.end();
      await ensureUtf8Database(url, url.pathname.replace(/^\//, '') || 'heartlink');
      pool = buildPool(config.databaseUrl);
    } else {
      console.warn(`[DB] ⚠ Database encoding is ${enc[0]?.server_encoding}, not UTF8: emoji/non-Latin text may fail.`);
    }
  }
  pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));
  await runMigrations();
};

export const disconnectDB = async (): Promise<void> => {
  try {
    if (pool) await pool.end();
    pool = null;
    if (embeddedPg) await embeddedPg.stop();
    embeddedPg = null;
    console.log('[DB] Disconnected from PostgreSQL.');
  } catch (err) {
    console.error('[DB] Error during disconnect:', err);
  }
};
