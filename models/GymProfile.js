const mongoose = require('mongoose');

const gymProfileSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    unique: true
  },
  gymName: {
    type: String,
    required: true,
    trim: true
  },
  address: {
    type: String,
    trim: true,
    default: ''
  },
  city: {
    type: String,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    trim: true,
    default: ''
  },
  mapLink: {
    type: String,
    trim: true,
    default: ''
  },
  openingHours: {
    type: String,
    trim: true,
    default: ''
  },
  logo: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

const GymProfile = mongoose.model('GymProfile', gymProfileSchema);
module.exports = GymProfile;
