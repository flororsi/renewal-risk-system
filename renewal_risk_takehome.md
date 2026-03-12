# Sr. Full Stack Engineer Take-Home Project
## Renewal Risk Detection System for ROP

**Time Limit:** 2 hours  
**Deliverable:** Working feature with backend API, database schema, webhook delivery system, and React dashboard

---

## Context

You're building a critical feature for the Residential Operating Platform (ROP): a system that identifies residents at risk of not renewing their leases before it's too late to intervene.

**The Business Problem:**
- Property managers lose $2,400-3,200 per early move-out (30 days vacancy + re-leasing costs)
- They need to identify at-risk residents early enough to offer retention incentives
- Current system: no visibility until it's too late

**Your Job:**
Build the backend API, database schema, and React dashboard that surfaces at-risk residents and delivers renewal events to an external Revenue Management System (RMS) with guaranteed delivery.

---

## Requirements

### 1. Database Schema Design
You'll extend an existing ROP schema. We've provided core entities (Property, Unit, Resident, Lease). **Your responsibility:**

Design a minimal schema for:
- **Renewal Risk Score**: Store risk scores for each resident (calculated at a point in time)
- **Risk Signal Tracking**: Track the inputs to the risk calculation (days to expiry, payment history, engagement, etc.) so you understand why someone was flagged
- **Webhook Delivery State**: Track webhook attempts, failures, retry status, and delivery confirmation for audit/debugging

**Constraints:**
- Single PostgreSQL database, multi-tenant by property_id
- Think about query performance: you'll need to efficiently retrieve residents at risk for a given property
- ACID semantics matter: webhook state updates must be atomic

**Deliverable:** 
- SQL migration file (or TypeORM/Prisma schema definition)
- Document your design decisions: why these tables? Why this structure?

---

### 2. Renewal Risk Scoring API

**Endpoint: POST /api/v1/properties/:propertyId/renewal-risk/calculate**

Triggers the renewal risk batch job for a single property. Returns summary of residents flagged.

**Input:**
```json
{
  "propertyId": "prop-001",
  "asOfDate": "2025-01-02"
}
```

**Output:**
```json
{
  "propertyId": "prop-001",
  "calculatedAt": "2025-01-02T14:30:00Z",
  "totalResidents": 250,
  "flaggedCount": 18,
  "riskTiers": {
    "high": 8,
    "medium": 10,
    "low": 0
  },
  "flags": [
    {
      "residentId": "res-001",
      "name": "Jane Doe",
      "unitId": "unit-101",
      "riskScore": 85,
      "riskTier": "high",
      "daysToExpiry": 45,
      "signals": {
        "daysToExpiryDays": 45,
        "paymentHistoryDelinquent": false,
        "noRenewalOfferYet": true,
        "rentGrowthAboveMarket": false
      }
    }
  ]
}
```

