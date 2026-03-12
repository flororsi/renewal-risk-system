import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import apiRouter from './api/routes';
import { startRetryWorker, stopRetryWorker } from './webhooks/retryWorker';
import { startJobWorker, stopJobWorker } from './services/jobWorker';

const app = express();
const PORT = process.env.PORT ?? 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  console.log('[server] Health check — successfully connected');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1', apiRouter);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  startRetryWorker();
  startJobWorker();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal: string) {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  stopRetryWorker();
  stopJobWorker();
  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
