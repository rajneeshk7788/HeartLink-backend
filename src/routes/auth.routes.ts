import { Router } from 'express';
import { AuthController } from '../controllers/auth/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';

const router = Router();

const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many password reset requests. Please try again later.',
});
const refreshLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// REST Authentication Endpoints (Strict separation: REST is auth only)
router.post('/register', credentialLimiter, AuthController.register);
router.post('/login', credentialLimiter, AuthController.login);
// Logout works with just the refresh token (access token may already be expired)
router.post('/logout', AuthController.logout);
router.post('/refresh-token', refreshLimiter, AuthController.refreshToken);
router.post('/forgot-password', resetLimiter, AuthController.forgotPassword);
router.post('/reset-password', resetLimiter, AuthController.resetPassword);
router.get('/me', requireAuth, AuthController.getMe);

export default router;
