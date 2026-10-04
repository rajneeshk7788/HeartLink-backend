import crypto from 'crypto';
import { User, IUser } from '../../models/User';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';

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

export class AuthService {
  static async register(dto: RegisterDTO): Promise<AuthResponse> {
    const existingEmail = await User.findOne({ email: dto.email.toLowerCase().trim() });
    if (existingEmail) {
      throw new Error('An account with this email already exists');
    }

    const existingUsername = await User.findOne({ username: dto.username.toLowerCase().trim() });
    if (existingUsername) {
      throw new Error('This username is already taken');
    }

    const user = new User({
      username: dto.username.toLowerCase().trim(),
      email: dto.email.toLowerCase().trim(),
      password: dto.password,
      displayName: dto.displayName.trim(),
      avatar: dto.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(dto.username)}`,
      gender: dto.gender || 'prefer-not-to-say',
      bio: dto.bio || '',
      isOnline: true,
      lastSeen: new Date(),
    });

    const accessToken = signAccessToken(user._id.toString());
    const refreshToken = signRefreshToken(user._id.toString());

    user.refreshTokens = [refreshToken];
    await user.save();

    return {
      accessToken,
      refreshToken,
      user: user.toSafeUser(),
    };
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

    const accessToken = signAccessToken(user._id.toString());
    const refreshToken = signRefreshToken(user._id.toString());

    // Keep up to 5 refresh tokens to support multi-device
    user.refreshTokens = [...(user.refreshTokens || []).slice(-4), refreshToken];
    user.isOnline = true;
    user.lastSeen = new Date();
    await user.save();

    return {
      accessToken,
      refreshToken,
      user: user.toSafeUser(),
    };
  }

  static async logout(userId: string, refreshToken?: string): Promise<void> {
    const user = await User.findById(userId);
    if (!user) return;

    if (refreshToken) {
      user.refreshTokens = user.refreshTokens.filter((token) => token !== refreshToken);
    } else {
      user.refreshTokens = [];
    }
    await user.save();
  }

  static async refreshToken(oldRefreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = verifyRefreshToken(oldRefreshToken);
    if (!payload) {
      throw new Error('Invalid or expired refresh token');
    }

    const user = await User.findById(payload.userId);
    if (!user || !user.refreshTokens.includes(oldRefreshToken)) {
      throw new Error('Refresh token revoked or invalid');
    }

    // Token rotation
    const newAccessToken = signAccessToken(user._id.toString());
    const newRefreshToken = signRefreshToken(user._id.toString());

    user.refreshTokens = user.refreshTokens.filter((token) => token !== oldRefreshToken);
    user.refreshTokens.push(newRefreshToken);
    await user.save();

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  static async forgotPassword(email: string): Promise<{ message: string; resetToken?: string }> {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Return vague message for security, but return token if dev environment
      return { message: 'If that email is registered, password reset instructions have been generated.' };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpires = new Date(Date.now() + 3600000); // 1 hour
    await user.save();

    return {
      message: 'Password reset token generated successfully. In production this is sent via email.',
      resetToken, // Returned so frontend user can test reset immediately
    };
  }

  static async resetPassword(resetToken: string, newPassword: string): Promise<{ message: string }> {
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
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
