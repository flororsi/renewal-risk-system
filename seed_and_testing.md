# Seed Data & Testing Guide

## Quick Start

This guide helps you set up realistic test data and manually verify the renewal risk feature works end-to-end.

---

## Sample Seed Data Script

Below is a SQL seed script you can run directly in your PostgreSQL database. This creates:
- 1 property with 20 units
- 15 residents with varied lease situations
- Realistic pricing and payment history
- Some residents at risk of not renewing

```sql
-- seed.sql
-- Note: Run this script after creating your schema

-- Create property
INSERT INTO properties (name, address, city, state, zip_code, status)
VALUES ('Park Meadows Apartments', '123 Main St', 'Denver', 'CO', '80206', 'active')
RETURNING id;

-- Store the property_id from above, then replace :property_id in the script below
-- For convenience, we'll use a CTE-based approach:

WITH property_data AS (
  INSERT INTO properties (name, address, city, state, zip_code, status)
  VALUES ('Park Meadows Apartments', '123 Main St', 'Denver', 'CO', '80206', 'active')
  RETURNING id
),
unit_type_data AS (
  INSERT INTO unit_types (property_id, name, bedrooms, bathrooms, square_footage)
  SELECT id, '1BR/1BA', 1, 1, 700
  FROM property_data
  RETURNING id, property_id
),
units_data AS (
  INSERT INTO units (property_id, unit_type_id, unit_number, floor, status)
  SELECT
    ut.property_id,
    ut.id,
    (100 + gs.n)::text,
    FLOOR(gs.n / 10) + 1,
    'occupied'
  FROM unit_type_data ut
  CROSS JOIN generate_series(1, 20) AS gs(n)
  RETURNING id, property_id, unit_type_id, unit_number
),
unit_pricing_data AS (
  INSERT INTO unit_pricing (unit_id, base_rent, market_rent, effective_date)
  SELECT id, 1600, 1600, CURRENT_DATE
  FROM units_data
  RETURNING unit_id
),
-- Scenario 1: High risk - lease expires in 45 days, no renewal offer, paying on time
resident_1 AS (
  INSERT INTO residents (property_id, unit_id, first_name, last_name, email, status)
  SELECT property_id, id, 'Jane', 'Doe', 'jane.doe@example.com', 'active'
  FROM units_data WHERE unit_number = '101'
  RETURNING id, property_id, unit_id
),
lease_1 AS (
  INSERT INTO leases (property_id, resident_id, unit_id, lease_start_date, lease_end_date, monthly_rent, lease_type, status)
  SELECT property_id, id, unit_id, '2023-01-15', CURRENT_DATE + INTERVAL '45 days', 1400, 'fixed', 'active'
  FROM resident_1
  RETURNING id, property_id, resident_id
),
payments_1 AS (
  INSERT INTO resident_ledger (property_id, resident_id, transaction_type, charge_code, amount, transaction_date)
  SELECT
    r.property_id,
    r.id,
    'payment',
    'rent',
    1400,
    CURRENT_DATE - INTERVAL '1 month' * (6 - gs.n)
  FROM resident_1 r
  CROSS JOIN generate_series(0, 5) AS gs(n)
  RETURNING id
),
-- Scenario 2: Medium risk - lease expires in 60 days, missed one payment
resident_2 AS (
  INSERT INTO residents (property_id, unit_id, first_name, last_name, email, status)
  SELECT property_id, id, 'John', 'Smith', 'john.smith@example.com', 'active'
  FROM units_data WHERE unit_number = '102'
  RETURNING id, property_id, unit_id
),
lease_2 AS (
  INSERT INTO leases (property_id, resident_id, unit_id, lease_start_date, lease_end_date, monthly_rent, lease_type, status)
  SELECT property_id, id, unit_id, '2023-01-15', CURRENT_DATE + INTERVAL '60 days', 1500, 'fixed', 'active'
  FROM resident_2
  RETURNING id, property_id, resident_id
),
payments_2 AS (
  INSERT INTO resident_ledger (property_id, resident_id, transaction_type, charge_code, amount, transaction_date)
  SELECT
    r.property_id,
    r.id,
    'payment',
    'rent',
    1500,
    CURRENT_DATE - INTERVAL '1 month' * (6 - gs.n)
  FROM resident_2 r
  CROSS JOIN generate_series(0, 4) AS gs(n) -- Only 5 payments (1 missed)
  RETURNING id
),
-- Scenario 3: Low risk - 6 months left on lease, renewal offer sent
resident_3 AS (
  INSERT INTO residents (property_id, unit_id, first_name, last_name, email, status)
  SELECT property_id, id, 'Alice', 'Johnson', 'alice.johnson@example.com', 'active'
  FROM units_data WHERE unit_number = '103'
  RETURNING id, property_id, unit_id
),
lease_3 AS (
  INSERT INTO leases (property_id, resident_id, unit_id, lease_start_date, lease_end_date, monthly_rent, lease_type, status)
  SELECT property_id, id, unit_id, '2023-06-15', CURRENT_DATE + INTERVAL '180 days', 1600, 'fixed', 'active'
  FROM resident_3
  RETURNING id, property_id, resident_id
),
payments_3 AS (
  INSERT INTO resident_ledger (property_id, resident_id, transaction_type, charge_code, amount, transaction_date)
  SELECT
    r.property_id,
    r.id,
    'payment',
    'rent',
    1600,
    CURRENT_DATE - INTERVAL '1 month' * (6 - gs.n)
  FROM resident_3 r
  CROSS JOIN generate_series(0, 5) AS gs(n)
  RETURNING id
),
renewal_3 AS (
  INSERT INTO renewal_offers (property_id, resident_id, lease_id, renewal_start_date, renewal_end_date, proposed_rent, status)
  SELECT
    l.property_id,
    l.resident_id,
    l.id,
    CURRENT_DATE + INTERVAL '180 days',
    CURRENT_DATE + INTERVAL '545 days',
    1650,
    'pending'
  FROM lease_3 l
  RETURNING id
),
-- Scenario 4: High risk - Month-to-month
resident_4 AS (
  INSERT INTO residents (property_id, unit_id, first_name, last_name, email, status)
  SELECT property_id, id, 'Bob', 'Williams', 'bob.williams@example.com', 'active'
  FROM units_data WHERE unit_number = '104'
  RETURNING id, property_id, unit_id
),
lease_4 AS (
  INSERT INTO leases (property_id, resident_id, unit_id, lease_start_date, lease_end_date, monthly_rent, lease_type, status)
  SELECT property_id, id, unit_id, '2024-12-01', '2025-01-01', 1450, 'month_to_month', 'active'
  FROM resident_4
  RETURNING id, property_id, resident_id
),
payments_4 AS (
  INSERT INTO resident_ledger (property_id, resident_id, transaction_type, charge_code, amount, transaction_date)
  SELECT
    r.property_id,
    r.id,
    'payment',
    'rent',
    1450,
    CURRENT_DATE - INTERVAL '1 month' * (6 - gs.n)
  FROM resident_4 r
  CROSS JOIN generate_series(0, 5) AS gs(n)
  RETURNING id
)
SELECT 'Seed data inserted successfully!' AS result;
```

