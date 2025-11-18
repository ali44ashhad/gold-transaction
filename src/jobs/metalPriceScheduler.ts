import cron from 'node-cron';
import { runMetalPriceSync } from '../controllers/metalPriceController';

const DEFAULT_CRON_EXPRESSION = '0 0 * * *'; // Midnight daily
const DEFAULT_TIMEZONE = 'America/New_York';

export const startMetalPriceCron = (): void => {
  const cronEnabledEnv = process.env.METAL_PRICE_CRON_ENABLED;
  if (cronEnabledEnv === 'false') {
    console.log('[MetalPriceCron] Disabled via METAL_PRICE_CRON_ENABLED=false');
    return;
  }

  const cronExpression = process.env.METAL_PRICE_CRON_EXPRESSION || DEFAULT_CRON_EXPRESSION;
  const cronTimezone = process.env.METAL_PRICE_CRON_TIMEZONE || DEFAULT_TIMEZONE;

  cron.schedule(
    cronExpression,
    async () => {
      try {
        const { goldPrice, silverPrice, timestamp } = await runMetalPriceSync();
        console.log(
          `[MetalPriceCron] Updated prices at ${timestamp.toISOString()} | gold: $${goldPrice} | silver: $${silverPrice}`,
        );
      } catch (error) {
        console.error('[MetalPriceCron] Failed to refresh metal prices:', error);
      }
    },
    {
      timezone: cronTimezone,
    },
  );

  console.log(
    `[MetalPriceCron] Scheduled daily refresh using "${cronExpression}" (timezone: ${cronTimezone}). Set METAL_PRICE_CRON_ENABLED=false to disable.`,
  );
};


