import mongoose from 'mongoose';
import Stripe from 'stripe';

import { Subscription, ISubscription, MetalType, UnitType, SubscriptionStatus } from '../models/Subscription';
import { MetalPrice } from '../models/MetalPrice';
import { IOrder } from '../models/Order';
import { Order } from '../models/Order';

type SubscriptionSyncOptions = {
  status?: SubscriptionStatus;
  currentPeriodEnd?: Date;
  stripeSubscriptionId?: string;
  accumulatedValueDelta?: number;
  accumulatedWeightDelta?: number;
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

const OZ_IN_GRAMS = 31.1034768;

const getBaseUnitForMetal = (metal: MetalType): UnitType => (metal === 'silver' ? 'oz' : 'g');

const convertPriceToTargetUnit = (price: number, baseUnit: UnitType, targetUnit: UnitType): number => {
  if (targetUnit === baseUnit) {
    return price;
  }

  if (baseUnit === 'g' && targetUnit === 'oz') {
    return price * OZ_IN_GRAMS;
  }

  if (baseUnit === 'oz' && targetUnit === 'g') {
    return price / OZ_IN_GRAMS;
  }

  return price;
};

const getMetalPricePerUnit = async (metal: MetalType, targetUnit: UnitType): Promise<number | null> => {
  const record = await MetalPrice.findOne({ metalSymbol: metal }).lean();
  if (!record?.price || record.price <= 0) {
    console.warn(`[SubscriptionSync] Could not determine price for metal=${metal}`);
    return null;
  }

  const baseUnit = getBaseUnitForMetal(metal);
  return convertPriceToTargetUnit(record.price, baseUnit, targetUnit);
};

const computeWeightDelta = async (
  metal: MetalType,
  targetUnit: UnitType,
  amountDelta?: number,
  explicitWeightDelta?: number
): Promise<number | null> => {
  if (typeof explicitWeightDelta === 'number' && explicitWeightDelta >= 0) {
    return explicitWeightDelta;
  }

  if (!amountDelta || amountDelta <= 0) {
    return null;
  }

  const pricePerUnit = await getMetalPricePerUnit(metal, targetUnit);
  if (!pricePerUnit || pricePerUnit <= 0) {
    console.warn(
      `[SubscriptionSync] Skipping weight accumulation because pricePerUnit is unavailable for metal=${metal}`
    );
    return null;
  }

  return amountDelta / pricePerUnit;
};

export const syncSubscriptionFromOrder = async (
  order: IOrder,
  options: SubscriptionSyncOptions = {}
): Promise<ISubscription | null> => {
  if (!order || order.orderType !== 'subscription' || !order.user || !order.stripeCustomerId) {
    return null;
  }

  const config = buildConfigFromOrder(order);
  const stripeSubscriptionId = order.stripeSubscriptionId ?? options.stripeSubscriptionId;
  
  // Find or create subscription based on stripeSubscriptionId (preferred) or user+config
  let subscription: ISubscription | null = null;
  
  if (stripeSubscriptionId) {
    // First, try to find by stripeSubscriptionId
    subscription = await Subscription.findOne({ stripeSubscriptionId });
  }
  
  // If not found and order already has a subscriptionId, use that
  if (!subscription && order.subscriptionId) {
    subscription = await Subscription.findById(order.subscriptionId);
  }
  
  // If still not found, try to find by user and matching config (for same subscription plan)
  if (!subscription && order.user) {
    subscription = await Subscription.findOne({
      userId: order.user,
      stripeCustomerId: order.stripeCustomerId,
      metal: config.metal,
      planName: config.planName,
      targetWeight: config.targetWeight,
      targetUnit: config.targetUnit,
    });
  }

  // Prepare update data
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
      status: options.status ?? 'pending_payment',
    },
    $setOnInsert: {
      userId: order.user,
    },
  };

  if (stripeSubscriptionId) {
    update.$set.stripeSubscriptionId = stripeSubscriptionId;
  }

  if (options.currentPeriodEnd) {
    update.$set.currentPeriodEnd = options.currentPeriodEnd;
  }

  const weightDelta = await computeWeightDelta(
    config.metal,
    config.targetUnit,
    options.accumulatedValueDelta,
    options.accumulatedWeightDelta
  );

  const hasValueDelta = typeof options.accumulatedValueDelta === 'number' && options.accumulatedValueDelta !== 0;
  const hasWeightDelta = typeof weightDelta === 'number' && weightDelta !== 0;

  if (hasValueDelta || hasWeightDelta) {
    update.$inc = {
      ...(update.$inc || {}),
      ...(hasValueDelta ? { accumulatedValue: options.accumulatedValueDelta } : {}),
      ...(hasWeightDelta ? { accumulatedWeight: weightDelta } : {}),
    };
  }

  // Find or create subscription
  if (subscription) {
    // Update existing subscription
    Object.assign(subscription, update.$set);
    if (update.$inc) {
      subscription.accumulatedValue = (subscription.accumulatedValue || 0) + (update.$inc.accumulatedValue || 0);
      subscription.accumulatedWeight = (subscription.accumulatedWeight || 0) + (update.$inc.accumulatedWeight || 0);
    }
    await subscription.save();
    
    // Link order to subscription if not already linked
    const subscriptionId = new mongoose.Types.ObjectId(subscription.id);
    if (!order.subscriptionId || order.subscriptionId.toString() !== subscriptionId.toString()) {
      order.subscriptionId = subscriptionId;
      await order.save();
    }
    
    return subscription;
  } else {
    // Create new subscription
    const newSubscription = await Subscription.create({
      userId: order.user,
      ...update.$set,
      accumulatedValue: update.$inc?.accumulatedValue || 0,
      accumulatedWeight: update.$inc?.accumulatedWeight || 0,
    });
    
    // Link order to subscription
    order.subscriptionId = new mongoose.Types.ObjectId(newSubscription.id);
    await order.save();
    
    return newSubscription;
  }
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

  // If subscription not found by stripeSubscriptionId, try to find by orderId in metadata
  // and sync from that order
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

