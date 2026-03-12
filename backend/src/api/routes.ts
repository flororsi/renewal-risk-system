/**
 * API Routes
 *
 * All routes are mounted under /api/v1 in index.ts.
 *
 * Endpoints:
 *   POST /properties/:propertyId/renewal-risk/calculate
 *   GET  /properties/:propertyId/renewal-risk
 *   POST /properties/:propertyId/residents/:residentId/renewal-event
 *   GET  /properties/:propertyId/webhook-status
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getLatestRiskScores } from '../services/riskScoring';
import { createAndDeliver } from '../webhooks/webhookService';
import { prisma } from '../db';

function makeIdempotencyKey(propertyId: string, date: Date): string {
  return crypto
    .createHash('sha256')
    .update(`${propertyId}:${date.toISOString().split('T')[0]}`)
    .digest('hex');
}

const router = Router();

// ---------------------------------------------------------------------------
// GET /properties — list all properties (for dashboard landing page)
// ---------------------------------------------------------------------------
router.get('/properties', async (_req: Request, res: Response) => {
  const properties = await prisma.property.findMany({
    select: { id: true, name: true, address: true },
    orderBy: { name: 'asc' },
  });
  res.json({ properties });
});

// ---------------------------------------------------------------------------
// POST /properties/:propertyId/renewal-risk/calculate
// ---------------------------------------------------------------------------
router.post(
  '/properties/:propertyId/renewal-risk/calculate',
  async (req: Request, res: Response) => {
    const { propertyId } = req.params;
    const { asOfDate, triggerSource = 'AUTO' } = req.body as { asOfDate?: string; triggerSource?: string };

    const date = asOfDate ? new Date(asOfDate) : new Date();

    if (isNaN(date.getTime())) {
      res.status(400).json({ error: 'Invalid asOfDate. Use ISO format: YYYY-MM-DD' });
      return;
    }

    try {
      const property = await prisma.property.findUnique({ where: { id: propertyId } });
      if (!property) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }

      let job;
      if (triggerSource === 'AUTO') {
        const idempotencyKey = makeIdempotencyKey(propertyId, date);
        job = await prisma.batchJob.upsert({
          where:  { idempotencyKey },
          update: {},
          create: { propertyId, asOfDate: date, triggerSource: 'AUTO', idempotencyKey, status: 'PENDING' },
        });
      } else {
        job = await prisma.batchJob.create({
          data: { propertyId, asOfDate: date, triggerSource: 'MANUAL', status: 'PENDING' },
        });
      }

      res.status(202).json({
        jobId: job.id,
        status: job.status,
        propertyId,
        asOfDate: date.toISOString().split('T')[0],
        triggerSource: job.triggerSource,
      });
    } catch (err) {
      console.error('[routes] Error creating batch job:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /properties/:propertyId/renewal-risk
// ---------------------------------------------------------------------------
router.get(
  '/properties/:propertyId/renewal-risk',
  async (req: Request, res: Response) => {
    const { propertyId } = req.params;
    const { tier } = req.query as { tier?: string };

    try {
      const property = await prisma.property.findUnique({ where: { id: propertyId } });
      if (!property) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }

      const scores = await getLatestRiskScores(propertyId, tier);
      res.json({ propertyId, scores });
    } catch (err) {
      console.error('[routes] Error fetching risk scores:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /properties/:propertyId/residents/:residentId/renewal-event
// ---------------------------------------------------------------------------
router.post(
  '/properties/:propertyId/residents/:residentId/renewal-event',
  async (req: Request, res: Response) => {
    const { propertyId, residentId } = req.params;

    try {
      // Find the latest risk score for this resident
      const latestScore = await prisma.renewalRiskScore.findFirst({
        where: { propertyId, residentId },
        orderBy: { asOfDate: 'desc' },
      });

      if (!latestScore) {
        res.status(404).json({
          error: 'No risk score found for this resident. Run /calculate first.',
        });
        return;
      }

      const result = await createAndDeliver('renewal.risk_flagged', propertyId, {
        residentId,
        riskScoreId: latestScore.id,
        riskScore: latestScore.riskScore,
        riskTier: latestScore.riskTier,
        signals: {
          daysToExpiry: latestScore.daysToExpiry,
          missedRentPayments: latestScore.missedRentPayments,
          noRenewalOfferYet: latestScore.noRenewalOfferYet,
          rentGrowthAboveMarket: latestScore.rentGrowthAboveMarket,
        },
        triggerSource: 'MANUAL',
      });

      res.status(201).json(result);
    } catch (err) {
      console.error('[routes] Error creating renewal event:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /properties/:propertyId/webhook-status
// ---------------------------------------------------------------------------
router.get(
  '/properties/:propertyId/webhook-status',
  async (req: Request, res: Response) => {
    const { propertyId } = req.params;

    try {
      const deliveries = await prisma.webhookDeliveryState.findMany({
        where: { propertyId },
        include: {
          event: {
            select: {
              eventType: true,
              triggerSource: true,
              triggeredAt: true,
              residentId: true,
              payload: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      const summary = {
        total: deliveries.length,
        pending: deliveries.filter((d) => d.status === 'PENDING').length,
        delivered: deliveries.filter((d) => d.status === 'DELIVERED').length,
        failed: deliveries.filter((d) => d.status === 'FAILED').length,
        dlq: deliveries.filter((d) => d.status === 'DLQ').length,
      };

      res.json({ propertyId, summary, deliveries });
    } catch (err) {
      console.error('[routes] Error fetching webhook status:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /properties/:propertyId/renewal-risk/latest-job
// ---------------------------------------------------------------------------
router.get(
  '/properties/:propertyId/renewal-risk/latest-job',
  async (req: Request, res: Response) => {
    const { propertyId } = req.params;

    try {
      const job = await prisma.batchJob.findFirst({
        where: { propertyId },
        orderBy: { createdAt: 'desc' },
      });

      if (!job) {
        res.status(404).json({ error: 'No jobs found for this property' });
        return;
      }

      res.json({
        jobId:          job.id,
        propertyId:     job.propertyId,
        asOfDate:       job.asOfDate.toISOString().split('T')[0],
        triggerSource:  job.triggerSource,
        status:         job.status,
        createdAt:      job.createdAt.toISOString(),
        startedAt:      job.startedAt?.toISOString() ?? null,
        completedAt:    job.completedAt?.toISOString() ?? null,
        errorMessage:   job.errorMessage ?? null,
        totalResidents: job.totalResidents ?? null,
        flaggedCount:   job.flaggedCount ?? null,
        highCount:      job.highCount ?? null,
        mediumCount:    job.mediumCount ?? null,
        lowCount:       job.lowCount ?? null,
      });
    } catch (err) {
      console.error('[routes] Error fetching latest job:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /properties/:propertyId/renewal-risk/jobs/:jobId
// ---------------------------------------------------------------------------
router.get(
  '/properties/:propertyId/renewal-risk/jobs/:jobId',
  async (req: Request, res: Response) => {
    const { propertyId, jobId } = req.params;

    try {
      const job = await prisma.batchJob.findUnique({ where: { id: jobId } });

      if (!job || job.propertyId !== propertyId) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      const response: Record<string, unknown> = {
        jobId:         job.id,
        propertyId:    job.propertyId,
        asOfDate:      job.asOfDate.toISOString().split('T')[0],
        triggerSource: job.triggerSource,
        status:        job.status,
        createdAt:     job.createdAt.toISOString(),
        startedAt:     job.startedAt?.toISOString() ?? null,
        completedAt:   job.completedAt?.toISOString() ?? null,
        errorMessage:  job.errorMessage ?? null,
      };

      if (job.status === 'COMPLETED') {
        response.summary = {
          totalResidents: job.totalResidents,
          flaggedCount:   job.flaggedCount,
          riskTiers: {
            high:   job.highCount,
            medium: job.mediumCount,
            low:    job.lowCount,
          },
        };
      }

      res.json(response);
    } catch (err) {
      console.error('[routes] Error fetching job status:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
