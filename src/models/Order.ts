import mongoose, { Document, Schema } from 'mongoose';

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'cancelled' | 'refunded';
  stripeSessionId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },  
  currency: { type: String, default: 'inr' },
  status: { type: String, enum: ['pending','paid','cancelled','refunded'], default: 'pending' },
  stripeSessionId: { type: String },
  metadata: { type: Schema.Types.Mixed },
}, { timestamps: true });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);
