import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { connectDB } from '../config/database';
import { Order } from '../models/Order';

dotenv.config();

const backfillOrders = async (): Promise<void> => {
  await connectDB();

  const orders = await Order.find({});
  let updatedCount = 0;

  for (const order of orders) {
    let changed = false;

    if (!order.orderType) {
      order.orderType = order.stripeSubscriptionId ? 'subscription' : 'one_time';
      changed = true;
    }

    if ((!order.amountInMinor || order.amountInMinor <= 0) && order.amount) {
      order.amountInMinor = Math.round(order.amount * 100);
      changed = true;
    }

    if (!order.stripeSessionId && typeof order.metadata?.stripeSessionId === 'string') {
      order.stripeSessionId = order.metadata.stripeSessionId;
      changed = true;
    }

    if (!order.stripeCustomerId && typeof order.metadata?.stripeCustomerId === 'string') {
      order.stripeCustomerId = order.metadata.stripeCustomerId;
      changed = true;
    }

    if (!order.stripeSubscriptionId && typeof order.metadata?.stripeSubscriptionId === 'string') {
      order.stripeSubscriptionId = order.metadata.stripeSubscriptionId;
      changed = true;
    }

    if (changed) {
      await order.save();
      updatedCount += 1;
    }
  }

  console.log(`Backfill complete. Updated ${updatedCount} orders.`);
};

backfillOrders()
  .then(() => {
    mongoose.connection.close();
    process.exit(0);
  })
  .catch((error) => {
    console.error('Backfill script failed', error);
    mongoose.connection.close();
    process.exit(1);
  });


