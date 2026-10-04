import { Router } from 'express';
import { AuthController } from '../controllers/auth/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// REST Authentication Endpoints (Strict separation: REST is auth only)
router.post('/register', AuthController.register);
router.post('/login', AuthController.login);
router.post('/logout', requireAuth, AuthController.logout);
router.post('/refresh-token', AuthController.refreshToken);
router.post('/forgot-password', AuthController.forgotPassword);
router.post('/reset-password', AuthController.resetPassword);
router.get('/me', requireAuth, AuthController.getMe);

export default router;
