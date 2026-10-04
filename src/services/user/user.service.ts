import { User, IUser } from '../../models/User';

export interface UpdateProfileInput {
  displayName?: string;
  bio?: string;
  avatar?: string;
  gender?: string;
  statusMessage?: string;
}

export class UserService {
  static async searchUsers(query: string, currentUserId: string): Promise<IUser[]> {
    if (!query || query.trim() === '') {
      // Return recent active users if query is empty
      return User.find({ _id: { $ne: currentUserId } })
        .sort({ updatedAt: -1 })
        .limit(20);
    }

    const regex = new RegExp(query.trim(), 'i');
    return User.find({
      _id: { $ne: currentUserId },
      $or: [{ username: regex }, { displayName: regex }, { email: regex }],
    })
      .sort({ displayName: 1 })
      .limit(20);
  }

  static async getUserProfile(userId: string): Promise<IUser | null> {
    return User.findById(userId);
  }

  static async updateProfile(userId: string, input: UpdateProfileInput): Promise<IUser> {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (input.displayName !== undefined) user.displayName = input.displayName.trim();
    if (input.bio !== undefined) user.bio = input.bio.trim();
    if (input.avatar !== undefined) user.avatar = input.avatar.trim();
    if (input.gender !== undefined) user.gender = input.gender;
    if (input.statusMessage !== undefined) user.statusMessage = input.statusMessage.trim();

    await user.save();
    return user;
  }
}
