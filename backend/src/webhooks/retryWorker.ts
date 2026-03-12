/**
 * Retry Worker
 *
 * Polls every 5 seconds for webhook deliveries that need to be attempted.
 * A delivery is eligible when:
 *   - status is PENDING or FAILED
 *   - next_retry_at <= NOW()
 *
 * Processes eligible deliveries concurrently (up to CONCURRENCY_LIMIT at once).
 * Uses the deliveryClient for the actual HTTP POST + state update.
 */

import { attemptDelivery } from './deliveryClient';
import { prisma } from '../db';

const POLL_INTERVAL_MS = 5_000;
const CONCURRENCY_LIMIT = 10;

let workerInterval: ReturnType<typeof setInterval> | null = null;

async function processDuePending(): Promise<void> {
  const now = new Date();

  const pending = await prisma.webhookDeliveryState.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      nextRetryAt: { lte: now },
    },
    take: CONCURRENCY_LIMIT,
    orderBy: { nextRetryAt: 'asc' },
  });

  if (pending.length === 0) return;

  console.log(`[retryWorker] Processing ${pending.length} delivery/deliveries`);

  await Promise.allSettled(
    pending.map((delivery) =>
      attemptDelivery(delivery.id).catch((err) => {
        console.error(`[retryWorker] Unhandled error for delivery ${delivery.id}:`, err);
      })
    )
  );
}

export function startRetryWorker(): void {
  if (workerInterval) {
    console.warn('[retryWorker] Worker already running');
    return;
  }

  console.log(`[retryWorker] Starting — polling every ${POLL_INTERVAL_MS}ms`);

  // Run once immediately on startup
  processDuePending().catch((err) => {
    console.error('[retryWorker] Error on initial run:', err);
  });

  workerInterval = setInterval(() => {
    processDuePending().catch((err) => {
      console.error('[retryWorker] Error during poll:', err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopRetryWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[retryWorker] Stopped');
  }
}
