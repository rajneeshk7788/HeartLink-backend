import bcrypt from 'bcryptjs';
import { queryOne, withTransaction } from '../db';

const DEMO_PASSWORD = 'Password123!';

const DEMO_USERS = [
  {
    username: 'alice',
    email: 'alice@example.com',
    displayName: 'Alice Johnson',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
    gender: 'female',
    bio: 'Loves photography, coffee, and weekend hikes.',
    statusMessage: 'Ready for great conversations! ✨',
  },
  {
    username: 'bob',
    email: 'bob@example.com',
    displayName: 'Bob Smith',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    gender: 'male',
    bio: 'Software engineer, marathon runner, and jazz lover.',
    statusMessage: 'Code, run, repeat 🏃‍♂️',
  },
  {
    username: 'charlie',
    email: 'charlie@example.com',
    displayName: 'Charlie Davis',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    gender: 'non-binary',
    bio: 'Digital artist & music producer looking for creative connections.',
    statusMessage: 'Designing the future 🎨',
  },
];

/** Creates the demo users and a starter conversation, only into an empty database. */
export const seedInitialData = async (): Promise<void> => {
  try {
    const existing = await queryOne<{ count: string }>('SELECT count(*) FROM users');
    if (existing && Number(existing.count) > 0) {
      console.log('[Seed] Database already contains users, skipping seed.');
      return;
    }

    console.log('[Seed] Seeding initial demo users and chat...');
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    await withTransaction(async (tx) => {
      const ids: Record<string, string> = {};
      for (const u of DEMO_USERS) {
        const { rows } = await tx.query(
          `INSERT INTO users (username, email, password_hash, display_name, avatar, gender, bio, status_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
          [u.username, u.email, passwordHash, u.displayName, u.avatar, u.gender, u.bio, u.statusMessage]
        );
        ids[u.username] = rows[0].id;
      }

      const { alice, bob } = ids;
      const directKey = [alice, bob].sort().join(':');
      const conv = await tx.query(
        'INSERT INTO conversations (direct_key) VALUES ($1) RETURNING id::text AS id',
        [directKey]
      );
      const conversationId: string = conv.rows[0].id;
      await tx.query(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
        [conversationId, alice, bob]
      );

      const starter = [
        { sender: bob, content: 'Hey Alice! Great to connect with you here on ConnectPulse.', at: "now() - interval '2 minutes'" },
        {
          sender: alice,
          content: 'Hi Bob! Loved reading your profile. Are you up for a quick video chat later?',
          at: "now() - interval '1 minute'",
        },
      ];
      let lastId = '';
      for (const m of starter) {
        const { rows } = await tx.query(
          `INSERT INTO messages (conversation_id, sender_id, content, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'read', ${m.at}, ${m.at}) RETURNING id::text AS id`,
          [conversationId, m.sender, m.content]
        );
        lastId = rows[0].id;
        // Both people have read both starter messages
        await tx.query('INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2), ($1, $3)', [lastId, alice, bob]);
      }
      await tx.query('UPDATE conversations SET last_message_id = $2 WHERE id = $1', [conversationId, lastId]);
    });

    console.log('[Seed] Seed completed: Created Alice, Bob, Charlie and starter conversation.');
  } catch (err) {
    console.error('[Seed] Error seeding data:', err);
  }
};
