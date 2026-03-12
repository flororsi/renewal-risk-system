# Renewal Risk Detection System - Architecture Documentation

## System Overview

The Renewal Risk Detection System is composed of three main layers:

```
┌─────────────────────────────────────────────────────────────┐
│                    React Dashboard (Frontend)               │
│  - View risk scores & properties at risk                    │
│  - Filter by risk tier                                      │
│  - Trigger renewal events manually                          │
└────────────────────┬────────────────────────────────────────┘
                     │ REST API (HTTP)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Express Backend (Node.js)                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  API Server                                          │  │
│  │  - POST /calculate (batch job)                       │  │
│  │  - GET /risks (dashboard data)                       │  │
│  │  - POST /trigger-event (manual renewal)              │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Worker Processes                                    │  │
│  │  - Retry Worker (webhook delivery)                   │  │
│  │  - Batch Worker (risk scoring)                       │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ SQL Queries / Transactions
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              PostgreSQL Database                            │
│  - renewal_risk_scores                                      │
│  - renewal_events                                           │
│  - webhook_delivery_state                                   │
│  - batch_jobs                                               │
│  - (existing ROP tables: properties, residents, leases...)  │
└─────────────────────────────────────────────────────────────┘
                     │ HTTPS Webhooks
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              External RMS (Revenue Management System)       │
│  - Receives renewal.risk_flagged events                     │
│  - Returns 200 OK or error                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1. Frontend (React)

**Location:** `frontend/src/`

**Key Components:**
- **RenewalRiskPage** (`pages/RenewalRiskPage.tsx`)
  - ✅ Polls `/api/v1/properties/:id/renewal-risk/latest-job` every 3 seconds
  - ✅ Loads risk scores from `/api/v1/properties/:id/renewal-risk`
  - ✅ Triggers daily batch job on mount (idempotent)
  - ✅ Shows batch job status (PENDING → RUNNING → COMPLETED)
  
- **RiskTable** (`components/RiskTable.tsx`)
  - ✅ Mobile-responsive (card view on sm screens, table on md+)
  - ✅ Expandable rows to show risk signals
  - ✅ "Trigger Event" button (calls POST /renewal-event)
  - ✅ Tier-based filtering (HIGH / MEDIUM / LOW)

- **SignalsDetail** (`components/SignalsDetail.tsx`)
  - ✅ Detailed breakdown of why resident was flagged
  - ✅ Shows all risk signals in formatted display

**Data Flow:**
1. Page mounts → Enqueue today's batch job (idempotent)
2. Poll latest job status every 3s
3. When job COMPLETED → Refresh risk scores
4. User clicks "Trigger Event" → POST with residentId
5. Toast notification (success/error)

**State Management:**
- React hooks (useState, useEffect, useCallback, useRef)
- No external state library needed (simple polling pattern)

---

### 2. Backend API Server

**Location:** `backend/src/api/`

**Endpoints:**

#### **POST /api/v1/properties/:propertyId/renewal-risk/calculate**
Enqueue a batch risk scoring job.

```
Request:
{
  "asOfDate": "2025-01-02",
  "triggerSource": "AUTO" | "MANUAL"
}

