import mongoose from 'mongoose';
import { User, IUser } from '../../models/User';
import { isSafeHttpUrl } from '../auth/auth.service';

export interface UpdateProfileInput {
  displayName?: string;
  bio?: string;
  avatar?: string;
  gender?: string;
  statusMessage?: string;
}

const MAX_QUERY_LENGTH = 50;
const ALLOWED_GENDERS = ['male', 'female', 'non-binary', 'other', 'prefer-not-to-say'];

/** Escape user input so it is matched literally (prevents regex injection / ReDoS). */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class UserService {
  static async searchUsers(query: string, currentUserId: string): Promise<IUser[]> {
    const trimmed = (query || '').trim().slice(0, MAX_QUERY_LENGTH);

    if (!trimmed) {
      // Return recently active users if query is empty
      return User.find({ _id: { $ne: currentUserId } })
        .sort({ lastSeen: -1 })
        .limit(20);
    }

    const regex = new RegExp(escapeRegex(trimmed), 'i');
    // Email is private: only match on public fields
    return User.find({
      _id: { $ne: currentUserId },
      $or: [{ username: regex }, { displayName: regex }],
    })
      .sort({ displayName: 1 })
      .limit(20);
  }

  static async getUserProfile(userId: string): Promise<IUser | null> {
    if (!mongoose.Types.ObjectId.isValid(userId)) return null;
    return User.findById(userId);
  }

  static async updateProfile(userId: string, input: UpdateProfileInput): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (input.displayName !== undefined && input.displayName !== null) {
      const displayName = input.displayName.trim();
      if (!displayName) throw new Error('Display name cannot be empty');
      if (displayName.length > 50) throw new Error('Display name is too long (max 50 characters)');
      user.displayName = displayName;
    }
    if (input.bio !== undefined && input.bio !== null) user.bio = input.bio.trim();
    if (input.avatar !== undefined && input.avatar !== null) {
      const avatar = input.avatar.trim();
      if (avatar && !isSafeHttpUrl(avatar)) {
        throw new Error('Avatar must be an http(s) URL');
      }
      user.avatar = avatar;
    }
    if (input.gender !== undefined && input.gender !== null) {
      if (!ALLOWED_GENDERS.includes(input.gender)) {
        throw new Error(`Gender must be one of: ${ALLOWED_GENDERS.join(', ')}`);
      }
      user.gender = input.gender;
    }
    if (input.statusMessage !== undefined && input.statusMessage !== null) {
      user.statusMessage = input.statusMessage.trim();
    }

    await user.save(); // schema validators enforce bio/statusMessage max lengths
    return user;
  }
}
