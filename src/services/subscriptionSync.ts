import mongoose from 'mongoose';
import Stripe from 'stripe';

import { Subscription, ISubscription, MetalType, UnitType, SubscriptionStatus } from '../models/Subscription';
import { IOrder } from '../models/Order';
import { Order } from '../models/Order';

type SubscriptionSyncOptions = {
  status?: SubscriptionStatus;
  currentPeriodEnd?: Date;
  stripeSubscriptionId?: string;
  accumulatedValueDelta?: number;
};

const coerceMetal = (value?: unknown): MetalType => {
  return value === 'silver' ? 'silver' : 'gold';
};

const coerceUnit = (value?: unknown): UnitType => {
  return value === 'g' ? 'g' : 'oz';
};

const toPositiveNumber = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return num > 0 ? num : fallback;
};

const toNonNegativeNumber = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return num >= 0 ? num : fallback;
};

const buildConfigFromOrder = (order: IOrder) => {
  const config = order.subscriptionConfig ?? {};
  const metadata = order.metadata ?? {};

  const targetWeight =
    config.targetWeight ??
    toPositiveNumber(metadata.targetWeight ?? metadata.target_weight, 1);
  const targetUnit = config.targetUnit ?? coerceUnit(metadata.targetUnit ?? metadata.target_unit);
  const monthlyInvestment =
    config.monthlyInvestment ??
    order.amount ??
    toPositiveNumber(metadata.monthlyInvestment ?? metadata.monthly_investment, 1);

  return {
    planName:
      config.planName ??
      metadata.planName ??
      metadata.plan ??
      order.productName ??
      'PharaohVault Plan',
    metal: config.metal ?? coerceMetal(metadata.metal),
    targetWeight,
    targetUnit,
    monthlyInvestment,
    quantity: config.quantity ?? toPositiveNumber(metadata.quantity, 1),
    targetPrice: config.targetPrice ?? toNonNegativeNumber(metadata.targetPrice, 0),
  };
};

export const syncSubscriptionFromOrder = async (
  order: IOrder,
  options: SubscriptionSyncOptions = {}
): Promise<ISubscription | null> => {
  if (!order || order.orderType !== 'subscription' || !order.user || !order.stripeCustomerId) {
    return null;
  }

  const config = buildConfigFromOrder(order);
  const subscriptionId = order.stripeSubscriptionId ?? options.stripeSubscriptionId;
  const filter = subscriptionId ? { stripeSubscriptionId: subscriptionId } : { orderId: order._id };

  const update: Record<string, any> = {
    $set: {
      planName: config.planName,
      metal: config.metal,
      targetWeight: config.targetWeight,
      targetUnit: config.targetUnit,
      monthlyInvestment: config.monthlyInvestment,
      quantity: config.quantity,
      targetPrice: config.targetPrice,
      stripeCustomerId: order.stripeCustomerId,
      orderId: order._id,
      status: options.status ?? 'pending_payment',
    },
    $setOnInsert: {
      userId: order.user,
      accumulatedWeight: 0,
    },
  };

  if (subscriptionId) {
    update.$set.stripeSubscriptionId = subscriptionId;
  }

  if (options.currentPeriodEnd) {
    update.$set.currentPeriodEnd = options.currentPeriodEnd;
  }

  if (options.accumulatedValueDelta) {
    update.$inc = { accumulatedValue: options.accumulatedValueDelta };
  }

  return Subscription.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
};

const mapStripeSubscriptionStatus = (
  status: Stripe.Subscription.Status
): SubscriptionStatus => {
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

export const applyStripeSubscriptionEvent = async (
  subscription: Stripe.Subscription
): Promise<ISubscription | null> => {
  const status = mapStripeSubscriptionStatus(subscription.status);
  const periodEndSeconds = (subscription as Stripe.Subscription & {
    current_period_end?: number | null;
  }).current_period_end;
  const currentPeriodEnd = periodEndSeconds
    ? new Date(periodEndSeconds * 1000)
    : undefined;
  const stripeCustomerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;

  const update: Partial<ISubscription> = {
    status,
    currentPeriodEnd,
    stripeCustomerId,
  };

  const quantity = subscription.items?.data?.[0]?.quantity;
  if (typeof quantity === 'number') {
    update.quantity = quantity;
  }

  const price = subscription.items?.data?.[0]?.price;
  if (price?.unit_amount) {
    update.monthlyInvestment = price.unit_amount / 100;
  }

  const updated = await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: subscription.id },
    { $set: update },
    { new: true }
  );

  if (updated) {
    return updated;
  }

  const orderId = subscription.metadata?.orderId;
  if (orderId && mongoose.Types.ObjectId.isValid(orderId)) {
    const order = await Order.findById(orderId);
    if (order) {
      return syncSubscriptionFromOrder(order, {
        status,
        currentPeriodEnd,
        stripeSubscriptionId: subscription.id,
      });
    }
  }

  return null;
};

