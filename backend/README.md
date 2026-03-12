# Backend — Renewal Risk Detection API

Express + TypeScript + Prisma service for computing renewal risk scores and delivering webhook events.

## What this backend does

1. **Calculates risk scores** for residents (based on lease expiry, payment history, rent increases, offers)
2. **Triggers webhooks** to notify external RMS when residents are at risk
3. **Retries failed webhooks** automatically until success or 5 attempts max

---

## How it works (the actual flow)

### When you POST `/calculate`:
```
1. Frontend: POST /properties/{propertyId}/renewal-risk/calculate
2. Backend API: Creates a BatchJob record (status=PENDING) → returns 202
3. Dashboard: Starts polling GET /latest-job every 3 seconds
4. Job Worker (background): Picks up the PENDING job
   - Fetches all residents for that property
   - Calculates risk score for each
   - Saves scores to renewal_risk_scores table
   - Auto-triggers webhooks for HIGH-risk residents
5. Job Worker: Updates job status to COMPLETED
6. Dashboard: Detects completion → shows risk table
```

### When you click "Trigger Event":
```
1. Frontend: POST /properties/{propertyId}/residents/{residentId}/renewal-event
2. Backend API: Creates RenewalEvent + WebhookDeliveryState (status=PENDING)
3. Retry Worker (background, automatic):
   - Every 5 seconds: checks for PENDING/FAILED deliveries
   - Tries HTTP POST to RMS webhook URL
   - If fails → sets nextRetryAt + increments attemptCount
   - If succeeds → marks DELIVERED
   - After 5 failures → moves to DLQ
4. RMS webhook endpoint: Receives the HTTP POST (if successful)
```

**Key insight:** The Retry Worker is NOT called by frontend. It runs automatically in the background.

---

## Architecture

```
backend/
├── prisma/
│   ├── schema.prisma           # DB schema
│   └── seed.ts                 # Sample data
├── src/
│   ├── api/
│   │   └── routes.ts           # REST endpoints
│   ├── services/
│   │   ├── riskScoring.ts      # Calculates risk scores
│   │   └── jobWorker.ts        # Background: processes PENDING batch jobs
│   ├── webhooks/
│   │   ├── webhookService.ts   # Creates events + delivery records
│   │   ├── deliveryClient.ts   # Sends HTTP to RMS + handles retry logic
│   │   ├── retryWorker.ts      # Background: retries FAILED deliveries
│   │   └── eventRegistry.ts    # Event type configs
│   └── index.ts                # Server entry point
└── package.json
```

**Two background workers running:**
- **Job Worker** (every 5 seconds): Processes PENDING batch jobs
- **Retry Worker** (every 5 seconds): Retries failed webhook deliveries

Both are started when the server starts (`src/index.ts` lines 38-39).

---

## Setup

### With Docker Compose (recommended)

```bash
docker-compose up --build

# First-time setup
docker compose exec backend npx prisma db push
docker compose exec backend npx prisma db seed
```

### Local (without Docker)

```bash
# 1. Start Postgres
docker run -d \
  -e POSTGRES_USER=rdp \
  -e POSTGRES_PASSWORD=rdp_secret \
  -e POSTGRES_DB=rdp_db \
  -p 5432:5432 \
  postgres:15

# 2. Backend
cd backend
npm install

# Create .env
cat > .env << 'EOF'
DATABASE_URL=postgresql://rdp:rdp_secret@localhost:5432/rdp_db
RMS_WEBHOOK_URL=http://localhost:3001/webhook
WEBHOOK_SECRET=super_secret_webhook_key
PORT=3000
EOF

# Initialize DB
npx prisma db push
npm run db:seed

# Start server
npm run dev
```

### Scripts

| Command | What it does |
|---------|------------|
| `npm run dev` | Start server with hot reload (ts-node) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled code |
| `npm run db:seed` | Reset + seed sample data |
| `npm run db:studio` | Open Prisma GUI for database |

---

## API Endpoints

All endpoints are under `/api/v1`.

### POST `/properties/:propertyId/renewal-risk/calculate`

**What it does:** Enqueue a batch job to calculate risk for all residents.

**Request body:** `{ "asOfDate": "2026-03-12" }` (optional, defaults to today)

