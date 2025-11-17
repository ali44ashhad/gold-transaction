// src/routes/checkout.ts
import express from 'express';
import { stripe } from '../stripe';
import { authenticate } from '../middleware/auth';
import { Order } from '../models/Order';
import Stripe from 'stripe';

const router = express.Router();

/**
 * Basic route info
 */
router.get('/', (req, res) => {
  res.json({
    message: 'Checkout routes: POST /create-checkout-session (protected), POST /webhook (raw)',
    endpoints: [
      { method: 'POST', path: '/api/checkout/create-checkout-session' },
      { method: 'POST', path: '/api/checkout/webhook' }
    ]
  });
});

/**
 * Create Checkout Session (protected)
 * Expects: { amount: number (smallest currency unit), currency?: string, productName?: string }
 */
// router.post('/create-checkout-session', authenticate, async (req, res) => {
//   try {
//     // req.user set by authenticate middleware
    
//     const userId = (req as any).user?.userId;
//     const { amount, currency = 'inr', productName = 'Gold Item' } = req.body;

//     // Validate amount: must be positive integer in smallest currency unit (e.g., paise)
//     if (!Number.isInteger(amount) || amount <= 0) {
//       return res.status(400).json({ error: 'amount must be a positive integer in the smallest currency unit (e.g., paise)' });
//     }

//     // create order in DB with pending status
//     const order = await Order.create({
//       user: userId,
//       amount,
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
//             unit_amount: amount,
//           },
//           quantity: 1,
//         },
//       ],
//       metadata: { orderId: order._id.toString(), userId },
//       success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
//       cancel_url: `${process.env.BASE_URL}/cancel`,
//     });

//     // Save session id on order for later reconciliation
//     order.stripeSessionId = session.id;
//     await order.save();

//     // Return the hosted URL so frontend can redirect
//     res.json({ url: session.url, id: session.id });
//   } catch (err: any) {
//     console.error('create-checkout-session error:', err);
//     res.status(500).json({ error: 'Could not create checkout session' });
//   }
// });
router.post('/create-checkout-session', authenticate, async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    let { amount, currency = 'inr', productName = 'Gold Item' } = req.body;

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // 🔥 If frontend is sending rupees → convert to paise
    // Example: 100 → 10000
    const amountInPaise = Math.round(amount * 100);

    // create order (save rupees or paise — your choice, I saved rupees to DB)
    const order = await Order.create({
      user: userId,
      amount: amount,     // storing rupees
      currency,
      status: 'pending',
    });

    // create stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: productName },
            unit_amount: amountInPaise,   // 🔥 Stripe always needs smallest unit
          },
          quantity: 1,
        },
      ],
      metadata: { orderId: order._id.toString(), userId },
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/cancel`,
    });

    order.stripeSessionId = session.id;
    await order.save();

    res.json({ url: session.url, id: session.id });

  } catch (err: any) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});


/**
 * Webhook handler function (must be mounted with raw body parser)
 * Exported so index.ts can mount it with bodyParser.raw(...) BEFORE express.json()
 */
export async function webhookHandler(req: express.Request, res: express.Response) {
  const sig = req.headers['stripe-signature'] as string | undefined;
  const webhookSecret = process.env.WEBHOOK_SECRET as string | undefined;
  if (!sig || !webhookSecret) {
    console.warn('Missing webhook signature or webhook secret');
    return res.status(400).send('Missing webhook signature/secret');
  }

  let event: Stripe.Event;
  try {
    // Important: req.body must be raw Buffer when this function is called
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err?.message || 'signature verification failed'}`);
  }

  try {
    // Handle checkout.session.completed
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId;

      if (orderId) {
        const order = await Order.findById(orderId);
        if (order) {
          order.status = 'paid';
          order.stripeSessionId = session.id;
          await order.save();
          console.log('Order marked paid:', orderId);
        } else {
          console.warn('Order not found for id from metadata:', orderId);
        }
      } else {
        // fallback: find by stripeSessionId
        const order = await Order.findOne({ stripeSessionId: session.id });
        if (order) {
          order.status = 'paid';
          await order.save();
          console.log('Order found by session id and marked paid:', session.id);
        } else {
          console.warn('Order not found for session id:', session.id);
        }
      }
    }

    // Add other event types if you need (payment_intent.succeeded, charge.refunded, etc.)
  } catch (dbErr) {
    console.error('Error processing webhook event:', dbErr);
    // still return 200/2xx? Stripe will retry on non-2xx — here return 500 to let Stripe retry.
    return res.status(500).send('Internal processing error');
  }

  // Respond to Stripe with 2xx to acknowledge receipt
  res.json({ received: true });
}

export default router;
