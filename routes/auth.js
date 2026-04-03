const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, gymName, mobile, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const user = new User({ name, gymName, mobile, email, password });
    await user.save();
    const token = await user.generateAuthToken();

    res.status(201).json({ user, token, isProfileComplete: user.isProfileComplete });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findByCredentials(email, password);

    // Auto-fix: if GymProfile exists but flag is false, update it
    if (!user.isProfileComplete) {
      const GymProfile = require('../models/GymProfile');
      const profile = await GymProfile.findOne({ owner: user._id });
      if (profile && profile.gymName) {
        user.isProfileComplete = true;
        await user.save();
        console.log('[Auth] Auto-fixed isProfileComplete for user:', user.email);
      }
    }

    const token = await user.generateAuthToken();
    console.log('[Auth] Login success — email:', email, 'isProfileComplete:', user.isProfileComplete);
    res.json({ user, token, isProfileComplete: user.isProfileComplete });
  } catch (error) {
    res.status(400).json({ error: 'Invalid login credentials' });
  }
});

// POST /api/auth/logout
router.post('/logout', auth, async (req, res) => {
  try {
    req.user.tokens = req.user.tokens.filter(t => t.token !== req.token);
    await req.user.save();
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    user.password = newPassword;
    user.tokens = []; // Invalidate all sessions
    await user.save();
    const token = await user.generateAuthToken();
    res.json({ message: 'Password reset successfully', token });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/auth/me — returns user + isProfileComplete
router.get('/me', auth, async (req, res) => {
  // Auto-fix if needed
  if (!req.user.isProfileComplete) {
    const GymProfile = require('../models/GymProfile');
    const profile = await GymProfile.findOne({ owner: req.user._id });
    if (profile && profile.gymName) {
      req.user.isProfileComplete = true;
      await req.user.save();
    }
  }
  res.json({ ...req.user.toJSON(), isProfileComplete: req.user.isProfileComplete });
});

module.exports = router;
