import { Request, Response } from 'express';
import crypto from 'crypto';
import { User } from '../models/User';
import { UserRole } from '../models/UserRole';
import { generateToken } from '../utils/jwt';
import { sendPasswordResetEmail } from '../utils/email';

export const signup = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      phone,
      billingAddress,
      shippingAddress,
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ error: 'User already registered' });
      return;
    }

    // Create user
    const user = await User.create({
      email,
      password,
      firstName,
      lastName,
      phone,
      billingAddress,
      shippingAddress,
    });

    // Create user role entry (for Stripe customer ID storage later)
    try {
      await UserRole.create({
        userId: user._id,
        role: user.role,
      });
    } catch (roleError: any) {
      // If UserRole creation fails, log but don't fail signup
      console.warn('Failed to create UserRole entry:', roleError.message);
    }

    // Generate JWT token
    const token = generateToken({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: String(user._id),
        _id: String(user._id),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        billingAddress: user.billingAddress,
        shippingAddress: user.shippingAddress,
        role: user.role,
        emailVerified: user.emailVerified,
        withdrawnGold: user.withdrawnGold ?? 0,
        withdrawnSilver: user.withdrawnSilver ?? 0,
      },
    });
  } catch (error: any) {
    console.error('Signup error:', error);
    
    // Handle duplicate key errors (MongoDB)
    if (error.code === 11000) {
      res.status(400).json({ error: 'User already registered' });
      return;
    }
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const firstError = Object.values(error.errors)[0] as any;
      res.status(400).json({ error: firstError?.message || 'Validation error' });
      return;
    }
    
    res.status(500).json({ error: error.message || 'Server error during signup' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Find user and include password
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Generate JWT token
    const token = generateToken({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
      message: 'Login successful',
      user: {
        id: String(user._id),
        _id: String(user._id),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        billingAddress: user.billingAddress,
        shippingAddress: user.shippingAddress,
        role: user.role,
        emailVerified: user.emailVerified,
        withdrawnGold: user.withdrawnGold ?? 0,
        withdrawnSilver: user.withdrawnSilver ?? 0,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message || 'Server error during login' });
  }
};

export const logout = async (_req: Request, res: Response): Promise<void> => {
  res.cookie('token', '', {
    httpOnly: true,
    expires: new Date(0),
  });
  res.json({ message: 'Logout successful' });
};

export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!.userId).select('-password');
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      user: {
        id: String(user._id),
        _id: String(user._id),
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        billingAddress: user.billingAddress,
        shippingAddress: user.shippingAddress,
        role: user.role,
        emailVerified: user.emailVerified,
        withdrawnGold: user.withdrawnGold ?? 0,
        withdrawnSilver: user.withdrawnSilver ?? 0,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists or not for security
      res.json({ message: 'If that email exists, a password reset link has been sent' });
      return;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpire = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save({ validateBeforeSave: false });

    try {
      await sendPasswordResetEmail(email, resetToken);
      res.json({ message: 'Password reset email sent' });
    } catch (error) {
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });
      throw error;
    }
  } catch (error: any) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, password } = req.body;

    // Hash the token to compare with stored token
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    // Set new password
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    // Generate new token and set cookie
    const jwtToken = generateToken({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    });

    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ message: 'Password reset successful' });
  } catch (error: any) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

