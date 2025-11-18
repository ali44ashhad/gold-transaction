import { Request, Response } from 'express';
import { User } from '../models/User';
import { UserRole } from '../models/UserRole';
import dotenv from 'dotenv';
dotenv.config();

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const update: Record<string, unknown> = {};
    const {
      firstName,
      lastName,
      phone,
      billingAddress,
      shippingAddress,
    } = req.body;

    if (firstName !== undefined) update.firstName = firstName;
    if (lastName !== undefined) update.lastName = lastName;
    if (phone !== undefined) update.phone = phone;
    if (billingAddress) update.billingAddress = billingAddress;
    if (shippingAddress) update.shippingAddress = shippingAddress;

    const user = await User.findByIdAndUpdate(
      req.user!.userId,
      update,
      { new: true }
    ).select('-password');

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
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
};

export const getAllUsers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await User.find({})
      .select('-password')
      .lean();

    // Convert _id to id for consistency
    const formattedUsers = users.map(user => ({
      ...user,
      id: String(user._id),
      _id: String(user._id),
    }));

    res.json({ users: formattedUsers });
  } catch (error: any) {
    console.error('Get all users error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
};

export const updateUserRole = async (req: Request, res: Response): Promise<void> => {
  try {
    const { role } = req.body;
    const normalizedRole = role === 'admin' ? 'admin' : 'user';

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role: normalizedRole },
      { new: true }
    ).select('-password');

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
      },
    });
  } catch (error: any) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
};

export const createAdminUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const secretFromHeader = req.headers['x-admin-secret'];
    const adminSecret = typeof secretFromHeader === 'string'
      ? secretFromHeader
      : Array.isArray(secretFromHeader)
        ? secretFromHeader[0]
        : req.body?.adminSecret;

    const configuredSecret = process.env.ADMIN_CREATION_SECRET;

    if (!configuredSecret) {
      res.status(500).json({ error: 'Admin creation secret not configured' });
      return;
    }

    if (adminSecret !== configuredSecret) {
      res.status(403).json({ error: 'Invalid admin creation secret' });
      return;
    }

    const {
      email,
      password,
      firstName,
      lastName,
      phone,
      billingAddress,
      shippingAddress,
    } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ error: 'User already exists' });
      return;
    }

    const user = await User.create({
      email,
      password,
      firstName,
      lastName,
      phone,
      billingAddress,
      shippingAddress,
      role: 'admin',
    });

    try {
      await UserRole.findOneAndUpdate(
        { userId: user._id },
        { role: 'admin' },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (roleError: any) {
      console.warn('Failed to upsert UserRole entry for admin:', roleError.message);
    }

    res.status(201).json({
      message: 'Admin user created successfully',
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
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('Create admin user error:', error);
    if (error.code === 11000) {
      res.status(400).json({ error: 'User already exists' });
      return;
    }
    res.status(500).json({ error: error.message || 'Server error' });
  }
};

