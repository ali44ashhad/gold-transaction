import mongoose, { Document, Schema } from 'mongoose';

const cancellationStatuses = [
  'pending',
  'approved',
  'rejected',
] as const;

export type CancellationRequestStatus = (typeof cancellationStatuses)[number];

export interface ICancellationRequest extends Document {
  userId: mongoose.Types.ObjectId;
  subscriptionId?: mongoose.Types.ObjectId;
  reason?: string;
  details?: string;
  status: CancellationRequestStatus;
  preferredCancellationDate?: Date;
  processedBy?: mongoose.Types.ObjectId;
  processedAt?: Date;
  resolutionNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CancellationRequestSchema = new Schema<ICancellationRequest>(
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
    reason: {
      type: String,
      trim: true,
    },
    details: {
      type: String,
    },
    status: {
      type: String,
      enum: cancellationStatuses,
      default: 'pending',
      index: true,
    },
    preferredCancellationDate: {
      type: Date,
    },
    processedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    processedAt: {
      type: Date,
    },
    resolutionNotes: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

CancellationRequestSchema.index({ subscriptionId: 1, status: 1 });
CancellationRequestSchema.index({ createdAt: -1 });

export const CancellationRequest = mongoose.model<ICancellationRequest>(
  'CancellationRequest',
  CancellationRequestSchema
);


