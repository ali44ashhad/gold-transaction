import { Request, Response } from 'express';
import { CancellationRequest } from '../models/CancellationRequest';
import { Subscription } from '../models/Subscription';
import { stripe } from '../stripe';

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
    console.log('[DEBUG] Update cancellation request called', {
      requestId: req.params.id,
      body: req.body,
      userRole: req.user?.role,
      userId: req.user?.userId,
    });

    const request = await CancellationRequest.findById(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Cancellation request not found' });
      return;
    }

    console.log('[DEBUG] Cancellation request found', {
      requestId: request._id,
      currentStatus: request.status,
      subscriptionId: request.subscriptionId,
      userId: request.userId,
    });

    const isOwner = request.userId.toString() === req.user?.userId;
    const isAdminUser = isAdmin(req);
    
    console.log('[DEBUG] Access check', {
      isOwner,
      isAdminUser,
      requestUserId: request.userId.toString(),
      currentUserId: req.user?.userId,
    });

    if (!isOwner && !isAdminUser) {
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

    if (isAdminUser) {
      console.log('[DEBUG] Admin user detected, processing admin fields');
      
      // Save the original status BEFORE updating fields
      const originalStatus = request.status;
      const newStatus = req.body.status;
      const statusChanged = newStatus && newStatus !== originalStatus;
      const isChangingToApproved = statusChanged && newStatus === 'approved';
      
      console.log('[DEBUG] Status change check', {
        newStatus,
        originalStatus,
        statusChanged,
        isChangingToApproved,
        subscriptionId: request.subscriptionId,
        hasSubscriptionId: !!request.subscriptionId,
      });

      // Now update the admin fields
      adminOnlyFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          (request as any)[field] = req.body[field];
        }
      });

      if (statusChanged) {
        request.processedBy = req.user!.userId as any;
        request.processedAt = new Date();

        // If status is being changed to "approved", cancel the subscription
        console.log('[DEBUG] Checking if should cancel subscription', {
          isChangingToApproved,
          hasSubscriptionId: !!request.subscriptionId,
          subscriptionId: request.subscriptionId,
        });

        if (isChangingToApproved && request.subscriptionId) {
          console.log('[DEBUG] Starting subscription cancellation process', {
            subscriptionId: request.subscriptionId,
          });
          try {
            // Find the subscription
            const subscription = await Subscription.findById(request.subscriptionId);
            
            if (!subscription) {
              console.warn(`[DEBUG] Subscription not found for cancellation request ${request._id}`, {
                subscriptionId: request.subscriptionId,
              });
            } else {
              console.log('[DEBUG] Subscription found', {
                subscriptionId: subscription._id,
                stripeSubscriptionId: subscription.stripeSubscriptionId,
                currentStatus: subscription.status,
                hasStripeSubscriptionId: !!subscription.stripeSubscriptionId,
              });

              // Cancel on Stripe if stripeSubscriptionId exists
              if (subscription.stripeSubscriptionId) {
                console.log('[DEBUG] Calling Stripe API to cancel subscription', {
                  stripeSubscriptionId: subscription.stripeSubscriptionId,
                });
                try {
                  // Cancel the subscription on Stripe
                  await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
                  
                  // Verify the cancellation by retrieving the subscription
                  const verifiedStripeSubscription = await stripe.subscriptions.retrieve(
                    subscription.stripeSubscriptionId
                  );
                  
                  const isVerifiedCanceled = verifiedStripeSubscription.status === 'canceled' || 
                                            verifiedStripeSubscription.cancel_at_period_end === true;
                  
                  console.info('Stripe subscription cancelled and verified', {
                    stripeSubscriptionId: subscription.stripeSubscriptionId,
                    subscriptionId: subscription._id,
                    cancellationRequestId: request._id,
                    stripeStatus: verifiedStripeSubscription.status,
                    cancelAtPeriodEnd: verifiedStripeSubscription.cancel_at_period_end,
                    canceledAt: verifiedStripeSubscription.canceled_at 
                      ? new Date(verifiedStripeSubscription.canceled_at * 1000).toISOString() 
                      : null,
                    verified: isVerifiedCanceled,
                  });
                  
                  if (!isVerifiedCanceled) {
                    console.warn('Stripe subscription cancellation may not be complete', {
                      stripeSubscriptionId: subscription.stripeSubscriptionId,
                      currentStatus: verifiedStripeSubscription.status,
                      cancelAtPeriodEnd: verifiedStripeSubscription.cancel_at_period_end,
                    });
                  }
                } catch (stripeError: any) {
                  console.error('Error cancelling Stripe subscription', {
                    stripeSubscriptionId: subscription.stripeSubscriptionId,
                    error: stripeError.message,
                    errorCode: stripeError.code,
                    errorType: stripeError.type,
                    cancellationRequestId: request._id,
                  });
                  // Continue with database update even if Stripe cancellation fails
                  // The subscription will be marked as canceled in the database
                }
              } else {
                console.log('[DEBUG] Subscription found but no stripeSubscriptionId', {
                  subscriptionId: subscription._id,
                  stripeSubscriptionId: subscription.stripeSubscriptionId,
                });
              }

              // Update subscription status in database
              subscription.status = 'canceled';
              await subscription.save();
              console.info('Subscription status updated to canceled', {
                subscriptionId: subscription._id,
                cancellationRequestId: request._id,
              });
            }
          } catch (subscriptionError: any) {
            console.error('[DEBUG] Error processing subscription cancellation', {
              subscriptionId: request.subscriptionId,
              error: subscriptionError.message,
              stack: subscriptionError.stack,
              cancellationRequestId: request._id,
            });
            // Don't fail the cancellation request update if subscription cancellation fails
            // Log the error but continue with saving the cancellation request
          }
        } else {
          console.log('[DEBUG] Skipping subscription cancellation', {
            isChangingToApproved,
            hasSubscriptionId: !!request.subscriptionId,
            reason: !isChangingToApproved ? 'Status is not changing to approved' : 'No subscriptionId',
          });
        }
      } else {
        console.log('[DEBUG] Status not changed, skipping cancellation logic', {
          newStatus: req.body.status,
          currentStatus: request.status,
        });
      }
    } else {
      console.log('[DEBUG] Not an admin user, skipping admin-only logic');
    }

    console.log('[DEBUG] Saving cancellation request', {
      requestId: request._id,
      newStatus: request.status,
    });
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




