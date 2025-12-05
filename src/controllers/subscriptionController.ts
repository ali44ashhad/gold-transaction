import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { Subscription, ISubscription, SubscriptionStatus } from '../models/Subscription';
import {
  CancellationRequest,
  CancellationRequestStatus,
  ICancellationRequest,
} from '../models/CancellationRequest';
import {
  WithdrawalRequest,
  WithdrawalRequestStatus,
  IWithdrawalRequest,
} from '../models/WithdrawalRequest';
import { stripe } from '../stripe';

const isAdmin = (req: Request) => req.user?.role === 'admin';

const canAccessSubscription = (req: Request, subscriptionUserId: mongoose.Types.ObjectId) => {
  if (isAdmin(req)) return true;
  return subscriptionUserId.toString() === req.user?.userId;
};

const subscriptionRetrieveParams: Stripe.SubscriptionRetrieveParams = {
  expand: ['items.data.price.product'],
};

const toStripeUnitAmount = (amount: number) => {
  return Math.round(Number(amount) * 100);
};

const epochToDate = (epoch?: number | null): Date | undefined => {
  if (!epoch) return undefined;
  return new Date(epoch * 1000);
};

const mapStripeStatus = (status: Stripe.Subscription.Status): SubscriptionStatus => {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
      return 'incomplete_expired';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'unpaid':
      return 'unpaid';
    default:
      return 'pending_payment';
  }
};

const ensureStripeProductId = (price: Stripe.Price | null | undefined) => {
  const productCandidate = price?.product;
  if (!productCandidate) {
    throw new Error('Stripe subscription price is missing product information');
  }

  if (typeof productCandidate === 'string') {
    return productCandidate;
  }

  if (productCandidate.id) {
    return productCandidate.id;
  }

  throw new Error('Unable to resolve product id for Stripe subscription price');
};

const buildRecurringConfig = (price: Stripe.Price | null | undefined) => {
  const interval = price?.recurring?.interval ?? 'month';
  const intervalCount = price?.recurring?.interval_count ?? 1;
  return {
    interval,
    interval_count: intervalCount,
  } satisfies Stripe.PriceCreateParams.Recurring;
};

