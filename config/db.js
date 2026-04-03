const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI;

    if (!uri) {
      console.error('❌ MONGO_URI is not defined in environment variables!');
      console.error('   Set MONGO_URI in .env file or Render environment settings.');
      process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    console.log('   URI:', uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')); // hide password in logs

    const conn = await mongoose.connect(uri);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`   Database: ${conn.connection.name}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

const disconnectDB = async () => {
  await mongoose.disconnect();
};

module.exports = { connectDB, disconnectDB };
