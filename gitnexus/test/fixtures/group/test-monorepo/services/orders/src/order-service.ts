import { Client } from '@grpc/grpc-js';

// Consumes AuthService gRPC
const authClient = new AuthServiceClient('localhost:50051');

// Consumes user.logged-in topic
await consumer.subscribe({ topic: 'user.logged-in', fromBeginning: true });
