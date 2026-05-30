const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

let io = null;

function initReferralRealtime(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'gym_management_super_secret_key_2024'
      );
      socket.ownerId = String(decoded.userId);
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const room = `owner:${socket.ownerId}`;
    socket.join(room);
    console.log('[ReferralRealtime] connected', socket.ownerId);

    socket.on('disconnect', () => {
      console.log('[ReferralRealtime] disconnected', socket.ownerId);
    });
  });

  console.log('[ReferralRealtime] Socket.IO initialized');
  return io;
}

function emitToOwner(ownerId, event, payload) {
  if (!io) return;
  io.to(`owner:${ownerId}`).emit(event, payload);
}

/**
 * Push a new/updated referral to connected clients (incremental cache update).
 */
function emitReferralCreated(ownerId, referral, stats = null) {
  emitToOwner(String(ownerId), 'referral:created', {
    referral,
    stats,
    at: new Date().toISOString(),
  });
}

function emitReferralStatsUpdated(ownerId, stats) {
  emitToOwner(String(ownerId), 'referral:stats', {
    stats,
    at: new Date().toISOString(),
  });
}

module.exports = {
  initReferralRealtime,
  emitReferralCreated,
  emitReferralStatsUpdated,
};
