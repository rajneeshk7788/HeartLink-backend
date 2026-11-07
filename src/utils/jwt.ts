import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
  userId: string;
}

export const signAccessToken = (userId: string): string => {
  return jwt.sign({ userId }, config.jwtSecret, {
    expiresIn: config.jwtAccessExpiresIn,
  } as jwt.SignOptions);
};

export const signRefreshToken = (userId: string): string => {
  // jti makes every refresh token unique, even when two are issued in the same second
  return jwt.sign({ userId }, config.jwtRefreshSecret, {
    expiresIn: config.jwtRefreshExpiresIn,
    jwtid: crypto.randomBytes(16).toString('hex'),
  } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): TokenPayload | null => {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as TokenPayload;
    return payload?.userId ? payload : null;
  } catch {
    return null;
  }
};

export const verifyRefreshToken = (token: string): TokenPayload | null => {
  try {
    const payload = jwt.verify(token, config.jwtRefreshSecret) as TokenPayload;
    return payload?.userId ? payload : null;
  } catch {
    return null;
  }
};

/** Refresh tokens are stored hashed so a database leak does not expose live sessions. */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
