import cron from 'node-cron';
import { Order } from '../models/Order';
import { stripe } from '../stripe';
import { notifyOps } from '../utils/alerting';

const DEFAULT_CRON_EXPRESSION = '0 * * * *'; // Every hour
const DEFAULT_TIMEZONE = 'America/New_York';
const CHECKOUT_SESSION_EXPIRY_HOURS = 24; // Stripe checkout sessions expire after 24 hours
const CANCELLED_ORDER_RETENTION_HOURS = 24; // Keep cancelled/failed orders for 24 hours before deletion

/**
 * Cleanup job to update Orders that are stuck in 'checkout.session.created' state
 * This handles cases where:
 * - Checkout sessions expired without completing
 * - Payment failed but webhook wasn't received
 * - Checkout was abandoned
 * - Payment intents failed but webhook didn't update the order
 * 
 * Also deletes cancelled and failed orders that are older than the retention period
 * to keep the database clean.
 */
export const runCheckoutSessionCleanup = async (): Promise<void> => {
  try {
    // Find orders that are still in 'checkout.session.created' state and are older than session expiry
    const expiryTime = new Date();
    expiryTime.setHours(expiryTime.getHours() - CHECKOUT_SESSION_EXPIRY_HOURS);

    const staleOrders = await Order.find({
      latestStripeEvent: 'checkout.session.created',
      status: 'pending',
      createdAt: { $lt: expiryTime },
      stripeSessionId: { $exists: true, $ne: null },
    }).limit(100); // Process in batches to avoid overwhelming Stripe API

    // Also check for orders with payment intents that might have failed
    // but webhook didn't update them (e.g., payment_intent.payment_failed webhook was missed)
    const ordersWithPaymentIntents = await Order.find({
      stripePaymentIntentId: { $exists: true, $ne: null },
      status: 'pending',
      paymentStatus: 'pending',
      createdAt: { $lt: expiryTime },
    }).limit(50);

    const totalOrdersToCheck = staleOrders.length + ordersWithPaymentIntents.length;

    if (totalOrdersToCheck === 0) {
      console.log('[CheckoutSessionCleanup] No stale orders found');
      return;
    }

    console.log(`[CheckoutSessionCleanup] Found ${staleOrders.length} stale checkout sessions and ${ordersWithPaymentIntents.length} orders with payment intents to check`);

    let updatedCount = 0;
    let errorCount = 0;

    for (const order of staleOrders) {
      try {
        if (!order.stripeSessionId) {
          continue;
        }

        // Fetch the checkout session from Stripe
        const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);

        // Check session status and update order accordingly
        if (session.status === 'expired') {
          order.status = 'cancelled';
          order.paymentStatus = 'failed';
          order.latestStripeEvent = 'checkout.session.expired';
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - session expired`);
        } else if (session.status === 'complete' && session.payment_status === 'unpaid') {
          order.status = 'cancelled';
          order.paymentStatus = 'failed';
          order.latestStripeEvent = 'checkout.session.completed.unpaid';
          // Update additional fields from session if available
          if (session.customer_details?.email) {
            order.billingEmail = session.customer_details.email;
          }
          if (session.customer_details?.name) {
            order.billingName = session.customer_details.name;
          }
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - session completed but unpaid`);
        } else if (session.status === 'complete' && session.payment_status === 'paid') {
          // This shouldn't happen if webhooks are working, but update it anyway
          order.status = 'paid';
          order.paymentStatus = 'succeeded';
          order.latestStripeEvent = 'checkout.session.completed.paid';
          if (session.customer_details?.email) {
            order.billingEmail = session.customer_details.email;
          }
          if (session.customer_details?.name) {
            order.billingName = session.customer_details.name;
          }
          if (session.customer) {
            order.stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
          }
          if (session.payment_intent) {
            order.stripePaymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
          }
          if (session.subscription) {
            order.stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          }
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - session completed and paid (webhook may have been missed)`);
        }
        // If session is still 'open', it's not expired yet, so we skip it
      } catch (error: any) {
        errorCount++;
        console.error(`[CheckoutSessionCleanup] Error processing order ${order.id}:`, error?.message || error);
        
        // If the session doesn't exist in Stripe, mark the order as cancelled
        if (error?.code === 'resource_missing' || error?.statusCode === 404) {
          order.status = 'cancelled';
          order.paymentStatus = 'failed';
          order.latestStripeEvent = 'checkout.session.not_found';
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - session not found in Stripe`);
        }
      }
    }

    // Process orders with payment intents that might have failed
    for (const order of ordersWithPaymentIntents) {
      try {
        if (!order.stripePaymentIntentId) {
          continue;
        }

        // Fetch the payment intent from Stripe to check its status
        const paymentIntent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);

        // Check if payment intent failed but order wasn't updated
        // Payment intent statuses that indicate failure:
        // - 'requires_payment_method': Payment failed, needs new payment method
        // - 'canceled': Payment intent was canceled
        if (paymentIntent.status === 'requires_payment_method' || paymentIntent.status === 'canceled') {
          order.status = 'cancelled';
          order.paymentStatus = 'failed';
          order.latestStripeEvent = 'payment_intent.failed.cleanup';
          
          // Update customer ID if not set
          if (!order.stripeCustomerId && paymentIntent.customer) {
            order.stripeCustomerId = typeof paymentIntent.customer === 'string'
              ? paymentIntent.customer
              : paymentIntent.customer.id;
          }
          
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - payment intent failed but webhook missed (status: ${paymentIntent.status})`);
        } else if (paymentIntent.status === 'succeeded') {
          // Payment succeeded but order wasn't updated (webhook missed)
          order.status = 'paid';
          order.paymentStatus = 'succeeded';
          order.latestStripeEvent = 'payment_intent.succeeded.cleanup';
          
          if (!order.stripeCustomerId && paymentIntent.customer) {
            order.stripeCustomerId = typeof paymentIntent.customer === 'string'
              ? paymentIntent.customer
              : paymentIntent.customer.id;
          }
          
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - payment intent succeeded but webhook missed`);
        }
        // Other statuses like 'processing', 'requires_action', etc. are still in progress, so we skip them
      } catch (error: any) {
        errorCount++;
        console.error(`[CheckoutSessionCleanup] Error processing payment intent for order ${order.id}:`, error?.message || error);
        
        // If the payment intent doesn't exist in Stripe, mark the order as cancelled
        if (error?.code === 'resource_missing' || error?.statusCode === 404) {
          order.status = 'cancelled';
          order.paymentStatus = 'failed';
          order.latestStripeEvent = 'payment_intent.not_found';
          await order.save();
          updatedCount++;
          console.log(`[CheckoutSessionCleanup] Updated order ${order.id} - payment intent not found in Stripe`);
        }
      }
    }

    // Delete old cancelled and failed orders
    const deletionCutoffTime = new Date();
    deletionCutoffTime.setHours(deletionCutoffTime.getHours() - CANCELLED_ORDER_RETENTION_HOURS);

    const ordersToDelete = await Order.find({
      $or: [
        { status: 'cancelled' },
        { paymentStatus: 'failed' },
      ],
      updatedAt: { $lt: deletionCutoffTime }, // Only delete orders that have been in cancelled/failed state for retention period
    }).limit(200); // Process in batches

    let deletedCount = 0;
    for (const order of ordersToDelete) {
      try {
        await Order.deleteOne({ _id: order._id });
        deletedCount++;
        console.log(`[CheckoutSessionCleanup] Deleted order ${order.id} - status: ${order.status}, paymentStatus: ${order.paymentStatus}`);
      } catch (error: any) {
        errorCount++;
        console.error(`[CheckoutSessionCleanup] Error deleting order ${order.id}:`, error?.message || error);
      }
    }

    if (ordersToDelete.length > 0) {
      console.log(`[CheckoutSessionCleanup] Deleted ${deletedCount} cancelled/failed orders (out of ${ordersToDelete.length} found)`);
    }

    console.log(
      `[CheckoutSessionCleanup] Completed: ${updatedCount} orders updated, ${deletedCount} orders deleted, ${errorCount} errors`,
    );

    if (errorCount > 0 && totalOrdersToCheck > 0) {
      await notifyOps('CheckoutSessionCleanup encountered errors', {
        totalOrders: totalOrdersToCheck,
        staleCheckoutSessions: staleOrders.length,
        ordersWithPaymentIntents: ordersWithPaymentIntents.length,
        updatedCount,
        deletedCount,
        errorCount,
      });
    }
  } catch (error) {
    console.error('[CheckoutSessionCleanup] Fatal error:', error);
    await notifyOps('CheckoutSessionCleanup fatal error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const startCheckoutSessionCleanupCron = (): void => {
  const cronEnabledEnv = process.env.CHECKOUT_CLEANUP_CRON_ENABLED;
  if (cronEnabledEnv === 'false') {
    console.log('[CheckoutSessionCleanup] Disabled via CHECKOUT_CLEANUP_CRON_ENABLED=false');
    return;
  }

  const cronExpression = process.env.CHECKOUT_CLEANUP_CRON_EXPRESSION || DEFAULT_CRON_EXPRESSION;
  const cronTimezone = process.env.CHECKOUT_CLEANUP_CRON_TIMEZONE || DEFAULT_TIMEZONE;

  cron.schedule(
    cronExpression,
    async () => {
      await runCheckoutSessionCleanup();
    },
    {
      timezone: cronTimezone,
    },
  );

  console.log(
    `[CheckoutSessionCleanup] Scheduled cleanup job using "${cronExpression}" (timezone: ${cronTimezone}). Set CHECKOUT_CLEANUP_CRON_ENABLED=false to disable.`,
  );
};

