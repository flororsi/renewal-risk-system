/**
 * Risk Scoring Service
 *
 * Calculates renewal risk scores for all active residents with active leases
 * at a given property, as of a reference date.
 *
 * Scoring formula:
 *   - Days to expiry:      up to 40pts  (linear: 40 * max(0, 1 - days/120))
 *   - Missed rent payments: 25pts       (if rent payments in last 6mo < rent charges)
 *   - No renewal offer:    20pts        (no pending/accepted offer)
 *   - Rent above market:   15pts        (if market_rent > monthly_rent * 1.10)
 *
 * Tiers: HIGH >= 70, MEDIUM 40–69, LOW < 40
 * Flagged = HIGH + MEDIUM
 */

import { RiskTier } from '@prisma/client';
import { createAndDeliver, autoEventExists } from '../webhooks/webhookService';
import { prisma } from '../db';

export interface RiskSignals {
  daysToExpiryDays: number;
  paymentHistoryDelinquent: boolean;
  noRenewalOfferYet: boolean;
  rentGrowthAboveMarket: boolean;
}

export interface ResidentRiskResult {
  residentId: string;
  residentName: string;
  name: string;          // alias for residentName (spec contract)
  unitNumber: string;
  unitId: string;        // alias for unitNumber (spec contract)
  leaseId: string;
  leaseEndDate: string;
  monthlyRent: number;
  marketRent: number | null;
  riskScore: number;
  riskTier: 'HIGH' | 'MEDIUM' | 'LOW';
  signals: RiskSignals;
  webhookEventId?: string;
}

export interface CalculateRiskResponse {
  propertyId: string;
  calculatedAt: string;
  totalResidents: number;
  flaggedCount: number;
  riskTiers: {
    high: number;
    medium: number;
    low: number;
  };
  flags: ResidentRiskResult[];
}

function computeDaysToExpiryScore(daysToExpiry: number): number {
  return Math.round(40 * Math.max(0, 1 - daysToExpiry / 120));
}

