import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';
import { MediaService, MAX_IMAGE_BYTES } from '../services/media/media.service';
import { emitToUsers } from '../sockets/socketManager';

/**
 * Chat photos.
 *   POST /api/media            multipart: conversationId + photo  -> { message }
 *   GET  /api/media/:mediaId   the photo (only for participants of its conversation)
 * Both need `Authorization: Bearer <access token>`.
 */
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'You are sending photos too quickly. Please wait a moment.',
});

const handleUpload = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  upload.single('photo')(req, res, (err: any) => {
    if (!err) return next();
    const message =
      err?.code === 'LIMIT_FILE_SIZE'
        ? 'Photo is too large (max 8 MB)'
        : err?.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Send exactly one photo in the "photo" field'
          : 'Could not read the upload';
    res.status(400).json({ success: false, message });
  });
};

router.post('/', requireAuth, uploadLimiter, handleUpload, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!conversationId || !file) {
      res.status(400).json({ success: false, message: 'conversationId and a photo are required' });
      return;
    }
    const { message, participantIds } = await MediaService.sendImage(req.user!.id, conversationId, file.buffer);
    const payload = JSON.parse(JSON.stringify(message));
    emitToUsers(participantIds, 'message:new', payload);
    res.status(201).json({ success: true, data: { message: payload } });
  } catch (err: any) {
    const msg: string = err?.message || 'Could not send photo';
    const status = /not found|access denied/i.test(msg) ? 404 : 400;
    res.status(status).json({ success: false, message: msg });
  }
});

router.get('/:mediaId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const media = await MediaService.getForUser(req.params.mediaId, req.user!.id);
    if (!media) {
      res.status(404).json({ success: false, message: 'Photo not found' });
      return;
    }
    res.setHeader('Content-Type', media.mime);
    res.setHeader('Content-Length', String(media.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    // Ids are never reused, so devices may cache a photo for good (privately)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(media.data);
  } catch (err: any) {
    console.error('[Media] download error:', err?.message);
    res.status(500).json({ success: false, message: 'Could not load photo' });
  }
});

export default router;
