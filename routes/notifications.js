const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const Member = require('../models/Member');
const auth = require('../middleware/auth');

// GET /api/notifications
router.get('/', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ owner: req.user._id })
      .populate('member', 'name photo')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(notifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/notifications/generate — scan members and create expiry notifications
router.post('/generate', auth, async (req, res) => {
  try {
    const now = new Date();
    const members = await Member.find({ owner: req.user._id });
    const notifications = [];

    for (const member of members) {
      const expiry = new Date(member.expiryDate);
      const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

      let message = null;
      let type = null;

      // Before expiry reminders
      if (daysUntilExpiry === 7) {
        type = 'expiry_reminder';
        message = `Hello ${member.name}, your membership will expire in 7 days on ${expiry.toLocaleDateString()}. Please renew to continue your workouts.`;
      } else if (daysUntilExpiry === 3) {
        type = 'expiry_reminder';
        message = `Hello ${member.name}, your membership will expire in 3 days on ${expiry.toLocaleDateString()}. Please renew soon.`;
      } else if (daysUntilExpiry === 1) {
        type = 'expiry_reminder';
        message = `Hello ${member.name}, your membership expires tomorrow on ${expiry.toLocaleDateString()}. Renew now!`;
      } else if (daysUntilExpiry === 0) {
        type = 'expiry_reminder';
        message = `Hello ${member.name}, your membership expires today! Please renew to continue your training.`;
      }
      // After expiry recovery reminders
      else if (daysUntilExpiry === -3) {
        type = 'expiry_recovery';
        message = `Hello ${member.name}, your membership expired 3 days ago. Renew now to continue your training.`;
      } else if (daysUntilExpiry === -7) {
        type = 'expiry_recovery';
        message = `Hello ${member.name}, your membership expired 7 days ago. We miss you! Renew to get back on track.`;
      }

      // Payment due reminder
      if (member.dueAmount > 0) {
        const paymentNotif = new Notification({
          owner: req.user._id,
          member: member._id,
          type: 'payment_due',
          message: `${member.name} has a pending payment of ₹${member.dueAmount}.`
        });
        notifications.push(paymentNotif);
      }

      if (message && type) {
        const notification = new Notification({
          owner: req.user._id,
          member: member._id,
          type,
          message
        });
        notifications.push(notification);
      }
    }

    // Save all generated notifications
    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }

    res.json({
      message: `${notifications.length} notification(s) generated`,
      count: notifications.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/notifications/:id/read — mark as read
router.put('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json(notification);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
