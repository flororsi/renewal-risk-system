/**
 * Event Registry
 *
 * Central configuration for all webhook event types supported by the system.
 * Each entry defines how to build the payload and where to deliver it.
 *
 * Adding a new event type:
 *   1. Add an entry to EVENT_REGISTRY with the event key.
 *   2. Define a buildPayload function that shapes the data contract for that event.
 *   3. The webhookService will pick up the configuration automatically.
 */

export interface EventConfig {
  buildPayload: (data: Record<string, unknown>) => Record<string, unknown>;
  targetUrl: string;
  maxAttempts: number;
}

export const EVENT_REGISTRY: Record<string, EventConfig> = {
  'renewal.risk_flagged': {
    buildPayload: (data) => ({
      event: 'renewal.risk_flagged',
      eventId: data.eventId,
      timestamp: data.triggeredAt,
      propertyId: data.propertyId,
      residentId: data.residentId,
      residentName: data.residentName,
      unitNumber: data.unitNumber,
      data: {
        riskScore: data.riskScore,
        riskTier: data.riskTier,
        daysToExpiry: (data.signals as Record<string, unknown>)?.daysToExpiry,
        signals: data.signals,
      },
    }),
    targetUrl: process.env.RMS_WEBHOOK_URL ?? 'http://localhost:3001/webhook',
    maxAttempts: 5,
  },
};

export function getEventConfig(eventType: string): EventConfig {
  const config = EVENT_REGISTRY[eventType];
  if (!config) {
    throw new Error(`Unknown event type: ${eventType}`);
  }
  return config;
}
