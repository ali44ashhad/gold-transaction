// // src/routes/checkout.ts
// import express from 'express';
// import { stripe } from '../stripe';
// import { authenticate } from '../middleware/auth';
// import { Order } from '../models/Order';
// import Stripe from 'stripe';

// const router = express.Router();

// /**
//  * Basic route info
//  */
// router.get('/', (req, res) => {
//   res.json({
//     message: 'Checkout routes: POST /create-checkout-session (protected), POST /webhook (raw)',
//     endpoints: [
//       { method: 'POST', path: '/api/checkout/create-checkout-session' },
//       { method: 'POST', path: '/api/checkout/webhook' }
//     ]
//   });
// });


// router.post('/create-checkout-session', authenticate, async (req, res) => {
//   try {
//     const userId = (req as any).user?.userId;
//     let { amount, currency = 'inr', productName = 'Gold Item' } = req.body;

//     if (typeof amount !== 'number' || amount <= 0) {
//       return res.status(400).json({ error: 'amount must be a positive number' });
//     }

//     // 🔥 If frontend is sending rupees → convert to paise
//     // Example: 100 → 10000
//     const amountInPaise = Math.round(amount * 100);

//     // create order (save rupees or paise — your choice, I saved rupees to DB)
//     const order = await Order.create({
//       user: userId,
//       amount: amount,     // storing rupees
//       currency,
//       status: 'pending',
//     });

//     // create stripe checkout session
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       mode: 'payment',
//       line_items: [
//         {
//           price_data: {
//             currency,
//             product_data: { name: productName },
//             unit_amount: amountInPaise,   // 🔥 Stripe always needs smallest unit
//           },
//           quantity: 1,
//         },
//       ],
//       metadata: { orderId: order._id.toString(), userId }, 
//       success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
//       cancel_url: `${process.env.BASE_URL}/cancel`,
//     });

//     order.stripeSessionId = session.id;
//     await order.save();

//     res.json({ url: session.url, id: session.id });

//   } catch (err: any) {
//     console.error('create-checkout-session error:', err);
//     res.status(500).json({ error: 'Could not create checkout session' });
//   }
// });


// /**
//  * Webhook handler function (must be mounted with raw body parser)
//  * Exported so index.ts can mount it with bodyParser.raw(...) BEFORE express.json()
//  */
// export async function webhookHandler(req: express.Request, res: express.Response) {
//   const sig = req.headers['stripe-signature'] as string | undefined;
//   const webhookSecret = process.env.WEBHOOK_SECRET as string | undefined;
//   if (!sig || !webhookSecret) {
//     console.warn('Missing webhook signature or webhook secret');
//     return res.status(400).send('Missing webhook signature/secret');
//   }

//   let event: Stripe.Event;
//   try {
//     // Important: req.body must be raw Buffer when this function is called
//     event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
//   } catch (err: any) {
//     console.error('Webhook signature verification failed:', err?.message || err);
//     return res.status(400).send(`Webhook Error: ${err?.message || 'signature verification failed'}`);
//   }

//   try {
//     // Handle checkout.session.completed
//     if (event.type === 'checkout.session.completed') {
//       const session = event.data.object as Stripe.Checkout.Session;
//       const orderId = session.metadata?.orderId;

//       if (orderId) {
//         const order = await Order.findById(orderId);
//         if (order) {
//           order.status = 'paid';
//           order.stripeSessionId = session.id;
//           await order.save();
//           console.log('Order marked paid:', orderId);
//         } else {
//           console.warn('Order not found for id from metadata:', orderId);
//         }
//       } else {
//         // fallback: find by stripeSessionId
//         const order = await Order.findOne({ stripeSessionId: session.id });
//         if (order) {
//           order.status = 'paid';
//           await order.save();
//           console.log('Order found by session id and marked paid:', session.id);
//         } else {
//           console.warn('Order not found for session id:', session.id);
//         }
//       }
//     }

