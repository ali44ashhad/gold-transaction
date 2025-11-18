import { Router } from 'express';
import { getMetalPrices, syncMetalPrices } from '../controllers/metalPriceController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

router.get('/', getMetalPrices);
router.post('/sync',
     authenticate, authorize('admin'),
      syncMetalPrices);

export default router;