**To run:**
```bash
psql -U your_username -d your_database -f seed.sql
# or
psql your_database < seed.sql
```

---

## Manual Testing Workflow

### 1. Start the Backend
```bash
cd backend
npm install
npm run dev
```

Should output something like:
```
✓ Database connected
✓ Server running on http://localhost:3000
```

### 2. Start the Frontend
```bash
cd frontend
npm install
npm run dev
```

Should open at `http://localhost:5173` (or similar).

### 3. Test the Renewal Risk API

**Calculate renewal risk for your property:**
```bash
curl -X POST http://localhost:3000/api/v1/properties/{propertyId}/renewal-risk/calculate \
  -H "Content-Type: application/json" \
  -d '{
    "propertyId": "{propertyId from seed output}",
    "asOfDate": "2025-01-02"
  }'
```

**Expected response:**
```json
{
  "propertyId": "...",
  "calculatedAt": "2025-01-02T...",
  "totalResidents": 15,
  "flaggedCount": 8,
  "riskTiers": {
    "high": 4,
    "medium": 4,
    "low": 0
  },
  "flags": [
    {
      "residentId": "...",
      "name": "Jane Doe",
      "unitId": "101",
      "riskScore": 85,
      "riskTier": "high",
      "daysToExpiry": 45,
      "signals": {
        "daysToExpiryDays": 45,
        "paymentHistoryDelinquent": false,
        "noRenewalOfferYet": true,
        "rentGrowthAboveMarket": false
      }
    },
    ...
  ]
}
```

### 4. Test the Dashboard

Open `http://localhost:5173/properties/{propertyId}/renewal-risk` in your browser.

You should see:
- A table of at-risk residents
- Risk scores and tiers (color-coded)
- Expandable sections showing risk signals
- A "Trigger Renewal Event" button for each resident

### 5. Test Webhook Delivery

