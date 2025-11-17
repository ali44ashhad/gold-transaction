import { body } from 'express-validator';

export const validateSignup = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('billingAddress.street').trim().notEmpty().withMessage('Billing street is required'),
  body('billingAddress.city').trim().notEmpty().withMessage('Billing city is required'),
  body('billingAddress.state').trim().notEmpty().withMessage('Billing state is required'),
  body('billingAddress.zip').trim().notEmpty().withMessage('Billing zip is required'),
  body('shippingAddress.street').trim().notEmpty().withMessage('Shipping street is required'),
  body('shippingAddress.city').trim().notEmpty().withMessage('Shipping city is required'),
  body('shippingAddress.state').trim().notEmpty().withMessage('Shipping state is required'),
  body('shippingAddress.zip').trim().notEmpty().withMessage('Shipping zip is required'),
];

export const validateLogin = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

export const validateForgotPassword = [
  body('email').isEmail().normalizeEmail(),
];

export const validateResetPassword = [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

