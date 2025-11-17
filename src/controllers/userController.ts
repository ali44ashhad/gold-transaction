import { Request, Response } from 'express';
import { User } from '../models/User';

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

