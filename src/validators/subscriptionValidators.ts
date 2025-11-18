import { body, param, query } from 'express-validator';
import { SubscriptionStatus } from '../models/Subscription';

const allowedStatuses: SubscriptionStatus[] = [
  'pending_payment',
  'active',
  'trialing',
  'canceling',
  'canceled',
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
];

export const subscriptionIdParamValidator = [
  param('id').isMongoId().withMessage('Invalid subscription id'),
];

export const listSubscriptionsValidator = [
  query('status').optional().isIn(allowedStatuses).withMessage('Invalid status value'),
  query('userId').optional().isMongoId().withMessage('Invalid userId'),
];

export const createSubscriptionValidator = [
  body('metal')
    .isIn(['gold', 'silver'])
    .withMessage('Metal must be either gold or silver'),
  body('planName').optional().isString().trim(),
  body('targetWeight')
    .isFloat({ gt: 0 })
    .withMessage('Target weight must be greater than 0'),
  body('targetUnit')
    .isIn(['oz', 'g'])
    .withMessage('Target unit must be oz or g'),
  body('monthlyInvestment')
    .isInt({ min: 1 })
    .withMessage('Monthly investment must be at least 1'),
  body('quantity').optional().isInt({ min: 1 }),
  body('accumulatedValue').optional().isFloat({ min: 0 }),
  body('accumulatedWeight').optional().isFloat({ min: 0 }),
  body('status').optional().isIn(allowedStatuses),
  body('stripeCustomerId')
    .isString()
    .notEmpty()
    .withMessage('Stripe customer id is required'),
  body('stripeSubscriptionId').optional().isString(),
  body('targetPrice').optional().isFloat({ min: 0 }),
  body('currentPeriodEnd').optional().isISO8601().toDate(),
];

export const updateSubscriptionValidator = [
  body('planName').optional().isString().trim(),
  body('targetWeight').optional().isFloat({ gt: 0 }),
  body('targetUnit').optional().isIn(['oz', 'g']),
  body('monthlyInvestment').optional().isInt({ min: 1 }),
  body('quantity').optional().isInt({ min: 1 }),
  body('accumulatedValue').optional().isFloat({ min: 0 }),
  body('accumulatedWeight').optional().isFloat({ min: 0 }),
  body('status').optional().isIn(allowedStatuses),
  body('stripeSubscriptionId').optional().isString(),
  body('targetPrice').optional().isFloat({ min: 0 }),
  body('currentPeriodEnd').optional().isISO8601().toDate(),
];

