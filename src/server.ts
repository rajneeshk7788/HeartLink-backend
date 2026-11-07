import http from 'http';
import os from 'os';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { Server as SocketIOServer, Socket } from 'socket.io';

import { config, isOriginAllowed } from './config';
import { connectDB, disconnectDB } from './config/db';
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

  // Behind a load balancer / reverse proxy, trust the first hop for req.ip (rate limiting)
  if (config.isProduction) {
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by');

  // Cross-Origin Resource Sharing: only the configured client origins (no wildcard)
  const corsOrigin = (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => callback(null, isOriginAllowed(origin));

  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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
    introspection: !config.isProduction,
    formatError: (formattedError) => {
      const code = formattedError.extensions?.code;
      if (code === 'INTERNAL_SERVER_ERROR') {
        console.error('[GraphQL Error]:', formattedError);
      }
      // Never leak stack traces to clients
      const { stacktrace, ...extensions } = (formattedError.extensions || {}) as any;
      return { ...formattedError, extensions };
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
      origin: corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    maxHttpBufferSize: 1e6,
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

  // Nobody is connected right after a (re)start: clear stale presence flags
  await User.updateMany({ isOnline: true }, { $set: { isOnline: false } });

  if (config.seedDemoData) {
    const { seedInitialData } = await import('./utils/seed');
    await seedInitialData();
  }

  httpServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${config.port} is already in use. Stop the other server (or set PORT in backend/.env) and try again.`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(config.port, config.host, () => {
    const lanAddresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address);

    console.log(`=======================================================`);
    console.log(`🚀 ConnectPulse Server running on ${config.host}:${config.port}`);
    console.log(`🔐 REST Auth API:       http://localhost:${config.port}/api/auth`);
    console.log(`📊 GraphQL Endpoint:    http://localhost:${config.port}/graphql`);
    console.log(`⚡ Socket.IO Server:    ws://localhost:${config.port}`);
    console.log(`📱 Android emulator:    http://10.0.2.2:${config.port}`);
    lanAddresses.forEach((ip) => console.log(`📱 Phone on same Wi-Fi: http://${ip}:${config.port}`));
    console.log(`=======================================================`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[Server] ${signal} received, shutting down...`);
    io.close();
    await apolloServer.stop().catch(() => undefined);
    httpServer.close();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[Server Error] Startup failure:', err);
  process.exit(1);
});
