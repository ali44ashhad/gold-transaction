import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

export interface IUser extends Document {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  billingAddress: IAddress;
  shippingAddress: IAddress;
  role: 'admin' | 'user';
  emailVerified: boolean;
  resetPasswordToken?: string;
  resetPasswordExpire?: Date;
  withdrawnGold?: number;
  withdrawnSilver?: number;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const AddressSchema = new Schema<IAddress>({
  street: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  zip: { type: String, required: true },
}, { _id: false });

const UserSchema = new Schema<IUser>({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false, // Don't include password in queries by default
  },
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  billingAddress: {
    type: AddressSchema,
    required: true,
  },
  shippingAddress: {
    type: AddressSchema,
    required: true,
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user',
  },
  emailVerified: {
    type: Boolean,
    default: false,
  },
  resetPasswordToken: {
    type: String,
    select: false,
  },
  resetPasswordExpire: {
    type: Date,
    select: false,
  },
  withdrawnGold: {
    type: Number,
    default: 0,
  },
  withdrawnSilver: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Method to compare password
UserSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Index for email
UserSchema.index({ email: 1 });

export const User = mongoose.model<IUser>('User', UserSchema);

