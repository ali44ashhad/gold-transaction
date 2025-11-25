import { body, param, query } from 'express-validator';
import { CancellationRequestStatus } from '../models/CancellationRequest';

const allowedStatuses: CancellationRequestStatus[] = [
  'pending',
  'in_review',
  'approved',
  'rejected',
  'completed',
];

export const cancellationRequestIdParamValidator = [
  param('id').isMongoId().withMessage('Invalid cancellation request id'),
];

export const listCancellationRequestValidator = [
  query('status').optional().isIn(allowedStatuses).withMessage('Invalid status filter'),
  query('userId').optional().isMongoId().withMessage('Invalid userId'),
  query('subscriptionId').optional().isMongoId().withMessage('Invalid subscriptionId'),
];

export const createCancellationRequestValidator = [
  body('subscriptionId').optional().isMongoId().withMessage('Invalid subscription id'),
  body('reason').optional().isString().trim(),
  body('details').optional().isString().trim(),
  body('preferredCancellationDate').optional().isISO8601().toDate(),
];

export const updateCancellationRequestValidator = [
  body('reason').optional().isString().trim(),
  body('details').optional().isString().trim(),
  body('preferredCancellationDate').optional().isISO8601().toDate(),
  body('status').optional().isIn(allowedStatuses),
  body('resolutionNotes').optional().isString().trim(),
];


