const mongoose = require('mongoose');

const enquirySchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  notes: {
    type: String,
    default: '',
    trim: true
  },
  status: {
    type: String,
    enum: ['new', 'follow-up', 'joined', 'not-interested'],
    default: 'new'
  },
  tags: {
    type: [String],
    default: []
  },
  nextFollowUp: {
    type: Date
  }
}, {
  timestamps: true
});

enquirySchema.index({ owner: 1, createdAt: -1 });

const Enquiry = mongoose.model('Enquiry', enquirySchema);
module.exports = Enquiry;
