import http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { Server as SocketIOServer, Socket } from 'socket.io';

import { config } from './config';
import { connectDB } from './config/db';
import authRoutes from './routes/auth.routes';
import { typeDefs } from './graphql/schema/typeDefs';
import { resolvers, GraphQLContext } from './graphql/resolvers';
import { getContextUserFromToken } from './middleware/auth.middleware';
import { verifyAccessToken } from './utils/jwt';
import { User } from './models/User';
import { setIO } from './sockets/socketManager';
import { registerPresenceHandlers } from './sockets/presence.socket';
import { registerChatHandlers } from './sockets/chat.socket';
import { registerCallHandlers } from './sockets/call.socket';

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  // Cross-Origin Resource Sharing
  app.use(
    cors({
      origin: [config.clientUrl, 'http://localhost:5173', 'http://127.0.0.1:5173', '*'],
      credentials: true,
    })
  );

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // REST API Routes - Strictly Authentication Only
  app.use('/api/auth', authRoutes);

  // Health check endpoint
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'ConnectPulse API',
      timestamp: new Date().toISOString(),
      architecture: {
        auth: 'REST API',
        data: 'GraphQL',
        realtime: 'Socket.IO',
        media: 'WebRTC Peer-to-Peer',
      },
    });
  });

  // Apollo Server (GraphQL for Application Data)
  const apolloServer = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    formatError: (formattedError, error) => {
      console.error('[GraphQL Error]:', formattedError);
      return formattedError;
    },
  });

  await apolloServer.start();

  app.use(
    '/graphql',
    expressMiddleware(apolloServer, {
      context: async ({ req }) => {
        const authHeader = req.headers.authorization;
        const user = await getContextUserFromToken(authHeader);
        return { user };
      },
    })
  );

  // Socket.IO Server (Real-Time Events & WebRTC Signaling)
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: [config.clientUrl, 'http://localhost:5173', 'http://127.0.0.1:5173', '*'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  setIO(io);

  // Socket.IO Authentication Middleware
  io.use(async (socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication token required for Socket connection'));
      }

      const payload = verifyAccessToken(token);
      if (!payload) {
        return next(new Error('Invalid or expired socket authentication token'));
      }

      const user = await User.findById(payload.userId);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.data.userId = user._id.toString();
      socket.data.user = user.toSafeUser();
      next();
    } catch (err: any) {
      next(new Error(`Socket authentication error: ${err.message}`));
    }
  });

  // Socket connection lifecycle
  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] User connected: ${socket.data.userId} (socket ${socket.id})`);

    // Register domain socket handlers
    registerPresenceHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerCallHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${socket.data.userId} (socket ${socket.id})`);
    });
  });

  // Connect Database, Seed Starter Data, and Listen
  await connectDB();
  const { seedInitialData } = await import('./utils/seed');
  await seedInitialData();

  httpServer.listen(config.port, () => {
    console.log(`=======================================================`);
    console.log(`🚀 ConnectPulse Server running on port ${config.port}`);
    console.log(`🔐 REST Auth API:       http://localhost:${config.port}/api/auth`);
    console.log(`📊 GraphQL Endpoint:    http://localhost:${config.port}/graphql`);
    console.log(`⚡ Socket.IO Server:    ws://localhost:${config.port}`);
    console.log(`=======================================================`);
  });
}

startServer().catch((err) => {
  console.error('[Server Error] Startup failure:', err);
  process.exit(1);
});
