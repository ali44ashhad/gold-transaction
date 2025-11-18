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
  createAdminUser,
} from '../controllers/userController';
// import { validateSignup } from '../validators/authValidators';

const router = express.Router();

// @route   PUT /api/users/me
// @desc    Update current user profile
// @access  Private
router.put('/me', authenticate, validate(validateUpdateProfile), updateProfile);

// @route   POST /api/users/admin
// @desc    Create an admin user using a shared secret (bootstrap)
// @access  Protected via ADMIN_CREATION_SECRET
router.post('/admin', createAdminUser);

// @route   GET /api/users
// @desc    Get all users (admin only)
// @access  Private (Admin)
router.get('/', authenticate, authorize('admin'), getAllUsers);

// @route   PATCH /api/users/:id/role
// @desc    Update user role (admin only)
// @access  Private (Admin)
router.patch('/:id/role', authenticate, authorize('admin'), validate(validateUpdateRole), updateUserRole);

export default router;

