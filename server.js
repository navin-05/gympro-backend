const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { connectDB } = require('./config/db');
const enquiryRoutes = require('./routes/enquiryRoutes');

// Load environment variables
dotenv.config();

const app = express();

// ✅ RATE LIMITER (GLOBAL)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP
  message: {
    error: "Too many requests, please try again later."
  },
  standardHeaders: true,
  legacyHeaders: false,
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

// 🔥 Apply strict limiter only to auth routes
app.use('/api/auth', authLimiter, require('./routes/auth'));

// Other routes
app.use('/api/gym', require('./routes/gym'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/members', require('./routes/members'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/transformations', require('./routes/transformations'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/enquiries', enquiryRoutes);

// Health check
app.get('/api/health', (req, res) => {
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