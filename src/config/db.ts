import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { config } from './index';

let mongoMemoryServerInstance: any = null;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

/** Parses host, port and database name from a mongodb:// URI. */
const parseMongoUri = (uri: string) => {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/:?,]+)(?::(\d+))?(?:\/([^?]*))?/);
  return {
    host: match?.[1] || '',
    port: match?.[2] ? parseInt(match[2], 10) : 27017,
    dbName: (match?.[3] || '').trim() || 'dating_chat_app',
  };
};

/**
 * Development fallback when no MongoDB server is running locally:
 * starts a real mongod (downloaded/cached by mongodb-memory-server) that stores its
 * data in backend/.local-db, so accounts and chats survive server restarts.
 */
const startLocalMongo = async (port: number, dbName: string): Promise<string> => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = path.resolve(__dirname, '..', '..', config.localDbDir);
  fs.mkdirSync(dbPath, { recursive: true });

  mongoMemoryServerInstance = await MongoMemoryServer.create({
    instance: {
      port,
      ip: '127.0.0.1',
      dbPath,
      storageEngine: 'wiredTiger',
    },
  });
  console.log(`[DB] Local MongoDB started on 127.0.0.1:${port} (data folder: ${dbPath})`);
  return `${mongoMemoryServerInstance.getUri().replace(/\/+$/, '')}/${dbName}`;
};

export const connectDB = async (): Promise<void> => {
  mongoose.set('strictQuery', true);
  const sanitizedUri = config.mongodbUri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/, '$1****$3');
  const { host, port, dbName } = parseMongoUri(config.mongodbUri);
  const isLocal = LOCAL_HOSTS.includes(host);
  console.log(`[DB] Attempting connection to MongoDB at: ${sanitizedUri}...`);

  try {
    await mongoose.connect(config.mongodbUri, {
      // A local server answers instantly; don't make developers wait 15s when it's down
      serverSelectionTimeoutMS: isLocal ? 3000 : 15000,
    });
    console.log('[DB] Connected successfully to primary MongoDB instance.');
    return;
  } catch (primaryErr: any) {
    console.warn(`\n[DB] ❌ Could not connect to primary MongoDB: ${primaryErr.message}`);
    if (config.mongodbUri.includes('mongodb+srv://') || config.mongodbUri.includes('.mongodb.net')) {
      console.warn('[DB] 💡 Atlas Troubleshooting Checklist:');
      console.warn('  1. Network Access: Ensure your IP is whitelisted in MongoDB Atlas -> Network Access.');
      console.warn('  2. Credentials: Check Database Access username & password in Atlas (remove `<>` placeholders).');
      console.warn('  3. Special characters: If your password has @, #, $, %, etc., encode it using encodeURIComponent().');
      console.warn('  4. Database Name: Add your db name before `?` e.g., /dating_chat_app?retryWrites=true\n');
    }

    if (!config.allowInMemoryDbFallback) {
      // In production, never fall back to a substitute database: fail loudly instead.
      throw primaryErr;
    }
    await mongoose.disconnect().catch(() => undefined);
  }

  // Development fallback
  try {
    let fallbackUri: string;
    if (isLocal && config.persistLocalDb) {
      console.warn('[DB] No MongoDB server is running locally — starting a bundled local MongoDB...');
      fallbackUri = await startLocalMongo(port, dbName);
    } else {
      console.warn('[DB] Launching temporary in-memory MongoDB (data is lost on restart)...');
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      mongoMemoryServerInstance = await MongoMemoryServer.create();
      fallbackUri = `${mongoMemoryServerInstance.getUri().replace(/\/+$/, '')}/${dbName}`;
    }
    await mongoose.connect(fallbackUri);
    console.log('[DB] Connected successfully to fallback MongoDB instance.');
  } catch (memErr: any) {
    console.error('[DB] Failed to start a fallback MongoDB:', memErr);
    throw memErr;
  }
};

export const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    if (mongoMemoryServerInstance) {
      // doCleanup only removes temporary folders, never the persistent .local-db folder
      await mongoMemoryServerInstance.stop({ doCleanup: true, force: false });
    }
    console.log('[DB] Disconnected from MongoDB.');
  } catch (err) {
    console.error('[DB] Error during disconnect:', err);
  }
};
