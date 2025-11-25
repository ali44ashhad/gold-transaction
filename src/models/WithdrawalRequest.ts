import mongoose, { Document, Schema } from 'mongoose';
import type { MetalType, UnitType } from './Subscription';

const withdrawalStatuses = [
  'pending',
  'in_review',
  'approved',
  'processing',
  'rejected',
  'completed',
] as const;

// const fulfillmentMethods = [
//   'physical_delivery',
//   'vault_pickup',
//   'cash_out',
// ] as const;

export type WithdrawalRequestStatus = (typeof withdrawalStatuses)[number];
// export type WithdrawalFulfillmentMethod = (typeof fulfillmentMethods)[number];

export interface IWithdrawalRequest extends Document {
  userId: mongoose.Types.ObjectId;
  subscriptionId?: mongoose.Types.ObjectId;
  metal: MetalType;
  requestedWeight: number;
  requestedUnit: UnitType;
  estimatedValue?: number;
  status: WithdrawalRequestStatus;
//   fulfillmentMethod: WithdrawalFulfillmentMethod;
//   payoutCurrency?: string;
//   payoutReference?: string;
  notes?: string;
  processedBy?: mongoose.Types.ObjectId;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WithdrawalRequestSchema = new Schema<IWithdrawalRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription',
      index: true,
    },
    metal: {
      type: String,
      enum: ['gold', 'silver'],
      required: true,
    },
    requestedWeight: {
      type: Number,
      required: true,
      min: 0,
    },
    requestedUnit: {
      type: String,
      enum: ['oz', 'g'],
      required: true,
    },
    estimatedValue: {
      type: Number,
      min: 0,
    },
    status: {
      type: String,
      enum: withdrawalStatuses,
      default: 'pending',
      index: true,
    },
    // fulfillmentMethod: {
    //   type: String,
    //   enum: fulfillmentMethods,
    //   default: 'physical_delivery',
    // },
    // payoutCurrency: {
    //   type: String,
    //   default: 'inr',
    // },
    // payoutReference: {
    //   type: String,
    //   trim: true,
    // },
    notes: {
      type: String,
    },
    processedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    processedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

WithdrawalRequestSchema.index({ subscriptionId: 1, status: 1 });
WithdrawalRequestSchema.index({ createdAt: -1 });

export const WithdrawalRequest = mongoose.model<IWithdrawalRequest>(
  'WithdrawalRequest',
  WithdrawalRequestSchema
);


