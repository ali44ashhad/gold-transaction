// import mongoose, { Document, Schema } from 'mongoose';

// export interface IOrder extends Document {
//   user: mongoose.Types.ObjectId;
//   amount: number;
//   currency: string;
//   status: 'pending' | 'paid' | 'cancelled' | 'refunded';
//   stripeSessionId?: string;
//   metadata?: Record<string, any>;
//   createdAt: Date;
//   updatedAt: Date;
// }

// const OrderSchema = new Schema<IOrder>({
//   user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
//   amount: { type: Number, required: true },  
//   currency: { type: String, default: 'inr' },
//   status: { type: String, enum: ['pending','paid','cancelled','refunded'], default: 'pending' },
//   stripeSessionId: { type: String },
//   metadata: { type: Schema.Types.Mixed },
// }, { timestamps: true });

// export const Order = mongoose.model<IOrder>('Order', OrderSchema);


import mongoose, { Document, Schema } from 'mongoose';
import type { MetalType, UnitType } from './Subscription';

const orderStatuses = ['pending', 'paid', 'cancelled', 'refunded'] as const;
const paymentStatuses = [
  'pending',
  'requires_payment_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'refunded',
] as const;
const invoiceStatuses = ['none', 'draft', 'open', 'paid', 'void', 'uncollectible'] as const;
const orderTypes = ['subscription', 'one_time'] as const;

export type OrderStatus = (typeof orderStatuses)[number];
export type PaymentStatus = (typeof paymentStatuses)[number];
export type InvoiceStatus = (typeof invoiceStatuses)[number];
export type OrderType = (typeof orderTypes)[number];

export interface SubscriptionConfig {
  planName?: string;
  metal?: MetalType;
  targetWeight?: number;
  targetUnit?: UnitType;
  monthlyInvestment?: number;
  quantity?: number;
  targetPrice?: number;
  interval?: 'month' | 'year';
  intervalCount?: number;
}

export interface IOrder extends Document {
  user?: mongoose.Types.ObjectId;
  subscriptionId?: mongoose.Types.ObjectId; // Reference to Subscription (required for subscription orders)
  orderType: OrderType;
  amount: number; // major units (e.g. INR)
  amountInMinor: number; // minor units (e.g. paise)
  currency: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  invoiceStatus: InvoiceStatus;
  productName?: string;
  productDescription?: string;
  billingEmail?: string;
  billingName?: string;
  stripeSessionId?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePaymentIntentId?: string;
  stripeInvoiceId?: string;
  receiptUrl?: string;
  latestStripeEvent?: string;
  latestStripeEventId?: string;
  latestStripeEventReceivedAt?: Date;
  metadata?: Record<string, any>;
  subscriptionConfig?: SubscriptionConfig;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription',
      required: false,
      index: true,
    },
    orderType: { type: String, enum: orderTypes, default: 'subscription' },
    amount: { type: Number, required: true },
    amountInMinor: { type: Number, required: true },
    currency: { type: String, default: 'inr' },
    status: { type: String, enum: orderStatuses, default: 'pending' },
    paymentStatus: { type: String, enum: paymentStatuses, default: 'pending' },
    invoiceStatus: { type: String, enum: invoiceStatuses, default: 'none' },
    productName: { type: String },
    productDescription: { type: String },
    billingEmail: { type: String },
    billingName: { type: String },
    stripeSessionId: { type: String, index: true },
    stripeCustomerId: { type: String, index: true },
    stripeSubscriptionId: { type: String, index: true },
    stripePaymentIntentId: { type: String, index: true },
    stripeInvoiceId: { type: String },
    receiptUrl: { type: String },
    latestStripeEvent: { type: String },
    latestStripeEventId: { type: String, index: true },
    latestStripeEventReceivedAt: { type: Date },
    metadata: { type: Schema.Types.Mixed },
    subscriptionConfig: {
      planName: { type: String },
      metal: { type: String, enum: ['gold', 'silver'] },
      targetWeight: { type: Number },
      targetUnit: { type: String, enum: ['oz', 'g'] },
      monthlyInvestment: { type: Number },
      quantity: { type: Number },
      targetPrice: { type: Number },
      interval: { type: String, enum: ['month', 'year'] },
      intervalCount: { type: Number },
    },
  },
  { timestamps: true }
);

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
