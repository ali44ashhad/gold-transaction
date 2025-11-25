import { body, param, query } from 'express-validator';
import { WithdrawalRequestStatus } from '../models/WithdrawalRequest';

const allowedStatuses: WithdrawalRequestStatus[] = [
  'pending',
  'in_review',
  'approved',
  'processing',
  'rejected',
  'completed',
];

export const withdrawalRequestIdParamValidator = [
  param('id').isMongoId().withMessage('Invalid withdrawal request id'),
];

export const listWithdrawalRequestValidator = [
  query('status').optional().isIn(allowedStatuses).withMessage('Invalid status filter'),
  query('userId').optional().isMongoId().withMessage('Invalid userId'),
  query('subscriptionId').optional().isMongoId().withMessage('Invalid subscriptionId'),
  query('metal').optional().isIn(['gold', 'silver']),
];

export const createWithdrawalRequestValidator = [
  body('subscriptionId').optional().isMongoId().withMessage('Invalid subscription id'),
  body('metal')
    .isIn(['gold', 'silver'])
    .withMessage('Metal must be gold or silver'),
  body('requestedWeight')
    .isFloat({ gt: 0 })
    .withMessage('Requested weight must be greater than 0'),
  body('requestedUnit')
    .isIn(['oz', 'g'])
    .withMessage('Requested unit must be oz or g'),
  body('estimatedValue').optional().isFloat({ min: 0 }),
  body('notes').optional().isString().trim(),
];

export const updateWithdrawalRequestValidator = [
  body('requestedWeight').optional().isFloat({ gt: 0 }),
  body('requestedUnit').optional().isIn(['oz', 'g']),
  body('estimatedValue').optional().isFloat({ min: 0 }),
  body('notes').optional().isString().trim(),
  body('status').optional().isIn(allowedStatuses),
];


