import express from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  validateSignup,
  validateLogin,
  validateForgotPassword,
  validateResetPassword,
} from '../validators/authValidators';
import {
  signup,
  login,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
} from '../controllers/authController';

const router = express.Router();

// @route   POST /api/auth/signup
// @desc    Register a new user
// @access  Public
router.post('/signup', validate(validateSignup), signup);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', validate(validateLogin), login);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', authenticate, logout);

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', authenticate, getCurrentUser);

// @route   POST /api/auth/forgot-password
// @desc    Send password reset email
// @access  Public
router.post('/forgot-password', validate(validateForgotPassword), forgotPassword);

// @route   POST /api/auth/reset-password
// @desc    Reset password with token
// @access  Public
router.post('/reset-password', validate(validateResetPassword), resetPassword);

export default router;

