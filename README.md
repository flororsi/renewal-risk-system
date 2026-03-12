# Renewal Risk Detection System

A full-stack feature for the Residential Operating Platform (ROP) that identifies residents at risk of not renewing their leases, surfaces them in a React dashboard, and delivers renewal events to an external Revenue Management System (RMS) via webhooks with automatic retry logic and dead-letter queue for failed deliveries.

---

## Architecture Overview

```
rdp-system/
├── backend/             Express + TypeScript + Prisma
│   ├── prisma/          Schema + seed data
│   └── src/
│       ├── api/         REST endpoints
│       ├── services/    Risk scoring logic
│       └── webhooks/    Event registry, delivery client, retry worker
├── frontend/            Vite + React + Tailwind CSS
└── docker-compose.yml   Postgres + backend + frontend
```

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 18+ (for local development without Docker)

### With Docker Compose

```bash
cd rdp-system
docker-compose up --build
```

Services:
- Postgres: `localhost:5432`
- Backend API: `http://localhost:3000`
- Frontend: `http://localhost:5173`

**First-time setup** — run these after containers are up:

```bash
docker compose exec backend npx prisma db push
docker compose exec backend npx prisma db seed
```

### Run frontend and backend separately (without Docker)

**Terminal 1 — Backend**
```bash
cd backend
npm install
npm run dev
```

**Terminal 2 — Frontend**
```bash
cd frontend
npm install
npm run dev
```

---

### Local Development (without Docker)

**1. Start Postgres**
```bash
docker run -d \
  -e POSTGRES_USER=rdp \
  -e POSTGRES_PASSWORD=rdp_secret \
  -e POSTGRES_DB=rdp_db \
  -p 5432:5432 \
  postgres:15
```

**2. Backend**
```bash
cd backend
npm install

# Create .env file
cat > .env << 'EOF'
DATABASE_URL=postgresql://rdp:rdp_secret@localhost:5432/rdp_db
RMS_WEBHOOK_URL=http://localhost:3001/webhook
WEBHOOK_SECRET=super_secret_webhook_key
PORT=3000
EOF

# Push schema and seed
npx prisma db push
npm run db:seed

# Start dev server
npm run dev
```

**3. Frontend**
```bash
cd frontend
npm install
npm run dev
```

Visit `http://localhost:5173`, paste the property ID printed by the seed script.

---

## Database Migrations

```bash
cd backend

# Push schema to DB (no migration files, good for development)
npx prisma db push

# Generate Prisma client
npx prisma generate

# Open Prisma Studio (database GUI)
npm run db:studio

# Seed test data
npm run db:seed
```

---

## API Reference

Replace `{propertyId}` with the UUID printed by `npm run db:seed`.

### Calculate renewal risk

Computes risk scores for all active residents at a property and auto-triggers webhooks for HIGH-risk residents.

```bash
curl -s -X POST http://localhost:3000/api/v1/properties/{propertyId}/renewal-risk/calculate \
  -H "Content-Type: application/json" \
  -d '{"asOfDate": "2026-03-11"}' | jq .
```

Response:
```json
{
  "propertyId": "...",
  "asOfDate": "2026-03-11",
  "totalResidents": 4,
  "flaggedCount": 3,
  "riskTiers": { "high": 2, "medium": 1, "low": 1 },
  "flags": [
    {
      "residentId": "...",
      "residentName": "Jane Smith",
      "unitNumber": "101",
      "leaseEndDate": "2026-03-26",
      "riskScore": 85,
      "riskTier": "HIGH",
      "signals": {
        "daysToExpiry": 15,
        "paymentHistoryDelinquent": true,
        "noRenewalOfferYet": true,
        "rentGrowthAboveMarket": true
      }
    }
  ]
}
```

### Get latest risk scores

```bash
# All tiers
curl -s http://localhost:3000/api/v1/properties/{propertyId}/renewal-risk | jq .

# Filter by tier
curl -s "http://localhost:3000/api/v1/properties/{propertyId}/renewal-risk?tier=high" | jq .
curl -s "http://localhost:3000/api/v1/properties/{propertyId}/renewal-risk?tier=medium" | jq .
curl -s "http://localhost:3000/api/v1/properties/{propertyId}/renewal-risk?tier=low" | jq .
```

### Manually trigger a renewal event

```bash
curl -s -X POST http://localhost:3000/api/v1/properties/{propertyId}/residents/{residentId}/renewal-event \
  -H "Content-Type: application/json" | jq .
```

