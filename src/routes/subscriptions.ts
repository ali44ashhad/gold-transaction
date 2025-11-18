import express from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  createSubscription,
  getSubscriptions,
  getSubscriptionById,
  updateSubscription,
  deleteSubscription,
  deletePendingSubscriptions,
} from '../controllers/subscriptionController';
import {
  createSubscriptionValidator,
  listSubscriptionsValidator,
  subscriptionIdParamValidator,
  updateSubscriptionValidator,
} from '../validators/subscriptionValidators';

const router = express.Router();

// List subscriptions (admin sees all, users see their own)
router.get(
  '/',
  authenticate,
  validate(listSubscriptionsValidator),
  getSubscriptions
);

// Create a subscription
router.post(
  '/',
  authenticate,
  validate(createSubscriptionValidator),
  createSubscription
);

// Delete pending subscriptions (admin only)
router.delete(
  '/pending',
  authenticate,
  authorize('admin'),
  deletePendingSubscriptions
);

// Get a single subscription
router.get(
  '/:id',
  authenticate,
  validate(subscriptionIdParamValidator),
  getSubscriptionById
);

// Update subscription
router.put(
  '/:id',
  authenticate,
  validate([...subscriptionIdParamValidator, ...updateSubscriptionValidator]),
  updateSubscription
);

// Delete subscription
router.delete(
  '/:id',
  authenticate,
  validate(subscriptionIdParamValidator),
  deleteSubscription
);

export default router;

