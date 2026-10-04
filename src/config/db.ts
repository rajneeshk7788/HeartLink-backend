import mongoose from 'mongoose';
import { config } from './index';

let mongoMemoryServerInstance: any = null;

export const connectDB = async (): Promise<void> => {
  try {
    mongoose.set('strictQuery', false);
    const sanitizedUri = config.mongodbUri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/, '$1****$3');
    console.log(`[DB] Attempting connection to MongoDB at: ${sanitizedUri}...`);

    await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: 15000,
    });
    console.log('[DB] Connected successfully to primary MongoDB instance.');
  } catch (primaryErr: any) {
    console.warn(`\n[DB] ❌ Could not connect to primary MongoDB: ${primaryErr.message}`);
    if (config.mongodbUri.includes('mongodb+srv://') || config.mongodbUri.includes('.mongodb.net')) {
      console.warn('[DB] 💡 Atlas Troubleshooting Checklist:');
      console.warn('  1. Network Access: Ensure your IP is whitelisted (or 0.0.0.0/0) in MongoDB Atlas -> Network Access.');
      console.warn('  2. Credentials: Check Database Access username & password in Atlas (remove `<>` placeholders).');
      console.warn('  3. Special characters: If your password has @, #, $, %, etc., encode it using encodeURIComponent().');
      console.warn('  4. Database Name: Add your db name before `?` e.g., /dating_chat_app?retryWrites=true\n');
    }
    console.warn('[DB] Launching in-memory MongoDB fallback...');
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      mongoMemoryServerInstance = await MongoMemoryServer.create();
      const memUri = mongoMemoryServerInstance.getUri();
      console.log(`[DB] In-memory MongoDB started at: ${memUri}`);

      await mongoose.connect(memUri);
      console.log('[DB] Connected successfully to In-Memory MongoDB instance.');
    } catch (memErr: any) {
      console.error('[DB] Failed to initialize in-memory MongoDB:', memErr);
      throw memErr;
    }
  }
};

export const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    if (mongoMemoryServerInstance) {
      await mongoMemoryServerInstance.stop();
    }
    console.log('[DB] Disconnected from MongoDB.');
  } catch (err) {
    console.error('[DB] Error during disconnect:', err);
  }
};