Response (202 Accepted):
{
  "jobId": "uuid",
  "status": "PENDING",
  "message": "Job queued. Check status via GET /latest-job"
}
```

**Implementation:**
1. Validate propertyId exists
2. Generate idempotency_key = `${propertyId}:${asOfDate}`
3. INSERT batch_job with UNIQUE(idempotency_key) → handles duplicates
4. Return jobId immediately (202)
5. Worker picks up job asynchronously

---

#### **GET /api/v1/properties/:propertyId/renewal-risk/latest-job**
Poll for batch job status.

```
Response:
{
  "jobId": "uuid",
  "status": "RUNNING",
  "asOfDate": "2025-01-02",
  "startedAt": "2025-01-02T10:30:00Z",
  "completedAt": null,
  "totalResidents": 250,
  "flaggedCount": 18,
  "highCount": 8,
  "mediumCount": 10,
  "lowCount": 0
}
```

**Implementation:**
```typescript
const job = await db.batchJob.findFirst({
  where: { propertyId },
  orderBy: { createdAt: 'desc' }
});
return job || 204 No Content;
```

---

#### **GET /api/v1/properties/:propertyId/renewal-risk?tier=HIGH**
Fetch risk scores (with optional tier filter).

```
Response:
{
  "scores": [
    {
      "residentId": "uuid",
      "residentName": "Jane Doe",
      "unitNumber": "101",
      "leaseEndDate": "2025-02-15",
      "monthlyRent": 1450,
      "marketRent": 1600,
      "riskScore": 85,
      "riskTier": "HIGH",
      "signals": {
        "daysToExpiryDays": 45,
        "paymentHistoryDelinquent": false,
        "noRenewalOfferYet": true,
        "rentGrowthAboveMarket": true
      }
    }
  ]
}
```

**Implementation:**
```typescript
let query = db.renewalRiskScore.findMany({
  where: { 
    propertyId,
    asOfDate: TODAY
  },
  include: { resident: true, lease: true }
});

if (tier) {
  query = query.where({ riskTier: tier });
}

return query.orderBy({ riskScore: 'desc' });
```

---

#### **POST /api/v1/properties/:propertyId/residents/:residentId/renewal-event**
Manually trigger a renewal event (manager action).

```
Request:
{}

Response (201 Created):
{
  "eventId": "uuid",
  "residentId": "uuid",
  "timestamp": "2025-01-02T14:30:00Z",
  "status": "pending_delivery"
}
```

**Implementation:**
1. Fetch latest risk score for resident (last 7 days)
2. If not found → 404 (not flagged recently)
3. Start transaction:
   - INSERT renewal_event (trigger_source='MANUAL')
   - INSERT webhook_delivery_state (status='PENDING', next_retry_at=NOW)
   - COMMIT
4. Return 201 with eventId

---

### 3. Backend Workers

**Location:** `backend/src/services/`

#### **Batch Worker** (`jobWorker.ts`)

Runs periodically or on-demand to calculate risk scores.

**Trigger:**
- Scheduled: Every night at 00:00 UTC (with AUTO trigger)
- Manual: POST /calculate endpoint

**Job Steps:**
1. START TRANSACTION
2. Lock batch_job row with FOR UPDATE
3. Set status='RUNNING', started_at=NOW
4. COMMIT

5. Fetch all residents for property (with active leases)
6. For each resident:
   - Calculate days_to_expiry
   - Fetch payment history (check for delinquency)
   - Check renewal offer status
   - Compare current rent vs market rent
   - Calculate risk score (0-100)
   - Determine risk tier (HIGH/MEDIUM/LOW)
7. Bulk INSERT into renewal_risk_scores
   - ON CONFLICT (resident_id, as_of_date) DO UPDATE
   - Handles re-runs gracefully

8. START TRANSACTION
9. Count flagged residents by tier
10. UPDATE batch_job:
    - status='COMPLETED'
    - completedAt=NOW
    - totalResidents=X, flaggedCount=Y, etc.
11. COMMIT

12. **Optionally:** Auto-trigger events for HIGH risk
    ```typescript
    for each HIGH-tier score:
      if (!eventExistsRecently(residentId, asOfDate)):
        createRenewalEvent(trigger_source='AUTO')
    ```

**Error Handling:**
- If batch job fails: UPDATE status='FAILED', errorMessage
- If event creation fails: Log, continue (don't block scoring)
- Timeout: Job has 5 min limit; if exceeds, mark FAILED

---

#### **Retry Worker** (`retryWorker.ts`)

Runs every 30 seconds (configurable) to retry failed webhook deliveries.

**Job Steps:**
1. Query webhook_delivery_state:
   ```sql
   WHERE status IN ('PENDING', 'FAILED')
         AND next_retry_at <= NOW()
   ORDER BY next_retry_at ASC
   LIMIT 100
   ```

2. For each delivery record:
   a. Fetch the associated RenewalEvent
   b. Attempt HTTP POST to target_url with payload
   c. If success (2xx):
      - UPDATE status='DELIVERED', updatedAt=NOW
   d. If client error (4xx):
      - UPDATE status='FAILED', dlq_reason='client_error', updatedAt=NOW
   e. If server error (5xx) or timeout:
      - If attempt_count >= max_attempts:
        * UPDATE status='DLQ', dlq_reason='max_attempts_exceeded'
      - Else:
        * INCREMENT attempt_count
        * CALCULATE next_retry_at = NOW + (2 ^ attempt_count) seconds
        * UPDATE status='PENDING', next_retry_at, lastAttemptAt=NOW

**Retry Schedule:**
```
Attempt 1: Immediate
Attempt 2: Wait 1s
Attempt 3: Wait 2s
Attempt 4: Wait 4s
Attempt 5: Wait 8s
Attempt 6: DLQ (max_attempts=5)
```

**Idempotency:**
- Each delivery has unique event_id (1:1)
- If webhook.site receives duplicate → merchant processes twice?
- RMS **must** implement idempotency key in request header
- Webhook includes eventId (RMS stores: "processed event-xyz-123")

---

## Data Flow Diagrams

### Flow 1: Batch Risk Scoring

```
Manager visits dashboard
          ↓
