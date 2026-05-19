const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  gymName: {
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
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  isProfileComplete: {
    type: Boolean,
    default: false
  },
  tokens: [{
    token: {
      type: String,
      required: true
    }
  }],
  notificationSettings: {
    enabled: {
      type: Boolean,
      default: false
    },
    scheduledTime: {
      type: String,
      default: '09:00 PM',
      trim: true
    },
    scheduledHour: {
      type: Number,
      default: 21,
      min: 0,
      max: 23
    },
    scheduledMinute: {
      type: Number,
      default: 0,
      min: 0,
      max: 59
    },
    timezone: {
      type: String,
      default: 'UTC',
      trim: true
    },
    lastNotificationSentDate: {
      type: String,
      default: null
    },
    whatsappNotificationNumber: {
      type: String,
      default: null,
      trim: true
    }
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

// Generate auth token
userSchema.methods.generateAuthToken = async function() {
  const token = jwt.sign(
    { userId: this._id.toString() },
    process.env.JWT_SECRET || 'gym_management_super_secret_key_2024',
    { expiresIn: '30d' }
  );
  this.tokens = this.tokens.concat({ token });
  await this.save();
  return token;
};

// Hide sensitive data in JSON responses
userSchema.methods.toJSON = function() {
  const userObject = this.toObject();
  delete userObject.password;
  delete userObject.tokens;
  return userObject;
};

// Find user by credentials
userSchema.statics.findByCredentials = async (email, password) => {
  const user = await User.findOne({ email });
  if (!user) {
    throw new Error('Invalid login credentials');
  }
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    throw new Error('Invalid login credentials');
  }
  return user;
};

const User = mongoose.model('User', userSchema);
module.exports = User;