**Response (202 Accepted):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "PENDING",
  "propertyId": "abc-123",
  "asOfDate": "2026-03-12",
  "triggerSource": "AUTO"
}
```

**Important:** If you call this endpoint twice with the same `asOfDate`, it reuses the existing job (doesn't create a duplicate). This is idempotent by design.

**How to track progress:**
```bash
# Poll this endpoint every 3 seconds
curl http://localhost:3000/api/v1/properties/abc-123/renewal-risk/latest-job
```

---

### GET `/properties/:propertyId/renewal-risk/latest-job`

**What it does:** Get the most recent batch job for a property (returns its current status).

**Response (200):**
```json
{
  "jobId": "...",
  "propertyId": "abc-123",
  "asOfDate": "2026-03-12",
  "status": "COMPLETED",
  "totalResidents": 4,
  "flaggedCount": 2,
  "highCount": 1,
  "mediumCount": 1,
  "lowCount": 2,
  "startedAt": "2026-03-12T10:00:05Z",
  "completedAt": "2026-03-12T10:00:15Z"
}
```

**Status values:** `PENDING` (waiting) → `RUNNING` (in progress) → `COMPLETED` (done) or `FAILED` (error)

---

### GET `/properties/:propertyId/renewal-risk?tier=HIGH`

**What it does:** Get calculated risk scores for all residents (optionally filtered by tier).

**Query params:** `tier=HIGH|MEDIUM|LOW` (optional, case-insensitive)

**Response (200):**
```json
{
  "propertyId": "abc-123",
  "scores": [
    {
      "residentId": "...",
      "residentName": "Jane Doe",
      "unitNumber": "101",
      "leaseEndDate": "2026-04-15",
      "monthlyRent": 1450,
      "marketRent": 1600,
      "riskScore": 85,
      "riskTier": "HIGH",
      "signals": {
        "daysToExpiry": 34,
        "missedRentPayments": false,
        "noRenewalOfferYet": true,
        "rentGrowthAboveMarket": true
      }
    }
  ]
}
```

---

### POST `/properties/:propertyId/residents/:residentId/renewal-event`

**What it does:** Manually trigger a webhook event for a specific resident.

**Request body:** `{}` (empty)

**Response (201 Created):**
```json
{
  "eventId": "...",
  "status": "pending"
}
```

**How it works:**
1. API looks up the latest risk score for that resident
2. If found → creates RenewalEvent + WebhookDeliveryState (PENDING)
3. Retry Worker picks it up and delivers the webhook

**Response (404):**
```json
{
  "error": "No risk score found for this resident. Run /calculate first."
}
```

---

### GET `/properties/:propertyId/webhook-status`

**What it does:** Check delivery status of all webhook events for a property.

**Response (200):**
```json
{
  "propertyId": "abc-123",
  "summary": {
    "total": 5,
    "pending": 1,
    "delivered": 3,
    "failed": 1,
    "dlq": 0
  },
  "deliveries": [
    {
      "id": "...",
      "eventId": "...",
      "status": "DELIVERED",
      "attemptCount": 1,
      "lastAttemptAt": "2026-03-12T10:00:20Z",
      "lastResponseStatus": 200,
      "event": {
        "eventType": "renewal.risk_flagged",
        "triggerSource": "MANUAL",
        "triggeredAt": "2026-03-12T10:00:10Z"
      }
    }
  ]
}
```

**Status meanings:**
- `PENDING`: Waiting to be delivered (or waiting for next retry)
- `DELIVERED`: Successfully sent to RMS (got 2xx response)
- `FAILED`: Still retrying (attempt < 5)
- `DLQ`: Abandoned after 5 failed attempts

---

## Risk Scoring Formula

| Signal | Points | How it's calculated |
|--------|--------|-------------------|
| Days to lease expiry | 0–40 | `40 × max(0, 1 − days/120)` — full points if lease expires in <4 months |
| Missed rent payments | 0–25 | 25 points if any missed payments in last 6 months |
| No renewal offer | 0–20 | 20 points if no pending/accepted offer yet |
| Rent above market | 0–15 | 15 points if market rent is >10% higher than current rent |

**Total score:** 0–100

**Tiers:**
- **HIGH:** 70+ (at risk)
- **MEDIUM:** 40–69 (moderate risk)
- **LOW:** <40 (low risk)

---

## How Webhook Delivery Works

When an event is created (either AUTO or MANUAL), the backend:
1. Creates a `RenewalEvent` record
2. Creates a `WebhookDeliveryState` with status=PENDING → nextRetryAt=NOW
3. Retry Worker picks it up immediately

**If the RMS endpoint responds with 2xx:** DELIVERED ✅

**If the RMS endpoint fails:**
```
Attempt 1: Fails → Wait 1 second
Attempt 2: Fails → Wait 2 seconds
Attempt 3: Fails → Wait 4 seconds
Attempt 4: Fails → Wait 8 seconds
Attempt 5: Fails → Move to DLQ (no more retries)
```

**Each webhook is signed:**
```
Header: X-RMS-Signature: sha256=<hmac>
Body: JSON payload with eventId, timestamp, resident data
```

The RMS should verify the signature using the shared secret.

---

## Background Workers (Automatic)

### Job Worker
- **Runs:** Every 5 seconds automatically
- **Does:** Picks up PENDING BatchJobs and calculates risk scores
- **Result:** Updates batch_jobs table with status=COMPLETED|FAILED
- **Idempotency:** Uses unique constraint on (residentId, asOfDate) to prevent duplicates

### Retry Worker  
- **Runs:** Every 5 seconds automatically
- **Does:** Finds PENDING|FAILED deliveries with nextRetryAt <= NOW
- **Result:** Attempts HTTP POST to RMS webhook
- **Backoff:** Exponential (1s → 2s → 4s → 8s → 16s)
- **Abandonment:** After 5 attempts, moves to DLQ

**Important:** Both workers run INSIDE the Express process. If the server crashes, the workers stop (but data persists in DB). This is fine for development. For production, run workers in a separate service.

---

## Data Integrity

✅ **Batch jobs are idempotent:**
- Calling `/calculate` twice with the same `asOfDate` reuses the existing job (doesn't create a duplicate)
- Unique constraint on `idempotencyKey` prevents duplicate jobs

✅ **Risk scores are updated, not duplicated:**
- Risk scores use unique constraint on (residentId, asOfDate)
- Rerunning the same job upserts (updates or inserts) the scores
- Each resident has at most ONE score per date

✅ **Webhook deliveries are fully tracked:**
- Every delivery attempt is logged with attempt_count, lastAttemptAt, lastResponseStatus
- Delivery history never deleted (can't delete after 5 failures)

✅ **Transactions are atomic:**
- Event + DeliveryState created together in a transaction
- No orphaned records

---

## Testing Locally

### 1. Create a webhook receiver (test endpoint)

```bash
# Option A: Python
python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        print('✅ Webhook received!')
        print(json.dumps(json.loads(body), indent=2))
        print('Signature:', self.headers.get('X-RMS-Signature'))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
