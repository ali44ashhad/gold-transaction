import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order';
import { Subscription } from '../models/Subscription';

const asObjectId = (value?: string | null): mongoose.Types.ObjectId | undefined => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    return undefined;
  }
  return new mongoose.Types.ObjectId(value);
};

/**
 * Get all orders/payments for a specific subscription
 * Supports both MongoDB subscriptionId and Stripe subscriptionId
 */
export const getOrdersBySubscriptionId = async (req: Request, res: Response): Promise<void> => {
  try {
    const { subscriptionId } = req.params;
    const { limit = '100' } = req.query;

    console.log('[OrderController] getOrdersBySubscriptionId called with:', {
      subscriptionId,
      limit,
      userRole: req.user?.role,
      userUserId: req.user?.userId
    });

    if (!subscriptionId) {
      res.status(400).json({ error: 'Subscription ID is required' });
      return;
    }

    // Get user context for filtering
    const ownerObjectId = asObjectId(req.user?.userId);
    if (!ownerObjectId && req.user?.role !== 'admin') {
      console.log('[OrderController] No owner ObjectId and user is not admin, returning 403');
      res.status(403).json({ error: 'Unable to resolve user context' });
      return;
    }

    // First, try to find the subscription to verify it exists and user has access
    let subscription = null;
    const isMongoId = mongoose.Types.ObjectId.isValid(subscriptionId);
    
    if (isMongoId) {
      subscription = await Subscription.findById(subscriptionId);
      console.log('[OrderController] Found subscription by MongoDB ID:', subscription ? 'yes' : 'no');
    } else {
      // Try to find by stripeSubscriptionId
      subscription = await Subscription.findOne({ stripeSubscriptionId: subscriptionId });
      console.log('[OrderController] Found subscription by Stripe ID:', subscription ? 'yes' : 'no');
    }

    // If subscription found, verify user has access
    if (subscription) {
      const subscriptionUserId = subscription.userId?.toString();
      const userUserId = req.user?.userId;
      
      if (req.user?.role !== 'admin' && subscriptionUserId !== userUserId) {
        console.log('[OrderController] User does not have access to this subscription');
        res.status(403).json({ error: 'Access denied. You do not have permission to view orders for this subscription.' });
        return;
      }
    } else {
      console.log('[OrderController] Subscription not found for subscriptionId:', subscriptionId);
      // Still try to fetch orders, but log a warning
    }

    // Build filter for orders
    const filter: Record<string, unknown> = {};
    const orConditions: Record<string, unknown>[] = [];

    // Support both MongoDB subscriptionId and Stripe subscriptionId
    if (isMongoId) {
      orConditions.push({ subscriptionId: new mongoose.Types.ObjectId(subscriptionId) });
      console.log('[OrderController] Added MongoDB subscriptionId condition:', subscriptionId);
    }
    orConditions.push({ stripeSubscriptionId: subscriptionId });
    console.log('[OrderController] Added stripeSubscriptionId condition:', subscriptionId);

    filter.$or = orConditions;

    // Add user filter if not admin (to ensure users only see their own orders)
    if (ownerObjectId && req.user?.role !== 'admin') {
      filter.user = ownerObjectId;
      console.log('[OrderController] Added user filter:', ownerObjectId.toString());
    }

    console.log('[OrderController] Final filter:', JSON.stringify(filter, null, 2));

    // Parse and validate limit
    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) 
      ? Math.min(Math.max(parsedLimit, 1), 200) // Max 200 orders
      : 100;

    // Fetch orders
    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean(); // Use lean() for better performance

    console.log('[OrderController] Found orders count:', orders.length);
    if (orders.length > 0) {
      console.log('[OrderController] Sample order:', {
        _id: orders[0]._id?.toString(),
        subscriptionId: orders[0].subscriptionId?.toString(),
        stripeSubscriptionId: orders[0].stripeSubscriptionId,
        amount: orders[0].amount,
        status: orders[0].status
      });
    } else {
      // Debug: Check if there are any orders at all
      const totalOrders = await Order.countDocuments({});
      console.log('[OrderController] Total orders in database:', totalOrders);
      
      if (filter.user) {
        const userOrdersCount = await Order.countDocuments({ user: filter.user });
        console.log('[OrderController] Total orders for user:', userOrdersCount);
      }
      
      // Check each condition separately
      for (const condition of orConditions) {
        const count = await Order.countDocuments(condition);
        console.log('[OrderController] Orders matching condition', JSON.stringify(condition), ':', count);
      }
    }

    res.json({
      data: orders,
      count: orders.length,
      subscriptionId: subscriptionId,
      subscriptionFound: !!subscription
    });
  } catch (error: any) {
    console.error('[OrderController] Error fetching orders by subscription ID:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to fetch orders',
      details: error.stack 
    });
  }
};

/**
 * Get a single order by ID
 */
export const getOrderById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      res.status(400).json({ error: 'Invalid order ID' });
      return;
    }

    const order = await Order.findById(orderId);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // Check access
    const ownerObjectId = asObjectId(req.user?.userId);
    if (req.user?.role !== 'admin') {
      if (!ownerObjectId || order.user?.toString() !== ownerObjectId.toString()) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    res.json({ data: order });
  } catch (error: any) {
    console.error('[OrderController] Error fetching order by ID:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch order' });
  }
};
