const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const Member = require('../models/Member');
const auth = require('../middleware/auth');

// POST /api/attendance/checkin
router.post('/checkin', auth, async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) {
      return res.status(400).json({ error: 'Member ID is required' });
    }

    const member = await Member.findOne({ _id: memberId, owner: req.user._id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Check if membership is expired
    const now = new Date();
    if (new Date(member.expiryDate) < now) {
      return res.status(403).json({
        error: 'Membership expired',
        message: `${member.name}'s membership expired on ${new Date(member.expiryDate).toLocaleDateString()}. Please renew to check in.`
      });
    }

    // Create today's date string for duplicate checking
    const today = now.toISOString().split('T')[0];

    try {
      const attendance = new Attendance({
        member: memberId,
        owner: req.user._id,
        checkInTime: now,
        date: today
      });
      await attendance.save();

      res.status(201).json({
        message: `${member.name} checked in successfully!`,
        checkInTime: now,
        memberName: member.name,
        memberStatus: member.status
      });
    } catch (dupError) {
      if (dupError.code === 11000) {
        return res.status(400).json({
          error: 'Already checked in',
          message: `${member.name} has already checked in today.`
        });
      }
      throw dupError;
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/attendance/:memberId
router.get('/:memberId', auth, async (req, res) => {
  try {
    const records = await Attendance.find({
      member: req.params.memberId,
      owner: req.user._id
    }).sort({ checkInTime: -1 }).limit(60);

    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/attendance — all attendance today
router.get('/', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const records = await Attendance.find({
      owner: req.user._id,
      date: today
    }).populate('member', 'name photo').sort({ checkInTime: -1 });

    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
