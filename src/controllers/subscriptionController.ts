import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Subscription } from '../models/Subscription';
import {
  CancellationRequest,
  CancellationRequestStatus,
  ICancellationRequest,
} from '../models/CancellationRequest';

const isAdmin = (req: Request) => req.user?.role === 'admin';

const canAccessSubscription = (req: Request, subscriptionUserId: mongoose.Types.ObjectId) => {
  if (isAdmin(req)) return true;
  return subscriptionUserId.toString() === req.user?.userId;
};

export const createSubscription = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const {
      metal,
      planName,
      targetWeight,
      targetUnit,
      monthlyInvestment,
      quantity = 1,
      accumulatedValue = 0,
      accumulatedWeight = 0,
      status = 'pending_payment',
      stripeCustomerId,
      stripeSubscriptionId,
      targetPrice = 0,
      currentPeriodEnd,
    } = req.body;

    const subscription = await Subscription.create({
      userId,
      metal,
      planName: planName || `${metal.charAt(0).toUpperCase() + metal.slice(1)} Plan`,
      targetWeight,
      targetUnit,
      monthlyInvestment,
      quantity,
      accumulatedValue,
      accumulatedWeight,
      status,
      stripeCustomerId,
      stripeSubscriptionId,
      targetPrice,
      currentPeriodEnd,
    });

    res.status(201).json({ subscription });
  } catch (error: any) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: error.message || 'Failed to create subscription' });
  }
};

export const getSubscriptions = async (req: Request, res: Response): Promise<void> => {
  try {
    const query: Record<string, unknown> = {};

    if (!isAdmin(req)) {
      query.userId = req.user!.userId;
    } else if (req.query.userId) {
      query.userId = req.query.userId;
    }

    if (req.query.status) {
      query.status = req.query.status;
    }

    const subscriptions = await Subscription.find(query).sort({ createdAt: -1 });
    const subscriptionIds = subscriptions.map((subscription) => subscription._id);

    type CancellationRequestSummary = Pick<ICancellationRequest, 'subscriptionId' | 'status'> & {
      _id: mongoose.Types.ObjectId;
    };

    const cancellationRequests = (await CancellationRequest.find({
      subscriptionId: { $in: subscriptionIds },
      status: { $nin: ['completed', 'rejected'] },
    })
      .select('_id subscriptionId status')
      .lean()) as unknown as CancellationRequestSummary[];

    const cancellationMap = new Map<
      string,
      { id: string; status: CancellationRequestStatus }
    >(
      cancellationRequests
        .filter((request) => request.subscriptionId)
        .map((request) => [
          request.subscriptionId!.toString(),
          { id: request._id.toString(), status: request.status },
        ])
    );

    const subscriptionsWithCancellationInfo = subscriptions.map((subscription) => {
      const subscriptionObj = subscription.toObject();
      const subscriptionId = (subscription._id as mongoose.Types.ObjectId).toString();
      const cancellationInfo = cancellationMap.get(subscriptionId);

      return {
        ...subscriptionObj,
        cancellationRequestId: cancellationInfo?.id ?? null,
        cancellationRequestStatus: cancellationInfo?.status ?? null,
      };
    });

    res.json({ subscriptions: subscriptionsWithCancellationInfo });
  } catch (error: any) {
    console.error('Get subscriptions error:', error);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
};

export const getSubscriptionById = async (req: Request, res: Response): Promise<void> => {
  try {
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }

    if (!canAccessSubscription(req, subscription.userId)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const cancellationRequest = await CancellationRequest.findOne({
      subscriptionId: subscription._id,
      status: { $nin: ['completed', 'rejected'] },
    })
      .select('_id status')
      .lean<Pick<ICancellationRequest, 'status'> & { _id: mongoose.Types.ObjectId }>();

    const subscriptionWithCancellationInfo = {
      ...subscription.toObject(),
      cancellationRequestId: cancellationRequest?._id.toString() ?? null,
      cancellationRequestStatus: cancellationRequest?.status ?? null,
    };

    res.json({ subscription: subscriptionWithCancellationInfo });
  } catch (error: any) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
};

export const updateSubscription = async (req: Request, res: Response): Promise<void> => {
  try {
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }

    if (!canAccessSubscription(req, subscription.userId)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updatableFields: Array<keyof typeof req.body> = [
      'planName',
      'targetWeight',
      'targetUnit',
      'monthlyInvestment',
      'quantity',
      'accumulatedValue',
      'accumulatedWeight',
      'status',
      'stripeSubscriptionId',
      'targetPrice',
      'currentPeriodEnd',
    ];

    updatableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        (subscription as any)[field] = req.body[field];
      }
    });

    await subscription.save();

    res.json({ subscription });
  } catch (error: any) {
    console.error('Update subscription error:', error);
    res.status(500).json({ error: error.message || 'Failed to update subscription' });
  }
};

export const deleteSubscription = async (req: Request, res: Response): Promise<void> => {
  try {
    const subscription = await Subscription.findById(req.params.id);
    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }

    if (!canAccessSubscription(req, subscription.userId)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await subscription.deleteOne();

    res.json({ message: 'Subscription deleted successfully' });
  } catch (error: any) {
    console.error('Delete subscription error:', error);
    res.status(500).json({ error: 'Failed to delete subscription' });
  }
};

export const deletePendingSubscriptions = async (_req: Request, res: Response): Promise<void> => {
  try {
    const { deletedCount } = await Subscription.deleteMany({ status: 'pending_payment' });
    res.json({ deletedCount });
  } catch (error: any) {
    console.error('Delete pending subscriptions error:', error);
    res.status(500).json({ error: 'Failed to delete pending subscriptions' });
  }
};