//     // Add other event types if you need (payment_intent.succeeded, charge.refunded, etc.)
//   } catch (dbErr) {
//     console.error('Error processing webhook event:', dbErr);
//     // still return 200/2xx? Stripe will retry on non-2xx — here return 500 to let Stripe retry.
//     return res.status(500).send('Internal processing error');
//   }

//   // Respond to Stripe with 2xx to acknowledge receipt
//   res.json({ received: true });
// }

// export default router;

// src/routes/checkout.ts
import express from 'express';
import { stripe } from '../stripe';
import { Order } from '../models/Order';
import dotenv from 'dotenv';
import { Request, Response } from 'express';
import mongoose from 'mongoose';

dotenv.config();

const router = express.Router();

 
// router.post('/create-session', async (req: Request, res: Response) => {
//   try {
//     const { amount, currency = 'inr', userId, metadata } = req.body;

//     if (!amount || Number(amount) <= 0) {
//       return res.status(400).json({ error: 'Invalid amount' });
//     }

//     const unitAmount = Math.round(Number(amount) * 100); // INR -> paise

//     // Create an Order in DB with status pending
//     const order = new Order({
//       user: userId ? new mongoose.Types.ObjectId(userId) : undefined,
//       amount: Number(amount),
//       currency,
//       status: 'pending',
//       metadata: metadata || {},
//     });

//     await order.save();

//     // Create a Checkout Session with dynamic recurring price (monthly)
//     // Using price_data so we don't need to persist Price objects in Stripe.
//     const session = await stripe.checkout.sessions.create({
//       mode: 'subscription',
//       line_items: [
//         {
//           price_data: {
//             currency,
//             product_data: {
//               name: 'Custom Monthly Subscription',
//               description: `Monthly subscription — ₹${Number(amount)}`,
//             },
//             unit_amount: unitAmount,
//             recurring: {
//               interval: 'month',
//             },
//           },
//           quantity: 1,
//         },
//       ],
//       // Attach order id to session metadata so webhook can find the order
//       metadata: {
//         orderId: order._id.toString(),
//         ...(metadata || {}),
//       },
//       subscription_data: {
//         metadata: {
//           orderId: order._id.toString(),
//         },
//       },
//       success_url: `${process.env.BASE_URL || 'http://localhost:5005'}/success?session_id={CHECKOUT_SESSION_ID}`,
//       cancel_url: `${process.env.BASE_URL || 'http://localhost:5005'}/cancel`,
//     });

//     // Save stripeSessionId so we can correlate later
//     order.stripeSessionId = session.id;
//     await order.save();

//     return res.json({ url: session.url, sessionId: session.id, orderId: order._id });
//   } catch (err: any) {
//     console.error('create-session error', err);
//     return res.status(500).json({ error: 'Failed to create checkout session' });
//   }
// });

router.post('/create-session', async (req: Request, res: Response) => {
  try {
    console.log("🔥 Incoming Request to /create-session");
    console.log("Body:", req.body);

    const { amount, currency = 'inr', userId, metadata } = req.body;

    if (!amount || Number(amount) <= 0) {
      console.log("❌ Invalid amount received:", amount);
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const unitAmount = Math.round(Number(amount) * 100);

    const orderData: any = {
      amount: Number(amount),
      currency,
      status: 'pending',
      metadata: metadata || {},
    };

    if (userId) {
      orderData.user = new mongoose.Types.ObjectId(userId);
    }

    console.log("📝 Order data to save:", orderData);

    const order = new Order(orderData);
    await order.save();

    console.log("💾 Order saved:", order);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: 'Custom Monthly Subscription',
              description: `Monthly subscription — ₹${Number(amount)}`,
            },
            unit_amount: unitAmount,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      metadata: { orderId: order._id.toString(), ...(metadata || {}) },
      subscription_data: { metadata: { orderId: order._id.toString() } },
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
    });

    console.log("🎉 Stripe Session Created:", session);

    order.stripeSessionId = session.id;
    await order.save();

    console.log("📌 Order updated with stripeSessionId:", order);

    return res.json({
      url: session.url,
      sessionId: session.id,
      orderId: order._id
    });
  } catch (err: any) {
    console.error("❌ ERROR in /create-session:", err);
    return res.status(500).json({
      error: "Failed to create checkout session",
      details: err.message,
    });
  }
});