**Option A: Use webhook.site (free, no setup)**
1. Go to https://webhook.site
2. Copy your unique URL
3. In the backend, configure the RMS endpoint to your webhook.site URL (either via environment variable or config)
4. Click "Trigger Renewal Event" for a high-risk resident
5. Check webhook.site—you should see the webhook delivered in 1-2 seconds

**Option B: Use a mock server (if you prefer local testing)**
```bash
# Terminal 1: Run a simple mock RMS
node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log('Webhook received:', JSON.parse(body));
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
  });
});
server.listen(3001, () => console.log('Mock RMS on :3001'));
"

# Then configure your app's RMS endpoint to http://localhost:3001/webhook
```

### 6. Test Webhook Retry Logic

To test retries, you can:
1. Trigger a renewal event
2. Immediately stop the RMS (or make it return 503)
3. Check your `webhook_delivery_state` table—you should see:
   - `attempt_count` incrementing (1, 2, 3...)
   - `last_attempt_at` updating
   - `next_retry_at` showing exponential backoff (1s, 2s, 4s, 8s, 16s)
4. After 5 failed attempts, status should move to `dlq`

**Query to check webhook state:**
```sql
SELECT 
  id, 
  event_id, 
  status, 
  attempt_count, 
  last_attempt_at, 
  next_retry_at 
FROM webhook_delivery_state 
ORDER BY created_at DESC 
LIMIT 10;
```

### 7. Test Idempotency

To test that duplicate webhooks aren't delivered:
1. Manually insert a webhook_delivery_state record with status='delivered'
2. Trigger the renewal event for the same resident again
3. Check webhook.site—the webhook should NOT appear twice (idempotency key prevents it)

**Query to verify:**
```sql
SELECT 
  event_id, 
  status, 
  COUNT(*) as count 
FROM webhook_delivery_state 
GROUP BY event_id, status 
HAVING COUNT(*) > 1;

-- Should return empty (no duplicates)
```

---

## Expected Results

### Renewal Risk Calculation
- **Jane Doe** (45 days to expiry, no renewal offer, $1,400 rent vs $1,600 market): Risk score ~85 (HIGH)
- **John Smith** (60 days, 1 missed payment): Risk score ~70 (MEDIUM)
- **Alice Johnson** (180 days, renewal offer sent): Risk score ~20 (LOW)
- **Bob Williams** (MTM, no renewal offer): Risk score ~65 (MEDIUM)

### Webhook Delivery
- First attempt: < 100ms (instant)
- If it fails, retry after 1s
- If it fails again, retry after 2s
- After 5 failures, move to DLQ
- No duplicate deliveries (idempotency key prevents it)

---

## Troubleshooting

**"Property not found"**
- Make sure you're using the propertyId from seed output, not a placeholder

**"Webhook not received"**
- Check backend logs for errors
- Verify RMS endpoint is correct
- If using webhook.site, make sure URL is public (not localhost)

**"Dashboard is empty"**
- Run the calculation API first
- Check browser console for API errors
- Verify propertyId matches

**"Webhook retries not working"**
- Make sure webhook_delivery_state table exists
- Check if there's a background job/scheduler running retries (you may need to implement this)
- Verify `next_retry_at` is being updated correctly

---

## Code Quality Checklist

Before submitting, verify:

- [ ] Seed script runs without errors
- [ ] API endpoints respond to the documented examples
- [ ] Dashboard loads and displays residents
- [ ] "Trigger Renewal Event" works and delivers webhook
- [ ] Webhook retry logic works (you can test with webhook.site)
- [ ] Idempotency prevents duplicates
- [ ] Error states are handled gracefully
- [ ] No console errors in browser or terminal
- [ ] Schema is documented in README
- [ ] Database migrations/setup is reproducible

---

## Time-Saving Tips

If you're running short on time:

1. **Seed data** can be simple—10 residents is enough to test
2. **Webhook retry** can be synchronous initially (just retry in the same request) but document that you'd move it to async
3. **Dashboard** doesn't need filters/sorting—just a working table
4. **Error handling** can be basic—just log and return 500
5. **Request signing** can be documented but not implemented (if you're out of time)

What matters: **working feature that handles the happy path + one error case + clear thinking about the hard parts.**

---

## Example: Running End-to-End in 20 minutes

1. **Backend setup** (5 min): `npm install`, create tables, seed data
2. **API endpoint** (10 min): POST /renewal-risk/calculate, GET /renewal-risk/:propertyId
3. **React component** (3 min): Fetch from API, display in a table
4. **Webhook basic** (2 min): On button click, POST to RMS endpoint

That's enough to show you can ship. Polish comes second.
