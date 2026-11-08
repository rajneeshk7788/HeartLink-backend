import { query, queryOne } from '../../db';
import { User, isValidId, selfUserColumns } from '../../models/types';
import { isSafeHttpUrl } from '../../utils/validation';

export interface UpdateProfileInput {
  displayName?: string | null;
  bio?: string | null;
  avatar?: string | null;
  gender?: string | null;
  statusMessage?: string | null;
}

const MAX_QUERY_LENGTH = 50;
export const ALLOWED_GENDERS = ['male', 'female', 'non-binary', 'other', 'prefer-not-to-say'];

/** Escape LIKE wildcards so user input is matched literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export class UserService {
  static async findById(userId: string): Promise<User | null> {
    if (!isValidId(userId)) return null;
    return queryOne<User>(`SELECT ${selfUserColumns('u')} FROM users u WHERE u.id = $1`, [userId]);
  }

  static async searchUsers(searchText: string, currentUserId: string): Promise<User[]> {
    const trimmed = (searchText || '').trim().slice(0, MAX_QUERY_LENGTH);

    if (!trimmed) {
      // Recently active users when there is no search text
      return query<User>(
        `SELECT ${selfUserColumns('u')} FROM users u WHERE u.id <> $1 ORDER BY u.last_seen DESC LIMIT 20`,
        [currentUserId]
      );
    }

    // Email is private: only match on public fields
    const pattern = `%${escapeLike(trimmed)}%`;
    return query<User>(
      `SELECT ${selfUserColumns('u')} FROM users u
        WHERE u.id <> $1 AND (u.username ILIKE $2 OR u.display_name ILIKE $2)
        ORDER BY u.display_name ASC LIMIT 20`,
      [currentUserId, pattern]
    );
  }

  static async getUserProfile(userId: string): Promise<User | null> {
    return UserService.findById(userId);
  }

  static async updateProfile(userId: string, input: UpdateProfileInput): Promise<User> {
    const current = await UserService.findById(userId);
    if (!current) {
      throw new Error('User not found');
    }

    const next = {
      displayName: current.displayName,
      bio: current.bio,
      avatar: current.avatar,
      gender: current.gender,
      statusMessage: current.statusMessage,
    };

    if (input.displayName !== undefined && input.displayName !== null) {
      const displayName = input.displayName.trim();
      if (!displayName) throw new Error('Display name cannot be empty');
      if (displayName.length > 50) throw new Error('Display name is too long (max 50 characters)');
      next.displayName = displayName;
    }
    if (input.bio !== undefined && input.bio !== null) {
      const bio = input.bio.trim();
      if (bio.length > 500) throw new Error('Bio is too long (max 500 characters)');
      next.bio = bio;
    }
    if (input.avatar !== undefined && input.avatar !== null) {
      const avatar = input.avatar.trim();
      if (avatar && !isSafeHttpUrl(avatar)) {
        throw new Error('Avatar must be an http(s) URL');
      }
      next.avatar = avatar;
    }
    if (input.gender !== undefined && input.gender !== null) {
      if (!ALLOWED_GENDERS.includes(input.gender)) {
        throw new Error(`Gender must be one of: ${ALLOWED_GENDERS.join(', ')}`);
      }
      next.gender = input.gender;
    }
    if (input.statusMessage !== undefined && input.statusMessage !== null) {
      const statusMessage = input.statusMessage.trim();
      if (statusMessage.length > 140) throw new Error('Status message is too long (max 140 characters)');
      next.statusMessage = statusMessage;
    }

    const updated = await queryOne<User>(
      `UPDATE users u SET display_name = $2, bio = $3, avatar = $4, gender = $5, status_message = $6, updated_at = now()
        WHERE u.id = $1
        RETURNING ${selfUserColumns('u')}`,
      [userId, next.displayName, next.bio, next.avatar, next.gender, next.statusMessage]
    );
    return updated!;
  }

  static async setPresence(userId: string, isOnline: boolean): Promise<void> {
    if (!isValidId(userId)) return;
    await query('UPDATE users SET is_online = $2, last_seen = now() WHERE id = $1', [userId, isOnline]);
  }

  /** After a restart nobody is connected yet: clear stale online flags. */
  static async resetAllPresence(): Promise<void> {
    await query('UPDATE users SET is_online = false WHERE is_online = true');
  }
}
