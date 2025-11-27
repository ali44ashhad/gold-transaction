import { Request, Response } from 'express';
import { WithdrawalRequest } from '../models/WithdrawalRequest';

const isAdmin = (req: Request): boolean => req.user?.role === 'admin';

const canAccessRequest = (req: Request, ownerId: string): boolean => {
  if (isAdmin(req)) return true;
  return ownerId === req.user?.userId;
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

    if (isAdmin(req)) {
      adminOnlyFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          (request as any)[field] = req.body[field];
        }
      });

      if (req.body.status && req.body.status !== request.status) {
        request.processedBy = req.user!.userId as any;
        request.processedAt = new Date();
      }
    }

    await request.save();
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



