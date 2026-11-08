import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, withTransaction, Tx } from '../../db';
import { User, selfUserColumns } from '../../models/types';
import { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } from '../../utils/jwt';
import { config } from '../../config';
import { isMailConfigured, sendPasswordResetEmail } from '../../utils/mailer';
import { isSafeHttpUrl, isUniqueViolation } from '../../utils/validation';
import { ALLOWED_GENDERS } from '../user/user.service';

export { isSafeHttpUrl };

export interface RegisterDTO {
  username: string;
  email: string;
  password: string;
  displayName: string;
  avatar?: string;
  gender?: string;
  bio?: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

const MAX_SESSIONS = 5;
const BCRYPT_ROUNDS = 10;
// Real bcrypt hash of a random value, compared against when the email is unknown (timing safety)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);
const FORGOT_PASSWORD_MESSAGE = 'If that email is registered, password reset instructions have been sent.';

/** Issues a token pair and stores the (hashed) refresh token, keeping the newest MAX_SESSIONS. */
const issueSession = async (tx: Tx, userId: string): Promise<{ accessToken: string; refreshToken: string }> => {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  await tx.query('INSERT INTO refresh_tokens (token_hash, user_id) VALUES ($1, $2)', [hashToken(refreshToken), userId]);
  await tx.query(
    `DELETE FROM refresh_tokens
      WHERE user_id = $1
        AND token_hash NOT IN (
          SELECT token_hash FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
    [userId, MAX_SESSIONS]
  );
  return { accessToken, refreshToken };
};

const getSelf = async (tx: Tx, userId: string): Promise<User> => {
  const { rows } = await tx.query(`SELECT ${selfUserColumns('u')} FROM users u WHERE u.id = $1`, [userId]);
  return rows[0];
};

export class AuthService {
  static async register(dto: RegisterDTO): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const username = dto.username.toLowerCase().trim();
    const displayName = dto.displayName.trim();

    if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
      throw new Error('Username must be 3-30 characters: letters, numbers, underscores or dots');
    }
    if (!displayName || displayName.length > 50) {
      throw new Error('Display name must be 1-50 characters');
    }
    if (dto.avatar && !isSafeHttpUrl(dto.avatar)) {
      throw new Error('Avatar must be an http(s) URL');
    }
    if ((dto.bio || '').length > 500) {
      throw new Error('Bio is too long (max 500 characters)');
    }
    const gender = dto.gender && ALLOWED_GENDERS.includes(dto.gender) ? dto.gender : 'prefer-not-to-say';

    if (await queryOne('SELECT 1 FROM users WHERE email = $1', [email])) {
      throw new Error('An account with this email already exists');
    }
    if (await queryOne('SELECT 1 FROM users WHERE username = $1', [username])) {
      throw new Error('This username is already taken');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      return await withTransaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO users (username, email, password_hash, display_name, avatar, gender, bio)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
          [
            username,
            email,
            passwordHash,
            displayName,
            dto.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`,
            gender,
            dto.bio || '',
          ]
        );
        const userId: string = rows[0].id;
        const tokens = await issueSession(tx, userId);
        return { ...tokens, user: await getSelf(tx, userId) };
      });
    } catch (err) {
      // Two sign-ups racing for the same email/username
      if (isUniqueViolation(err, 'users_email_key')) throw new Error('An account with this email already exists');
      if (isUniqueViolation(err, 'users_username_key')) throw new Error('This username is already taken');
      throw err;
    }
  }

  static async login(dto: LoginDTO): Promise<AuthResponse> {
    const row = await queryOne<{ id: string; password_hash: string }>(
      'SELECT id::text AS id, password_hash FROM users WHERE email = $1',
      [dto.email.toLowerCase().trim()]
    );
    // Compare even when the user doesn't exist so response time doesn't reveal which emails are registered
    const hash = row?.password_hash || DUMMY_HASH;
    const isMatch = await bcrypt.compare(dto.password, hash);
    if (!row || !isMatch) {
      throw new Error('Invalid email or password');
    }

    return withTransaction(async (tx) => {
      const tokens = await issueSession(tx, row.id);
      await tx.query('UPDATE users SET last_seen = now() WHERE id = $1', [row.id]);
      return { ...tokens, user: await getSelf(tx, row.id) };
    });
  }

  /**
   * Revokes a session. Works with only the refresh token, so clients can log out
   * even after their short-lived access token has expired.
   */
  static async logout(refreshToken?: string, userIdFromAccessToken?: string): Promise<void> {
    if (refreshToken) {
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)]);
      return;
    }
    if (userIdFromAccessToken) {
      await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userIdFromAccessToken]);
    }
  }

  static async refreshToken(oldRefreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = verifyRefreshToken(oldRefreshToken);
    if (!payload) {
      throw new Error('Invalid or expired refresh token');
    }

    return withTransaction(async (tx) => {
      // Deleting the old token in the same statement makes reuse (and parallel refreshes) fail cleanly
      const { rowCount } = await tx.query('DELETE FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2', [
        hashToken(oldRefreshToken),
        payload.userId,
      ]);
      if (!rowCount) {
        throw new Error('Refresh token revoked or invalid');
      }
      return issueSession(tx, payload.userId);
    });
  }

  static async forgotPassword(email: string): Promise<{ message: string; resetToken?: string }> {
    const row = await queryOne<{ id: string; email: string }>(
      'SELECT id::text AS id, email FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (!row) {
      // Same response whether or not the account exists (no account enumeration)
      return { message: FORGOT_PASSWORD_MESSAGE };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    await query(
      `UPDATE users SET reset_password_token = $2, reset_password_expires = now() + interval '1 hour' WHERE id = $1`,
      [row.id, hashToken(resetToken)]
    );

    if (isMailConfigured()) {
      try {
        await sendPasswordResetEmail(row.email, resetToken);
      } catch (err: any) {
        console.error('[Auth] Failed to send password reset email:', err.message);
      }
    } else if (config.isProduction) {
      console.error('[Auth] Password reset requested but SMTP is not configured (set SMTP_HOST etc).');
    }

    // The raw token is only ever returned to the client in development builds.
    if (config.exposeResetTokenInResponse) {
      return {
        message: 'Development mode: reset token returned directly (in production it is emailed).',
        resetToken,
      };
    }
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  static async resetPassword(resetToken: string, newPassword: string): Promise<{ message: string }> {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE users
            SET password_hash = $2, reset_password_token = NULL, reset_password_expires = NULL, updated_at = now()
          WHERE reset_password_token = $1 AND reset_password_expires > now()
          RETURNING id`,
        [hashToken(resetToken), passwordHash]
      );
      if (rows.length === 0) {
        throw new Error('Password reset token is invalid or has expired');
      }
      // Revoke all sessions on password reset
      await tx.query('DELETE FROM refresh_tokens WHERE user_id = $1', [rows[0].id]);
    });
    return { message: 'Password has been reset successfully. Please log in with your new password.' };
  }

  static async getMe(userId: string): Promise<User> {
    const user = await queryOne<User>(`SELECT ${selfUserColumns('u')} FROM users u WHERE u.id = $1`, [userId]);
    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }
}
