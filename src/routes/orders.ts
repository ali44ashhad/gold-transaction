import express, { Request, Response } from 'express';
import mongoose from 'mongoose';

import { authenticate } from '../middleware/auth';
import { Order } from '../models/Order';
import { getOrdersBySubscriptionId, getOrderById } from '../controllers/orderController';

const router = express.Router();

const asObjectId = (value?: string | null): mongoose.Types.ObjectId | undefined => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    return undefined;
  }
  return new mongoose.Types.ObjectId(value);
};

router.use(authenticate);

// Get orders by subscription ID (specific endpoint)
router.get('/subscription/:subscriptionId', getOrdersBySubscriptionId);

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId, sessionId, subscriptionId, invoiceId, limit = '5', userId } = req.query;
    
    console.log('[Orders Route] GET /orders - Query params:', {
      orderId,
      sessionId,
      subscriptionId,
      invoiceId,
      limit,
      userId,
      userRole: req.user?.role,
      userUserId: req.user?.userId
    });
    
    const ownerObjectId =
      req.user?.role === 'admin' && typeof userId === 'string'
        ? asObjectId(userId)
        : asObjectId(req.user?.userId);

    console.log('[Orders Route] Owner ObjectId:', ownerObjectId?.toString());

    if (!ownerObjectId && req.user?.role !== 'admin') {
      console.log('[Orders Route] No owner ObjectId and user is not admin, returning 403');
      res.status(403).json({ error: 'Unable to resolve user context' });
      return;
    }

    const filter: Record<string, unknown> = {};
    if (ownerObjectId && req.user?.role !== 'admin') {
      filter.user = ownerObjectId;
      console.log('[Orders Route] Adding user filter (non-admin):', ownerObjectId.toString());
    } else if (ownerObjectId && req.user?.role === 'admin') {
      filter.user = ownerObjectId;
      console.log('[Orders Route] Adding user filter (admin):', ownerObjectId.toString());
    }

    const orConditions: Record<string, unknown>[] = [];
    if (typeof orderId === 'string' && mongoose.Types.ObjectId.isValid(orderId)) {
      orConditions.push({ _id: orderId });
      console.log('[Orders Route] Added orderId condition:', orderId);
    }
    if (typeof sessionId === 'string') {
      orConditions.push({ stripeSessionId: sessionId });
      console.log('[Orders Route] Added sessionId condition:', sessionId);
    }
    if (typeof subscriptionId === 'string') {
      // Support both MongoDB subscriptionId and Stripe subscriptionId
      const isMongoId = mongoose.Types.ObjectId.isValid(subscriptionId);
      console.log('[Orders Route] Processing subscriptionId:', subscriptionId, 'isMongoId:', isMongoId);
      
      if (isMongoId) {
        orConditions.push({ subscriptionId: subscriptionId });
        console.log('[Orders Route] Added MongoDB subscriptionId condition:', subscriptionId);
      }
      orConditions.push({ stripeSubscriptionId: subscriptionId });
      console.log('[Orders Route] Added stripeSubscriptionId condition:', subscriptionId);
    }
    if (typeof invoiceId === 'string') {
      orConditions.push({ stripeInvoiceId: invoiceId });
      console.log('[Orders Route] Added invoiceId condition:', invoiceId);
    }

    if (orConditions.length > 0) {
      filter.$or = orConditions;
      console.log('[Orders Route] Final filter with $or conditions:', JSON.stringify(filter, null, 2));
    } else if (req.user?.role === 'admin' && !filter.user) {
      // Allow admins to list recent orders even without filters, but cap the limit.
      console.log('[Orders Route] Admin query without filters, using empty filter');
    } else if (!filter.user) {
      console.log('[Orders Route] No filters and no user filter, returning 400');
      res.status(400).json({ error: 'Provide at least one lookup parameter' });
      return;
    }

    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 5;
    console.log('[Orders Route] Query limit:', safeLimit);

    console.log('[Orders Route] Executing Order.find with filter:', JSON.stringify(filter, null, 2));
    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(safeLimit);

    console.log('[Orders Route] Found orders count:', orders.length);
    if (orders.length > 0) {
      console.log('[Orders Route] Sample order:', {
        _id: orders[0]._id?.toString(),
        subscriptionId: orders[0].subscriptionId?.toString(),
        stripeSubscriptionId: orders[0].stripeSubscriptionId,
        user: orders[0].user?.toString(),
        amount: orders[0].amount,
        status: orders[0].status
      });
    } else {
      console.log('[Orders Route] No orders found. Checking if there are any orders in DB...');
      const totalOrders = await Order.countDocuments({});
      console.log('[Orders Route] Total orders in database:', totalOrders);
      if (filter.user) {
        const userOrdersCount = await Order.countDocuments({ user: filter.user });
        console.log('[Orders Route] Orders for user:', userOrdersCount);
      }
      if (filter.$or) {
        // Check each condition separately
        for (const condition of filter.$or as Record<string, unknown>[]) {
          const count = await Order.countDocuments(condition);
          console.log('[Orders Route] Orders matching condition', JSON.stringify(condition), ':', count);
        }
      }
    }

    res.json({ data: orders });
  } catch (error: any) {
    console.error('[Orders Route] Failed to fetch orders', error);
    res.status(500).json({ error: error.message || 'Failed to fetch orders' });
  }
});

// Get single order by ID (using controller)
router.get('/:orderId', getOrderById);

export default router;


