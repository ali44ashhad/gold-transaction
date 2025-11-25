import { Request, Response } from 'express';
import { CancellationRequest } from '../models/CancellationRequest';

const isAdmin = (req: Request): boolean => req.user?.role === 'admin';

const canAccessRequest = (req: Request, ownerId: string): boolean => {
  if (isAdmin(req)) return true;
  return ownerId === req.user?.userId;
};

export const createCancellationRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const {
      subscriptionId,
      reason,
      details,
      preferredCancellationDate,
    } = req.body;

    const request = await CancellationRequest.create({
      userId,
      subscriptionId,
      reason,
      details,
      preferredCancellationDate,
    });

    res.status(201).json({ request });
  } catch (error: any) {
    console.error('Create cancellation request error:', error);
    res.status(500).json({ error: error.message || 'Failed to submit cancellation request' });
  }
};

export const getCancellationRequests = async (req: Request, res: Response): Promise<void> => {
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

    const requests = await CancellationRequest.find(query).sort({ createdAt: -1 });
    res.json({ requests });
  } catch (error: any) {
    console.error('List cancellation requests error:', error);
    res.status(500).json({ error: 'Failed to fetch cancellation requests' });
  }
};

export const getCancellationRequestById = async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await CancellationRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Cancellation request not found' });
      return;
    }

    if (!canAccessRequest(req, request.userId.toString())) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json({ request });
  } catch (error: any) {
    console.error('Get cancellation request error:', error);
    res.status(500).json({ error: 'Failed to fetch cancellation request' });
  }
};

export const updateCancellationRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await CancellationRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Cancellation request not found' });
      return;
    }

    const isOwner = request.userId.toString() === req.user?.userId;
    if (!isOwner && !isAdmin(req)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const userUpdatableFields = ['reason', 'details', 'preferredCancellationDate'] as const;
    const adminOnlyFields = ['status', 'resolutionNotes'] as const;

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
    } else if (!isAdmin(req) && !isOwner) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await request.save();
    res.json({ request });
  } catch (error: any) {
    console.error('Update cancellation request error:', error);
    res.status(500).json({ error: error.message || 'Failed to update cancellation request' });
  }
};

export const deleteCancellationRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const request = await CancellationRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Cancellation request not found' });
      return;
    }

    await request.deleteOne();
    res.json({ message: 'Cancellation request deleted' });
  } catch (error: any) {
    console.error('Delete cancellation request error:', error);
    res.status(500).json({ error: 'Failed to delete cancellation request' });
  }
};


