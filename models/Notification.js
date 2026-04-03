const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  member: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member'
  },
  type: {
    type: String,
    enum: ['expiry_reminder', 'expired_recovery', 'payment_due', 'referral'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  read: {
    type: Boolean,
    default: false
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

const Notification = mongoose.model('Notification', notificationSchema);
module.exports = Notification;
