const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const Attendance = require('../models/Attendance');
const auth = require('../middleware/auth');

// GET /api/dashboard
router.get('/', auth, async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysFromNow = new Date(now);
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

    // Get all members for this owner
    const allMembers = await Member.find({ owner: req.user._id });

    const totalMembers = allMembers.length;
    let activeCount = 0;
    let expiringSoonCount = 0;
    let expiredCount = 0;
    let pendingDuesCount = 0;
    let totalRevenue = 0;

    // First day of this month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    allMembers.forEach(member => {
      const expiry = new Date(member.expiryDate);
      const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

      if (daysLeft < 0) {
        expiredCount++;
      } else if (daysLeft <= 7) {
        expiringSoonCount++;
      } else {
        activeCount++;
      }

      if (member.dueAmount > 0) {
        pendingDuesCount++;
      }

      // Revenue this month — members who started this month
      const memberStart = new Date(member.startDate);
      if (memberStart >= monthStart) {
        totalRevenue += member.paidAmount || 0;
      }
    });

    // Today's attendance count
    const today = now.toISOString().split('T')[0];
    const todayAttendance = await Attendance.countDocuments({
      owner: req.user._id,
      date: today
    });

    res.json({
      totalMembers,
      activeMembers: activeCount,
      expiringSoon: expiringSoonCount,
      expiredMembers: expiredCount,
      revenueThisMonth: totalRevenue,
      pendingDues: pendingDuesCount,
      todayAttendance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
