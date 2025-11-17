import express from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  validateUpdateProfile,
  validateUpdateRole,
} from '../validators/userValidators';
import {
  updateProfile,
  getAllUsers,
  updateUserRole,
} from '../controllers/userController';

const router = express.Router();

// @route   PUT /api/users/me
// @desc    Update current user profile
// @access  Private
router.put('/me', authenticate, validate(validateUpdateProfile), updateProfile);

// @route   GET /api/users
// @desc    Get all users (admin only)
// @access  Private (Admin)
router.get('/', authenticate, authorize('admin'), getAllUsers);

// @route   PATCH /api/users/:id/role
// @desc    Update user role (admin only)
// @access  Private (Admin)
router.patch('/:id/role', authenticate, authorize('admin'), validate(validateUpdateRole), updateUserRole);

export default router;