Frontend: POST /calculate (AUTO, idempotent)
          ↓
API: INSERT batch_job (status=PENDING)
     Return 202, jobId
          ↓
Dashboard: Start polling GET /latest-job every 3s
          ↓
Batch Worker: Picks up PENDING job
              Locks batch_job row
              Set status=RUNNING
              ↓
              Fetch residents → Calculate risk
              Bulk INSERT/UPDATE renewal_risk_scores
              ↓
              Count flagged by tier
              UPDATE batch_job (status=COMPLETED, stats)
              ↓
              [OPTIONAL] Auto-trigger HIGH-risk events
          ↓
Dashboard: Detects status=COMPLETED
           Refresh risk scores table
           Show: "250 residents, 18 flagged (8 HIGH)"
```

---

### Flow 2: Manual Event Trigger + Webhook Delivery

```
Manager clicks "Trigger Event" for resident Jane
          ↓
Frontend: POST /residents/:id/renewal-event
          ↓
API: Check: Is Jane flagged (risk score in last 7 days)?
     YES → START TRANSACTION
            INSERT renewal_event (trigger_source='MANUAL', payload={...})
            INSERT webhook_delivery_state (status='PENDING')
            COMMIT
     Return 201, eventId
          ↓
Frontend: Show toast "Renewal event created: evt-abc-123"
          ↓
Retry Worker: (every 30s)
              Query PENDING/FAILED deliveries with next_retry_at <= NOW
              Fetch renewal_event + payload
              ↓
              POST to RMS webhook URL with:
              { event: 'renewal.risk_flagged', eventId, timestamp, data }
              + HMAC-SHA256 signature
              ↓
              RMS Webhook Handler:
              1. Validate HMAC signature
              2. Check: "Have I processed eventId before?"
              3. If NO: Process (send SMS to manager, etc.)
              4. If YES: Silently return 200 (already handled)
              5. Return 200 OK
              ↓
              [SUCCESS] UPDATE webhook_delivery_state (status='DELIVERED')
              [FAILURE 5xx/timeout] Exponential backoff, retry up to 5x
              [FAILURE 4xx/invalid] Move to DLQ (manual review needed)
```

---

## Deployment Architecture

### Single-Process Deployment (Development)

```
docker-compose up
  ├─ PostgreSQL (port 5432)
  ├─ Backend Express (port 3000)
  │  └─ Batch Job Worker (runs in-process)
  │  └─ Retry Worker (runs in-process)
  └─ Frontend Dev Server (port 5173)
```

**How workers run:**
```typescript
// backend/src/index.ts
const app = express();

// Start API server
app.listen(3000);

// Start batch worker
startBatchWorker({ interval: 60_000 }); // Check every 1 min

// Start retry worker
startRetryWorker({ interval: 30_000 }); // Check every 30s
```

**Pros:**
- ✅ Simple for dev/testing
- ✅ No separate infra needed

**Cons:**
- ❌ Workers block API requests (not scalable)
- ❌ No high availability

---

### Production Deployment (Recommended)

```
Load Balancer (ELB/ALB)
      ↓
