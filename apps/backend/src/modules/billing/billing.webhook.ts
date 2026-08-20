import { Request, Response } from 'express';
import { handlePaymentWebhook } from './billing.service';

export async function billingWebhookHandler(req: Request, res: Response) {
  try {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const result = await handlePaymentWebhook(rawBody, req.headers);
    res.json(result);
  } catch (error) {
    const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
    res.status(status).json({ error: status >= 500 ? 'Payment webhook failed' : (error as Error).message });
  }
}

