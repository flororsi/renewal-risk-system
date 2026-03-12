interface Signals {
  daysToExpiryDays: number;
  paymentHistoryDelinquent: boolean;
  noRenewalOfferYet: boolean;
  rentGrowthAboveMarket: boolean;
}

interface SignalsDetailProps {
  signals: Signals;
  monthlyRent: number;
  marketRent: number | null;
  riskScore: number;
  dark: boolean;
}

interface SignalCardProps {
  active: boolean;
  title: string;
  detail: string;
  weight: number;
  contribution: number;
  dark: boolean;
}

function SignalCard({ active, title, detail, weight, contribution, dark }: SignalCardProps) {
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-xl border ${
      active
        ? dark ? 'bg-red-950/50 border-red-800/60' : 'bg-red-50 border-red-200'
        : dark ? 'bg-gray-800/40 border-gray-700/50' : 'bg-gray-50 border-gray-200'
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
          active ? 'bg-red-500 text-white' : dark ? 'bg-gray-700 text-gray-400' : 'bg-gray-200 text-gray-500'
        }`}>
          {active ? '!' : '✓'}
        </span>
        <div className="min-w-0">
          <p className={`text-sm font-medium truncate ${
            active ? dark ? 'text-red-300' : 'text-red-700' : dark ? 'text-gray-400' : 'text-gray-500'
          }`}>{title}</p>
          <p className={`text-xs mt-0.5 truncate ${dark ? 'text-gray-500' : 'text-gray-400'}`}>{detail}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 text-right">
        <span className={`text-xs ${dark ? 'text-gray-600' : 'text-gray-400'}`}>{weight}% weight</span>
        <span className={`text-sm font-bold w-8 ${active ? 'text-red-400' : dark ? 'text-gray-600' : 'text-gray-300'}`}>
          +{contribution}
        </span>
      </div>
    </div>
  );
}

function computeLeaseExpiryScore(days: number): number {
  return Math.round(40 * Math.max(0, 1 - days / 120));
}

export default function SignalsDetail({ signals, monthlyRent, marketRent, riskScore, dark }: SignalsDetailProps) {
  const rentDiff = marketRent !== null
    ? (((marketRent - monthlyRent) / monthlyRent) * 100).toFixed(1)
    : null;

  const leaseScore = computeLeaseExpiryScore(signals.daysToExpiryDays);

  return (
    <div className="pt-3 pb-1">
      <div className="flex items-center justify-between mb-3">
        <h4 className={`text-sm font-semibold ${dark ? 'text-gray-300' : 'text-gray-700'}`}>Risk Breakdown</h4>
        <span className={`text-sm ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
          Total Score: <span className={`font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>{riskScore}/100</span>
        </span>
      </div>
      <div className="space-y-2">
        <SignalCard
          active={signals.daysToExpiryDays < 120}
          title={`Lease expires in ${signals.daysToExpiryDays} days`}
          detail={signals.daysToExpiryDays < 120 ? 'Within 120-day warning window' : 'More than 120 days remaining'}
          weight={40}
          contribution={leaseScore}
          dark={dark}
        />
        <SignalCard
          active={signals.paymentHistoryDelinquent}
          title={signals.paymentHistoryDelinquent ? 'Missed or late payments detected' : 'Payment history is clean'}
          detail={signals.paymentHistoryDelinquent ? 'One or more charges without matching payment in last 6 months' : 'No delinquencies in last 6 months'}
          weight={25}
          contribution={signals.paymentHistoryDelinquent ? 25 : 0}
          dark={dark}
        />
        <SignalCard
          active={signals.noRenewalOfferYet}
          title={signals.noRenewalOfferYet ? 'No renewal offer on file' : 'Renewal offer on file'}
          detail={signals.noRenewalOfferYet ? 'No pending or accepted offer exists for this lease' : 'Renewal offer is pending or accepted'}
          weight={20}
          contribution={signals.noRenewalOfferYet ? 20 : 0}
          dark={dark}
        />
        <SignalCard
          active={signals.rentGrowthAboveMarket}
          title={
            rentDiff !== null && signals.rentGrowthAboveMarket
              ? `Market rent +${Math.abs(parseFloat(rentDiff)).toFixed(1)}% above current`
              : 'Rent aligned with market'
          }
          detail={
            marketRent !== null
              ? `Market: $${marketRent.toFixed(0)}/mo · Current: $${monthlyRent.toFixed(0)}/mo${rentDiff ? ` (${parseFloat(rentDiff) > 0 ? '+' : ''}${rentDiff}%)` : ''}`
              : 'No market rent data available'
          }
          weight={15}
          contribution={signals.rentGrowthAboveMarket ? 15 : 0}
          dark={dark}
        />
      </div>
    </div>
  );
}