┌─────────────────────────┐
│  API Autoscaling Group  │
│  (3-5 instances)        │
│  - No workers           │
│  - Only API routes      │
└────────┬────────────────┘
         │
    ┌────┴─────────────────────────┐
    ↓                              ↓
┌──────────────────────┐   ┌──────────────────────┐
│  Batch Job Worker    │   │  Retry Worker        │
│  (1-2 instances)     │   │  (1-2 instances)     │
│  Node.js + Prisma    │   │  Node.js + Prisma    │
│  Runs: 0:00 UTC      │   │  Runs: Every 30s     │
│  + when triggered    │   │                      │
└──────────────────────┘   └──────────────────────┘
         │                         │
         └─────────────┬───────────┘
                       ↓
              PostgreSQL (RDS)
              - Multi-AZ backup
              - Read replicas
```

**Why separate workers:**
- API instances stay responsive (no background task blocking)
- Workers scale independently
- Can shut down workers without losing API availability
- Easy to add/remove workers based on load

**Deployment Options:**
1. **ECS/Fargate:** Run API + workers as separate services
2. **Kubernetes:** Deployment for API, CronJob for batch, Deployment for retry
3. **AWS Lambda:** Batch job as scheduled Lambda (5 min limit OK?)

---

## Error Handling Strategy

### API Errors

| Scenario | Status | Handling |
|----------|--------|----------|
| Property not found | 404 | Return error, log |
| Risk score >7 days old | 404 | Dashboard shows "no recent data" |
| Resident not at risk | 400 | "Cannot trigger event; not flagged" |
| Batch job already running | 409 | "Job in progress; check back in 30s" |
| Database connection lost | 503 | Retry middleware: 3x with backoff |

---

### Worker Errors

#### Batch Job Worker
```
TRY:
  Start transaction
  Lock batch_job
  Fetch residents
  Calculate scores
  Bulk insert
  Commit
CATCH error:
  Rollback transaction
  UPDATE batch_job (status='FAILED', error_message=error.msg)
  Alert ops (log ERROR level)
  [Do NOT retry automatically; manual intervention needed]
```

#### Retry Worker
```
TRY:
  POST webhook
CATCH:
  If 4xx error (client error):
    Move to DLQ immediately (no retry for bad requests)
  If 5xx or timeout:
    Increment attempt_count
    If attempt_count < 5:
      Calculate next_retry = NOW + (2^attempt_count)
      Update next_retry_at
    Else:
      Move to DLQ
      Create alert for ops
```

---

## Rate Limiting & Throttling

### API Rate Limits (per property)

```typescript
// Limit risk calculations to 10/hour per property
POST /calculate: 10 per hour
GET /risks: 60 per minute
POST /trigger-event: 100 per minute
```

**Implementation:**
```typescript
import rateLimit from 'express-rate-limit';

const calcLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.params.propertyId
});

app.post('/properties/:propertyId/renewal-risk/calculate', 
  calcLimiter, 
  handleCalculate);
```

---

### Webhook Rate Limits

**Retry Worker:**
- Max 100 delivery records processed per cycle (30s)
- Max 10 webhook requests per second (to RMS)
- Circuit breaker: if RMS returns 429, backoff 5 min

---

## Monitoring & Observability

### Metrics to Track

```
1. Batch Job Success Rate
   - Counter: batch_jobs_completed
   - Counter: batch_jobs_failed
   - Gauge: batch_job_duration_seconds

2. Webhook Delivery
   - Counter: webhook_delivered
   - Counter: webhook_failed
   - Counter: webhook_dlq
   - Gauge: webhook_retry_attempts (avg)
   - Gauge: webhook_pending_count (how many waiting)

3. API Performance
   - Histogram: api_request_duration_seconds
   - Counter: api_errors_total (by status code)
   - Gauge: active_requests

4. Data Quality
   - Gauge: flagged_residents_count (by property, tier)
   - Gauge: renewal_events_created_total
