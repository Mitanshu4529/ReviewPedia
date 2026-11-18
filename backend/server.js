import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import app from './app.js';
import { connectToDb } from './db/connect.js';
import mongoose from 'mongoose';
import { getJwtSecret } from './utils/jwtConfig.js';
import { corsOriginCallback } from './utils/security.js';

// Reads the JWT from the socket handshake: `auth.token` (sent by the client) or
// the httpOnly `token` cookie.
const tokenFromHandshake = (handshake) => {
    if (typeof handshake.auth?.token === 'string' && handshake.auth.token) return handshake.auth.token;
    const cookieHeader = handshake.headers?.cookie || '';
    for (const part of cookieHeader.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === 'token') return decodeURIComponent(rest.join('='));
    }
    return null;
};

const PORT = process.env.PORT || 3001;

const start = async () => {
    try {
        await connectToDb();
        
        const server = http.createServer(app);
        
        // Initialize Socket.io
        const io = new Server(server, {
            cors: {
                origin: corsOriginCallback,
                methods: ['GET', 'POST'],
                credentials: true
            }
        });

        // Store io instance in app so controllers can access it
        app.set('io', io);

        // Every socket must present a valid JWT. Without this, anyone could join
        // another user's room and receive their private messages.
        io.use((socket, next) => {
            const token = tokenFromHandshake(socket.handshake);
            if (!token) return next(new Error('Authentication required'));
            try {
                const decoded = jwt.verify(token, getJwtSecret());
                if (!decoded?.id) return next(new Error('Invalid token'));
                socket.data.userId = decoded.id.toString();
                next();
            } catch {
                next(new Error('Invalid token'));
            }
        });

        // Socket connection logic
        io.on('connection', (socket) => {
            // The room is derived from the verified token, never from client input.
            socket.join(socket.data.userId);

            // Kept for older clients that still emit 'join': the argument is ignored.
            socket.on('join', () => {});

            socket.on('disconnect', () => {
                // no per-socket state to clean up
            });
        });
        
        server.listen(PORT, () => {
            console.log(`API Server running on port ${PORT}`);
        });

        // Graceful shutdown
        const shutdown = async (signal) => {
            console.log(`\nReceived ${signal}. Shutting down gracefully...`);
            server.close(async () => {
                console.log('HTTP and WebSocket server closed.');
                try {
                    await mongoose.disconnect();
                    console.log('MongoDB connection closed.');
                    process.exit(0);
                } catch (err) {
                    console.error('Error during MongoDB disconnection:', err);
                    process.exit(1);
                }
            });

            // Force close after 10 seconds if graceful shutdown hangs
            setTimeout(() => {
                console.error('Forced shutdown due to timeout.');
                process.exit(1);
            }, 10000);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (error) {
        console.error("Failed to start the server:", error);
        process.exit(1);
    }
};

start();
