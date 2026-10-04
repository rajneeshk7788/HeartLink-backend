import dotenv from 'dotenv';
import mongoose from 'mongoose';
import dns from 'dns';

dotenv.config();

const uri = process.env.MONGODB_URI;

console.log('==================================================');
console.log('       MongoDB Atlas Connection Diagnostic        ');
console.log('==================================================\n');

if (!uri) {
  console.error('❌ MONGODB_URI is not defined in backend/.env!');
  process.exit(1);
}

// Mask password for display
const maskedUri = uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/, '$1****$3');
console.log(`📌 Configured URI: ${maskedUri}\n`);

// 1. Check if still default localhost
if (uri.includes('127.0.0.1') || uri.includes('localhost')) {
  console.warn('⚠️  Your backend/.env is currently pointing to LOCALHOST.');
  console.warn('   To connect to MongoDB Atlas, replace MONGODB_URI in backend/.env with your Atlas connection string.');
  console.warn('   Example:');
  console.warn('   MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/dating_chat_app?retryWrites=true&w=majority\n');
}

// 2. Check for leftover placeholder tags like <password> or <username>
if (uri.includes('<') || uri.includes('>')) {
  console.error('❌ Found angle brackets `<` or `>` in your connection string!');
  console.error('   Please replace `<password>` with your actual password (without the `< >` symbols).\n');
}

// 3. Check for unencoded special characters in credentials
try {
  const match = uri.match(/mongodb(?:\+srv)?:\/\/([^:]+):([^@]+)@/);
  if (match) {
    const rawPass = match[2];
    const forbiddenChars = [':', '/', '?', '#', '[', ']', '@'];
    const hasUnencoded = forbiddenChars.some((char) => rawPass.includes(char));
    if (hasUnencoded) {
      console.warn('⚠️  Your password may contain unencoded special characters (: / ? # [ ] @).');
      console.warn('   If connection fails with authentication error, URL-encode the password using encodeURIComponent("yourPassword").\n');
    }
  }
} catch {
  // ignore regex parsing error
}

// 4. DNS Check if mongodb+srv
if (uri.startsWith('mongodb+srv://')) {
  const hostMatch = uri.match(/mongodb\+srv:\/\/[^@]+@([^/?]+)/);
  if (hostMatch && hostMatch[1]) {
    const host = hostMatch[1];
    console.log(`🔍 Checking DNS resolution for SRV host: ${host}...`);
    dns.resolveSrv(`_mongodb._tcp.${host}`, (err, addresses) => {
      if (err) {
        console.warn(`⚠️  DNS SRV lookup warning: ${err.message}`);
        console.warn('   (Note: Some Windows networks/ISPs fail SRV lookup. If connection times out, try Google DNS 8.8.8.8 or Atlas standard string.)\n');
      } else {
        console.log(`✅ DNS resolved ${addresses.length} host server(s) successfully.\n`);
      }
    });
  }
}

// 5. Test actual connection
console.log('🔄 Attempting to connect with Mongoose (timeout: 15s)...');

mongoose
  .connect(uri, { serverSelectionTimeoutMS: 15000 })
  .then(() => {
    console.log('\n🎉 SUCCESS: Successfully connected to MongoDB Atlas!');
    console.log(`📊 Database Name: ${mongoose.connection.name}`);
    console.log(`🌐 Host: ${mongoose.connection.host}`);
    console.log('==================================================\n');
    return mongoose.disconnect();
  })
  .then(() => {
    process.exit(0);
  })
  .catch((err: any) => {
    console.error('\n❌ FAILED TO CONNECT TO MONGODB:');
    console.error(`Error message: ${err.message}\n`);

    if (err.message.includes('bad auth') || err.message.includes('Authentication failed')) {
      console.log('👉 CAUSE: Invalid Username or Password.');
      console.log('   Fix:');
      console.log('   1. Go to MongoDB Atlas -> Database Access.');
      console.log('   2. Verify your Database User username.');
      console.log('   3. Reset the password if needed and update backend/.env.');
    } else if (err.message.includes('ETIMEDOUT') || err.message.includes('buffering timed out') || err.message.includes('Server selection timed out')) {
      console.log('👉 CAUSE: Network Access (IP Whitelist) or Firewall blocking.');
      console.log('   Fix:');
      console.log('   1. Go to MongoDB Atlas -> Network Access.');
      console.log('   2. Click "Add IP Address".');
      console.log('   3. Click "Allow Access From Anywhere" (0.0.0.0/0) or "Add Current IP Address".');
      console.log('   4. Wait 1-2 minutes for the changes to apply in Atlas.');
    } else if (err.message.includes('querySrv') || err.message.includes('ENOTFOUND')) {
      console.log('👉 CAUSE: DNS resolution failed for the Atlas cluster.');
      console.log('   Fix:');
      console.log('   1. Check your internet connection.');
      console.log('   2. Set your Windows network adapter DNS to 8.8.8.8 and 8.8.4.4 (Google DNS).');
      console.log('   3. Alternatively, copy the "Standard Connection String" (without +srv) from Atlas.');
    }

    console.log('\n==================================================');
    process.exit(1);
  });
