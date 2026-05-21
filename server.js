const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { connectDB } = require('./config/db');
const enquiryRoutes = require('./routes/enquiryRoutes');
const { triggerScheduledNotificationsIfDue } = require('./utils/triggerScheduledNotifications');

// Load environment variables
dotenv.config();

console.log('BACKEND PROCESS STARTED:', process.pid);

process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  if (/Bad MAC|Failed to decrypt|SessionEntry|Closing session|prekey bundle|No matching sessions/i.test(msg)) {
    console.log('[WhatsApp][session][info] Signal/decrypt rejection (ignored, no lifecycle action):', msg);
    return;
  }
  console.error('[UnhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  const msg = String(err?.message || err || '');
  // WhatsApp LocalAuth sometimes throws EBUSY while unlinking lockfile; avoid hard crash/restart loop.
  if (/EBUSY/i.test(msg) && /[\\\/]\.wwebjs_auth[\\\/]session[\\\/]lockfile/i.test(msg)) {
    console.error('[UncaughtException][WhatsApp][Lockfile]', msg);
    return;
  }
  console.error('[UncaughtException]', err);
  process.exit(1);
});

const app = express();
app.set('trust proxy', 1);

// Lightweight health (no /api prefix) for probes — also wakes schedule check on Render
app.get('/health', (req, res) => {
  triggerScheduledNotificationsIfDue('health').catch(() => {});
  res.json({ success: true });
});

// ✅ RATE LIMITER (GLOBAL) — OPTIONS excluded: CORS preflight must not burn the budget
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: {
    error: "Too many requests, please try again later."
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

// Apply rate limiter globally
app.use(limiter);

// 🔐 STRONG LIMIT for AUTH (login/signup)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // stricter
  message: {
    error: "Too many login attempts. Try again later."
  }
});

// ✅ CORS
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Wake schedule check on normal API traffic (Render cold start + daily app use)
app.use((req, res, next) => {
  if (req.method !== 'OPTIONS' && req.path.startsWith('/api/') && req.path !== '/api/health') {
    triggerScheduledNotificationsIfDue('api-traffic').catch(() => {});
  }
  next();
});

// 🔥 Apply strict limiter only to auth routes
app.use('/api/auth', authLimiter, require('./routes/auth'));

// Attendance: extra per-IP cap (check-in is bursty from QR / retries)
const attendanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attendance requests. Please slow down.' },
});

// Other routes
app.use('/api/gym', require('./routes/gym'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/members', require('./routes/members'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/attendance', attendanceLimiter, require('./routes/attendance'));
app.use('/api/transformations', require('./routes/transformations'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/enquiries', enquiryRoutes);

// Health check
app.get('/api/health', (req, res) => {
  triggerScheduledNotificationsIfDue('api-health').catch(() => {});
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    environment: process.env.NODE_ENV || 'development',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error:", err.message);
  res.status(500).json({ error: "Internal Server Error" });
});

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    // WhatsApp: single global init in background (never from routes/cron/send)
    const { startWhatsAppClient } = require('./services/whatsappClient');
    setImmediate(async () => {
      try {
        await startWhatsAppClient();
      } catch (err) {
        console.error('[WhatsApp] Startup initialization failed:', err.message);
      }
    });

    // STEP 6 — Delay scheduler startup (WhatsApp warmup on low-memory VPS)
    setTimeout(() => {
      console.log('[Scheduler] Starting after WhatsApp warmup...');
      // Start scheduled cron jobs (after DB is connected)
      require('./cron/membershipCron');
      triggerScheduledNotificationsIfDue('startup').catch(() => {});
    }, 45000);

    app.listen(PORT, () => {
      console.log(`\n🏋️ Gym Management API running on port ${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   Health check: /api/health\n`);
    });

  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();