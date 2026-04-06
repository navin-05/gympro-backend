const express = require('express');
const router = express.Router();
const Member = require('../models/Member');
const Renewal = require('../models/Renewal');
const Attendance = require('../models/Attendance');
const auth = require('../middleware/auth');
const NodeCache = require("node-cache");

// 🔥 Cache (per user, 60 sec)
const cache = new NodeCache({ stdTTL: 60 });

// GET /api/dashboard
router.get('/', auth, async (req, res) => {
  try {
    console.log("Dashboard API hit");

    const cacheKey = `dashboard_${req.user._id}`;

    // 🔥 Check cache first
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      console.log("Serving from cache");
      return res.json(cachedData);
    }

    const now = new Date();

    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(now.getDate() + 7);

    // Use local month boundaries; inclusive start, exclusive end.
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

    // 🔥 Run all DB queries in parallel
    const [
      totalMembers,
      activeMembers,
      expiringSoon,
      expiredMembers,
      pendingDues,
      newMembersRevenueData,
      renewalsRevenueData,
      todayAttendance
    ] = await Promise.all([

      Member.countDocuments({ owner: req.user._id }),

      Member.countDocuments({
        owner: req.user._id,
        expiryDate: { $gt: sevenDaysFromNow }
      }),

      Member.countDocuments({
        owner: req.user._id,
        expiryDate: { $gte: now, $lte: sevenDaysFromNow }
      }),

      Member.countDocuments({
        owner: req.user._id,
        expiryDate: { $lt: now }
      }),

      Member.countDocuments({
        owner: req.user._id,
        dueAmount: { $gt: 0 }
      }),

      Member.aggregate([
        {
          $match: {
            owner: req.user._id,
            startDate: { $gte: monthStart, $lt: monthEnd }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$paidAmount", 0] } }
          }
        }
      ]),

      Renewal.aggregate([
        {
          $match: {
            owner: req.user._id,
            renewalDate: { $gte: monthStart, $lt: monthEnd }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$amount", 0] } }
          }
        }
      ]),

      Attendance.countDocuments({
        owner: req.user._id,
        date: now.toISOString().split('T')[0]
      })

    ]);

    console.log("DB queries executed");

    const newMembersRevenueThisMonth = newMembersRevenueData[0]?.total || 0;
    const renewalsRevenueThisMonth = renewalsRevenueData[0]?.total || 0;
    const revenueThisMonth = newMembersRevenueThisMonth + renewalsRevenueThisMonth;

    const responseData = {
      totalMembers,
      activeMembers,
      expiringSoon,
      expiredMembers,
      revenueThisMonth,
      newMembersRevenueThisMonth,
      renewalsRevenueThisMonth,
      pendingDues,
      todayAttendance
    };

    // 🔥 Store in cache
    cache.set(cacheKey, responseData);

    res.json(responseData);

  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;