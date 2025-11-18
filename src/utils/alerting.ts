import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

type AlertPayload = Record<string, unknown> | undefined;

const resolveWebhookUrl = (): string | undefined => {
  return process.env.OPS_ALERT_WEBHOOK || process.env.SLACK_WEBHOOK_URL;
};

const postJson = async (webhookUrl: string, payload: Record<string, unknown>): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    try {
      const url = new URL(webhookUrl);
      const data = JSON.stringify(payload);

      const request = https.request(
        {
          method: 'POST',
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (response) => {
          response.on('data', () => null);
          response.on('end', () => resolve());
        }
      );

      request.on('error', (err) => reject(err));
      request.write(data);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
};

export const notifyOps = async (message: string, context?: AlertPayload): Promise<void> => {
  const webhookUrl = resolveWebhookUrl();

  if (!webhookUrl) {
    console.warn('[OPS ALERT]', message, context || {});
    return;
  }

  try {
    await postJson(webhookUrl, {
      text: message,
      attachments: context
        ? [
            {
              color: '#f97316',
              fields: Object.entries(context).map(([title, value]) => ({
                title,
                value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
                short: false,
              })),
            },
          ]
        : undefined,
    });
  } catch (error) {
    console.error('Failed to deliver ops alert', error);
  }
};



