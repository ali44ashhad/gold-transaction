import { Request, Response } from 'express';
import dotenv from 'dotenv';
import { MetalPrice } from '../models/MetalPrice';

dotenv.config();

const GOLD_API_BASE_URL = 'https://www.goldapi.io/api';

interface GoldApiResponse {
  price?: number;
  price_gram_24k?: number;
  error?: string;
}

const getStartOfYesterdayUtc = (): Date => {
  const boundary = new Date();
  boundary.setUTCHours(0, 0, 0, 0);
  boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary;
};

const getDateStringDaysAgo = (daysAgo: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
};

const buildMetalUrl = (metalSymbol: 'gold' | 'silver', date: string): string => {
  const metalCode = metalSymbol === 'gold' ? 'XAU' : 'XAG';
  return `${GOLD_API_BASE_URL}/${metalCode}/USD/${date}`;
};

const extractMetalPrice = (
  payload: GoldApiResponse,
  metalSymbol: 'gold' | 'silver',
): number | null => {
  if (metalSymbol === 'gold') {
    return typeof payload.price_gram_24k === 'number' ? payload.price_gram_24k : null;
  }

  return typeof payload.price === 'number' ? payload.price : null;
};

const fetchMetalPrice = async (
  url: string,
  apiKey: string,
  metalSymbol: 'gold' | 'silver',
): Promise<number> => {
  const response = await fetch(url, {
    headers: {
      'x-access-token': apiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    let errorMessage = `Gold API request for ${metalSymbol} failed with status ${response.status}`;
    try {
      const errorData = (await response.json()) as GoldApiResponse;
      if (errorData?.error) {
        errorMessage = errorData.error;
      }
    } catch {
      // ignore parsing errors
    }

    if (errorMessage.includes('monthly quota')) {
      errorMessage = 'Monthly API quota exceeded. Please upgrade your Gold API plan.';
    }

    throw new Error(errorMessage);
  }

  const payload = (await response.json()) as GoldApiResponse;
  const price = extractMetalPrice(payload, metalSymbol);

  if (price === null) {
    throw new Error(`Invalid ${metalSymbol} data returned from Gold API`);
  }

  return price;
};

const fetchMetalPriceWithRetry = async (
  apiKey: string,
  metalSymbol: 'gold' | 'silver',
  maxRetries: number = 10,
): Promise<number> => {
  let lastError: Error | null = null;

  for (let daysAgo = 1; daysAgo <= maxRetries; daysAgo++) {
    const dateString = getDateStringDaysAgo(daysAgo);
    const url = buildMetalUrl(metalSymbol, dateString);

    try {
      const price = await fetchMetalPrice(url, apiKey, metalSymbol);
      // Check if price is 0 - treat as invalid and try next day
      if (price === 0) {
        lastError = new Error(`Zero price returned for ${metalSymbol} on date ${dateString}`);
        continue;
      }
      // If we get here, we have a valid non-zero price
      return price;
    } catch (error: any) {
      lastError = error;
      // Check if the error is about invalid/null data or non-200 status
      // In these cases, try the next day
      const isDataError =
        error?.message?.includes('Invalid') ||
        error?.message?.includes('null') ||
        error?.message?.includes('failed with status');

      if (!isDataError && daysAgo === maxRetries) {
        // For non-data errors (like API quota), throw immediately on last retry
        throw error;
      }
      // Continue to next day for data errors or if not the last retry
      continue;
    }
  }

  // If we exhausted all retries, throw an error
  const errorMessage = lastError
    ? `Unable to fetch valid ${metalSymbol} price after trying ${maxRetries} days: ${lastError.message}`
    : `Unable to fetch valid ${metalSymbol} price after trying ${maxRetries} days`;
  throw new Error(errorMessage);
};

export const getMetalPrices = async (_req: Request, res: Response): Promise<void> => {
  try {
    const prices = await MetalPrice.find().sort({ metalSymbol: 1 });
    res.json({ data: prices });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch metal prices' });
  }
};

export interface MetalPriceSyncResult {
  goldPrice: number;
  silverPrice: number;
  timestamp: Date;
}

export const runMetalPriceSync = async (): Promise<MetalPriceSyncResult> => {
  const apiKey = process.env.GOLD_API_KEY;

  if (!apiKey) {
    throw new Error('Gold API key is not configured');
  }

  const [goldPrice, silverPrice] = await Promise.all([
    fetchMetalPriceWithRetry(apiKey, 'gold'),
    fetchMetalPriceWithRetry(apiKey, 'silver'),
  ]);

  const timestamp = new Date();

  await MetalPrice.bulkWrite([
    {
      updateOne: {
        filter: { metalSymbol: 'gold' },
        update: {
          $set: {
            price: goldPrice,
            lastUpdated: timestamp,
          },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { metalSymbol: 'silver' },
        update: {
          $set: {
            price: silverPrice,
            lastUpdated: timestamp,
          },
        },
        upsert: true,
      },
    },
  ]);

  return { goldPrice, silverPrice, timestamp };
};

export const ensureFreshMetalPrices = async (): Promise<boolean> => {
  const existingPrices = await MetalPrice.find();
  const yesterdayBoundary = getStartOfYesterdayUtc();

  const missingPrices = existingPrices.length < 2;
  const stalePrices = existingPrices.some((record) => {
    if (!record?.lastUpdated) {
      return true;
    }
    return record.lastUpdated < yesterdayBoundary;
  });

  if (missingPrices || stalePrices) {
    await runMetalPriceSync();
    return true;
  }

  return false;
};

export const syncMetalPrices = async (_req: Request, res: Response): Promise<void> => {
  try {
    const { goldPrice, silverPrice, timestamp } = await runMetalPriceSync();

    res.json({
      message: 'Metal prices updated successfully',
      data: {
        gold: { price: goldPrice, lastUpdated: timestamp },
        silver: { price: silverPrice, lastUpdated: timestamp },
      },
    });
  } catch (error: any) {
    console.error('Failed to sync metal prices:', error);
    res.status(500).json({
      error: error.message || 'Failed to sync metal prices',
    });
  }
};


