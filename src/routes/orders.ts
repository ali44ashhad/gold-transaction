import express, { Request, Response } from 'express';
import mongoose from 'mongoose';

import { authenticate } from '../middleware/auth';
import { Order, IOrder } from '../models/Order';

const router = express.Router();

const asObjectId = (value?: string | null): mongoose.Types.ObjectId | undefined => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    return undefined;
  }
  return new mongoose.Types.ObjectId(value);
};

const canAccessOrder = (order: IOrder, user?: Express.Request['user']): boolean => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!order.user) return false;
  return order.user.toString() === user.userId;
};

router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  try {
    const { orderId, sessionId, subscriptionId, invoiceId, limit = '5', userId } = req.query;
    const ownerObjectId =
      req.user?.role === 'admin' && typeof userId === 'string'
        ? asObjectId(userId)
        : asObjectId(req.user?.userId);

    if (!ownerObjectId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Unable to resolve user context' });
    }

    const filter: Record<string, unknown> = {};
    if (ownerObjectId && req.user?.role !== 'admin') {
      filter.user = ownerObjectId;
    } else if (ownerObjectId && req.user?.role === 'admin') {
      filter.user = ownerObjectId;
    }

    const orConditions: Record<string, unknown>[] = [];
    if (typeof orderId === 'string' && mongoose.Types.ObjectId.isValid(orderId)) {
      orConditions.push({ _id: orderId });
    }
    if (typeof sessionId === 'string') {
      orConditions.push({ stripeSessionId: sessionId });
    }
    if (typeof subscriptionId === 'string') {
      orConditions.push({ stripeSubscriptionId: subscriptionId });
    }
    if (typeof invoiceId === 'string') {
      orConditions.push({ stripeInvoiceId: invoiceId });
    }

    if (orConditions.length > 0) {
      filter.$or = orConditions;
    } else if (req.user?.role === 'admin' && !filter.user) {
      // Allow admins to list recent orders even without filters, but cap the limit.
    } else if (!filter.user) {
      return res.status(400).json({ error: 'Provide at least one lookup parameter' });
    }

    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 5;

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(safeLimit);

    res.json({ data: orders });
  } catch (error: any) {
    console.error('Failed to fetch orders', error);
    res.status(500).json({ error: error.message || 'Failed to fetch orders' });
  }
});

router.get('/:orderId', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!canAccessOrder(order, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ data: order });
  } catch (error: any) {
    console.error('Failed to fetch order', error);
    res.status(500).json({ error: error.message || 'Failed to fetch order' });
  }
});

export default router;