**Risk Scoring Logic (You Design This):**
Use these signals to calculate a 0-100 risk score:
- **Days to lease expiry** (higher = more risk): Weight 40%
- **Payment delinquency** (missed/late payments): Weight 25%
- **No renewal offer yet** (haven't been offered renewal yet): Weight 20%
- **Market rent vs. actual rent** (if new market rent >> current rent, they may leave): Weight 15%

Example: Resident with 45 days to expiry (90/100 risk), no delinquency (0/25), no renewal offer (20/20), rent well below market (15/15) = 125 points, normalized to 85/100.

**Design decisions you'll need to make:**
- How do you handle edge cases (e.g., month-to-month residents)?
- How do you query efficiently across 5000+ residents without timeouts?
- Should the batch job run async or sync?

---

### 3. Renewal Risk Dashboard (React)

**Page: /properties/:propertyId/renewal-risk**

Display residents at risk. Minimal table with:
- Resident name
- Unit ID
- Days to lease expiry
- Risk score + tier (color-coded: red/yellow/green)
- Why they're flagged (expand to see signals)
- One action button: "Trigger Renewal Event" (see below)

**Table should:**
- Load from the API
- Show loading/error states
- Filter/sort by risk tier (optional, table stakes if you have time)

**Design note:** This is operational software for property managers. It needs to be functional and clear. Don't over-design; focus on usability.

---

### 4. Webhook Delivery System

**Critical Requirement:** Deliver renewal events to external RMS with p95 delivery within 2 seconds of the event.

**Setup:**
When a property manager clicks "Trigger Renewal Event" for a resident, your system must:

1. Create a renewal event (in the database)
2. Attempt to deliver a webhook to a pre-configured RMS endpoint
3. If it fails, retry with exponential backoff (1s, 2s, 4s, 8s, 16s)
4. After 5 failed attempts, move to a dead-letter queue (DLQ) for manual review
5. Ensure idempotency: if the same event is delivered twice, the RMS should handle it gracefully

**Webhook Payload:**
```json
{
  "event": "renewal.risk_flagged",
  "eventId": "evt-abc123",
  "timestamp": "2025-01-02T14:30:00Z",
  "propertyId": "prop-001",
  "residentId": "res-001",
  "data": {
    "riskScore": 85,
    "riskTier": "high",
    "daysToExpiry": 45,
    "signals": {
      "daysToExpiryDays": 45,
      "paymentHistoryDelinquent": false,
      "noRenewalOfferYet": true,
      "rentGrowthAboveMarket": false
    }
  }
}
```

**Your Responsibilities:**
- Design the webhook delivery state schema (how do you track attempts, failures, etc.?)
- Implement retry logic with exponential backoff
- Implement idempotency (how will you prevent duplicate deliveries?)
- Implement dead-letter queue handling
- Document how the RMS should validate webhook authenticity (request signing, etc.)

**Testing:**
Provide a mock RMS endpoint (or instructions for testing with a webhook.site-like service) that the evaluator can use to verify delivery.

---

### 5. Error Handling & Edge Cases

Think through and handle:
- What happens if the RMS endpoint is unreachable?
- What if a resident's lease has already expired?
- What if there's no market rent data available?
- What if the batch job is triggered twice simultaneously?

Document your decisions in a brief README.

---

## Tech Stack

**Backend:**
- Node.js + TypeScript
- Express or similar
- TypeORM, Prisma, or raw SQL (your choice, but show me you understand your queries)
- PostgreSQL

**Frontend:**
- React + TypeScript
- Minimal styling (Tailwind, styled-components, or vanilla CSS—doesn't matter)
- Fetch or axios for API calls

**Deployment/Testing:**
- Provide a way to run this locally (docker-compose or npm scripts)
- Seed script with sample data
- Simple instructions for manual testing

---

## Evaluation Rubric

We're looking for:

### Backend (60%)
- **Data Modeling** (15%): Schema design shows understanding of multi-tenancy, query patterns, and ACID semantics. Decisions are documented.
- **API Design** (15%): Clear, RESTful endpoints. Proper error handling and validation.
- **Webhook Delivery** (20%): Retry logic, exponential backoff, idempotency, DLQ. Shows you've thought about reliability.
- **Query Performance** (10%): Queries are indexed, efficient, and avoid N+1 problems.

### Frontend (25%)
- **Functionality** (15%): Dashboard loads data, displays it, handles errors and loading states.
- **UX** (10%): Clear, usable interface. Property managers should understand what they're looking at.

### Code Quality (15%)
- **Clarity & Maintainability**: Code is readable. Comments where necessary.
- **Error Handling**: Defensive programming. What could go wrong?
- **Testing Mindset**: You've thought about edge cases.

### Agentic Development (Bonus, 5%)
- Identify which parts were generated using AI tools (Claude, Cursor, etc.)
- In the follow-up, discuss tradeoffs: what did AI do well? What did you need to refine?
- This is a signal of pragmatism, not a penalty.

---

## What NOT to Do

- Don't over-engineer. A working feature beats a perfect architecture.
- Don't spend 30 minutes on styling. Functional > pretty.
- Don't implement features not in the requirements (auth, multi-property filters, advanced analytics).
- Don't leave dead code or half-finished ideas.

---

## Submission

Submit as a **single GitHub repository** (public or private, shared with us) containing:

```
.
├── backend/
│   ├── src/
│   │   ├── api/
│   │   ├── schema/
│   │   ├── services/
│   │   ├── webhooks/
│   │   └── index.ts
│   ├── migrations/
│   ├── package.json
│   └── README.md
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   └── App.tsx
│   ├── package.json
│   └── README.md
├── docker-compose.yml
└── README.md (root—instructions for running everything)
```

**Root README should include:**
- How to set up (docker-compose up, npm install, etc.)
- How to seed sample data
- How to test the renewal risk API
- How to test webhook delivery
- Any notes on design decisions or tradeoffs

---

## Questions?

If something is ambiguous, **make a decision and document it**. That's part of the test.

Good luck.
