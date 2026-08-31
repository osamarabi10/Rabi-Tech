import { Router } from 'express';
import QRCode from 'qrcode';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';

const router = Router();
router.use(verifyToken);

/**
 * Generate a real QR for the click-to-chat target shown in the Growth builder.
 * The target is deliberately restricted to WhatsApp's public link format: the
 * endpoint must never become a general-purpose QR or a way to disguise a
 * destination the operator did not review.
 */
router.get('/qr', async (req, res) => {
  const target = String(req.query.target || '');
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).json({ error: 'A valid WhatsApp click-to-chat URL is required' });
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'wa.me'
    || !/^\d{5,15}$/.test(parsed.pathname.slice(1))
    || parsed.hash
  ) {
    return res.status(400).json({ error: 'Only https://wa.me click-to-chat URLs are supported' });
  }

  try {
    const dataUrl = await QRCode.toDataURL(target, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    });
    return res.json({ dataUrl });
  } catch (error) {
    logger.error('Growth QR generation failed', {
      error: error instanceof Error ? error.stack : String(error),
      requestId: (req as any).id,
    });
    return res.status(500).json({ error: 'Could not generate the QR code' });
  }
});

export default router;
