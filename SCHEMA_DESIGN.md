# Renewal Risk Detection System - Schema Design Documentation

## Overview

This document explains the design decisions for the database schema supporting the Renewal Risk Detection System. The schema extends an existing ROP (Residential Operating Platform) data model with three new domains: risk scoring, event tracking, and webhook delivery state management.

---

## Core Design Principles

### 1. **Multi-Tenancy by Property**
All new tables include `property_id` as a required field. This allows:
- Data isolation per property without separate databases
- Efficient querying of property-specific data (indexed by `property_id`)
- Future support for per-property SLA/webhooks
- Simplifies operations and backup/restore

### 2. **Point-in-Time Accuracy**
Risk scores are calculated and stored with `as_of_date` to:
- Track historical risk assessment (e.g., "this resident was flagged on Jan 2")
- Support audit trails ("why was this action taken?")
- Enable comparison across time periods
- Prevent stale data confusion (risk scores for different lease conditions)

### 3. **Event Sourcing Pattern for Webhooks**
The system separates **events** (what happened) from **delivery state** (how we're delivering it):
- `RenewalEvent`: immutable event record with payload
- `WebhookDeliveryState`: mutable delivery status
- This allows replaying failed deliveries without recalculating risk

### 4. **ACID Semantics**
All critical operations use atomic transactions:
- Creating risk score + triggering webhook in same transaction (no orphaned events)
- Webhook state updates are isolated (no duplicate deliveries)
- Batch job status transitions are atomic

---

## Table Design Rationale

### **RenewalRiskScore** (Core Risk Data)

```sql
CREATE TABLE renewal_risk_scores (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL,     -- Multi-tenant isolation
  resident_id UUID NOT NULL,     -- Who is at risk
  lease_id UUID NOT NULL,        -- Which lease (for context)
  
  -- Risk calculation inputs (denormalized for query performance)
  risk_score INT,                -- 0-100 score
  risk_tier ENUM('HIGH', 'MEDIUM', 'LOW'),
  days_to_expiry INT,
  missed_rent_payments BOOLEAN,
  no_renewal_offer_yet BOOLEAN,
  rent_growth_above_market BOOLEAN,
  
  -- Audit trail
  as_of_date DATE,               -- Point in time
  calculated_at TIMESTAMP,       -- When computed
  
  UNIQUE(resident_id, as_of_date),  -- Only one score per resident per day
  INDEX (property_id, as_of_date DESC),  -- Query: get all risks for property on date X
  INDEX (property_id, risk_tier)         -- Query: filter by tier
);
```

**Why this structure:**

1. **Denormalized Risk Signals** (missed_rent_payments, no_renewal_offer_yet, etc.)
   - Avoids N+1 queries to reconstruct why someone was flagged
   - Stores the **inputs** at calculation time (not live data)
   - If ledger changes, old risk score remains accurate (point-in-time snapshot)

2. **UNIQUE(resident_id, as_of_date)**
   - Prevents duplicate risk calculations
   - Allows the batch job to be idempotent (retry won't create duplicates)
   - Forces one score per resident per day (clear semantics)

3. **Indexes for Common Queries**
   - `(property_id, as_of_date DESC)`: "Get all risks for property X on date Y" — dashboard load
   - `(property_id, risk_tier)`: "Filter dashboard by HIGH risk" — filtering

4. **Separate `json signals_json`** *(optional, if needed)*
   - Full signal detail (e.g., exact payment amounts, rent differential %)
   - Not queried directly, just for audit/debugging

**What We Don't Store:**
- Lease terms (live in `leases` table) — avoid duplication and staleness
- Current rent/market data (live in `unit_pricing` table) — single source of truth

---

### **RenewalEvent** (Immutable Event Record)

```sql
CREATE TABLE renewal_events (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  resident_id UUID NOT NULL,
  risk_score_id UUID NOT NULL,      -- Link to risk that triggered this
  event_type VARCHAR(50),            -- 'renewal.risk_flagged', etc.
  trigger_source ENUM('AUTO', 'MANUAL'),  -- Auto batch or manual manager action
  as_of_date DATE,                   -- Risk assessment date
  payload JSONB,                     -- Full webhook payload (immutable)
  triggered_at TIMESTAMP,            -- When event was created
  
  FOREIGN KEY (risk_score_id) REFERENCES renewal_risk_scores(id)
);
```

**Why this structure:**

1. **Immutable Payload**
   - Once created, the event never changes
   - Supports replay: if webhook delivery fails, we resend the **exact same payload**
   - No risk of accidental data corruption

2. **Risk Score ID Link**
   - Connects event to the risk assessment that triggered it
   - Enables: "click to see details of the risk calc that triggered this event"
   - Audit trail: what data was used?

3. **Trigger Source (AUTO vs MANUAL)**
   - AUTO: batch job runs daily, auto-triggers for HIGH risk
   - MANUAL: manager can click "Trigger Event" for any resident
   - Needed for analytics/audit ("which events are manual interventions?")

4. **No Delivery State in This Table**
   - Keeps event data pure
   - Delivery is a separate concern (see WebhookDeliveryState below)
   - If delivery fails, we don't mutate this record

---

### **WebhookDeliveryState** (Retry & Delivery Tracking)

```sql
CREATE TABLE webhook_delivery_state (
  id UUID PRIMARY KEY,
  event_id UUID UNIQUE NOT NULL,    -- 1:1 with RenewalEvent
  property_id UUID NOT NULL,        -- De-normalized for multi-tenant filtering
  target_url VARCHAR(500),          -- Where to send the webhook
  
  -- Delivery status
  status ENUM('PENDING', 'DELIVERED', 'FAILED', 'DLQ'),
  attempt_count INT DEFAULT 0,      -- Current attempt #
  max_attempts INT DEFAULT 5,       -- Stop after 5 failures
  last_attempt_at TIMESTAMP,        -- When did we last try?
  next_retry_at TIMESTAMP,          -- Exponential backoff: when to retry
  
  -- Failure details (for debugging)
  last_response_status INT,         -- HTTP 500, 503, timeout, etc.
  last_response_body TEXT,          -- Error message from RMS
  dlq_reason VARCHAR(500),          -- Why it was moved to DLQ
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (status, next_retry_at)  -- Query: "Get all PENDING events ready to retry"
);
```

**Why this structure:**

1. **1:1 Relationship with RenewalEvent (UNIQUE event_id)**
   - Each event has exactly one delivery record
   - Prevents accidental duplicate tracking
   - Simplifies foreign key constraints

2. **Exponential Backoff Tracking**
   - `next_retry_at`: Worker query = `SELECT * WHERE status='PENDING' AND next_retry_at <= NOW()`
   - Decouples retry decision from event data
   - Natural: "what's the next thing to do?"
   - Survives server restarts: timestamp is persisted

3. **Attempt Count + Max Attempts**
   - Prevents infinite retry loops
   - Clear stopping condition (after 5 failures → DLQ)
   - Configurable per deployment

4. **Failure Details**
   - `last_response_status`: HTTP 503? Network timeout? DNS?
   - `last_response_body`: RMS error message (helps debugging)
   - `dlq_reason`: Why was it abandoned? ("max_attempts_exceeded", "target_unreachable")

5. **De-normalized property_id**
   - Could query through event → risk → property, but that's slow
   - De-normalized for filtering by property (ops: "show me all DLQ messages for property X")

---

### **BatchJob** (Audit & Status Tracking)

```sql
CREATE TABLE batch_jobs (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  as_of_date DATE,                  -- Risk calc date
  trigger_source VARCHAR(50),       -- 'AUTO' or 'MANUAL'
  idempotency_key VARCHAR(255),     -- Prevents duplicates: UNIQUE(idempotency_key)
  
  -- Mutable status
  status ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  
  -- Summary stats (written at completion)
  total_residents INT,
  flagged_count INT,
  high_count INT,
  medium_count INT,
  low_count INT,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  INDEX (status, created_at DESC),  -- "Get recent jobs"
  INDEX (property_id, as_of_date DESC)  -- "Get job history for property"
);
```

**Why this structure:**

1. **Idempotency Key**
   - `UNIQUE(idempotency_key)` prevents duplicate batch jobs
   - Frontend can retry safely: if request fails, resend same key
   - Database enforces: "only one job per key"

2. **Status Transitions**
   - PENDING → RUNNING: job started
   - RUNNING → COMPLETED: success (write summary stats)
   - RUNNING → FAILED: error occurred (write error_message)
   - Dashboard polls: "is job done?" by checking status

3. **Summary Statistics**
   - Written **at completion**, not incrementally
   - Single truth: "on this date, we flagged 18 residents" (not "we've flagged 8 so far...")
   - API returns these to dashboard immediately

4. **Audit Trail**
   - timestamps: when job ran
   - trigger_source: why (AUTO schedule vs MANUAL manager click)
   - error_message: if failed, why?

---

## Query Patterns & Performance

### Pattern 1: Fetch all risks for property on a date
```sql
SELECT * FROM renewal_risk_scores
WHERE property_id = $1 AND as_of_date = $2
ORDER BY risk_tier DESC
INDEX: (property_id, as_of_date DESC)
```
✅ Efficient: single index lookup, no table scan

### Pattern 2: Dashboard filters by risk tier
```sql
SELECT * FROM renewal_risk_scores
WHERE property_id = $1 AND as_of_date = $2 AND risk_tier = $3
INDEX: (property_id, risk_tier)
```
✅ Efficient: index covers this query

### Pattern 3: Find webhook delivery work (retry worker)
```sql
SELECT * FROM webhook_delivery_state
WHERE status = 'PENDING' AND next_retry_at <= NOW()
ORDER BY next_retry_at ASC
INDEX: (status, next_retry_at)
```
✅ Efficient: single index range scan, orders by when to retry

### Pattern 4: Get batch job results
```sql
SELECT * FROM batch_jobs
WHERE property_id = $1 AND as_of_date = $2
```
✅ No problem: small table, used for summary only (not on hot path)

### N+1 Prevention
- Join risk score → resident → lease once (not loop per resident)
- Denormalize signals into risk_score table (don't re-query ledger)
- API response includes all needed fields (no secondary fetch for details)

---

## ACID & Transaction Design

### Critical Transaction: Trigger Renewal Event

```typescript
BEGIN TRANSACTION;

// 1. Check: Risk score exists and is recent
SELECT * FROM renewal_risk_scores
WHERE resident_id = $1 AND as_of_date >= DATE_SUB(NOW(), INTERVAL 7 DAY)
FOR UPDATE;  // Lock to prevent race condition

// 2. Create: Event (immutable)
INSERT INTO renewal_events 
  (id, resident_id, event_type, payload, triggered_at)
VALUES (...)
RETURNING id;

// 3. Create: Delivery state (initial status = PENDING)
INSERT INTO webhook_delivery_state
  (event_id, target_url, status, next_retry_at)
VALUES (...);

COMMIT;
```

**Why atomic:**
- If step 2 fails, delivery record is never created (no orphaned events)
- If step 3 fails, rollback deletes event (clean slate)
- Single point of failure: nothing left behind

**Why FOR UPDATE:**
- Locks risk score row while we're working
- Prevents two simultaneous triggers for same resident
- Lock is released on COMMIT

---

### Batch Job Idempotency

```typescript
BEGIN TRANSACTION;

// 1. Get or create batch job
INSERT INTO batch_jobs
  (property_id, as_of_date, idempotency_key, status)
VALUES ($1, $2, $3, 'PENDING')
ON CONFLICT (idempotency_key)
  DO UPDATE SET updated_at = NOW()
  RETURNING id;

// 2. If newly created, proceed to scoring
// If already exists (conflict), re-use existing job ID
// Allows retry: same request = same job

COMMIT;
```

**Why idempotency_key:**
- Frontend times out: they re-submit the request
- Database ignores duplicate: one job created
- Worker processes same idempotency_key: no double-calculation

---

## Design Tradeoffs & Decisions

### ✅ Denormalize Risk Signals Into RenewalRiskScore

**Decision:** Store `days_to_expiry`, `no_renewal_offer_yet`, etc. directly in risk_score, instead of querying them live.

**Tradeoff:**
- ✅ Faster dashboard loads (no joins, no re-calculation)
- ✅ Immutable audit trail (score explains itself)
- ❌ Takes more storage (repeted data)
- ❌ Must recalculate if logic changes

**Why this wins:** This is a **read-heavy** system (dashboard polls every 3s). One slow query hurts UX. Recalculation is rare and deliberate.

---

### ✅ Separate RenewalEvent from WebhookDeliveryState

**Decision:** Events are immutable records. Delivery is mutable state.

**Tradeoff:**
- ✅ Can replay failed deliveries (same payload)
- ✅ Event data is never corrupted
- ✅ Clear separation of concerns
- ❌ One extra table

**Why this wins:** Webhooks fail. We **must** retry. Event data must never change to ensure idempotency.

---

### ✅ Exponential Backoff Via `next_retry_at`

**Decision:** Store the next retry time, not just attempt count.

**Tradeoff:**
- ✅ Worker doesn't calculate delays (just query by timestamp)
- ✅ Survives restarts (timestamp is persisted)
- ✅ Natural for DB queries
- ❌ Takes one more column

**Why this wins:** Simplifies the retry worker. No complex scheduling logic.

---

### ✅ De-normalize property_id in WebhookDeliveryState

**Decision:** Even though we can get property_id via event -> risk -> property, we store it directly.

**Tradeoff:**
- ✅ Fast property-specific queries (ops: "show DLQ for property X")
- ✅ No joins needed
- ❌ Data duplication (can drift if not careful)

**Why this wins:** Webhooks are on the hot path. 5-10ms query must be <1ms. De-normalization is worth it.

---

## Scaling Considerations

### Current Design Supports:
- **5000+ residents per property** (indexed queries stay <100ms)
- **1000+ events/day** (batch job runs at night; events spread across day)
- **Multi-property (100+)** (property_id is always indexed)

### If We Needed to Scale Further:

1. **Batch Job Summary Table** (if daily stats are queried frequently)
   - Keep `batch_jobs` but add materialized view of `(property_id, month, total_flagged)`
   - Re-compute daily, serve stale (acceptable for analytics)

2. **Webhook Delivery Partitioning** (if millions of events/day)
   - Partition by `created_at` (monthly or weekly)
   - Retry worker reads current partition only
   - Old partitions become cold archive

3. **Risk Score Archive** (if we keep 2+ years of history)
   - Move scores >90 days old to separate `renewal_risk_scores_archive` table
   - Keep hot data (last 90 days) in main table with tight indexes

---

## Security & Data Integrity

### PII Handling
- Resident names are denormalized into risk_score for display
- Not PHI/PII concerns in renewable leases (no SSN, health data)
- Webhook payloads include minimal data (score, tier, signals)

### Webhook Signing
- Not stored in schema (handled by application)
- HMAC-SHA256 of payload using property-specific secret
- RMS validates signature before processing (prevents tampering)

### Access Control
- All queries filtered by `property_id` (multi-tenant isolation)
- No natural join paths to leak data across properties
- Application layer enforces auth (user → property ownership)

---

## Summary

| Table | Purpose | Key Insight |
|-------|---------|------------|
| `renewal_risk_scores` | Store risk snapshot | Denormalized signals for fast reads; point-in-time accuracy |
| `renewal_events` | Immutable event log | Separate from delivery state; supports replay |
| `webhook_delivery_state` | Retry tracking | Exponential backoff via `next_retry_at`; ideal for worker queries |
| `batch_jobs` | Audit & status | Idempotency key prevents doubles; summary stats at completion |

**Design Philosophy:** Optimize for **reads** (dashboard), **reliability** (webhook retry), and **auditability** (every decision tracked). Denormalization is justified by the read-heavy nature of the system.
