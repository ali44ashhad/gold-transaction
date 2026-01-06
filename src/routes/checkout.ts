import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import dotenv from 'dotenv';

import { stripe } from '../stripe';
import { Order, IOrder, PaymentStatus } from '../models/Order';
import { Subscription } from '../models/Subscription';
import type { MetalType, UnitType } from '../models/Subscription';
import { authenticate } from '../middleware/auth';
import { notifyOps } from '../utils/alerting';
import { validateCreateSessionPayload, CreateSessionPayload } from '../validators/checkoutValidators';
import { syncSubscriptionFromOrder, applyStripeSubscriptionEvent } from '../services/subscriptionSync';

dotenv.config();

const router = express.Router();

const DEFAULT_PRODUCT_NAME = 'Custom Monthly Subscription';
const DEFAULT_DESCRIPTION = 'Subscription created via PharaohVault backend';

type CheckoutMode = Stripe.Checkout.SessionCreateParams.Mode;
type SubscriptionDetailsInput = CreateSessionPayload['subscriptionDetails'];

type NormalizedSubscriptionConfig = {
  planName: string;
  metal: MetalType;
  targetWeight: number;
  targetUnit: UnitType;
  monthlyInvestment: number;
  quantity: number;
  targetPrice: number;
};

export const sanitizeMetadata = (metadata: unknown): Record<string, string> => {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  return Object.entries(metadata as Record<string, unknown>).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (value === undefined || value === null) {
        return acc;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        acc[key] = String(value);
      }
      return acc;
    },
    {}
  );
};

const ensureBaseUrl = () => {
  const url = process.env.FRONTEND_URL || process.env.BASE_URL || 'http://localhost:5005';
  return url.replace(/\/$/, '');
};

const ensureSubscriptionProductId = () => {
  const productId = process.env.STRIPE_SUBSCRIPTION_PRODUCT_ID;
  if (!productId) {
    throw new Error('Missing STRIPE_SUBSCRIPTION_PRODUCT_ID in environment');
  }
  return productId;
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

const normalizeSubscriptionConfig = (
  details: SubscriptionDetailsInput,
  metadata: Record<string, string>,
  amount: number,
  productName: string,
  quantity: number
): NormalizedSubscriptionConfig => {
  const rawPlanName = details?.planName ?? metadata.planName ?? metadata.plan;
  const planName = rawPlanName?.trim() || productName || DEFAULT_PRODUCT_NAME;
  const metal = (details?.metal ?? metadata.metal) === 'silver' ? 'silver' : 'gold';
  const targetUnit = (details?.targetUnit ?? metadata.targetUnit) === 'g' ? 'g' : 'oz';
  const targetWeight = toPositiveNumber(details?.targetWeight ?? metadata.targetWeight, 1);
  const monthlyInvestment = toPositiveNumber(
    details?.monthlyInvestment ?? metadata.monthlyInvestment,
    amount
  );
  const normalizedQuantity = toPositiveNumber(details?.quantity ?? metadata.quantity, quantity);
  const targetPrice = toNonNegativeNumber(details?.targetPrice ?? metadata.targetPrice, 0);

  return {
    planName,
    metal,
    targetUnit,
    targetWeight,
    monthlyInvestment,
    quantity: normalizedQuantity,
    targetPrice,
  };
};

const asObjectId = (value?: string): mongoose.Types.ObjectId | undefined => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    return undefined;
  }
  return new mongoose.Types.ObjectId(value);
};

