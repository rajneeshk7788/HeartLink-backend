import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';

export const seedInitialData = async () => {
  try {
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      console.log('[Seed] Database already contains users, skipping seed.');
      return;
    }

    console.log('[Seed] Seeding initial demo users and chat...');

    const alice = new User({
      username: 'alice',
      email: 'alice@example.com',
      password: 'Password123!',
      displayName: 'Alice Johnson',
      avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
      gender: 'female',
      bio: 'Loves photography, coffee, and weekend hikes.',
      statusMessage: 'Ready for great conversations! ✨',
      isOnline: false,
    });
    await alice.save();

    const bob = new User({
      username: 'bob',
      email: 'bob@example.com',
      password: 'Password123!',
      displayName: 'Bob Smith',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
      gender: 'male',
      bio: 'Software engineer, marathon runner, and jazz lover.',
      statusMessage: 'Code, run, repeat 🏃‍♂️',
      isOnline: false,
    });
    await bob.save();

    const charlie = new User({
      username: 'charlie',
      email: 'charlie@example.com',
      password: 'Password123!',
      displayName: 'Charlie Davis',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
      gender: 'non-binary',
      bio: 'Digital artist & music producer looking for creative connections.',
      statusMessage: 'Designing the future 🎨',
      isOnline: false,
    });
    await charlie.save();

    // Create initial conversation between Alice and Bob
    const conversation = new Conversation({
      participants: [alice._id, bob._id],
      unreadCounts: [
        { userId: alice._id, count: 0 },
        { userId: bob._id, count: 0 },
      ],
    });
    await conversation.save();

    const msg1 = new Message({
      conversationId: conversation._id,
      sender: bob._id,
      content: 'Hey Alice! Great to connect with you here on ConnectPulse.',
      type: 'text',
      readBy: [bob._id, alice._id],
      status: 'read',
    });
    await msg1.save();

    const msg2 = new Message({
      conversationId: conversation._id,
      sender: alice._id,
      content: 'Hi Bob! Loved reading your profile. Are you up for a quick video chat later?',
      type: 'text',
      readBy: [alice._id, bob._id],
      status: 'read',
    });
    await msg2.save();

    conversation.lastMessage = msg2._id;
    await conversation.save();

    console.log('[Seed] Seed completed: Created Alice, Bob, Charlie and starter conversation.');
  } catch (err) {
    console.error('[Seed] Error seeding data:', err);
  }
};
