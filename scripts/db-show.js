/**
 * Look inside the database without installing any PostgreSQL tools.
 *
 *   npm run db:show                 -> every table with its row count
 *   npm run db:show users           -> the latest 50 rows of a table
 *   npm run db:show messages 100    -> the latest 100 rows
 *
 * Secrets are never printed (password hashes, tokens) and photo bytes are skipped.
 * The backend must be running when it uses the bundled PostgreSQL.
 */
require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/heartlink';
const HIDDEN = new Set(['password_hash', 'reset_password_token', 'reset_password_expires', 'token_hash', 'data']);

(async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const tables = (
      await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      )
    ).rows.map((r) => r.table_name);

    const table = process.argv[2];
    if (!table) {
      console.log(`Database: ${url.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@')}\n`);
      const counts = [];
      for (const t of tables) {
        const { rows } = await pool.query(`SELECT count(*)::int AS rows FROM "${t}"`);
        counts.push({ table: t, rows: rows[0].rows });
      }
      console.table(counts);
      console.log('\nSee the rows of a table:  npm run db:show <table>   (e.g. npm run db:show users)');
      return;
    }

    if (!tables.includes(table)) {
      console.error(`No table "${table}". Tables: ${tables.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const limit = Math.min(Math.max(parseInt(process.argv[3] || '50', 10) || 50, 1), 1000);
    const columns = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      )
    ).rows
      .map((r) => r.column_name)
      .filter((c) => !HIDDEN.has(c));
    const hasCreated = columns.includes('created_at');
    const { rows } = await pool.query(
      `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}"
        ${hasCreated ? 'ORDER BY created_at DESC' : ''} LIMIT ${limit}`
    );
    // Short, readable values in the table view
    const pretty = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => {
          if (v instanceof Date) return [k, v.toLocaleString()];
          const s = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
          return [k, s.length > 40 ? s.slice(0, 37) + '...' : s];
        })
      )
    );
    console.log(`${table}: showing ${rows.length} row(s)${hasCreated ? ', newest first' : ''}`);
    console.table(pretty);
  } catch (err) {
    console.error(
      err.code === 'ECONNREFUSED'
        ? 'Cannot reach PostgreSQL. Start the backend first (npm run dev or npm start) - it runs the bundled database.'
        : `Error: ${err.message}`
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
