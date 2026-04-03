const express = require('express');
const router = express.Router();
const GymProfile = require('../models/GymProfile');
const User = require('../models/User');
const auth = require('../middleware/auth');

// GET /api/gym/profile
router.get('/profile', auth, async (req, res) => {
  try {
    let profile = await GymProfile.findOne({ owner: req.user._id });
    if (!profile) {
      return res.json(null);
    }
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/gym/profile — first-time setup
router.post('/profile', auth, async (req, res) => {
  try {
    const existing = await GymProfile.findOne({ owner: req.user._id });
    if (existing) {
      return res.status(400).json({ error: 'Profile already exists. Use PUT to update.' });
    }

    const profile = new GymProfile({
      owner: req.user._id,
      ...req.body
    });
    await profile.save();

    // Mark user profile as complete
    await User.findByIdAndUpdate(req.user._id, { isProfileComplete: true });

    res.status(201).json({ profile, isProfileComplete: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/gym/profile — update existing
router.put('/profile', auth, async (req, res) => {
  try {
    const profile = await GymProfile.findOneAndUpdate(
      { owner: req.user._id },
      req.body,
      { new: true, runValidators: true, upsert: true }
    );

    // Ensure profile complete flag is set
    await User.findByIdAndUpdate(req.user._id, { isProfileComplete: true });

    res.json({ profile, isProfileComplete: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
