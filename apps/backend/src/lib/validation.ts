import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import logger from './logger';

// Shared schemas
export const phoneSchema = z
  .string()
  .min(7, 'رقم الهاتف قصير جداً')
  .max(20, 'رقم الهاتف طويل جداً')
  .regex(/^[\d+\-\(\)\s]+$/, 'رقم الهاتف غير صالح');

export const nameSchema = z
  .string()
  .min(1, 'الاسم مطلوب')
  .max(100, 'الاسم طويل جداً');

export const messageSchema = z
  .string()
  .min(1, 'الرسالة لا يمكن أن تكون فارغة')
  .max(10000, 'الرسالة طويلة جداً');

// Auth schemas
export const loginSchema = z.object({
  email: z.string().email('بريد إلكتروني غير صالح'),
  password: z.string().min(6, 'كلمة المرور قصيرة جداً'),
});

export const registerSchema = z.object({
  name: nameSchema,
  email: z.string().email('بريد إلكتروني غير صالح'),
  password: z.string().min(8, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل'),
  teamId: z.string().optional(),
});

// Conversation schemas
export const createConversationSchema = z.object({
  phone: phoneSchema,
  name: nameSchema.optional(),
  message: messageSchema.optional(),
  teamId: z.string().optional(),
});

export const resolveConversationSchema = z.object({
  conversationId: z.string().uuid('معرّف محادثة غير صالح'),
  withMessage: z.string().max(500).optional(),
});

// Ticket schemas
export const createTicketSchema = z.object({
  conversationId: z.string().uuid('معرّف محادثة غير صالح'),
  title: z.string().min(5, 'العنوان قصير جداً').max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
});

export const updateTicketSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  assignedToId: z.string().uuid().optional(),
});

// Contact schemas
export const createContactSchema = z.object({
  phone: phoneSchema,
  name: nameSchema.optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateContactSchema = z.object({
  name: nameSchema.optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
});

// Campaign schemas
export const createCampaignSchema = z.object({
  title: z.string().min(3, 'عنوان الحملة قصير جداً').max(100),
  message: messageSchema,
  mediaUrl: z.string().url().optional(),
  scheduledAt: z.string().datetime().optional(),
  recipientPhones: z.array(phoneSchema).optional(),
});

// Template schemas
export const createTemplateSchema = z.object({
  title: z.string().min(1).max(100),
  body: messageSchema,
  category: z.enum(['QUICK_REPLY', 'AUTO_REPLY', 'CAMPAIGN', 'OUTAGE', 'OUT_OF_HOURS']),
  teamId: z.string().optional(),
});

// Middleware to validate request body
export function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.body);
      (req as any).validated = validated;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        logger.warn('Validation error', {
          endpoint: req.path,
          errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
        });
        return res.status(400).json({
          error: 'Validation failed',
          details: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
        });
      }
      next(err);
    }
  };
}

// Middleware to validate query params
export function validateQuery<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.query);
      (req as any).validatedQuery = validated;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        logger.warn('Query validation error', { endpoint: req.path, errors: err.errors });
        return res.status(400).json({
          error: 'Invalid query parameters',
          details: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
        });
      }
      next(err);
    }
  };
}
