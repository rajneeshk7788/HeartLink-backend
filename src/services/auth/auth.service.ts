import crypto from 'crypto';
import { User, IUser } from '../../models/User';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} from '../../utils/jwt';
import { config } from '../../config';
import { isMailConfigured, sendPasswordResetEmail } from '../../utils/mailer';

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
  user: ReturnType<IUser['toSafeUser']>;
}

const MAX_SESSIONS = 5;
const FORGOT_PASSWORD_MESSAGE =
  'If that email is registered, password reset instructions have been sent.';

export const isSafeHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const issueSession = async (user: IUser): Promise<{ accessToken: string; refreshToken: string }> => {
  const accessToken = signAccessToken(user._id.toString());
  const refreshToken = signRefreshToken(user._id.toString());
  // Keep the most recent sessions (multi-device), stored hashed
  user.refreshTokens = [...(user.refreshTokens || []).slice(-(MAX_SESSIONS - 1)), hashToken(refreshToken)];
  return { accessToken, refreshToken };
};

export class AuthService {
  static async register(dto: RegisterDTO): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const username = dto.username.toLowerCase().trim();

    if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
      throw new Error('Username must be 3-30 characters: letters, numbers, underscores or dots');
    }

    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      throw new Error('An account with this email already exists');
    }

    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      throw new Error('This username is already taken');
    }

    if (dto.avatar && !isSafeHttpUrl(dto.avatar)) {
      throw new Error('Avatar must be an http(s) URL');
    }

    const user = new User({
      username,
      email,
      password: dto.password,
      displayName: dto.displayName.trim(),
      avatar: dto.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`,
      gender: dto.gender || 'prefer-not-to-say',
      bio: dto.bio || '',
      lastSeen: new Date(),
    });

    const tokens = await issueSession(user);
    await user.save();

    return { ...tokens, user: user.toSafeUser() };
  }

  static async login(dto: LoginDTO): Promise<AuthResponse> {
    const user = await User.findOne({ email: dto.email.toLowerCase().trim() });
    if (!user) {
      throw new Error('Invalid email or password');
    }

    const isMatch = await user.comparePassword(dto.password);
    if (!isMatch) {
      throw new Error('Invalid email or password');
    }

    const tokens = await issueSession(user);
    user.lastSeen = new Date();
    await user.save();

    return { ...tokens, user: user.toSafeUser() };
  }

  /**
   * Revokes a session. Works with only the refresh token, so clients can log out
   * even after their short-lived access token has expired.
   */
  static async logout(refreshToken?: string, userIdFromAccessToken?: string): Promise<void> {
    if (refreshToken) {
      const payload = verifyRefreshToken(refreshToken);
      const userId = payload?.userId || userIdFromAccessToken;
      if (!userId) return;
      await User.updateOne({ _id: userId }, { $pull: { refreshTokens: hashToken(refreshToken) } });
      return;
    }
    if (userIdFromAccessToken) {
      await User.updateOne({ _id: userIdFromAccessToken }, { $set: { refreshTokens: [] } });
    }
  }

  static async refreshToken(oldRefreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = verifyRefreshToken(oldRefreshToken);
    if (!payload) {
      throw new Error('Invalid or expired refresh token');
    }

    const user = await User.findById(payload.userId);
    const oldHash = hashToken(oldRefreshToken);
    if (!user || !user.refreshTokens.includes(oldHash)) {
      throw new Error('Refresh token revoked or invalid');
    }

    // Token rotation
    user.refreshTokens = user.refreshTokens.filter((token) => token !== oldHash);
    const tokens = await issueSession(user);
    await user.save();

    return tokens;
  }

  static async forgotPassword(email: string): Promise<{ message: string; resetToken?: string }> {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Same response whether or not the account exists (no account enumeration)
      return { message: FORGOT_PASSWORD_MESSAGE };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = hashToken(resetToken);
    user.resetPasswordExpires = new Date(Date.now() + 3600000); // 1 hour
    await user.save();

    if (isMailConfigured()) {
      try {
        await sendPasswordResetEmail(user.email, resetToken);
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
    const user = await User.findOne({
      resetPasswordToken: hashToken(resetToken),
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      throw new Error('Password reset token is invalid or has expired');
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.refreshTokens = []; // Revoke all sessions on password reset
    await user.save();

    return { message: 'Password has been reset successfully. Please log in with your new password.' };
  }

  static async getMe(userId: string): Promise<ReturnType<IUser['toSafeUser']>> {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    return user.toSafeUser();
  }
}
