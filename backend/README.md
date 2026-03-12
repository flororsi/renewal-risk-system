# Backend — Renewal Risk Detection API

Express + TypeScript + Prisma service for computing renewal risk scores and delivering webhook events.

## Structure

```
backend/
├── prisma/
│   ├── schema.prisma     # Database schema (new tables: RenewalRiskScore, RenewalEvent, WebhookDeliveryState, BatchJob)
│   └── seed.ts           # Sample data: Park Meadows Apartments with 4 residents across all risk tiers
├── src/
│   ├── api/
│   │   └── routes.ts     # REST endpoints (calculate, scores, renewal-event, webhook-status)
│   ├── services/
│   │   ├── riskScoring.ts  # Core scoring logic + getLatestRiskScores
│   │   └── jobWorker.ts    # Background worker polling PENDING BatchJobs
│   ├── webhooks/
│   │   ├── eventRegistry.ts  # Webhook event configs and payload builders
│   │   ├── webhookService.ts # Create event + delivery state (atomic)
│   │   ├── deliveryClient.ts # HTTP delivery + HMAC signing + exponential backoff
│   │   └── retryWorker.ts    # In-process polling worker for FAILED deliveries
│   └── index.ts          # Express server entry point
└── package.json
```

## Setup

### With Docker Compose (recommended)

```bash
# From repo root
docker-compose up --build

# First-time setup
docker compose exec backend npx prisma db push
docker compose exec backend npx prisma db seed
```

### Local (without Docker)

```bash
# Start Postgres
docker run -d \
  -e POSTGRES_USER=rdp \
  -e POSTGRES_PASSWORD=rdp_secret \
  -e POSTGRES_DB=rdp_db \
  -p 5432:5432 \
  postgres:15

# Install deps and configure
npm install
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

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with ts-node (hot reload) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled output |
| `npm run db:seed` | Seed sample data |
| `npm run db:studio` | Open Prisma Studio |

## API Endpoints

All prefixed with `/api/v1`.

### POST `/properties/:propertyId/renewal-risk/calculate`

Enqueues a risk calculation batch job. The job worker picks it up and computes scores for all active residents.

**Body:** `{ "asOfDate": "2026-03-12" }` (optional, defaults to today)

**Response (202):**
```json
{ "jobId": "...", "status": "PENDING", "propertyId": "...", "asOfDate": "2026-03-12" }
```

Poll `GET /properties/:propertyId/renewal-risk/jobs/:jobId` for results.

### GET `/properties/:propertyId/renewal-risk`

Returns latest risk scores. Optional `?tier=high|medium|low` filter.

### POST `/properties/:propertyId/residents/:residentId/renewal-event`

Manually triggers a `renewal.risk_flagged` webhook for a resident.

### GET `/properties/:propertyId/webhook-status`

Returns delivery state for all webhook events at the property (last 50).

## Risk Scoring

| Signal | Max Points | Formula |
|---|---|---|
| Days to lease expiry | 40 | `40 × max(0, 1 − days/120)` |
| Payment delinquency | 25 | Any missed payments in last 6 months |
| No renewal offer | 20 | No pending/accepted offer |
| Rent above market | 15 | `(market_rent − monthly_rent) / monthly_rent > 10%` |

**Tiers:** HIGH ≥ 70 · MEDIUM 40–69 · LOW < 40

## Webhook Delivery

- Signed with `HMAC-SHA256` → `X-RMS-Signature: sha256=<hex>`
- Exponential backoff: 1s → 2s → 4s → 8s → 16s
- DLQ after 5 failed attempts (`dlq_reason` stored)
- Idempotency for AUTO events: `autoEventExists()` check before creating

See root `README.md` for full webhook testing guide.
