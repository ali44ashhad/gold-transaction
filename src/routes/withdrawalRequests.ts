import express from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  createWithdrawalRequest,
  deleteWithdrawalRequest,
  getWithdrawalRequestById,
  getWithdrawalRequests,
  updateWithdrawalRequest,
} from '../controllers/withdrawalRequestController';
import {
  createWithdrawalRequestValidator,
  listWithdrawalRequestValidator,
  updateWithdrawalRequestValidator,
  withdrawalRequestIdParamValidator,
} from '../validators/withdrawalRequestValidators';

const router = express.Router();

router.get(
  '/',
  authenticate,
  validate(listWithdrawalRequestValidator),
  getWithdrawalRequests
);

router.post(
  '/',
  authenticate,
  validate(createWithdrawalRequestValidator),
  createWithdrawalRequest
);

router.get(
  '/:id',
  authenticate,
  validate(withdrawalRequestIdParamValidator),
  getWithdrawalRequestById
);

router.patch(
  '/:id',
  authenticate,
  validate([...withdrawalRequestIdParamValidator, ...updateWithdrawalRequestValidator]),
  updateWithdrawalRequest
);

router.delete(
  '/:id',
  authenticate,
  authorize('admin'),
  validate(withdrawalRequestIdParamValidator),
  deleteWithdrawalRequest
);

export default router;



