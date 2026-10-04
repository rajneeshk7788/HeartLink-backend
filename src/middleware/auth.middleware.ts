import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { User, IUser } from '../models/User';

export interface AuthenticatedRequest extends Request {
  user?: IUser;
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

    const token = authHeader.split(' ')[1];
    const payload = verifyAccessToken(token);

    if (!payload) {
      res.status(401).json({ success: false, message: 'Invalid or expired access token' });
      return;
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      res.status(401).json({ success: false, message: 'User associated with token not found' });
      return;
    }

    req.user = user;
    next();
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Authentication error', error: err.message });
  }
};

export const getContextUserFromToken = async (
  authHeader?: string
): Promise<IUser | null> => {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];
  const payload = verifyAccessToken(token);
  if (!payload) {
    return null;
  }
  return User.findById(payload.userId);
};
