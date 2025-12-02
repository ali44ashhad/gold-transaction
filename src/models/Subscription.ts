import mongoose, { Document, Schema } from 'mongoose';

export type MetalType = 'gold' | 'silver';
export type UnitType = 'oz' | 'g';
export type SubscriptionStatus = 
  | 'pending_payment' 
  | 'active' 
  | 'trialing' 
  | 'canceling' 
  | 'canceled' 
  | 'past_due' 
  | 'unpaid' 
  | 'incomplete' 
  | 'incomplete_expired';

export interface ISubscription extends Document {
  userId: mongoose.Types.ObjectId;
  metal: MetalType;
  planName: string;
  targetWeight: number;
  targetUnit: UnitType;
  monthlyInvestment: number;
  quantity: number;
  accumulatedValue: number;
  accumulatedWeight: number;
  status: SubscriptionStatus;
  stripeCustomerId: string;
  stripeSubscriptionId?: string;
  targetPrice: number;
  currentPeriodEnd?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  metal: {
    type: String,
    enum: ['gold', 'silver'],
    required: true,
  },
  planName: {
    type: String,
    required: true,
    trim: true,
  },
  targetWeight: {
    type: Number,
    required: true,
    min: 0,
  },
  targetUnit: {
    type: String,
    enum: ['oz', 'g'],
    required: true,
  },
  monthlyInvestment: {
    type: Number,
    required: true,
    min: 1,
  },
  quantity: {
    type: Number,
    default: 1,
    min: 1,
  },
  accumulatedValue: {
    type: Number,
    default: 0,
    min: 0,
  },
  accumulatedWeight: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: [
      'pending_payment',
      'active',
      'trialing',
      'canceling',
      'canceled',
      'past_due',
      'unpaid',
      'incomplete',
      'incomplete_expired',
    ],
    default: 'pending_payment',
    required: true,
  },
  stripeCustomerId: {
    type: String,
    required: true,
    index: true,
  },
  stripeSubscriptionId: {
    type: String,
    trim: true,
    index: true,
  },
  targetPrice: {
    type: Number,
    default: 0,
    min: 0,
  },
  currentPeriodEnd: {
    type: Date,
  },
}, {
  timestamps: true,
});

// Compound index for user and status queries
SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ userId: 1, createdAt: -1 });

export const Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);

