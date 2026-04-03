const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  photo: {
    type: String,
    default: ''
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  mobile: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
  },
  plan: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'MembershipPlan'
  },
  planName: {
    type: String,
    default: ''
  },
  startDate: {
    type: Date,
    required: true
  },
  expiryDate: {
    type: Date,
    required: true
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  dueAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: String,
    default: ''
  },
  referralCount: {
    type: Number,
    default: 0
  },
  qrCode: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Virtual for membership status
memberSchema.virtual('status').get(function() {
  const now = new Date();
  const expiry = new Date(this.expiryDate);
  const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry < 0) return 'Expired';
  if (daysUntilExpiry <= 7) return 'Expiring Soon';
  return 'Active';
});

// Ensure virtuals are included in JSON
memberSchema.set('toJSON', { virtuals: true });
memberSchema.set('toObject', { virtuals: true });

const Member = mongoose.model('Member', memberSchema);
module.exports = Member;
