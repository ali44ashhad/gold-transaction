import mongoose from 'mongoose';
import { WithdrawalRequest } from '../models/WithdrawalRequest';
import { Subscription } from '../models/Subscription';
import { User } from '../models/User';
import { stripe } from '../stripe';

const OZ_IN_GRAMS = 31.1034768;

/**
 * Convert weight from one unit to another
 */
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

/**
 * Process withdrawal approval - deducts accumulated weight/value and cancels Stripe subscription for Case 2
 */
export const processWithdrawalApproval = async (
  withdrawalRequestId: string,
  adminUserId: string
): Promise<{ success: boolean; error?: string }> => {
  console.log('[DEBUG] processWithdrawalApproval called', {
    withdrawalRequestId,
    adminUserId,
  });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Fetch withdrawal request
    console.log('[DEBUG] Fetching withdrawal request', { withdrawalRequestId });
    const withdrawalRequest = await WithdrawalRequest.findById(withdrawalRequestId).session(session);
    if (!withdrawalRequest) {
      console.error('[DEBUG] Withdrawal request not found', { withdrawalRequestId });
      await session.abortTransaction();
      return { success: false, error: 'Withdrawal request not found' };
    }

    console.log('[DEBUG] Withdrawal request found', {
      requestId: withdrawalRequest._id,
      status: withdrawalRequest.status,
      subscriptionId: withdrawalRequest.subscriptionId,
      requestedWeight: withdrawalRequest.requestedWeight,
      requestedUnit: withdrawalRequest.requestedUnit,
    });

    // Check if already processed (status is completed/rejected, or subscription already has 0 accumulated weight)
    if (['completed', 'rejected'].includes(withdrawalRequest.status)) {
      console.warn('[DEBUG] Withdrawal request already processed', {
        requestId: withdrawalRequest._id,
        status: withdrawalRequest.status,
      });
      await session.abortTransaction();
      return { success: false, error: 'Withdrawal request has already been processed' };
    }

    // Ensure status is "approved" before processing
    if (withdrawalRequest.status !== 'approved') {
      console.warn('[DEBUG] Withdrawal request status is not "approved"', {
        requestId: withdrawalRequest._id,
        currentStatus: withdrawalRequest.status,
      });
      await session.abortTransaction();
      return { success: false, error: `Cannot process withdrawal: status is "${withdrawalRequest.status}", expected "approved"` };
    }

    // Fetch associated subscription
    if (!withdrawalRequest.subscriptionId) {
      await session.abortTransaction();
      return { success: false, error: 'Withdrawal request is not associated with a subscription' };
    }

    console.log('[DEBUG] Fetching subscription', {
      subscriptionId: withdrawalRequest.subscriptionId,
    });
    const subscription = await Subscription.findById(withdrawalRequest.subscriptionId).session(session);
    if (!subscription) {
      console.error('[DEBUG] Subscription not found', {
        subscriptionId: withdrawalRequest.subscriptionId,
      });
      await session.abortTransaction();
      return { success: false, error: 'Subscription not found' };
    }

    console.log('[DEBUG] Subscription found', {
      subscriptionId: subscription._id,
      accumulatedWeight: subscription.accumulatedWeight,
      accumulatedValue: subscription.accumulatedValue,
      targetWeight: subscription.targetWeight,
      targetUnit: subscription.targetUnit,
      status: subscription.status,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
    });

    // Check if withdrawal has already been processed (subscription accumulated weight is 0)
    if (subscription.accumulatedWeight === 0) {
      console.warn('[DEBUG] Withdrawal already processed - accumulated weight is 0', {
        subscriptionId: subscription._id,
      });
      await session.abortTransaction();
      return { success: false, error: 'Withdrawal has already been processed (subscription accumulated weight is 0)' };
    }

    // Validate subscription has sufficient accumulated weight
    const requestedWeightInSubscriptionUnit = convertWeight(
      withdrawalRequest.requestedWeight,
      withdrawalRequest.requestedUnit,
      subscription.targetUnit
    );

    console.log('[DEBUG] Weight conversion', {
      requestedWeight: withdrawalRequest.requestedWeight,
      requestedUnit: withdrawalRequest.requestedUnit,
      subscriptionUnit: subscription.targetUnit,
      convertedWeight: requestedWeightInSubscriptionUnit,
      availableWeight: subscription.accumulatedWeight,
    });

    if (subscription.accumulatedWeight < requestedWeightInSubscriptionUnit) {
      console.error('[DEBUG] Insufficient accumulated weight', {
        subscriptionId: subscription._id,
        available: subscription.accumulatedWeight,
        requested: requestedWeightInSubscriptionUnit,
      });
      await session.abortTransaction();
      return {
        success: false,
        error: `Insufficient accumulated weight. Available: ${subscription.accumulatedWeight}${subscription.targetUnit}, Requested: ${requestedWeightInSubscriptionUnit}${subscription.targetUnit}`,
      };
    }

    // Determine case type: Case 1 (accumulated < target) vs Case 2 (accumulated >= target)
    const normalizedAccumulated = subscription.accumulatedWeight;
    const normalizedTarget = subscription.targetWeight;
    const isCase2 = normalizedAccumulated >= normalizedTarget;

    console.log('[DEBUG] Determining case type', {
      accumulatedWeight: normalizedAccumulated,
      targetWeight: normalizedTarget,
      isCase2,
    });

    // Deduct accumulated weight and value (set to 0)
    const previousAccumulatedWeight = subscription.accumulatedWeight;
    const previousAccumulatedValue = subscription.accumulatedValue;
    subscription.accumulatedWeight = 0;
    subscription.accumulatedValue = 0;

    console.log('[DEBUG] Deducting accumulated weight/value', {
      subscriptionId: subscription._id,
      previousWeight: previousAccumulatedWeight,
      previousValue: previousAccumulatedValue,
      newWeight: subscription.accumulatedWeight,
      newValue: subscription.accumulatedValue,
    });

    // Case 2: Cancel Stripe subscription and update DB status
    if (isCase2) {
      console.log('[DEBUG] Case 2 detected - will cancel Stripe subscription', {
        subscriptionId: subscription._id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      });

      if (subscription.stripeSubscriptionId) {
        try {
          console.log('[DEBUG] Cancelling Stripe subscription', {
            stripeSubscriptionId: subscription.stripeSubscriptionId,
          });
          // Cancel the subscription on Stripe (immediate cancellation)
          await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);

          // Verify the cancellation
          const verifiedStripeSubscription = await stripe.subscriptions.retrieve(
            subscription.stripeSubscriptionId
          );

          const isVerifiedCanceled =
            verifiedStripeSubscription.status === 'canceled' ||
            verifiedStripeSubscription.cancel_at_period_end === true;

          if (isVerifiedCanceled) {
            subscription.status = 'canceled';
            console.info('[DEBUG] Stripe subscription cancelled and verified', {
              stripeSubscriptionId: subscription.stripeSubscriptionId,
              subscriptionId: subscription._id,
              withdrawalRequestId: withdrawalRequest._id,
              stripeStatus: verifiedStripeSubscription.status,
              cancelAtPeriodEnd: verifiedStripeSubscription.cancel_at_period_end,
            });
          } else {
            console.warn('[DEBUG] Stripe subscription cancellation not verified', {
              stripeSubscriptionId: subscription.stripeSubscriptionId,
              subscriptionId: subscription._id,
            });
            // Still mark as canceled in DB even if verification fails
            subscription.status = 'canceled';
          }
        } catch (stripeError: any) {
          console.error('[DEBUG] Error cancelling Stripe subscription', {
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            subscriptionId: subscription._id,
            error: stripeError.message,
            stack: stripeError.stack,
          });
          // Continue with deduction even if Stripe cancellation fails
          subscription.status = 'canceled';
        }
      } else {
        console.log('[DEBUG] No Stripe subscription ID, marking as canceled in DB only', {
          subscriptionId: subscription._id,
        });
        // No Stripe subscription ID, just mark as canceled in DB
        subscription.status = 'canceled';
      }
    } else {
      console.log('[DEBUG] Case 1 detected - keeping Stripe subscription active', {
        subscriptionId: subscription._id,
        currentStatus: subscription.status,
      });
    }
    // Case 1: Keep Stripe subscription active, keep DB status unchanged

    // Fetch user to update withdrawn metal amounts
    console.log('[DEBUG] Fetching user to update withdrawn amounts', {
      userId: withdrawalRequest.userId,
    });
    const user = await User.findById(withdrawalRequest.userId).session(session);
    if (!user) {
      console.error('[DEBUG] User not found', {
        userId: withdrawalRequest.userId,
      });
      await session.abortTransaction();
      return { success: false, error: 'User not found' };
    }

    // Convert withdrawn weight to standard units:
    // - Gold: convert to grams (g)
    // - Silver: convert to ounces (oz)
    const withdrawnWeightInStandardUnit = withdrawalRequest.metal === 'gold'
      ? convertWeight(withdrawalRequest.requestedWeight, withdrawalRequest.requestedUnit, 'g')
      : convertWeight(withdrawalRequest.requestedWeight, withdrawalRequest.requestedUnit, 'oz');

    console.log('[DEBUG] Converting withdrawn weight to standard unit', {
      metal: withdrawalRequest.metal,
      requestedWeight: withdrawalRequest.requestedWeight,
      requestedUnit: withdrawalRequest.requestedUnit,
      standardUnit: withdrawalRequest.metal === 'gold' ? 'g' : 'oz',
      convertedWeight: withdrawnWeightInStandardUnit,
    });

    // Update user's withdrawn metal amount
    const previousWithdrawnGold = user.withdrawnGold || 0;
    const previousWithdrawnSilver = user.withdrawnSilver || 0;

    if (withdrawalRequest.metal === 'gold') {
      user.withdrawnGold = (user.withdrawnGold || 0) + withdrawnWeightInStandardUnit;
      console.log('[DEBUG] Updating withdrawnGold', {
        userId: user._id,
        previousAmount: previousWithdrawnGold,
        addedAmount: withdrawnWeightInStandardUnit,
        newAmount: user.withdrawnGold,
      });
    } else {
      user.withdrawnSilver = (user.withdrawnSilver || 0) + withdrawnWeightInStandardUnit;
      console.log('[DEBUG] Updating withdrawnSilver', {
        userId: user._id,
        previousAmount: previousWithdrawnSilver,
        addedAmount: withdrawnWeightInStandardUnit,
        newAmount: user.withdrawnSilver,
      });
    }

    // Save subscription changes
    console.log('[DEBUG] Saving subscription changes', {
      subscriptionId: subscription._id,
      newWeight: subscription.accumulatedWeight,
      newValue: subscription.accumulatedValue,
      newStatus: subscription.status,
    });
    await subscription.save({ session });
    console.log('[DEBUG] Subscription saved successfully');

    // Save user changes
    console.log('[DEBUG] Saving user changes', {
      userId: user._id,
      withdrawnGold: user.withdrawnGold,
      withdrawnSilver: user.withdrawnSilver,
    });
    await user.save({ session });
    console.log('[DEBUG] User saved successfully');

    // Commit transaction
    console.log('[DEBUG] Committing transaction');
    await session.commitTransaction();
    console.log('[DEBUG] Transaction committed successfully');

    console.info('[DEBUG] Withdrawal approval processed successfully', {
      withdrawalRequestId: withdrawalRequest._id,
      subscriptionId: subscription._id,
      userId: user._id,
      isCase2,
      canceledStripeSubscription: isCase2 && !!subscription.stripeSubscriptionId,
      finalWeight: subscription.accumulatedWeight,
      finalValue: subscription.accumulatedValue,
      finalStatus: subscription.status,
      withdrawnGold: user.withdrawnGold,
      withdrawnSilver: user.withdrawnSilver,
      withdrawnAmount: withdrawnWeightInStandardUnit,
      withdrawnMetal: withdrawalRequest.metal,
    });

    return { success: true };
  } catch (error: any) {
    console.error('[DEBUG] Error in processWithdrawalApproval - aborting transaction', {
      withdrawalRequestId,
      error: error.message,
      stack: error.stack,
    });
    await session.abortTransaction();
    console.error('[DEBUG] Transaction aborted');
    return { success: false, error: error.message || 'Failed to process withdrawal approval' };
  } finally {
    await session.endSession();
    console.log('[DEBUG] Session ended');
  }
};