router.post('/create-session', authenticate, validateCreateSessionPayload, async (req: Request, res: Response) => {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const {
      amount,
      currency = 'inr',
      metadata,
      mode = 'subscription',
      productName = DEFAULT_PRODUCT_NAME,
      description = DEFAULT_DESCRIPTION,
      interval = 'month',
      intervalCount = 1,
      quantity = 1,
      customerEmail,
      subscriptionDetails,
    } = req.body as CreateSessionPayload;

    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const unitAmount = Math.round(normalizedAmount * 100);
    const normalizedCurrency = String(currency).toLowerCase();
    const checkoutMode: CheckoutMode = mode === 'payment' ? 'payment' : 'subscription';
    const normalizedSubscriptionDetails =
      checkoutMode === 'subscription' ? subscriptionDetails : undefined;
    const sanitizedMetadata = sanitizeMetadata({
      ...metadata,
      ...(normalizedSubscriptionDetails
        ? {
            planName: normalizedSubscriptionDetails.planName,
            metal: normalizedSubscriptionDetails.metal,
            targetWeight: normalizedSubscriptionDetails.targetWeight,
            targetUnit: normalizedSubscriptionDetails.targetUnit,
            monthlyInvestment: normalizedSubscriptionDetails.monthlyInvestment,
            quantity: normalizedSubscriptionDetails.quantity,
            targetPrice: normalizedSubscriptionDetails.targetPrice,
          }
        : {}),
      userId: req.user.userId,
    });
    const normalizedSubscriptionConfig =
      checkoutMode === 'subscription'
        ? normalizeSubscriptionConfig(
            normalizedSubscriptionDetails,
            sanitizedMetadata,
            normalizedAmount,
            productName,
            quantity
          )
        : undefined;

    const order = await Order.create({
      user: asObjectId(req.user.userId),
      orderType: checkoutMode === 'payment' ? 'one_time' : 'subscription',
      amount: normalizedAmount,
      amountInMinor: unitAmount,
      currency: normalizedCurrency,
      status: 'pending',
      paymentStatus: 'pending',
      invoiceStatus: 'none',
      productName,
      productDescription: description,
      billingEmail: customerEmail,
      metadata: sanitizedMetadata,
      subscriptionConfig: normalizedSubscriptionConfig,
    });

    const orderId = order.id;
    const baseUrl = ensureBaseUrl();
    const encodedOrderId = encodeURIComponent(orderId);

    let lineItem: Stripe.Checkout.SessionCreateParams.LineItem;

    if (checkoutMode === 'subscription') {
      const productId = ensureSubscriptionProductId();
      const dynamicPrice = await stripe.prices.create({
        unit_amount: unitAmount,
        currency: normalizedCurrency,
        product: productId,
        recurring: {
          interval: interval === 'year' ? 'year' : 'month',
          interval_count: Number(intervalCount) > 0 ? Number(intervalCount) : 1,
        },
        nickname: `${productName} - $${normalizedAmount.toFixed(2)}`,
      });

      lineItem = {
        price: dynamicPrice.id,
        quantity: Number(quantity) > 0 ? Number(quantity) : 1,
      };
    } else {
      lineItem = {
        price_data: {
          currency: normalizedCurrency,
          product_data: {
            name: productName,
            description,
          },
          unit_amount: unitAmount,
        },
        quantity: Number(quantity) > 0 ? Number(quantity) : 1,
      };
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: checkoutMode,
      line_items: [lineItem],
      metadata: {
        orderId,
        ...sanitizedMetadata,
      },
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}&order_id=${encodedOrderId}`,
      cancel_url: `${baseUrl}/checkout/cancel?order_id=${encodedOrderId}`,
    };

    if (checkoutMode === 'subscription') {
      sessionParams.subscription_data = {
        metadata: {
          orderId,
          ...sanitizedMetadata,
        },
      };
    }

    if (customerEmail) {
      sessionParams.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    order.stripeSessionId = session.id;
    if (session.customer) {
      order.stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
    }
    order.latestStripeEvent = 'checkout.session.created';
    await order.save();

    return res.json({
      url: session.url,
      sessionId: session.id,
      orderId,
      expiresAt: session.expires_at ? session.expires_at * 1000 : undefined,
    });
  } catch (err: any) {
    console.error('create-session error', err);
    return res.status(500).json({
      error: 'Failed to create checkout session',
      details: err.message,
    });
  }
});

type OrderLookup = {
  orderId?: string | null;
  stripeSessionId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
};

const mapSubscriptionStatus = (
  status: Stripe.Subscription.Status
): Pick<IOrder, 'status' | 'paymentStatus'> => {
  switch (status) {
    case 'active':
      return { status: 'paid', paymentStatus: 'succeeded' };
    case 'trialing':
    case 'incomplete':
    case 'incomplete_expired':
      return { status: 'pending', paymentStatus: 'pending' };
    case 'canceled':
    case 'unpaid':
      return { status: 'cancelled', paymentStatus: 'failed' };
    case 'past_due':
      return { status: 'pending', paymentStatus: 'pending' };
    default:
      return { status: 'pending', paymentStatus: 'pending' };
  }
};

type StripeEventContext = {
  eventId: string;
  eventType: string;
  deliveredAt: Date;
};

export const updateOrderByLookup = async (
  lookup: OrderLookup,
  updates: Partial<IOrder>,
  context?: StripeEventContext
) => {
  const filters: Record<string, any>[] = [];

  if (lookup.orderId && mongoose.Types.ObjectId.isValid(lookup.orderId)) {
    filters.push({ _id: lookup.orderId });
  }
  if (lookup.stripeSessionId) {
    filters.push({ stripeSessionId: lookup.stripeSessionId });
  }
  if (lookup.stripeSubscriptionId) {
    filters.push({ stripeSubscriptionId: lookup.stripeSubscriptionId });
  }
  if (lookup.stripeInvoiceId) {
    filters.push({ stripeInvoiceId: lookup.stripeInvoiceId });
  }
  if (lookup.stripePaymentIntentId) {
    filters.push({ stripePaymentIntentId: lookup.stripePaymentIntentId });
  }

  for (const filter of filters) {
    const order = await Order.findOne(filter);
    if (!order) {
      continue;
    }

    if (context && order.latestStripeEventId === context.eventId) {
      console.info('Stripe webhook: duplicate event skipped', {
        eventId: context.eventId,
        orderId: order.id,
      });
      return order;
    }

    Object.assign(order, updates);
    if (context) {
      order.latestStripeEvent = context.eventType;
      order.latestStripeEventId = context.eventId;
      order.latestStripeEventReceivedAt = context.deliveredAt;
    }

    await order.save();
    return order;
  }

  await notifyOps('Stripe webhook could not match order', {
    lookup,
    eventId: context?.eventId,
    eventType: context?.eventType,
  });

  return null;
};

const ensureWebhookSecret = () => {
  if (!process.env.WEBHOOK_SECRET) {
    throw new Error('Missing WEBHOOK_SECRET in environment');
  }
  return process.env.WEBHOOK_SECRET;
};

const asStripeId = <T extends { id: string } | string | null | undefined>(value: T): string | undefined => {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
};

const getInvoiceSubscriptionId = (invoice: Stripe.Invoice): string | undefined => {
  const subscriptionCandidate = (invoice as Stripe.Invoice & {
    subscription?: string | Stripe.Subscription | null;
  }).subscription;
  return asStripeId(subscriptionCandidate ?? null);
};

const getInvoicePaymentIntentId = (invoice: Stripe.Invoice): string | undefined => {
  const paymentIntentCandidate = (invoice as Stripe.Invoice & {
    payment_intent?: string | Stripe.PaymentIntent | null;
  }).payment_intent;
  return asStripeId(paymentIntentCandidate ?? null);
};

const getInvoicePeriodEndDate = (invoice: Stripe.Invoice): Date | undefined => {
  const line = invoice.lines?.data?.[0];
  const periodEnd = line?.period?.end;
  return periodEnd ? new Date(periodEnd * 1000) : undefined;
};

const harmlessStripeEvents = new Set<string>([
  'charge.succeeded',
  'charge.failed',
  'payment_method.attached',
  'payment_method.detached',
  // 'payment_intent.created' - REMOVED: we need to handle this to link payment intents early
  'payment_intent.succeeded',
  'customer.created',
  'customer.updated',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice_payment.paid',
]);

export const buildPaymentStatus = (status?: string): PaymentStatus => {
  if (!status) return 'pending';
  if (status === 'paid' || status === 'succeeded') return 'succeeded';
  if (status === 'unpaid' || status === 'failed') return 'failed';
  if (status === 'processing') return 'processing';
  if (status === 'requires_payment_method') return 'requires_payment_method';
  if (status === 'requires_action') return 'requires_action';
  if (status === 'refunded') return 'refunded';
  return 'pending';
};

export const processStripeEvent = async (event: Stripe.Event): Promise<void> => {
  const context: StripeEventContext = {
    eventId: event.id,
    eventType: event.type,
    deliveredAt: new Date(),
  };
  

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const isUnpaid = session.payment_status === 'unpaid';
      const update: Partial<IOrder> = {
        latestStripeEvent: event.type,
        status: isUnpaid ? 'cancelled' : session.payment_status === 'paid' ? 'paid' : 'pending',
        paymentStatus: isUnpaid ? 'failed' : buildPaymentStatus(session.payment_status),
        billingEmail: session.customer_details?.email ?? undefined,
        billingName: session.customer_details?.name ?? undefined,
        stripeCustomerId: asStripeId(session.customer),
        stripeSubscriptionId: asStripeId(session.subscription),
        stripePaymentIntentId: asStripeId(session.payment_intent as any),
        stripeInvoiceId: asStripeId(session.invoice as any),
        amountInMinor: session.amount_total ?? undefined,
        amount:
          session.amount_total !== null && session.amount_total !== undefined
            ? session.amount_total / 100
            : undefined,
        currency: session.currency ?? undefined,
      };

      const updated = await updateOrderByLookup(
        {
          orderId: session.metadata?.orderId,
          stripeSessionId: session.id,
          stripeSubscriptionId: asStripeId(session.subscription),
        },
        update,
        context
      );

      if (!updated) {
        console.warn('Stripe webhook: no order matched checkout.session.completed', {
          sessionId: session.id,
          metadataOrderId: session.metadata?.orderId,
        });
      } else if (updated.orderType === 'subscription') {
        await syncSubscriptionFromOrder(updated, {
          status: isUnpaid ? 'past_due' : 'pending_payment',
          stripeSubscriptionId: asStripeId(session.subscription),
        });
      }
      break;
    }

    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const update: Partial<IOrder> = {
        latestStripeEvent: event.type,
        status: 'cancelled',
        paymentStatus: 'failed',
        billingEmail: session.customer_details?.email ?? undefined,
        billingName: session.customer_details?.name ?? undefined,
        stripeCustomerId: asStripeId(session.customer),
        stripeSubscriptionId: asStripeId(session.subscription),
        stripePaymentIntentId: asStripeId(session.payment_intent as any),
        stripeInvoiceId: asStripeId(session.invoice as any),
        amountInMinor: session.amount_total ?? undefined,
        amount:
          session.amount_total !== null && session.amount_total !== undefined
            ? session.amount_total / 100
            : undefined,
        currency: session.currency ?? undefined,
      };

      const updated = await updateOrderByLookup(
        {
          orderId: session.metadata?.orderId,
          stripeSessionId: session.id,
          stripeSubscriptionId: asStripeId(session.subscription),
        },
        update,
        context
      );

      if (!updated) {
        console.warn('Stripe webhook: no order matched checkout.session.async_payment_failed', {
          sessionId: session.id,
          metadataOrderId: session.metadata?.orderId,
        });
      } else if (updated.orderType === 'subscription') {
        await syncSubscriptionFromOrder(updated, {
          status: 'past_due',
          stripeSubscriptionId: asStripeId(session.subscription),
        });
      }
      break;
    }

    case 'payment_intent.created': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      
      // Retrieve full payment intent to get all details
      let fullPaymentIntent: Stripe.PaymentIntent;
      try {
        fullPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
          expand: ['invoice', 'customer'],
        });
      } catch (error) {
        console.error('Stripe webhook: failed to retrieve payment intent', {
          paymentIntentId: paymentIntent.id,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      // Try to find the order and link the payment intent early
      // This creates the link we need for payment_intent.payment_failed
      const sessionId = fullPaymentIntent.metadata?.checkout_session_id;
      const orderIdFromMetadata = fullPaymentIntent.metadata?.orderId;

      // Strategy 1: Find by orderId from metadata
      let updated: IOrder | null = null;
      if (orderIdFromMetadata && mongoose.Types.ObjectId.isValid(orderIdFromMetadata)) {
        updated = await Order.findById(orderIdFromMetadata);
      }

      // Strategy 2: Find by session ID from metadata
      if (!updated && sessionId) {
        updated = await Order.findOne({ stripeSessionId: sessionId });
      }

      // Strategy 3: If we have a customer, find pending orders and check their sessions
      if (!updated && fullPaymentIntent.customer) {
        const customerId = typeof fullPaymentIntent.customer === 'string' 
          ? fullPaymentIntent.customer 
          : fullPaymentIntent.customer.id;
        
        const pendingOrders = await Order.find({
          $or: [
            { stripeCustomerId: customerId },
            { stripeCustomerId: { $exists: false } },
            { stripeCustomerId: null },
          ],
          status: 'pending',
          latestStripeEvent: 'checkout.session.created',
          stripeSessionId: { $exists: true, $ne: null },
        }).limit(10);

        for (const order of pendingOrders) {
          if (!order.stripeSessionId) continue;
          
          try {
            const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
            const sessionPaymentIntentId = typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id;
            
            if (sessionPaymentIntentId === fullPaymentIntent.id) {
              updated = order;
              break;
            }
          } catch (error) {
            // Continue to next order if session retrieval fails
            continue;
          }
        }
      }

      // If we found the order, link the payment intent immediately
      if (updated) {
        // Check for duplicate event
        if (context && updated.latestStripeEventId === context.eventId) {
          console.info('Stripe webhook: duplicate payment_intent.created event skipped', {
            eventId: context.eventId,
            orderId: updated.id,
          });
          break;
        }

        updated.stripePaymentIntentId = fullPaymentIntent.id;
        if (!updated.stripeCustomerId && fullPaymentIntent.customer) {
          updated.stripeCustomerId = typeof fullPaymentIntent.customer === 'string'
            ? fullPaymentIntent.customer
            : fullPaymentIntent.customer.id;
        }
        if (context) {
          updated.latestStripeEvent = context.eventType;
          updated.latestStripeEventId = context.eventId;
          updated.latestStripeEventReceivedAt = context.deliveredAt;
        }
        await updated.save();
        
        console.log('Stripe webhook: linked payment_intent.created to order', {
          orderId: updated.id,
          paymentIntentId: fullPaymentIntent.id,
          sessionId: updated.stripeSessionId,
        });
      } else {
        console.debug('Stripe webhook: payment_intent.created - no order found to link', {
          paymentIntentId: fullPaymentIntent.id,
          sessionId,
          metadataOrderId: orderIdFromMetadata,
          customerId: typeof fullPaymentIntent.customer === 'string' 
            ? fullPaymentIntent.customer 
            : fullPaymentIntent.customer?.id,
        });
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      
      // Retrieve full payment intent to get all metadata and details
      let fullPaymentIntent: Stripe.PaymentIntent;
      try {
        fullPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
          expand: ['invoice', 'customer'],
        });
      } catch (error) {
        console.error('Stripe webhook: failed to retrieve payment intent', {
          paymentIntentId: paymentIntent.id,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      console.log('Stripe webhook: processing payment_intent.payment_failed', {
        paymentIntentId: fullPaymentIntent.id,
        customerId: typeof fullPaymentIntent.customer === 'string' 
          ? fullPaymentIntent.customer 
          : fullPaymentIntent.customer?.id,
        metadata: fullPaymentIntent.metadata,
      });

      const sessionId = fullPaymentIntent.metadata?.checkout_session_id;
      const orderIdFromMetadata = fullPaymentIntent.metadata?.orderId;
      
      const update: Partial<IOrder> = {
        latestStripeEvent: event.type,
        status: 'cancelled',
        paymentStatus: 'failed',
        stripePaymentIntentId: fullPaymentIntent.id,
        stripeCustomerId: asStripeId(fullPaymentIntent.customer),
      };

      // Strategy 1: Direct lookup by payment intent ID (should work now thanks to payment_intent.created)
      let updated = await updateOrderByLookup(
        {
          stripePaymentIntentId: fullPaymentIntent.id,
        },
        update,
        context
      );

      if (updated) {
        console.log('Stripe webhook: matched payment_intent.payment_failed via direct lookup (thanks to payment_intent.created)', {
          orderId: updated.id,
          paymentIntentId: fullPaymentIntent.id,
        });
      }

      // Strategy 2: Try to find by session ID from metadata
      if (!updated && sessionId) {
        updated = await updateOrderByLookup(
          {
            stripeSessionId: sessionId,
          },
          update,
          context
        );
      }

      // Strategy 3: Try orderId from metadata
      if (!updated && orderIdFromMetadata) {
        updated = await updateOrderByLookup(
          {
            orderId: orderIdFromMetadata,
          },
          update,
          context
        );
      }

      // Strategy 3.5: If payment intent has an invoice, check invoice metadata for orderId
      const paymentIntentWithInvoice = fullPaymentIntent as Stripe.PaymentIntent & {
        invoice?: string | Stripe.Invoice | null;
      };
      if (!updated && paymentIntentWithInvoice.invoice) {
        try {
          const invoiceId = typeof paymentIntentWithInvoice.invoice === 'string'
            ? paymentIntentWithInvoice.invoice
            : paymentIntentWithInvoice.invoice.id;
          const invoice = await stripe.invoices.retrieve(invoiceId);
          const invoiceOrderId = invoice.metadata?.orderId;
          
          if (invoiceOrderId) {
            updated = await updateOrderByLookup(
              {
                orderId: invoiceOrderId,
              },
              update,
              context
            );
            
            if (updated) {
              console.log('Stripe webhook: matched payment_intent.payment_failed to order via invoice metadata', {
                orderId: updated.id,
                paymentIntentId: fullPaymentIntent.id,
                invoiceId: invoiceId,
              });
            }
          }
        } catch (error) {
          // Continue to next strategy if invoice retrieval fails
          console.debug('Stripe webhook: failed to retrieve invoice for payment intent', {
            paymentIntentId: fullPaymentIntent.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Strategy 4: If we have a customer ID, try multiple approaches to find the order
      if (!updated && fullPaymentIntent.customer) {
        const customerId = typeof fullPaymentIntent.customer === 'string' 
          ? fullPaymentIntent.customer 
          : fullPaymentIntent.customer.id;
        
        console.log('Stripe webhook: Strategy 4 - searching for orders with customer', {
          customerId,
          paymentIntentId: fullPaymentIntent.id,
        });

        // Strategy 4a: Find pending orders that already have this customer ID set
        let pendingOrders = await Order.find({
          stripeCustomerId: customerId,
          status: 'pending',
          latestStripeEvent: 'checkout.session.created',
          stripeSessionId: { $exists: true, $ne: null },
        }).limit(10);

        // Strategy 4b: If no orders found, also check orders without stripeCustomerId set
        // (customer might have been created during checkout)
        if (pendingOrders.length === 0) {
          pendingOrders = await Order.find({
            status: 'pending',
            latestStripeEvent: 'checkout.session.created',
            stripeSessionId: { $exists: true, $ne: null },
            $or: [
              { stripeCustomerId: { $exists: false } },
              { stripeCustomerId: null },
            ],
          }).limit(20); // Check more orders since we don't have customer filter
        }

        console.log('Stripe webhook: Strategy 4 - found pending orders to check', {
          count: pendingOrders.length,
          customerId,
        });

        // Check each order's checkout session to see if it has this payment intent
        for (const order of pendingOrders) {
          if (!order.stripeSessionId) continue;
          
          try {
            const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
            
            // Update order's customer ID if it's not set
            if (!order.stripeCustomerId && session.customer) {
              order.stripeCustomerId = typeof session.customer === 'string' 
                ? session.customer 
                : session.customer.id;
            }
            
            const sessionPaymentIntentId = typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id;
            
            // Also check if session metadata has orderId that matches
            const sessionOrderId = session.metadata?.orderId;
            const orderMatches = sessionPaymentIntentId === fullPaymentIntent.id ||
              (sessionOrderId && sessionOrderId === order.id.toString());
            
            if (orderMatches) {
              // Found the matching order!
              Object.assign(order, update);
              if (context) {
                order.latestStripeEvent = context.eventType;
                order.latestStripeEventId = context.eventId;
                order.latestStripeEventReceivedAt = context.deliveredAt;
              }
              await order.save();
              updated = order;
              console.log('Stripe webhook: matched payment_intent.payment_failed to order via checkout session lookup', {
                orderId: order.id,
                paymentIntentId: fullPaymentIntent.id,
                sessionId: order.stripeSessionId,
                matchedBy: sessionPaymentIntentId === fullPaymentIntent.id ? 'payment_intent' : 'orderId',
              });
              break;
            }
          } catch (error) {
            // Continue to next order if session retrieval fails
            console.debug('Stripe webhook: failed to retrieve checkout session', {
              sessionId: order.stripeSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
        }

        // Strategy 4c: If still not found, query Stripe directly for checkout sessions
        if (!updated) {
          try {
            console.log('Stripe webhook: Strategy 4c - querying Stripe for checkout sessions', {
              customerId,
              paymentIntentId: fullPaymentIntent.id,
            });
            
            // List checkout sessions for this customer (limited to recent ones)
            const sessions = await stripe.checkout.sessions.list({
              customer: customerId,
              limit: 10,
            });

            for (const session of sessions.data) {
              const sessionPaymentIntentId = typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id;
              
              if (sessionPaymentIntentId === fullPaymentIntent.id) {
                // Found the session! Now find the order by session ID
                const orderIdFromSession = session.metadata?.orderId;
                
                if (orderIdFromSession) {
                  updated = await updateOrderByLookup(
                    {
                      orderId: orderIdFromSession,
                      stripeSessionId: session.id,
                    },
                    update,
                    context
                  );
                  
                  if (updated) {
                    console.log('Stripe webhook: matched payment_intent.payment_failed to order via Stripe session list', {
                      orderId: updated.id,
                      paymentIntentId: fullPaymentIntent.id,
                      sessionId: session.id,
                    });
                    break;
                  }
                }
              }
            }
          } catch (error) {
            console.debug('Stripe webhook: failed to list checkout sessions', {
              customerId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (!updated) {
        console.warn('Stripe webhook: no order matched payment_intent.payment_failed', {
          paymentIntentId: fullPaymentIntent.id,
          sessionId,
          metadataOrderId: orderIdFromMetadata,
          customerId: typeof fullPaymentIntent.customer === 'string' 
            ? fullPaymentIntent.customer 
            : fullPaymentIntent.customer?.id,
        });
      } else if (updated.orderType === 'subscription') {
        await syncSubscriptionFromOrder(updated, {
          status: 'past_due',
          stripeSubscriptionId: updated.stripeSubscriptionId,
        });
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const invoiceSubscriptionId = getInvoiceSubscriptionId(invoice);
      const periodEnd = getInvoicePeriodEndDate(invoice);
      const amountPaidMajor =
        invoice.amount_paid !== null && invoice.amount_paid !== undefined
          ? invoice.amount_paid / 100
          : undefined;
      const update: Partial<IOrder> = {
        latestStripeEvent: event.type,
        status: 'paid',
        paymentStatus: 'succeeded',
        invoiceStatus: invoice.status ?? 'paid',
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: invoiceSubscriptionId,
        stripeCustomerId: asStripeId(invoice.customer),
        stripePaymentIntentId: getInvoicePaymentIntentId(invoice),
        receiptUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? undefined,
        amountInMinor: invoice.amount_paid ?? invoice.amount_due ?? undefined,
        amount: amountPaidMajor,
        currency: invoice.currency ?? undefined,
      };

      let updated = await updateOrderByLookup(
        {
          orderId: invoice.metadata?.orderId,
          stripeSubscriptionId: invoiceSubscriptionId,
          stripeInvoiceId: invoice.id,
        },
        update,
        context
      );

      // If no order found and this is a subscription renewal, create a new order record
      if (!updated && invoiceSubscriptionId) {
        // Find the subscription to get user and subscription details
        const subscription = await Subscription.findOne({ stripeSubscriptionId: invoiceSubscriptionId });
        
        if (subscription && subscription.userId) {
          // Get the first order for this subscription to copy subscription config
          const firstOrder = await Order.findOne({
            stripeSubscriptionId: invoiceSubscriptionId,
            orderType: 'subscription',
          }).sort({ createdAt: 1 });

          // Build subscription config from first order or subscription
          const subscriptionConfig = firstOrder?.subscriptionConfig ? {
            planName: firstOrder.subscriptionConfig.planName,
            metal: firstOrder.subscriptionConfig.metal,
            targetWeight: firstOrder.subscriptionConfig.targetWeight,
            targetUnit: firstOrder.subscriptionConfig.targetUnit,
            monthlyInvestment: firstOrder.subscriptionConfig.monthlyInvestment ?? amountPaidMajor,
            quantity: firstOrder.subscriptionConfig.quantity,
            targetPrice: firstOrder.subscriptionConfig.targetPrice,
          } : {
            planName: subscription.planName,
            metal: subscription.metal,
            targetWeight: subscription.targetWeight,
            targetUnit: subscription.targetUnit,
            monthlyInvestment: subscription.monthlyInvestment,
            quantity: subscription.quantity,
            targetPrice: subscription.targetPrice,
          };

          // Create new order for this renewal payment
          const renewalOrder = await Order.create({
            user: subscription.userId,
            subscriptionId: subscription._id,
            orderType: 'subscription',
            amount: amountPaidMajor ?? 0,
            amountInMinor: invoice.amount_paid ?? invoice.amount_due ?? 0,
            currency: invoice.currency ?? 'inr',
            status: 'paid',
            paymentStatus: 'succeeded',
            invoiceStatus: invoice.status ?? 'paid',
            productName: subscriptionConfig.planName ?? DEFAULT_PRODUCT_NAME,
            productDescription: `Subscription renewal payment - ${subscriptionConfig.planName}`,
            billingEmail: invoice.customer_email ?? undefined,
            stripeCustomerId: asStripeId(invoice.customer),
            stripeSubscriptionId: invoiceSubscriptionId,
            stripeInvoiceId: invoice.id,
            stripePaymentIntentId: getInvoicePaymentIntentId(invoice),
            receiptUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? undefined,
            subscriptionConfig,
            metadata: {
              ...sanitizeMetadata(invoice.metadata),
              renewalPayment: 'true',
              originalOrderId: firstOrder?.id?.toString(),
            },
            latestStripeEvent: event.type,
            latestStripeEventId: context.eventId,
            latestStripeEventReceivedAt: context.deliveredAt,
          });

          updated = renewalOrder;
          console.info('Created new order for subscription renewal payment', {
            orderId: renewalOrder.id,
            invoiceId: invoice.id,
            subscriptionId: invoiceSubscriptionId,
            amount: amountPaidMajor,
          });
        } else {
          console.warn('Stripe webhook: no subscription found for renewal payment', {
            invoiceId: invoice.id,
            subscriptionId: invoiceSubscriptionId,
          });
        }
      }

      if (!updated) {
        console.warn('Stripe webhook: no order matched invoice.payment_succeeded', {
          invoiceId: invoice.id,
          metadataOrderId: invoice.metadata?.orderId,
        });
      } else if (updated.orderType === 'subscription') {
        await syncSubscriptionFromOrder(updated, {
          status: 'active',
          currentPeriodEnd: periodEnd,
          stripeSubscriptionId: invoiceSubscriptionId,
          accumulatedValueDelta: amountPaidMajor,
        });
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const invoiceSubscriptionId = getInvoiceSubscriptionId(invoice);
      const periodEnd = getInvoicePeriodEndDate(invoice);
      const amountDueMajor =
        invoice.amount_due !== null && invoice.amount_due !== undefined
          ? invoice.amount_due / 100
          : undefined;
      const update: Partial<IOrder> = {
        latestStripeEvent: event.type,
        status: 'pending',
        paymentStatus: 'failed',
        invoiceStatus: invoice.status ?? 'open',
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: invoiceSubscriptionId,
        stripeCustomerId: asStripeId(invoice.customer),
        amount: amountDueMajor,
        amountInMinor: invoice.amount_due ?? undefined,
        currency: invoice.currency ?? undefined,
      };

      let updated = await updateOrderByLookup(
        {
          orderId: invoice.metadata?.orderId,
          stripeSubscriptionId: invoiceSubscriptionId,
          stripeInvoiceId: invoice.id,
        },
        update,
        context
      );

      // If no order found and this is a subscription renewal, create a new order record for failed payment
      if (!updated && invoiceSubscriptionId) {
        const subscription = await Subscription.findOne({ stripeSubscriptionId: invoiceSubscriptionId });
        
        if (subscription && subscription.userId) {
          const firstOrder = await Order.findOne({
            stripeSubscriptionId: invoiceSubscriptionId,
            orderType: 'subscription',
          }).sort({ createdAt: 1 });

          const subscriptionConfig = firstOrder?.subscriptionConfig ? {
            planName: firstOrder.subscriptionConfig.planName,
            metal: firstOrder.subscriptionConfig.metal,
            targetWeight: firstOrder.subscriptionConfig.targetWeight,
            targetUnit: firstOrder.subscriptionConfig.targetUnit,
            monthlyInvestment: firstOrder.subscriptionConfig.monthlyInvestment ?? amountDueMajor,
            quantity: firstOrder.subscriptionConfig.quantity,
            targetPrice: firstOrder.subscriptionConfig.targetPrice,
          } : {
            planName: subscription.planName,
            metal: subscription.metal,
            targetWeight: subscription.targetWeight,
            targetUnit: subscription.targetUnit,
            monthlyInvestment: subscription.monthlyInvestment,
            quantity: subscription.quantity,
            targetPrice: subscription.targetPrice,
          };

          const failedOrder = await Order.create({
            user: subscription.userId,
            subscriptionId: subscription._id,
            orderType: 'subscription',
            amount: amountDueMajor ?? 0,
            amountInMinor: invoice.amount_due ?? 0,
            currency: invoice.currency ?? 'inr',
            status: 'pending',
            paymentStatus: 'failed',
            invoiceStatus: invoice.status ?? 'open',
            productName: subscriptionConfig.planName ?? DEFAULT_PRODUCT_NAME,
            productDescription: `Subscription renewal payment (failed) - ${subscriptionConfig.planName}`,
            billingEmail: invoice.customer_email ?? undefined,
            stripeCustomerId: asStripeId(invoice.customer),
            stripeSubscriptionId: invoiceSubscriptionId,
            stripeInvoiceId: invoice.id,
            subscriptionConfig,
            metadata: {
              ...sanitizeMetadata(invoice.metadata),
              renewalPayment: 'true',
              paymentFailed: 'true',
              originalOrderId: firstOrder?.id?.toString(),
            },
            latestStripeEvent: event.type,
            latestStripeEventId: context.eventId,
            latestStripeEventReceivedAt: context.deliveredAt,
          });

          updated = failedOrder;
          console.info('Created new order for failed subscription renewal payment', {
            orderId: failedOrder.id,
            invoiceId: invoice.id,
            subscriptionId: invoiceSubscriptionId,
            amount: amountDueMajor,
          });
        }
      }

      if (!updated) {
        console.warn('Stripe webhook: no order matched invoice.payment_failed', {
          invoiceId: invoice.id,
          metadataOrderId: invoice.metadata?.orderId,
        });
      } else if (updated.orderType === 'subscription') {
        await syncSubscriptionFromOrder(updated, {
          status: 'past_due',
          currentPeriodEnd: periodEnd,
          stripeSubscriptionId: invoiceSubscriptionId,
        });
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const { status, paymentStatus } = mapSubscriptionStatus(subscription.status);
      const update: Partial<IOrder> = {
        latestStripeEvent: event.type,
        status,
        paymentStatus,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: asStripeId(subscription.customer),
      };

      const updated = await updateOrderByLookup(
        {
          orderId: subscription.metadata?.orderId,
          stripeSubscriptionId: subscription.id,
        },
        update,
        context
      );

      if (!updated) {
        console.warn('Stripe webhook: no order matched subscription event', {
          subscriptionId: subscription.id,
          metadataOrderId: subscription.metadata?.orderId,
        });
      }
      await applyStripeSubscriptionEvent(subscription);
      break;
    }

    case 'customer.subscription.deleted': {
      // When a subscription is deleted/cancelled, only update the Subscription model.
      // Do NOT update Orders because Orders represent immutable payment history.
      // Successful payments should remain paymentStatus: 'succeeded' even after cancellation
      // to preserve accurate Total Invested calculations.
      const subscription = event.data.object as Stripe.Subscription;
      await applyStripeSubscriptionEvent(subscription);
      break;
    }

    default:
      if (harmlessStripeEvents.has(event.type)) {
        console.debug(`Stripe event ignored: ${event.type}`);
      } else {
        console.log(`Unhandled Stripe event type: ${event.type}`);
      }
  }
};

export const webhookHandler = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    res.status(400).send('Missing stripe-signature header');
    return;
  }

  let event: Stripe.Event;
  try {
    const secret = ensureWebhookSecret();
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new Error('Expected raw request body to be a Buffer');
    }

    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err: any) {
    console.error('Webhook signature verification failed', err?.message || err);
    res.status(400).send(`Webhook Error: ${err?.message || 'signature verification failed'}`);
    return;
  }

  try {
    await processStripeEvent(event);
    res.json({ received: true });
  } catch (err: any) {
    console.error('Error handling Stripe webhook', err);
    res.status(500).send('Webhook handling error');
  }
};

export default router;

