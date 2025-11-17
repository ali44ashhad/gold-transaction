import { body } from 'express-validator';

export const addressValidators = (prefix: string) => [
  body(`${prefix}.street`).optional().isString(),
  body(`${prefix}.city`).optional().isString(),
  body(`${prefix}.state`).optional().isString(),
  body(`${prefix}.zip`).optional().isString(),
];

export const validateUpdateProfile = [
  body('firstName').optional().isString(),
  body('lastName').optional().isString(),
  body('phone').optional().isString(),
  ...addressValidators('billingAddress'),
  ...addressValidators('shippingAddress'),
];

export const validateUpdateRole = [
  body('role')
    .optional({ values: 'falsy' })
    .isIn(['admin', 'user', '', null])
    .withMessage('Role must be admin or user'),
];

