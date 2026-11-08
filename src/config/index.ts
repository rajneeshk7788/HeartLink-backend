import dotenv from 'dotenv';
dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const DEV_ACCESS_SECRET = 'dev_only_access_secret_change_me';
const DEV_REFRESH_SECRET = 'dev_only_refresh_secret_change_me';

const requireInProduction = (name: string, devFallback: string): string => {
  const value = process.env[name];
  if (value && value.trim()) return value;
  if (isProduction) {
    throw new Error(`[Config] Environment variable ${name} must be set in production.`);
  }
  return devFallback;
};

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const clientUrls = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  // 0.0.0.0 = reachable from phones/emulators on your network, not just this PC
  host: process.env.HOST || '0.0.0.0',
  nodeEnv,
  isProduction,
  jwtSecret: requireInProduction('JWT_SECRET', DEV_ACCESS_SECRET),
  jwtRefreshSecret: requireInProduction('JWT_REFRESH_SECRET', DEV_REFRESH_SECRET),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  // PostgreSQL connection string, e.g. postgres://user:password@host:5432/dbname
  databaseUrl: requireInProduction('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/heartlink'),
  // TLS for hosted databases: 'require' (Neon, Supabase, Render external URL), 'verify', or 'disable'
  databaseSsl: (process.env.DATABASE_SSL || 'auto').toLowerCase(),
  databasePoolSize: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
  // Primary web client URL (first entry) used to build password reset links
  clientUrl: clientUrls[0],
  // All allowed browser origins (comma-separated CLIENT_URL)
  allowedOrigins: isProduction
    ? clientUrls
    : Array.from(new Set([...clientUrls, 'http://localhost:5173', 'http://127.0.0.1:5173'])),
  // When DATABASE_URL points at this PC but no PostgreSQL is running, start the bundled
  // PostgreSQL (development only) that keeps its data in LOCAL_DB_DIR
  allowLocalDbFallback: !isProduction && parseBool(process.env.USE_BUNDLED_POSTGRES, true),
  localDbDir: process.env.LOCAL_DB_DIR || '.local-pg',
  // Demo users (alice/bob/charlie) are only seeded outside production unless explicitly enabled
  seedDemoData: parseBool(process.env.SEED_DEMO_DATA, !isProduction),
  // Returning the reset token in the API response is a development convenience only
  exposeResetTokenInResponse: !isProduction && parseBool(process.env.EXPOSE_RESET_TOKEN, true),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'ConnectPulse <no-reply@connectpulse.local>',
  },
  callRingTimeoutMs: parseInt(process.env.CALL_RING_TIMEOUT_MS || '45000', 10),
};

if (!isProduction && config.jwtSecret === DEV_ACCESS_SECRET) {
  console.warn('[Config] Using development JWT secrets. Set JWT_SECRET / JWT_REFRESH_SECRET for any shared deployment.');
}

/** CORS origin check shared by Express and Socket.IO. Requests without an Origin (mobile apps, curl) are allowed. */
export const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return true;
  return config.allowedOrigins.includes(origin.replace(/\/+$/, ''));
};

// 'auto' TLS: on for well-known hosted providers / sslmode in the URL, off for local & Render-internal URLs
if (config.databaseSsl === 'auto') {
  const url = config.databaseUrl;
  const wantsSsl =
    /sslmode=(require|verify-ca|verify-full)/.test(url) ||
    /(neon\.tech|supabase\.(co|com)|render\.com|amazonaws\.com|azure\.com)/.test(url);
  (config as any).databaseSsl = wantsSsl ? 'require' : 'disable';
}