http.server.HTTPServer(('', 3001), H).serve_forever()
"

# Option B: Or use https://webhook.site and update RMS_WEBHOOK_URL in .env
```

### 2. Trigger an event

```bash
# Get property ID from console output during npm run db:seed
PROPERTY_ID="..."
RESIDENT_ID="..."

# Calculate risk
curl -X POST http://localhost:3000/api/v1/properties/$PROPERTY_ID/renewal-risk/calculate

# Check status
curl http://localhost:3000/api/v1/properties/$PROPERTY_ID/renewal-risk/latest-job

# Manually trigger event
curl -X POST http://localhost:3000/api/v1/properties/$PROPERTY_ID/residents/$RESIDENT_ID/renewal-event

# Check webhook status
curl http://localhost:3000/api/v1/properties/$PROPERTY_ID/webhook-status
```

### 3. Test webhook retry (simulate failures)

```bash
# Set RMS_WEBHOOK_URL to a bad endpoint
export RMS_WEBHOOK_URL="http://localhost:9999/webhook"

# Trigger an event
curl -X POST http://localhost:3000/api/v1/properties/$PROPERTY_ID/residents/$RESIDENT_ID/renewal-event

# Watch /webhook-status
# You'll see: PENDING → FAILED → FAILED → ... → DLQ
```

---

## Health Check

```bash
curl http://localhost:3000/health

# Response:
# {"status": "ok", "timestamp": "2026-03-12T10:00:00.000Z"}
```

---

## Production Considerations

⚠️ **Current limitations:**
- Background workers run in-process (stop if server crashes, but data persists)
- No authentication on API endpoints
- No rate limiting

🚀 **For production, you would:**
1. Move workers to separate services (Redis queues, Kubernetes jobs, Lambda, etc.)
2. Add user authentication (OAuth, JWT)
3. Add rate limiting per property
4. Add monitoring & alerting
5. Use environment variables for all secrets
6. Run migrations with versioning (Prisma migrations folder)

---

## See Also

- Root [`README.md`](../README.md) for full system documentation
- [`SCHEMA_DESIGN.md`](../SCHEMA_DESIGN.md) for database table documentation
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) for detailed design decisions