function computeTier(score: number): RiskTier {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

export async function calculateRiskForProperty(
  propertyId: string,
  asOfDate: Date
): Promise<CalculateRiskResponse> {
  // Fetch all active residents with active leases at this property
  const leases = await prisma.lease.findMany({
    where: {
      propertyId,
      status: 'active',
      resident: { status: 'active' },
    },
    include: {
      resident: true,
      unit: {
        include: {
          unitPricing: {
            orderBy: { effectiveDate: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const results: ResidentRiskResult[] = [];

  // Batch fetch signals upfront to avoid N+1 queries inside the loop
  const residentIds = leases.map((l) => l.resident.id);
  const leaseIds    = leases.map((l) => l.id);

  const sixMonthsAgo = new Date(asOfDate);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const allLedgerEntries = await prisma.residentLedger.findMany({
    where: {
      residentId:      { in: residentIds },
      transactionDate: { gte: sixMonthsAgo, lte: asOfDate },
    },
  });

  const allActiveOffers = await prisma.renewalOffer.findMany({
    where: {
      leaseId: { in: leaseIds },
      status:  { in: ['pending', 'accepted'] },
    },
  });

  // Build O(1) lookup maps
  const ledgerByResident = new Map<string, typeof allLedgerEntries>();
  for (const entry of allLedgerEntries) {
    if (!ledgerByResident.has(entry.residentId)) ledgerByResident.set(entry.residentId, []);
    ledgerByResident.get(entry.residentId)!.push(entry);
  }
  const offerByLease = new Set(allActiveOffers.map((o) => o.leaseId));

  for (const lease of leases) {
    const { resident, unit } = lease;

    // ---- Signal 1: Days to expiry ----
    const leaseEndDate = new Date(lease.leaseEndDate);
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysToExpiry = Math.max(
      0,
      Math.round((leaseEndDate.getTime() - asOfDate.getTime()) / msPerDay)
    );
    const expiryScore = computeDaysToExpiryScore(daysToExpiry);

    // ---- Signal 2: Payment delinquency (last 6 months) ----
    const ledgerEntries = ledgerByResident.get(resident.id) ?? [];
    const payments = ledgerEntries.filter((e) => e.transactionType === 'payment');
    const charges  = ledgerEntries.filter((e) => e.transactionType === 'charge' && e.chargeCode === 'rent');

    const expectedPayments = charges.length;
    const missedRentPayments = expectedPayments > 0 && payments.length < expectedPayments;
    const delinquencyScore = missedRentPayments ? 25 : 0;

    // ---- Signal 3: No renewal offer ----
    const noRenewalOfferYet = !offerByLease.has(lease.id);
    const offerScore = noRenewalOfferYet ? 20 : 0;

    // ---- Signal 4: Rent growth above market ----
    const latestPricing = unit.unitPricing[0];
    const monthlyRent = Number(lease.monthlyRent);
    const marketRent = latestPricing ? Number(latestPricing.marketRent) : null;

    let rentGrowthAboveMarket = false;
    let marketScore = 0;
    if (marketRent !== null) {
      // If market_rent > monthly_rent * 1.10 → resident pays below market → risk of not renewing at higher rate
      // Per the spec: (market_rent - monthly_rent) / monthly_rent > 0.10
      rentGrowthAboveMarket = (marketRent - monthlyRent) / monthlyRent > 0.1;
      marketScore = rentGrowthAboveMarket ? 15 : 0;
    }

    // ---- Total score & tier ----
    const riskScore = expiryScore + delinquencyScore + offerScore + marketScore;
    const riskTier = computeTier(riskScore);

    // ---- Upsert risk score ----
    const savedScore = await prisma.renewalRiskScore.upsert({
      where: {
        residentId_asOfDate: {
          residentId: resident.id,
          asOfDate,
        },
      },
      update: {
        riskScore,
        riskTier,
        daysToExpiry,
        missedRentPayments,
        noRenewalOfferYet,
        rentGrowthAboveMarket,
        signalsJson: { daysToExpiryDays: daysToExpiry, paymentHistoryDelinquent: missedRentPayments, noRenewalOfferYet, rentGrowthAboveMarket },
        calculatedAt: new Date(),
        leaseId: lease.id,
      },
      create: {
        propertyId,
        residentId: resident.id,
        leaseId: lease.id,
        riskScore,
        riskTier,
        daysToExpiry,
        missedRentPayments,
        noRenewalOfferYet,
        rentGrowthAboveMarket,
        signalsJson: { daysToExpiryDays: daysToExpiry, paymentHistoryDelinquent: missedRentPayments, noRenewalOfferYet, rentGrowthAboveMarket },
        asOfDate,
        calculatedAt: new Date(),
      },
    });

    // ---- Auto-trigger webhook for HIGH risk (idempotent) ----
    let webhookEventId: string | undefined;
    if (riskTier === 'HIGH') {
      const alreadyTriggered = await autoEventExists(resident.id, asOfDate);
      if (!alreadyTriggered) {
        const result = await createAndDeliver('renewal.risk_flagged', propertyId, {
          residentId: resident.id,
          riskScoreId: savedScore.id,
          riskScore,
          riskTier,
          signals: {
            daysToExpiry,
            missedRentPayments,
            noRenewalOfferYet,
            rentGrowthAboveMarket,
          },
          asOfDate,
          triggerSource: 'AUTO',
        });
        webhookEventId = result.eventId;
      }
    }

    const fullName = `${resident.firstName} ${resident.lastName}`;
    results.push({
      residentId: resident.id,
      residentName: fullName,
      name: fullName,
      unitNumber: unit.unitNumber,
      unitId: unit.unitNumber,
      leaseId: lease.id,
      leaseEndDate: leaseEndDate.toISOString().split('T')[0],
      monthlyRent,
      marketRent,
      riskScore,
      riskTier,
      signals: {
        daysToExpiryDays: daysToExpiry,
        paymentHistoryDelinquent: missedRentPayments,
        noRenewalOfferYet,
        rentGrowthAboveMarket,
      },
      webhookEventId,
    });
  }

  const highCount = results.filter((r) => r.riskTier === 'HIGH').length;
  const mediumCount = results.filter((r) => r.riskTier === 'MEDIUM').length;
  const lowCount = results.filter((r) => r.riskTier === 'LOW').length;
  const flagged = results.filter((r) => r.riskTier === 'HIGH' || r.riskTier === 'MEDIUM');

  return {
    propertyId,
    calculatedAt: asOfDate.toISOString(),
    totalResidents: results.length,
    flaggedCount: flagged.length,
    riskTiers: {
      high: highCount,
      medium: mediumCount,
      low: lowCount,
    },
    flags: flagged.sort((a, b) => b.riskScore - a.riskScore),
  };
}

export async function getLatestRiskScores(
  propertyId: string,
  tier?: string
): Promise<ResidentRiskResult[]> {
  const tierMap: Record<string, RiskTier> = {
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW',
  };
  const mappedTier = tier ? tierMap[tier.toLowerCase()] : undefined;

  // Single query: order by date desc, then filter in-memory to the latest date
  const allScores = await prisma.renewalRiskScore.findMany({
    where: {
      propertyId,
      ...(mappedTier ? { riskTier: mappedTier } : {}),
    },
    include: {
      resident: true,
      lease: {
        include: {
          unit: {
            include: {
              unitPricing: {
                orderBy: { effectiveDate: 'desc' },
                take: 1,
              },
            },
          },
        },
      },
    },
    orderBy: [{ asOfDate: 'desc' }, { riskScore: 'desc' }],
  });

  if (allScores.length === 0) return [];

  const latestDate = allScores[0].asOfDate;
  const scores = allScores.filter(
    (s) => s.asOfDate.getTime() === latestDate.getTime()
  );

  return scores.map((score) => {
    const marketRent = score.lease.unit.unitPricing[0]
      ? Number(score.lease.unit.unitPricing[0].marketRent)
      : null;

    const fullName = `${score.resident.firstName} ${score.resident.lastName}`;
    return {
      residentId: score.residentId,
      residentName: fullName,
      name: fullName,
      unitNumber: score.lease.unit.unitNumber,
      unitId: score.lease.unit.unitNumber,
      leaseId: score.leaseId,
      leaseEndDate: new Date(score.lease.leaseEndDate).toISOString().split('T')[0],
      monthlyRent: Number(score.lease.monthlyRent),
      marketRent,
      riskScore: score.riskScore,
      riskTier: score.riskTier as 'HIGH' | 'MEDIUM' | 'LOW',
      signals: {
        daysToExpiryDays: score.daysToExpiry,
        paymentHistoryDelinquent: score.missedRentPayments,
        noRenewalOfferYet: score.noRenewalOfferYet,
        rentGrowthAboveMarket: score.rentGrowthAboveMarket,
      },
    };
  });
}
