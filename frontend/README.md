# Frontend — Renewal Risk Dashboard

Vite + React + TypeScript + Tailwind CSS dashboard for property managers to view renewal risk scores and trigger webhook events.

## Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── RiskTable.tsx      # Expandable table with tier badges + "Trigger Event" button
│   │   └── SignalsDetail.tsx  # Per-resident risk signal breakdown (expanded row)
│   ├── pages/
│   │   ├── RenewalRiskPage.tsx  # Main dashboard: summary cards, risk table, webhook deliveries
│   │   └── PropertySelector.tsx # Landing page to pick a property
│   ├── App.tsx    # React Router setup
│   └── main.tsx   # Entry point
└── package.json
```

## Setup

```bash
npm install
npm run dev
```

Requires the backend running at `http://localhost:3000` (configured via `VITE_API_BASE_URL` in `.env`).

```
VITE_API_BASE_URL=http://localhost:3000
```

## Pages

### `/` — Property Selector
Lists all properties from `GET /api/v1/properties`. Click a property to go to its dashboard.

### `/properties/:propertyId/renewal-risk` — Risk Dashboard

Features:
- **Summary cards**: Total residents · At Risk · Critical (HIGH) · Potential monthly loss
- **Risk table**: Resident name, unit, lease end date, days remaining, risk score + tier badge (red/yellow/green)
- **Expand row**: Shows signal breakdown (lease expiry, payment history, renewal offer, market rent)
- **Trigger Renewal Event**: POST to backend, shows success/error toast
- **Filter by tier**: All / High / Medium / Low
- **Webhook Deliveries**: Auto-refreshing table (every 3s) showing delivery status; click row for full payload modal
- **Dark mode toggle**: Persisted in localStorage
- **Date picker + Recalculate**: Run scoring for any date

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server (http://localhost:5173) |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
