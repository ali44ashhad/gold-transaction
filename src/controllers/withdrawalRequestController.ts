import { Request, Response } from 'express';
import { WithdrawalRequest } from '../models/WithdrawalRequest';
import { Subscription } from '../models/Subscription';
import { processWithdrawalApproval } from '../services/withdrawalService';

const isAdmin = (req: Request): boolean => req.user?.role === 'admin';

const canAccessRequest = (req: Request, ownerId: string): boolean => {
  if (isAdmin(req)) return true;
  return ownerId === req.user?.userId;
};

const OZ_IN_GRAMS = 31.1034768;

const convertWeight = (weight: number, fromUnit: string, toUnit: string): number => {
  if (fromUnit === toUnit) return weight;
  if (fromUnit === 'oz' && toUnit === 'g') {
    return weight * OZ_IN_GRAMS;
  }
  if (fromUnit === 'g' && toUnit === 'oz') {
    return weight / OZ_IN_GRAMS;
  }
  return weight;
};

export const createWithdrawalRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const {
      subscriptionId,
      metal,
      requestedWeight,
      requestedUnit,
      estimatedValue,
      notes,
    } = req.body;

    // Validate subscription exists and user owns it
    if (subscriptionId) {
      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        res.status(404).json({ error: 'Subscription not found' });
        return;
      }

      // Check ownership
      if (subscription.userId.toString() !== userId) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Ensure subscription is active or trialing
      if (!['active', 'trialing'].includes(subscription.status)) {
        res.status(400).json({ error: 'Withdrawal can only be requested for active or trialing subscriptions' });
        return;
      }

      // Check for existing active withdrawal requests
      const activeStatuses = ['pending', 'in_review', 'approved', 'processing'];
      const existingRequest = await WithdrawalRequest.findOne({
        subscriptionId,
        status: { $in: activeStatuses },
      });

      if (existingRequest) {
        res.status(400).json({ error: 'An active withdrawal request already exists for this subscription' });
        return;
      }

      // Validate requested weight equals accumulated weight (converted to same unit)
      const requestedWeightInSubscriptionUnit = convertWeight(
        requestedWeight,
        requestedUnit,
        subscription.targetUnit
      );

      const tolerance = 0.0001; // Small tolerance for floating point comparison
      if (Math.abs(requestedWeightInSubscriptionUnit - subscription.accumulatedWeight) > tolerance) {
        res.status(400).json({
          error: `Requested weight must equal accumulated weight. Expected: ${subscription.accumulatedWeight}${subscription.targetUnit}`,
        });
        return;
      }
    }

    const request = await WithdrawalRequest.create({
      userId,
      subscriptionId,
      metal,
      requestedWeight,
      requestedUnit,
      estimatedValue,
      notes,
    });

    res.status(201).json({ request });
  } catch (error: any) {
    console.error('Create withdrawal request error:', error);
    res.status(500).json({ error: error.message || 'Failed to submit withdrawal request' });
  }
};

export const getWithdrawalRequests = async (req: Request, res: Response): Promise<void> => {
  try {
    const query: Record<string, unknown> = {};

    if (!isAdmin(req)) {
      query.userId = req.user!.userId;
    } else if (req.query.userId) {
      query.userId = req.query.userId;
    }

    if (req.query.status) {
      query.status = req.query.status;
    }

    if (req.query.subscriptionId) {
      query.subscriptionId = req.query.subscriptionId;
    }

    if (req.query.metal) {
      query.metal = req.query.metal;
    }

    const requests = await WithdrawalRequest.find(query).sort({ createdAt: -1 });
    res.json({ requests });
  } catch (error: any) {
    console.error('List withdrawal requests error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
  }
};

export const getWithdrawalRequestById = async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await WithdrawalRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Withdrawal request not found' });
      return;
    }

    if (!canAccessRequest(req, request.userId.toString())) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ request });
  } catch (error: any) {
    console.error('Get withdrawal request error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawal request' });
  }
};

export const updateWithdrawalRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await WithdrawalRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Withdrawal request not found' });
      return;
    }

    const isOwner = request.userId.toString() === req.user?.userId;
    if (!isOwner && !isAdmin(req)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const userUpdatableFields = ['requestedWeight', 'requestedUnit', 'estimatedValue', 'notes'] as const;
    const adminOnlyFields = ['status'] as const;

    userUpdatableFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        (request as any)[field] = req.body[field];
      }
    });

    const previousStatus = request.status;
    let statusChanged = false;

    if (isAdmin(req)) {
      // Check if status is changing BEFORE updating the request object
      if (req.body.status && req.body.status !== previousStatus) {
        statusChanged = true;
      }

      adminOnlyFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          (request as any)[field] = req.body[field];
        }
      });

      // Set processedBy and processedAt when status changes
      if (statusChanged) {
        request.processedBy = req.user!.userId as any;
        request.processedAt = new Date();
      }
    }

    console.log('[DEBUG] Saving withdrawal request', {
      requestId: request._id,
      previousStatus,
      newStatus: req.body.status,
      statusChanged,
      isAdmin: isAdmin(req),
    });

    await request.save();

    console.log('[DEBUG] Withdrawal request saved', {
      requestId: request._id,
      currentStatus: request.status,
    });

    // Process withdrawal approval when admin changes status to "approved"
    if (isAdmin(req) && statusChanged && req.body.status === 'approved' && previousStatus !== 'approved') {
      console.log('[DEBUG] Status changed to approved - calling processWithdrawalApproval', {
        requestId: request._id,
        previousStatus,
        newStatus: req.body.status,
        adminUserId: req.user!.userId,
      });

      try {
        const result = await processWithdrawalApproval(request._id.toString(), req.user!.userId);
        console.log('[DEBUG] processWithdrawalApproval result', {
          requestId: request._id,
          success: result.success,
          error: result.error,
        });

        if (!result.success) {
          console.error('[DEBUG] Failed to process withdrawal approval', {
            withdrawalRequestId: request._id,
            error: result.error,
          });
          // Don't fail the request update, but log the error
          // The admin can retry by updating the status again
        } else {
          console.log('[DEBUG] Withdrawal approval processed successfully', {
            requestId: request._id,
          });
        }
      } catch (processingError: any) {
        console.error('[DEBUG] Exception while processing withdrawal approval', {
          withdrawalRequestId: request._id,
          error: processingError.message,
          stack: processingError.stack,
        });
        // Don't fail the request update if processing fails
      }
    } else {
      console.log('[DEBUG] Skipping withdrawal processing', {
        isAdmin: isAdmin(req),
        statusChanged,
        newStatus: req.body.status,
        previousStatus,
        shouldProcess: isAdmin(req) && statusChanged && req.body.status === 'approved' && previousStatus !== 'approved',
      });
    }

    res.json({ request });
  } catch (error: any) {
    console.error('Update withdrawal request error:', error);
    res.status(500).json({ error: error.message || 'Failed to update withdrawal request' });
  }
};

export const deleteWithdrawalRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await WithdrawalRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Withdrawal request not found' });
      return;
    }

    await request.deleteOne();
    res.json({ message: 'Withdrawal request deleted' });
  } catch (error: any) {
    console.error('Delete withdrawal request error:', error);
    res.status(500).json({ error: 'Failed to delete withdrawal request' });
  }
};



