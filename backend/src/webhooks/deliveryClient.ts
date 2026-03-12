/**
 * Delivery Client
 *
 * Executes a single HTTP POST delivery attempt for a given
 * WebhookDeliveryState record. Signs the payload with HMAC-SHA256
 * and updates the delivery record with the result.
 *
 * Returns true on 2xx, false otherwise.
 * The retryWorker calls this and interprets the result.
 */

import crypto from 'crypto';
import { prisma } from '../db';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'dev_secret';
const RESPONSE_BODY_MAX_LEN = 2000;

function signPayload(body: string): string {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
}

export async function attemptDelivery(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.webhookDeliveryState.findUnique({
    where: { id: deliveryId },
    include: { event: true },
  });

  if (!delivery) {
    console.error(`[deliveryClient] Delivery ${deliveryId} not found`);
    return false;
  }

  const body = JSON.stringify(delivery.event.payload);
  const signature = signPayload(body);
  const now = new Date();

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let success = false;

  try {
    const response = await fetch(delivery.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RMS-Signature': `sha256=${signature}`,
        'X-Event-ID': delivery.eventId,
        'X-Event-Type': delivery.event.eventType,
      },
      body,
      // Node 18+ built-in fetch; 10 second timeout
      signal: AbortSignal.timeout(10_000),
    });

    responseStatus = response.status;
    const text = await response.text();
    responseBody = text.slice(0, RESPONSE_BODY_MAX_LEN);
    success = response.ok; // 2xx
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    responseBody = `fetch error: ${message}`.slice(0, RESPONSE_BODY_MAX_LEN);
    success = false;
  }

  const newAttemptCount = delivery.attemptCount + 1;
  const maxReached = newAttemptCount >= delivery.maxAttempts;

  // Exponential backoff: 2^(attempt-1) seconds
  const backoffSeconds = Math.pow(2, newAttemptCount - 1);
  const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000);

  if (success) {
    await prisma.webhookDeliveryState.update({
      where: { id: deliveryId },
      data: {
        status: 'DELIVERED',
        attemptCount: newAttemptCount,
        lastAttemptAt: now,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
        nextRetryAt,
      },
    });
    console.log(`[deliveryClient] Delivered event ${delivery.eventId} (attempt ${newAttemptCount})`);
  } else if (maxReached) {
    await prisma.webhookDeliveryState.update({
      where: { id: deliveryId },
      data: {
        status: 'DLQ',
        attemptCount: newAttemptCount,
        lastAttemptAt: now,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
        dlqReason: `Max attempts (${delivery.maxAttempts}) reached. Last status: ${responseStatus ?? 'network error'}`,
        nextRetryAt,
      },
    });
    console.warn(`[deliveryClient] Event ${delivery.eventId} moved to DLQ after ${newAttemptCount} attempts`);
  } else {
    await prisma.webhookDeliveryState.update({
      where: { id: deliveryId },
      data: {
        status: 'FAILED',
        attemptCount: newAttemptCount,
        lastAttemptAt: now,
        lastResponseStatus: responseStatus,
        lastResponseBody: responseBody,
        nextRetryAt,
      },
    });
    console.warn(
      `[deliveryClient] Delivery failed for event ${delivery.eventId} (attempt ${newAttemptCount}/${delivery.maxAttempts}), retry at ${nextRetryAt.toISOString()}`
    );
  }

  return success;
}
