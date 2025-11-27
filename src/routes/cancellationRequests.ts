import express from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validation';
import {
  createCancellationRequest,
  deleteCancellationRequest,
  getCancellationRequestById,
  getCancellationRequests,
  updateCancellationRequest,
} from '../controllers/cancellationRequestController';
import {
  cancellationRequestIdParamValidator,
  createCancellationRequestValidator,
  listCancellationRequestValidator,
  updateCancellationRequestValidator,
} from '../validators/cancellationRequestValidators';

const router = express.Router();

router.get(
  '/',
  authenticate,
  validate(listCancellationRequestValidator),
  getCancellationRequests
);

router.post(
  '/',
  authenticate,
  validate(createCancellationRequestValidator),
  createCancellationRequest
);

router.get(
  '/:id',
  authenticate,
  validate(cancellationRequestIdParamValidator),
  getCancellationRequestById
);

router.patch(
  '/:id',
  authenticate,
  validate([...cancellationRequestIdParamValidator, ...updateCancellationRequestValidator]),
  updateCancellationRequest
);

router.delete(
  '/:id',
  authenticate,
  authorize('admin'),
  validate(cancellationRequestIdParamValidator),
  deleteCancellationRequest
);

export default router;