/**
 * Webhook handler function (exported) - index.ts routes raw body to this
 * Verify signature using process.env.WEBHOOK_SECRET
 */
// export const webhookHandler = async (req: any, res: Response) => {
//   const signature = req.headers['stripe-signature'];
//   const webhookSecret = process.env.WEBHOOK_SECRET;

//   let event;

//   try {
//     if (!webhookSecret) {
//       throw new Error('Missing WEBHOOK_SECRET in environment');
//     }
//     // req.body is raw body because index.ts uses bodyParser.raw for this route
//     event = stripe.webhooks.constructEvent(req.body, signature as string, webhookSecret);
//   } catch (err: any) {
//     console.error('Webhook signature verification failed.', err.message);
//     return res.status(400).send(`Webhook Error: ${err.message}`);
//   }

//   try {
//     // Handle important events
//     switch (event.type) {
//       // Called when Checkout Session completes (subscription created)
//       case 'checkout.session.completed': {
//         const session = event.data.object as any;
//         const orderId = session.metadata?.orderId;

//         if (orderId) {
//           await Order.findByIdAndUpdate(orderId, { status: 'paid', stripeSessionId: session.id });
//           console.log(`Order ${orderId} marked paid via checkout.session.completed`);
//         } else {
//           // fallback: find by session id
//           await Order.findOneAndUpdate({ stripeSessionId: session.id }, { status: 'paid' });
//         }
//         break;
//       }

//       // Invoice payment succeeded (recurring payment succeeded)
//       case 'invoice.payment_succeeded': {
//         const invoice = event.data.object as any;
//         // invoice contains subscription and lines. We can log or update records.
//         const subId = invoice.subscription;
//         console.log('Invoice payment succeeded for subscription:', subId);

//         // If you stored order metadata on the subscription or the invoice, update corresponding order
//         // Try to read orderId from invoice lines or metadata
//         const orderId = invoice?.metadata?.orderId;
//         if (orderId) {
//           await Order.findByIdAndUpdate(orderId, { status: 'paid' });
//         }
//         break;
//       }

//       // Subscription cancelled or unpaid, update order(s) if desired
//       case 'customer.subscription.deleted': {
//         const subscription = event.data.object as any;
//         console.log('Subscription cancelled', subscription.id);
//         // If you stored orderId on subscription metadata you could mark order cancelled
//         const orderId = subscription?.metadata?.orderId;
//         if (orderId) {
//           await Order.findByIdAndUpdate(orderId, { status: 'cancelled' });
//         }
//         break;
//       }

//       default:
//         // Unhandled events
//         // console.log(`Unhandled event type ${event.type}`);
//         break;
//     }

//     res.json({ received: true });
//   } catch (err: any) {
//     console.error('Error handling webhook event', err);
//     res.status(500).send();
//   }
// };
export const webhookHandler = async (req: any, res: Response) => {
  console.log("⚡ Stripe Webhook Received");
  console.log("Headers:", req.headers);
  console.log("Raw Body:", req.body.toString());

  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    console.log("🔍 Parsed Stripe Event:", event);
  } catch (err: any) {
    console.error("❌ Webhook Signature Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log("📦 Event type:", event.type);
    console.log("📨 Event data:", event.data.object);

    switch (event.type) {
      case "checkout.session.completed":
        console.log("🎉 Checkout Session Completed Event");
        break;

      case "invoice.payment_succeeded":
        console.log("💰 Invoice Payment Succeeded Event");
        break;

      case "customer.subscription.deleted":
        console.log("⚠️ Subscription Cancelled");
        break;

      default:
        console.log("ℹ️ Unhandled event type:", event.type);
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error("❌ Webhook handling error:", err);
    res.status(500).send();
  }
};

export default router;
