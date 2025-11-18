import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

const metadataSchema = z
  .record(z.string().trim(), z.union([z.string(), z.number(), z.boolean()]).optional())
  .optional()
  .default({});

const subscriptionDetailsSchema = z
  .object({
    metal: z.enum(['gold', 'silver']),
    planName: z.string().trim().optional(),
    targetWeight: z
      .union([z.number(), z.string()])
      .transform((value) => Number(value))
      .refine((value) => Number.isFinite(value) && value > 0, 'targetWeight must be greater than 0'),
    targetUnit: z.enum(['oz', 'g']),
    monthlyInvestment: z
      .union([z.number(), z.string()])
      .transform((value) => Number(value))
      .refine((value) => Number.isFinite(value) && value > 0, 'monthlyInvestment must be greater than 0')
      .optional(),
    quantity: z
      .union([z.number(), z.string()])
      .transform((value) => Number(value))
      .refine((value) => Number.isFinite(value) && value > 0, 'quantity must be positive')
      .optional(),
    targetPrice: z
      .union([z.number(), z.string()])
      .transform((value) => Number(value))
      .refine((value) => Number.isFinite(value) && value >= 0, 'targetPrice must be zero or greater')
      .optional(),
  })
  .partial()
  .optional();

const createSessionSchema = z.object({
  amount: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, 'amount must be a positive number'),
  currency: z.string().trim().optional().default('inr'),
  metadata: metadataSchema,
  mode: z.enum(['subscription', 'payment']).optional().default('subscription'),
  productName: z.string().trim().optional(),
  description: z.string().trim().optional(),
  interval: z.enum(['month', 'year']).optional().default('month'),
  intervalCount: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, 'intervalCount must be positive')
    .optional()
    .default(1),
  quantity: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && value > 0, 'quantity must be positive')
    .optional()
    .default(1),
  customerEmail: z.string().email().optional(),
  subscriptionDetails: subscriptionDetailsSchema,
});

export type CreateSessionPayload = z.infer<typeof createSessionSchema>;

export const validateCreateSessionPayload = (req: Request, res: Response, next: NextFunction): void => {
  const parsed = createSessionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request payload',
      details: parsed.error.flatten(),
    });
    return;
  }

  req.body = parsed.data;
  next();
};


