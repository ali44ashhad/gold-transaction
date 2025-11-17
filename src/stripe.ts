// src/stripe.ts
import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error('Missing STRIPE_SECRET_KEY in env');

export const stripe = new Stripe(key, { apiVersion: '2022-11-15' });
