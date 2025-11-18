import { describe, expect, it, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';

import * as checkoutModule from '../checkout';

describe('processStripeEvent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handles checkout.session.completed events', async () => {
    const spy = vi.spyOn(checkoutModule, 'updateOrderByLookup').mockResolvedValue({} as any);

    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test',
          payment_status: 'paid',
          metadata: { orderId: 'order123' },
          customer_details: { email: 'test@example.com', name: 'Test User' },
          subscription: 'sub_123',
          payment_intent: 'pi_123',
          invoice: 'in_123',
          amount_total: 5000,
          currency: 'usd',
        },
      },
    } as unknown as Stripe.Event;

    await checkoutModule.processStripeEvent(event);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order123',
        stripeSessionId: 'cs_test',
        stripeSubscriptionId: 'sub_123',
      }),
      expect.objectContaining({
        paymentStatus: 'succeeded',
        amount: 50,
        currency: 'usd',
      }),
      expect.objectContaining({
        eventId: 'evt_1',
        eventType: 'checkout.session.completed',
      })
    );
  });

  it('handles invoice.payment_succeeded events', async () => {
    const spy = vi.spyOn(checkoutModule, 'updateOrderByLookup').mockResolvedValue({} as any);

    const event = {
      id: 'evt_2',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_456',
          status: 'paid',
          metadata: { orderId: 'order456' },
          subscription: 'sub_789',
          customer: 'cus_123',
          payment_intent: 'pi_456',
          hosted_invoice_url: 'https://example.com/invoice',
          amount_paid: 10000,
          currency: 'usd',
        },
      },
    } as unknown as Stripe.Event;

    await checkoutModule.processStripeEvent(event);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order456',
        stripeSubscriptionId: 'sub_789',
        stripeInvoiceId: 'in_456',
      }),
      expect.objectContaining({
        paymentStatus: 'succeeded',
        receiptUrl: 'https://example.com/invoice',
        amount: 100,
      }),
      expect.objectContaining({
        eventId: 'evt_2',
      })
    );
  });

  it('handles invoice.payment_failed events', async () => {
    const spy = vi.spyOn(checkoutModule, 'updateOrderByLookup').mockResolvedValue({} as any);

    const event = {
      id: 'evt_3',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_failed',
          status: 'open',
          metadata: { orderId: 'order789' },
          subscription: 'sub_failed',
          customer: 'cus_fail',
        },
      },
    } as unknown as Stripe.Event;

    await checkoutModule.processStripeEvent(event);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order789',
        stripeInvoiceId: 'in_failed',
      }),
      expect.objectContaining({
        paymentStatus: 'failed',
        invoiceStatus: 'open',
      }),
      expect.objectContaining({
        eventId: 'evt_3',
      })
    );
  });

  it('handles subscription lifecycle events', async () => {
    const spy = vi.spyOn(checkoutModule, 'updateOrderByLookup').mockResolvedValue({} as any);

    const event = {
      id: 'evt_4',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_123',
          status: 'active',
          metadata: { orderId: 'order000' },
          customer: 'cus_sub',
        },
      },
    } as unknown as Stripe.Event;

    await checkoutModule.processStripeEvent(event);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order000',
        stripeSubscriptionId: 'sub_123',
      }),
      expect.objectContaining({
        status: 'paid',
        paymentStatus: 'succeeded',
      }),
      expect.objectContaining({
        eventId: 'evt_4',
      })
    );
  });

  it('handles customer.subscription.created events', async () => {
    const spy = vi.spyOn(checkoutModule, 'updateOrderByLookup').mockResolvedValue({} as any);

    const event = {
      id: 'evt_5',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_created',
          status: 'trialing',
          metadata: { orderId: 'orderABC' },
          customer: 'cus_created',
        },
      },
    } as unknown as Stripe.Event;

    await checkoutModule.processStripeEvent(event);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'orderABC',
        stripeSubscriptionId: 'sub_created',
      }),
      expect.objectContaining({
        status: 'pending',
        paymentStatus: 'pending',
      }),
      expect.objectContaining({
        eventId: 'evt_5',
      })
    );
  });
});

describe('buildPaymentStatus', () => {
  it('maps Stripe statuses to internal statuses', () => {
    expect(checkoutModule.buildPaymentStatus('paid')).toBe('succeeded');
    expect(checkoutModule.buildPaymentStatus('unpaid')).toBe('failed');
    expect(checkoutModule.buildPaymentStatus('processing')).toBe('processing');
    expect(checkoutModule.buildPaymentStatus(undefined)).toBe('pending');
  });
});


