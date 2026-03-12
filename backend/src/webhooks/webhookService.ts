/**
 * Webhook Service
 *
 * Generic entry point for creating and scheduling webhook delivery.
 * Responsibilities:
 *   - Look up event config from the registry
 *   - Build the payload snapshot
 *   - Persist the renewal_event row
 *   - Create the webhook_delivery_state row (PENDING, next_retry_at = now)
 *
 * Actual HTTP delivery is handled by deliveryClient.ts.
 * Retry polling is handled by retryWorker.ts.
 */

import { v4 as uuidv4 } from 'uuid';
import { getEventConfig } from './eventRegistry';
import { prisma } from '../db';

export interface CreateAndDeliverOptions {
  residentId: string;
  riskScoreId: string;
  riskScore: number;
  riskTier: string;
  signals: {
    daysToExpiry: number;
    missedRentPayments: boolean;
    noRenewalOfferYet: boolean;
    rentGrowthAboveMarket: boolean;
  };
  asOfDate?: Date;
  triggerSource?: 'AUTO' | 'MANUAL';
}

export async function createAndDeliver(
  eventType: string,
  propertyId: string,
  options: CreateAndDeliverOptions
): Promise<{ eventId: string; status: 'pending' }> {
  const {
    residentId,
    riskScoreId,
    riskScore,
    riskTier,
    signals,
    asOfDate,
    triggerSource = 'MANUAL',
  } = options;

  const config = getEventConfig(eventType);
  const eventId = uuidv4();
  const triggeredAt = new Date();

  // Fetch resident name and unit number to include in payload
  const resident = await prisma.resident.findUnique({
    where: { id: residentId },
    select: {
      firstName: true,
      lastName: true,
      unit: { select: { unitNumber: true } },
    },
  });

  // Build the canonical payload for this event type
  const rawPayload = config.buildPayload({
    eventId,
    propertyId,
    residentId,
    residentName: resident ? `${resident.firstName} ${resident.lastName}` : residentId,
    unitNumber: resident?.unit?.unitNumber ?? null,
    riskScore,
    riskTier,
    signals,
    triggeredAt: triggeredAt.toISOString(),
  });

  // Prisma expects Json-compatible value; cast through unknown
  const payload = rawPayload as unknown as import('@prisma/client').Prisma.InputJsonValue;

  // Persist event + delivery state atomically
  await prisma.$transaction(async (tx) => {
    await tx.renewalEvent.create({
      data: {
        id: eventId,
        propertyId,
        residentId,
        riskScoreId,
        eventType,
        triggerSource,
        asOfDate: asOfDate ?? null,
        payload,
        triggeredAt,
      },
    });

    await tx.webhookDeliveryState.create({
      data: {
        propertyId,
        eventId,
        targetUrl: config.targetUrl,
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: config.maxAttempts,
        nextRetryAt: new Date(), // deliver immediately
      },
    });
  });

  return { eventId, status: 'pending' };
}

/**
 * Idempotency guard for AUTO events.
 * Returns true if an AUTO event already exists for this (residentId, asOfDate).
 */
export async function autoEventExists(
  residentId: string,
  asOfDate: Date
): Promise<boolean> {
  const existing = await prisma.renewalEvent.findFirst({
    where: {
      residentId,
      triggerSource: 'AUTO',
      asOfDate,
    },
  });
  return existing !== null;
}
