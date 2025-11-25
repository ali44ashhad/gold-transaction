// src/index.ts
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from './config/database';
import authRoutes from './routes/auth';
import checkoutRouter, { webhookHandler } from './routes/checkout';
import bodyParser from 'body-parser';
import userRoutes from './routes/users';
import subscriptionRoutes from './routes/subscriptions';
import metalPriceRoutes from './routes/metalPrices';
import orderRoutes from './routes/orders';
import { startMetalPriceCron } from './jobs/metalPriceScheduler';
import { ensureFreshMetalPrices } from './controllers/metalPriceController';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

// Connect to MongoDB
connectDB()
  .then(async () => {
    try {
      const refreshed = await ensureFreshMetalPrices();
      if (refreshed) {
        console.log('[MetalPriceStartup] Prices were stale; refreshed via Gold API.');
      } else {
        console.log('[MetalPriceStartup] Existing metal prices are current.');
      }
    } catch (error) {
      console.error('[MetalPriceStartup] Failed to verify metal prices on startup:', error);
    }

    startMetalPriceCron();
  })
  .catch((error) => {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  });

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

 
app.post(
  '/api/checkout/webhook',
  bodyParser.raw({ type: 'application/json' }),
  (req, res) => webhookHandler(req, res)
);
 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/checkout', checkoutRouter);
app.use('/api/orders', orderRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/metal-prices', metalPriceRoutes);

// Health check route
app.get('/api/health', (_req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'PharaohVault API is running',
    timestamp: new Date().toISOString(),
  });
});

// Database status route
app.get('/api/health/db', async (_req, res) => {
  try {
    const dbStatus = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    
    res.json({
      status: 'OK',
      database: {
        state: states[dbStatus] || 'unknown',
        name: mongoose.connection.name,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message,
    });
  }
});


app.get('/success', (req, res) => {
  const sessionId = req.query.session_id;

  res.send(`
    <html>
      <head>
        <title>Payment Successful</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            margin-top: 100px;
            color: #333;
          }
          .card {
            max-width: 400px;
            margin: auto;
            padding: 30px;
            border: 1px solid #ccc;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          .success {
            color: green;
            font-size: 24px;
            margin-bottom: 20px;
          }
          .session {
            font-size: 14px;
            margin-top: 10px;
            color: #555;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="success">🎉 Payment Successful 🎉</div>
          <p>Thank you! Your payment has been received.</p>
          <p class="session">Session ID:<br> <strong>${sessionId}</strong></p>
        </div>
      </body>
    </html>
  `);
});


app.get('/cancel', (_req, res) => {
  res.send(`
    <html>
      <head>
        <title>Payment Cancelled</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            margin-top: 100px;
            color: #333;
          }
          .card {
            max-width: 400px;
            margin: auto;
            padding: 30px;
            border: 1px solid #ccc;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          .cancel {
            color: red;
            font-size: 24px;
            margin-bottom: 20px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="cancel">❌ Payment Cancelled ❌</div>
          <p>Your payment was not completed.</p>
        </div>
      </body>
    </html>
  `);
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
});
