/**
 * Job Worker
 *
 * Polls every 5 seconds for BatchJob rows in PENDING status.
 * For each eligible job:
 *   1. Claims it atomically by setting status = RUNNING (updateMany WHERE status=PENDING)
 *   2. Calls calculateRiskForProperty()
 *   3. On success → status = COMPLETED + writes summary columns
 *   4. On failure → status = FAILED + writes errorMessage
 *
 * Concurrency limit: 3 simultaneous jobs.
 */

import { calculateRiskForProperty } from './riskScoring';
import { prisma } from '../db';

const POLL_INTERVAL_MS  = 5_000;
const CONCURRENCY_LIMIT = 3;

let workerInterval: ReturnType<typeof setInterval> | null = null;

async function processPendingJobs(): Promise<void> {
  const pending = await prisma.batchJob.findMany({
    where:   { status: 'PENDING' },
    take:    CONCURRENCY_LIMIT,
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length === 0) return;

  console.log(`[jobWorker] Processing ${pending.length} pending job(s)`);

  await Promise.allSettled(
    pending.map((job) =>
      processOneJob(job.id).catch((err) => {
        console.error(`[jobWorker] Unhandled error for job ${job.id}:`, err);
      })
    )
  );
}

async function processOneJob(jobId: string): Promise<void> {
  // Atomic claim: only one worker wins this race
  const claim = await prisma.batchJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data:  { status: 'RUNNING', startedAt: new Date() },
  });

  if (claim.count === 0) {
    console.log(`[jobWorker] Job ${jobId} already claimed — skipping`);
    return;
  }

  const job = await prisma.batchJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  try {
    const result = await calculateRiskForProperty(job.propertyId, job.asOfDate);

    await prisma.batchJob.update({
      where: { id: jobId },
      data: {
        status:         'COMPLETED',
        completedAt:    new Date(),
        totalResidents: result.totalResidents,
        flaggedCount:   result.flaggedCount,
        highCount:      result.riskTiers.high,
        mediumCount:    result.riskTiers.medium,
        lowCount:       result.riskTiers.low,
      },
    });

    console.log(`[jobWorker] Job ${jobId} completed — ${result.totalResidents} residents processed`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.batchJob.update({
      where: { id: jobId },
      data: {
        status:       'FAILED',
        completedAt:  new Date(),
        errorMessage: message.slice(0, 1000),
      },
    });

    console.error(`[jobWorker] Job ${jobId} failed:`, err);
  }
}

export function startJobWorker(): void {
  if (workerInterval) {
    console.warn('[jobWorker] Worker already running');
    return;
  }

  console.log(`[jobWorker] Starting — polling every ${POLL_INTERVAL_MS}ms`);

  processPendingJobs().catch((err) => {
    console.error('[jobWorker] Error on initial run:', err);
  });

  workerInterval = setInterval(() => {
    processPendingJobs().catch((err) => {
      console.error('[jobWorker] Error during poll:', err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopJobWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[jobWorker] Stopped');
  }
}
