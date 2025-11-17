import mongoose, { Document, Schema } from 'mongoose';

export interface IUserRole extends Document {
  userId: mongoose.Types.ObjectId;
  role: 'admin' | 'user';
  stripeCustomerId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserRoleSchema = new Schema<IUserRole>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user',
    required: true,
  },
  stripeCustomerId: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
});

// Index for userId
UserRoleSchema.index({ userId: 1 });

// Index for stripeCustomerId
UserRoleSchema.index({ stripeCustomerId: 1 });

export const UserRole = mongoose.model<IUserRole>('UserRole', UserRoleSchema);

