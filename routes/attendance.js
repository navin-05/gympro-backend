const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const Member = require('../models/Member');
const auth = require('../middleware/auth');
const { recordCheckinAttempt, WINDOW_MS: BURST_WINDOW_MS } = require('../middleware/checkinBurstGuard');

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

    const now = new Date();
    if (new Date(member.expiryDate) < now) {
      return res.status(403).json({
        error: 'Membership expired',
        message: `${member.name}'s membership expired on ${new Date(member.expiryDate).toLocaleDateString()}. Please renew to check in.`
      });
    }

    const today = now.toISOString().split('T')[0];

    const existing = await Attendance.findOne({
      member: memberId,
      owner: req.user._id,
      date: today,
    }).lean();

    if (existing) {
      return res.status(200).json({
        message: `${member.name} already checked in today.`,
        alreadyCheckedIn: true,
        checkInTime: existing.checkInTime,
        memberName: member.name,
        memberStatus: member.status,
      });
    }

    const burst = recordCheckinAttempt(req.user._id, memberId);
    if (!burst.ok) {
      return res.status(429).json({
        error: 'Too many check-in attempts',
        message: `Please wait before trying again (${BURST_WINDOW_MS / 1000}s cooldown).`,
      });
    }

    try {
      const attendance = new Attendance({
        member: memberId,
        owner: req.user._id,
        checkInTime: now,
        date: today,
      });
      await attendance.save();

      res.status(201).json({
        message: `${member.name} checked in successfully!`,
        alreadyCheckedIn: false,
        checkInTime: now,
        memberName: member.name,
        memberStatus: member.status,
      });
    } catch (dupError) {
      if (dupError.code === 11000) {
        const again = await Attendance.findOne({
          member: memberId,
          owner: req.user._id,
          date: today,
        }).lean();
        return res.status(200).json({
          message: `${member.name} already checked in today.`,
          alreadyCheckedIn: true,
          checkInTime: again?.checkInTime || now,
          memberName: member.name,
          memberStatus: member.status,
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