Response:
```json
{ "eventId": "...", "status": "pending" }
```

### View webhook delivery status

```bash
curl -s http://localhost:3000/api/v1/properties/{propertyId}/webhook-status | jq .
```

### Health check

```bash
curl -s http://localhost:3000/health
```

---

## Webhook Testing Guide

### Simulate a webhook receiver

Start a simple listener on port 3001 (the default `RMS_WEBHOOK_URL` target):

**Option A — using `nc` (netcat)**
```bash
while true; do nc -l 3001; done
```

**Option B — using Python**
```bash
python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers['Content-Length'])
        body = self.rfile.read(length)
        print('--- Webhook received ---')
        print(json.dumps(json.loads(body), indent=2))
        print('Signature:', self.headers.get('X-RMS-Signature'))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
    def log_message(self, *a): pass
http.server.HTTPServer(('', 3001), H).serve_forever()
"
```

**Option C — use a service like [webhook.site](https://webhook.site)**
Update `RMS_WEBHOOK_URL` in `.env` to the webhook.site URL.

### Verify HMAC signature

The backend sends `X-RMS-Signature: sha256=<hmac>`. To verify:

```bash
# Node.js verification snippet
node -e "
const crypto = require('crypto');
const secret = 'super_secret_webhook_key';
const body = '...'; // paste the raw JSON body
const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
console.log('Expected: sha256=' + sig);
"
```

### Retry behavior

The retry worker polls every 5 seconds for deliveries with `nextRetryAt <= NOW()`. When a delivery fails, it uses exponential backoff:

| Attempt | Status after fail | Wait before next retry |
|---------|-------------------|----------------------|
| 1 (first POST) | FAILED | 1 second |
| 2 | FAILED | 2 seconds |
| 3 | FAILED | 4 seconds |
| 4 | FAILED | 8 seconds |
| 5 | FAILED → DLQ | (no more retries) |

After 5 failed attempts, the delivery is moved to DLQ status with the reason stored in `dlq_reason`. No automatic retries occur after this point.

To simulate failures: set `RMS_WEBHOOK_URL` to a URL that returns 5xx or doesn't respond, then trigger an event and watch the `webhook-status` endpoint update.

---

## Risk Scoring Formula

| Signal | Max Points | Logic |
|--------|-----------|-------|
| Days to lease expiry | 40 | `40 × max(0, 1 − days/120)` — linear decay over 120 days |
| Payment delinquency | 25 | Any missed payments in last 6 months |
| No renewal offer | 20 | No pending/accepted offer in `renewal_offers` |
| Rent growth above market | 15 | `(market_rent − monthly_rent) / monthly_rent > 10%` |

**Tiers:** HIGH ≥ 70 | MEDIUM 40–69 | LOW < 40

**Flagged** = HIGH + MEDIUM residents only.

---

## Seed Data

The seed creates **Park Meadows Apartments** (Denver, CO) with 20 units and 4 residents covering all risk tiers:

| Resident | Expected Tier | Score | Days to Expiry | Delinquent | Has Offer | Above Market |
|----------|--------------|-------|----------------|------------|-----------|--------------|
| Jane Doe | HIGH | ~85 | 45 | No | No | Yes ($1400 vs $1600 market) |
| John Smith | MEDIUM | ~55 | 60 | Yes (1 missed) | No | No |
| Alice Johnson | LOW | ~20 | 180 | No | Yes (pending) | No |
| Bob Williams | HIGH | ~65 | 0 (MTM expired) | No | No | No |

---

## Design Decisions

### Why Prisma?
Strong TypeScript integration, readable schema, and automatic migration tracking. The `@unique` constraint on `(residentId, asOfDate)` in `renewal_risk_scores` gives us idempotent upserts for free.

### Why in-process workers?
The job worker and retry worker run as `setInterval` polling loops in the Express process. This approach avoids infrastructure dependencies for a take-home exercise.

**Limitation:** If the Node process crashes, the workers stop (but all data remains safe in the database). Jobs and deliveries resume processing once the server restarts. This is acceptable for development/testing but **NOT suitable for production**.

For production, use:
- A dedicated worker process (separate Node.js service with its own lifecycle)
- Redis job queue (BullMQ)
- Cloud Functions/Lambda
- Kubernetes CronJob/Deployment
- pg_cron with a dedicated worker pod

This ensures background tasks continue even if the API server is down.

### Webhook event idempotency
When triggering a webhook event, we check if one already exists for that resident on that date using a unique constraint (idempotency key: residentId + asOfDate). This prevents duplicate events from being created if the endpoint is called twice. Events are created inside a database transaction to ensure consistency.

### Asynchronous batch risk calculation
Risk scoring runs via a background job worker. POST `/calculate` returns 202 (accepted) immediately with a jobId. The job worker picks it up asynchronously (polled every 5 seconds) and computes scores. The frontend tracks progress by polling `/latest-job` status. This pattern keeps the API responsive for large resident lists.

The job worker runs as an in-process `setInterval` loop (same limitation as the retry worker — stops if the server crashes but data persists). For production, run workers in a separate service.

### UUIDs
Using `uuid` v4 (random) for all IDs. The plan mentions UUIDv7 (time-sortable), which is preferable in production for index locality and natural ordering — requires Node 20+ or a library like `uuidv7`.

### Frontend state management
No Redux or Zustand — local `useState` + `useEffect` is sufficient for this scope. The Vite dev proxy forwards `/api` requests to the backend, avoiding CORS issues in development.

---

## Edge Cases & Error Handling

### RMS endpoint unreachable
The delivery client wraps every HTTP call in try/catch. A network error (ECONNREFUSED, timeout) is treated the same as a non-2xx response: the delivery is marked `FAILED`, `attempt_count` increments, and `next_retry_at` is set with exponential backoff (1s → 2s → 4s → 8s → 16s). After 5 failed attempts the record moves to `DLQ` with `dlq_reason` storing the last error. The retry worker picks up `FAILED` records on the next poll cycle (every 5 seconds).

### Resident with an already-expired lease (month-to-month)
A lease with `lease_end_date` in the past results in `daysToExpiry = 0`, giving the maximum expiry score (40/40). This is intentional — an expired fixed-term lease with no renewal offer is the highest-urgency scenario. Month-to-month residents are included as long as their `lease.status = 'active'` and `resident.status = 'active'`.

### No market rent data available
If `unit_pricing` has no rows for the unit, `marketRent = null` and the rent-growth signal is skipped (0/15 points, `rentGrowthAboveMarket = false`). The score is calculated on the remaining 85 points and normalized within the same tier thresholds. This is documented in the response payload.

### Batch job triggered twice simultaneously (concurrent runs)
Calling `/calculate` twice with the same `asOfDate` reuses the existing job (doesn't create a duplicate). The unique constraint on `idempotencyKey` prevents duplicate jobs. Risk score writes use `upsert()` on the unique key `(residentId, asOfDate)` — concurrent upserts serialize at the DB level. For AUTO webhook events, `autoEventExists()` checks before creating a new event; a partial unique index on `(resident_id, as_of_date) WHERE trigger_source = 'AUTO'` enforces this at the DB level in production.

### Webhook HMAC signature validation
The backend signs every payload with `HMAC-SHA256` using `WEBHOOK_SECRET` and sends the signature as `X-RMS-Signature: sha256=<hex>`. The RMS should:
1. Read the raw request body (before JSON parsing)
2. Compute `HMAC-SHA256(body, secret)`
3. Compare with the received signature using a constant-time comparison
4. Reject requests where signatures don't match (return 401)

---

## Additional Documentation

### Database Schema
See [SCHEMA_DESIGN.md](SCHEMA_DESIGN.md) for detailed documentation of all tables, relationships, and design decisions regarding:
- `renewal_risk_scores` — Risk calculation snapshots and idempotency strategy
- `renewal_events` — Event tracking and trigger source differentiation (AUTO vs MANUAL)
- `webhook_delivery_state` — Delivery tracking with retry state and DLQ
- `batch_jobs` — Batch job tracking with idempotency key strategy
- Indexes and query optimization
- Entity relationships and constraints

### System Architecture
See [ARCHITECTURE.md](ARCHITECTURE.md) for:
- Detailed component architecture
- Data flow diagrams (risk scoring, webhook delivery)
- Deployment patterns (dev vs production)
- Scaling considerations
- Disaster recovery strategy
- Monitoring and observability

### Backend README
See [backend/README.md](backend/README.md) for:
- Backend-specific setup and configuration
- Complete API endpoint documentation with request/response examples
- Background worker details (Job Worker, Retry Worker)
- Data integrity guarantees
- Testing instructions
