import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Subscription } from '../models/Subscription';
import { Order } from '../models/Order';
import { User } from '../models/User';
import { MetalPrice } from '../models/MetalPrice';

const GRAMS_PER_OUNCE = 31.1035;

// Helper function to convert weight to a standard unit
const convertToStandardUnit = (weight: number, fromUnit: string, toUnit: string): number => {
  if (fromUnit === toUnit) return weight;
  if (fromUnit === 'oz' && toUnit === 'g') return weight * GRAMS_PER_OUNCE;
  if (fromUnit === 'g' && toUnit === 'oz') return weight / GRAMS_PER_OUNCE;
  return weight;
};

// Helper function to get base unit for metal (gold = grams, silver = ounces)
const getBaseUnitForMetal = (metal: 'gold' | 'silver'): 'g' | 'oz' => {
  return metal === 'silver' ? 'oz' : 'g';
};

// Helper function to get current metal price per trade unit
const getMetalPricePerTradeUnit = async (metal: 'gold' | 'silver'): Promise<number> => {
  try {
    const record = await MetalPrice.findOne({ metalSymbol: metal }).lean();
    if (!record?.price || record.price <= 0) {
      console.warn(`[Dashboard] Could not determine price for metal=${metal}`);
      return 0;
    }
    // MetalPrice stores prices in base units (gold per gram, silver per ounce)
    // which matches trade units, so we can return directly
    return record.price;
  } catch (error) {
    console.error(`[Dashboard] Error fetching metal price for ${metal}:`, error);
    return 0;
  }
};

export const getDashboardStats = async (req: Request, res: Response): Promise<void> => {
  try {
    // Only admins can access dashboard stats
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Access denied. Admin only.' });
      return;
    }

    // Get current month start and end dates
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // 1. Total invested amount: sum of all successful subscription orders (actual money paid)
    const totalInvestedResult = await Order.aggregate([
      {
        $match: {
          orderType: 'subscription',
          paymentStatus: 'succeeded',
        },
      },
      {
        $group: {
          _id: null,
          totalInvested: { $sum: '$amount' },
        },
      },
    ]);

    const totalInvested = totalInvestedResult[0]?.totalInvested || 0;

    // 2. Monthly invested: sum of successful subscription orders in current month
    const monthlyInvestedResult = await Order.aggregate([
      {
        $match: {
          orderType: 'subscription',
          paymentStatus: 'succeeded',
          createdAt: {
            $gte: currentMonthStart,
            $lte: currentMonthEnd,
          },
        },
      },
      {
        $group: {
          _id: null,
          monthlyInvested: { $sum: '$amount' },
        },
      },
    ]);

    const monthlyInvested = monthlyInvestedResult[0]?.monthlyInvested || 0;

    // 3. Number of users (excluding admins)
    const userCount = await User.countDocuments({ role: 'user' });

    res.json({
      totalInvested,
      monthlyInvested,
      userCount,
    });
  } catch (error: any) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
};

export const getUserDashboardStats = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = new mongoose.Types.ObjectId(req.user.userId);

    // Define cancelled statuses
    const cancelledStatuses = ['canceled', 'incomplete_expired'];

    // 1. Total invested: sum of all successful subscription orders for this user
    const totalInvestedResult = await Order.aggregate([
      {
        $match: {
          user: userId,
          orderType: 'subscription',
          paymentStatus: 'succeeded',
        },
      },
      {
        $group: {
          _id: null,
          totalInvested: { $sum: '$amount' },
        },
      },
    ]);

    const totalInvested = totalInvestedResult[0]?.totalInvested || 0;

    // 2. Current Investment: sum of current market values (accumulatedWeight * currentMetalPrice) for active subscriptions
    // Fetch current metal prices
    const goldPricePerGram = await getMetalPricePerTradeUnit('gold');
    const silverPricePerOz = await getMetalPricePerTradeUnit('silver');

    // Get all active subscriptions with their accumulated weight
    const activeSubscriptions = await Subscription.find({
      userId: userId,
      status: { $nin: cancelledStatuses },
    }).select('metal accumulatedWeight targetUnit');

    let currentInvestment = 0;
    activeSubscriptions.forEach((sub) => {
      const tradeUnit = getBaseUnitForMetal(sub.metal);
      const normalizedWeight = convertToStandardUnit(
        sub.accumulatedWeight || 0,
        sub.targetUnit || tradeUnit,
        tradeUnit
      );
      
      const pricePerUnit = sub.metal === 'gold' ? goldPricePerGram : silverPricePerOz;
      const currentValue = normalizedWeight * pricePerUnit;
      currentInvestment += currentValue;
    });

    // 3. Accumulated Gold: sum of accumulatedWeight for gold subscriptions that are active
    const goldSubscriptions = await Subscription.find({
      userId: userId,
      metal: 'gold',
      status: { $nin: cancelledStatuses },
    }).select('accumulatedWeight targetUnit');

    let accumulatedGold = 0;
    goldSubscriptions.forEach((sub) => {
      // Convert all gold weights to grams for consistency
      const weightInGrams = convertToStandardUnit(
        sub.accumulatedWeight || 0,
        sub.targetUnit || 'g',
        'g'
      );
      accumulatedGold += weightInGrams;
    });

    // 4. Accumulated Silver: sum of accumulatedWeight for silver subscriptions that are active
    const silverSubscriptions = await Subscription.find({
      userId: userId,
      metal: 'silver',
      status: { $nin: cancelledStatuses },
    }).select('accumulatedWeight targetUnit');

    let accumulatedSilver = 0;
    silverSubscriptions.forEach((sub) => {
      // Convert all silver weights to ounces for consistency
      const weightInOz = convertToStandardUnit(
        sub.accumulatedWeight || 0,
        sub.targetUnit || 'oz',
        'oz'
      );
      accumulatedSilver += weightInOz;
    });

    // 5. Get withdrawn gold and silver from user record
    const user = await User.findById(userId).select('withdrawnGold withdrawnSilver');
    const withdrawnGold = user?.withdrawnGold || 0;
    const withdrawnSilver = user?.withdrawnSilver || 0;

    res.json({
      totalInvested,
      currentInvestment,
      accumulatedGold,
      accumulatedSilver,
      withdrawnGold,
      withdrawnSilver,
    });
  } catch (error: any) {
    console.error('Get user dashboard stats error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
};
