import express from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { getDashboardStats, getUserDashboardStats } from '../controllers/dashboardController';

const router = express.Router();

// @route   GET /api/dashboard/stats
// @desc    Get dashboard statistics (admin only)
// @access  Private (Admin)
router.get('/stats', authenticate, authorize('admin'), getDashboardStats);

// @route   GET /api/dashboard/user-stats
// @desc    Get user dashboard statistics
// @access  Private
router.get('/user-stats', authenticate, getUserDashboardStats);

export default router;
