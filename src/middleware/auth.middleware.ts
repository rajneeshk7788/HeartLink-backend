import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { User } from '../models/types';
import { UserService } from '../services/user/user.service';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Authorization header missing or invalid' });
      return;
    }

    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      res.status(401).json({ success: false, message: 'Invalid or expired access token' });
      return;
    }

    const user = await UserService.findById(payload.userId);
    if (!user) {
      res.status(401).json({ success: false, message: 'User associated with token not found' });
      return;
    }

    req.user = user;
    next();
  } catch (err: any) {
    console.error('[Auth] middleware error:', err);
    res.status(500).json({ success: false, message: 'Authentication error' });
  }
};

/** Resolves the signed-in user for GraphQL / sockets; null when missing or invalid. */
export const getUserFromToken = async (token?: string | null): Promise<User | null> => {
  if (!token) return null;
  const payload = verifyAccessToken(token);
  if (!payload) return null;
  return UserService.findById(payload.userId);
};

export const getContextUserFromToken = async (authHeader?: string): Promise<User | null> => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return getUserFromToken(authHeader.slice(7));
};