const syncStripeMonthlyInvestment = async (
  subscription: ISubscription,
  nextMonthlyInvestment: number
): Promise<Stripe.Subscription> => {
  if (!subscription.stripeSubscriptionId) {
    throw new Error('Subscription is not linked to a Stripe subscription');
  }
  // console.log("TESTING STRIPE:", subscription.stripeSubscriptionId);
  
  const stripeSubscription = await stripe.subscriptions.retrieve(
    subscription.stripeSubscriptionId,
    subscriptionRetrieveParams
  );
  // console.log("TESTING STRIPE SUBSCRIPTION FOUND:", stripeSubscription);
  

  const stripeItem = stripeSubscription.items?.data?.[0];
  if (!stripeItem?.id) {
    throw new Error('Stripe subscription is missing line items');
  }

  const stripePrice = stripeItem.price;
  if (!stripePrice) {
    throw new Error('Stripe subscription item is missing price information');
  }
  console.log("TESTING STRIPE PRICE:", stripePrice);
  

  const desiredUnitAmount = toStripeUnitAmount(nextMonthlyInvestment);
  const currentUnitAmount = stripePrice.unit_amount ?? 0;
  // console.log("TESTING CURRENT UNIT AMOUNT:", currentUnitAmount);
  console.log("TESTING DESIRED UNIT AMOUNT:", desiredUnitAmount);
  console.log("TESTING CURRENT UNIT AMOUNT:", currentUnitAmount);


  if (currentUnitAmount === desiredUnitAmount) {
    return stripeSubscription;
  }

  const currency = stripePrice.currency ?? 'usd';
  const product = ensureStripeProductId(stripePrice);
  console.log("TESTING PRODUCT:", product);
  
  const recurring = buildRecurringConfig(stripePrice);

  const newPrice = await stripe.prices.create({
    unit_amount: desiredUnitAmount,
    currency,
    product,
    recurring,
    nickname: `${subscription.planName} - $${nextMonthlyInvestment.toFixed(2)}`,
  });

  const updatedSubscription = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    items: [
      {
        id: stripeItem.id,
        price: newPrice.id,
        quantity: stripeItem.quantity ?? 1,
      },
    ],
    billing_cycle_anchor: 'unchanged',
    proration_behavior: 'none',
    payment_behavior: 'pending_if_incomplete',
  });

  return updatedSubscription;
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

    type WithdrawalRequestSummary = Pick<IWithdrawalRequest, 'subscriptionId' | 'status'> & {
      _id: mongoose.Types.ObjectId;
    };

    const cancellationRequests = (await CancellationRequest.find({
      subscriptionId: { $in: subscriptionIds },
      status: { $nin: ['rejected'] },
    })
      .select('_id subscriptionId status')
      .lean()) as unknown as CancellationRequestSummary[];

    const withdrawalRequests = (await WithdrawalRequest.find({
      subscriptionId: { $in: subscriptionIds },
      status: { $nin: ['delivered', 'rejected'] },
    })
      .select('_id subscriptionId status')
      .lean()) as unknown as WithdrawalRequestSummary[];

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

    const withdrawalMap = new Map<
      string,
      { id: string; status: WithdrawalRequestStatus }
    >(
      withdrawalRequests
        .filter((request) => request.subscriptionId)
        .map((request) => [
          request.subscriptionId!.toString(),
          { id: request._id.toString(), status: request.status },
        ])
    );

    const subscriptionsWithRequestInfo = subscriptions.map((subscription) => {
      const subscriptionObj = subscription.toObject();
      const subscriptionId = (subscription._id as mongoose.Types.ObjectId).toString();
      const cancellationInfo = cancellationMap.get(subscriptionId);
      const withdrawalInfo = withdrawalMap.get(subscriptionId);

      return {
        ...subscriptionObj,
        cancellationRequestId: cancellationInfo?.id ?? null,
        cancellationRequestStatus: cancellationInfo?.status ?? null,
        withdrawalRequestId: withdrawalInfo?.id ?? null,
        withdrawalRequestStatus: withdrawalInfo?.status ?? null,
      };
    });

    res.json({ subscriptions: subscriptionsWithRequestInfo });
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
      status: { $nin: ['rejected'] },
    })
      .select('_id status')
      .lean<Pick<ICancellationRequest, 'status'> & { _id: mongoose.Types.ObjectId }>();

    const withdrawalRequest = await WithdrawalRequest.findOne({
      subscriptionId: subscription._id,
      status: { $nin: ['delivered', 'rejected'] },
    })
      .select('_id status')
      .lean<Pick<IWithdrawalRequest, 'status'> & { _id: mongoose.Types.ObjectId }>();

    const subscriptionWithRequestInfo = {
      ...subscription.toObject(),
      cancellationRequestId: cancellationRequest?._id.toString() ?? null,
      cancellationRequestStatus: cancellationRequest?.status ?? null,
      withdrawalRequestId: withdrawalRequest?._id.toString() ?? null,
      withdrawalRequestStatus: withdrawalRequest?.status ?? null,
    };

    res.json({ subscription: subscriptionWithRequestInfo });
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

    if (req.body.monthlyInvestment !== undefined) {
      const nextMonthlyInvestment = Number(req.body.monthlyInvestment);
      if (
        !Number.isFinite(nextMonthlyInvestment) ||
        nextMonthlyInvestment < 10 ||
        nextMonthlyInvestment > 1000
      ) {
        res.status(400).json({ error: 'monthlyInvestment must be between 10 and 1000 USD' });
        return;
      }

      if (!subscription.stripeSubscriptionId) {
        res.status(400).json({ error: 'Subscription is not linked to Stripe and cannot be modified' });
        return;
      }

      const updatedStripeSubscription = await syncStripeMonthlyInvestment(
        subscription,
        nextMonthlyInvestment
      );
    console.log("TESTING UPDATED STRIPE SUBSCRIPTION:", updatedStripeSubscription);
      
      subscription.monthlyInvestment = nextMonthlyInvestment;
      console.info('Subscription monthly investment updated', {
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        nextMonthlyInvestment,
      });

      const nextPeriodEndSeconds = (updatedStripeSubscription as Stripe.Subscription & {
        current_period_end?: number | null;
      }).current_period_end;
      const nextPeriodEnd = epochToDate(nextPeriodEndSeconds);
      if (nextPeriodEnd) {
        subscription.currentPeriodEnd = nextPeriodEnd;
      }

      subscription.status = mapStripeStatus(updatedStripeSubscription.status);

      const stripeQuantity = updatedStripeSubscription.items?.data?.[0]?.quantity;
      if (typeof stripeQuantity === 'number') {
        subscription.quantity = stripeQuantity;
      }
    }

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

