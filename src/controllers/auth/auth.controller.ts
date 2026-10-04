import { Response } from 'express';
import { AuthService } from '../../services/auth/auth.service';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';

export class AuthController {
  static async register(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { username, email, password, displayName, avatar, gender, bio } = req.body;

      if (!username || !email || !password || !displayName) {
        res.status(400).json({
          success: false,
          message: 'Username, email, password, and display name are required',
        });
        return;
      }

      if (password.length < 6) {
        res.status(400).json({
          success: false,
          message: 'Password must be at least 6 characters long',
        });
        return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        res.status(400).json({
          success: false,
          message: 'Please provide a valid email address',
        });
        return;
      }

      const result = await AuthService.register({
        username,
        email,
        password,
        displayName,
        avatar,
        gender,
        bio,
      });

      res.status(201).json({
        success: true,
        message: 'Account registered successfully',
        data: result,
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        message: err.message || 'Registration failed',
      });
    }
  }

  static async login(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({
          success: false,
          message: 'Email and password are required',
        });
        return;
      }

      const result = await AuthService.login({ email, password });

      res.status(200).json({
        success: true,
        message: 'Logged in successfully',
        data: result,
      });
    } catch (err: any) {
      res.status(401).json({
        success: false,
        message: err.message || 'Login failed',
      });
    }
  }

  static async logout(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;
      const userId = req.user?._id?.toString();

      if (userId) {
        await AuthService.logout(userId, refreshToken);
      }

      res.status(200).json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err.message || 'Logout failed',
      });
    }
  }

  static async refreshToken(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        res.status(400).json({
          success: false,
          message: 'Refresh token is required',
        });
        return;
      }

      const tokens = await AuthService.refreshToken(refreshToken);

      res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: tokens,
      });
    } catch (err: any) {
      res.status(401).json({
        success: false,
        message: err.message || 'Invalid refresh token',
      });
    }
  }

  static async forgotPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({
          success: false,
          message: 'Email is required',
        });
        return;
      }

      const result = await AuthService.forgotPassword(email);

      res.status(200).json({
        success: true,
        message: result.message,
        resetToken: result.resetToken,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to process forgot password request',
      });
    }
  }

  static async resetPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { resetToken, newPassword } = req.body;

      if (!resetToken || !newPassword) {
        res.status(400).json({
          success: false,
          message: 'Reset token and new password are required',
        });
        return;
      }

      if (newPassword.length < 6) {
        res.status(400).json({
          success: false,
          message: 'New password must be at least 6 characters long',
        });
        return;
      }

      const result = await AuthService.resetPassword(resetToken, newPassword);

      res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        message: err.message || 'Password reset failed',
      });
    }
  }

  static async getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: 'Unauthorized',
        });
        return;
      }

      const user = await AuthService.getMe(req.user._id.toString());

      res.status(200).json({
        success: true,
        data: { user },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err.message || 'Failed to fetch user',
      });
    }
  }
}
