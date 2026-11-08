/**
 * Database connection check:  npm run test:db
 * Connects using DATABASE_URL (starting the bundled PostgreSQL locally if needed),
 * applies migrations and prints what it finds.
 */
import { config } from './config';
import { connectDB, disconnectDB, query } from './db';

(async () => {
  const masked = config.databaseUrl.replace(/(postgres(?:ql)?:\/\/[^:/@]+:)([^@]+)(@)/, '$1****$3');
  console.log(`Checking PostgreSQL at ${masked} (TLS: ${config.databaseSsl})\n`);
  try {
    await connectDB();
    const [{ version }] = await query<{ version: string }>('SELECT version()');
    const counts = await query<{ table: string; rows: string }>(`
      SELECT 'users' AS table, count(*)::text AS rows FROM users
      UNION ALL SELECT 'conversations', count(*)::text FROM conversations
      UNION ALL SELECT 'messages', count(*)::text FROM messages
      UNION ALL SELECT 'call_records', count(*)::text FROM call_records`);
    const migrations = await query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version'
    );
    console.log(`\n✅ Connected: ${version.split(',')[0]}`);
    console.log(`   Migrations: ${migrations.map((m) => `${m.version}_${m.name}`).join(', ')}`);
    counts.forEach((c) => console.log(`   ${c.table.padEnd(14)} ${c.rows} rows`));
    await disconnectDB();
    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}`);
    await disconnectDB();
    process.exit(1);
  }
})();