```

### Logging

```typescript
// Example: Batch job completion
logger.info('Batch job completed', {
  jobId,
  propertyId,
  totalResidents,
  flaggedCount,
  durationMs,
  status: 'success'
});

// Example: Webhook retry
logger.warn('Webhook retry', {
  eventId,
  attemptCount,
  nextRetryAt,
  lastResponse: { status: 503, body: '...' }
});
```

---

## Security Considerations

### API Security

1. **Authentication:** (Not in scope for this exercise, but in production)
   - JWT token in Authorization header
   - User → Property mapping enforced
   - Rate limiting per user

2. **Input Validation:**
   ```typescript
   POST /calculate: Validate asOfDate is ISO 8601 date
   GET /risks?tier=HIGH: Validate tier is enum
   ```

3. **SQL Injection Prevention:** Use Prisma (parameterized queries)

---

### Webhook Security

1. **HMAC Signing:**
   ```typescript
   const signature = crypto
     .createHmac('sha256', WEBHOOK_SECRET)
     .update(JSON.stringify(payload))
     .digest('base64');
   
   headers: { 'X-Webhook-Signature': signature }
   ```

2. **RMS Validation:**
   ```typescript
   // In RMS webhook handler
   const signature = request.headers['x-webhook-signature'];
   const computed = hmac(payload, secret);
   if (signature !== computed) {
     return 403 Unauthorized;
   }
   ```

3. **Idempotency Key in Request:**
   ```typescript
   headers: { 'Idempotency-Key': eventId }
   ```

---

## Scaling Considerations

### Horizontal Scaling

**API Server:**
- Stateless → Scale with load balancer
- Add 3-5 instances behind ALB
- No shared state (except database)

**Batch Worker:**
- Run on schedule: 1 instance per property cluster
- OR: Single instance, processes all properties sequentially
- Alternative: Kafka/SQS to distribute jobs

**Retry Worker:**
- Single instance sufficient (queries database)
- Parallel workers possible if query rate exceeds capacity
- Use database advisory lock to prevent duplicate processing

---

### Database Scaling

| Load | Solution |
|------|----------|
| < 1000 residents | Single PostgreSQL instance |
| 1000-10k residents | Read replicas for analytics |
| 10k+ residents | Partition by property_id, shard |

---

## Disaster Recovery

### Backup Strategy

1. **Database:**
   - Daily automated snapshots (AWS RDS)
   - Point-in-time recovery enabled (7 days)

2. **Event Log (Audit Trail):**
   - renewal_events table is immutable, never deleted
   - Webhook delivery state kept for 90 days minimum

3. **Idempotency:**
   - Allows safe replay: re-run batch job, re-trigger events
   - RMS must store processed eventIds (their responsibility)

---

### Failure Scenarios

| Scenario | Recovery |
|----------|----------|
| API crashes | Load balancer routes to healthy instance |
| Batch job fails mid-run | Rollback transaction; re-run from start (idempotent) |
| Webhook delivery fails | Retry worker keeps trying (5 attempts) |
| RMS is down | Webhooks go to DLQ; manager retries later |
| Database fails | RDS failover to replica (automatic, <1 min) |

---

## Summary Table

| Component | Technology | Purpose | Scaling |
|-----------|------------|---------|---------|
| Frontend | React + TypeScript | Dashboard UI | CDN + static hosting |
| API Server | Express + Prisma | REST endpoints | Horizontal (no state) |
| Batch Worker | Node.js + Cron | Risk calculation | Per-property or scheduled |
| Retry Worker | Node.js loop | Webhook delivery | Single or parallel |
| Database | PostgreSQL | Full data store | RDS with replicas |
| External | RMS webhook | Consumes events | Partner responsibility |

---

## Next Steps for Production

1. **Authentication:** Add OAuth/JWT to API
2. **Monitoring:** Set up DataDog/CloudWatch + alerts
3. **Load Testing:** Verify 5000+ residents, 1000+ events/day
4. **Disaster Recovery:** Test failover, document runbooks
5. **Compliance:** Review GDPR/HIPAA if applicable (resident PII)
6. **Testing:** Add integration tests for webhook flows
7. **Documentation:** Update RMS integration guide with secrets, signing, idempotency
