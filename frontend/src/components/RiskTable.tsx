import { useState } from 'react';
import SignalsDetail from './SignalsDetail';

export interface RiskScore {
  residentId: string;
  residentName: string;
  unitNumber: string;
  leaseId: string;
  leaseEndDate: string;
  monthlyRent: number;
  marketRent: number | null;
  riskScore: number;
  riskTier: 'HIGH' | 'MEDIUM' | 'LOW';
  signals: {
    daysToExpiryDays: number;
    paymentHistoryDelinquent: boolean;
    noRenewalOfferYet: boolean;
    rentGrowthAboveMarket: boolean;
  };
}

interface RiskTableProps {
  scores: RiskScore[];
  propertyId: string;
  onToast: (message: string, type: 'success' | 'error') => void;
  dark: boolean;
}

const TIER_STYLES_LIGHT: Record<string, string> = {
  HIGH: 'bg-red-100 text-red-800 border border-red-200',
  MEDIUM: 'bg-yellow-100 text-yellow-800 border border-yellow-200',
  LOW: 'bg-green-100 text-green-800 border border-green-200',
};

const TIER_STYLES_DARK: Record<string, string> = {
  HIGH: 'bg-red-950 text-red-300 border border-red-800',
  MEDIUM: 'bg-yellow-950 text-yellow-300 border border-yellow-800',
  LOW: 'bg-green-950 text-green-300 border border-green-800',
};


function TierBadge({ tier, score, dark }: { tier: string; score: number; dark: boolean }) {
  const styles = dark ? TIER_STYLES_DARK : TIER_STYLES_LIGHT;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${styles[tier] ?? 'bg-gray-100 text-gray-800'}`}>
      {tier} · {score}
    </span>
  );
}

export default function RiskTable({ scores, propertyId, onToast, dark }: RiskTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [triggeringRows, setTriggeringRows] = useState<Set<string>>(new Set());

  function toggleRow(residentId: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(residentId)) next.delete(residentId);
      else next.add(residentId);
      return next;
    });
  }

  async function triggerEvent(residentId: string) {
    setTriggeringRows((prev) => new Set(prev).add(residentId));
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL}/api/v1/properties/${propertyId}/residents/${residentId}/renewal-event`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      const data = await response.json();
      if (response.ok) {
        onToast(`Renewal event created: ${data.eventId}`, 'success');
      } else {
        onToast(data.error ?? 'Failed to create event', 'error');
      }
    } catch {
      onToast('Network error — could not create event', 'error');
    } finally {
      setTriggeringRows((prev) => {
        const next = new Set(prev);
        next.delete(residentId);
        return next;
      });
    }
  }

  if (scores.length === 0) {
    return (
      <div className={`text-center py-12 ${dark ? 'text-gray-500' : 'text-gray-500'}`}>
        No risk scores found. Run a calculation first.
      </div>
    );
  }

  return (
    <>
      {/* Mobile card view */}
      <div className="sm:hidden space-y-3">
        {scores.map((score) => {
          const isExpanded = expandedRows.has(score.residentId);
          const isTriggering = triggeringRows.has(score.residentId);

          return (
            <div key={score.residentId} className={`rounded-lg border p-3 transition-colors ${isExpanded ? (dark ? 'bg-gray-800 border-blue-700' : 'bg-blue-50 border-blue-200') : (dark ? 'bg-gray-800 border-gray-700 hover:border-gray-600' : 'bg-white border-gray-200 hover:border-gray-300')}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <button
                    onClick={() => toggleRow(score.residentId)}
                    className="w-full text-left"
                    aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className={`font-semibold text-sm ${dark ? 'text-gray-100' : 'text-gray-900'}`}>{score.residentName}</div>
                        <div className={`text-xs mt-0.5 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Unit {score.unitNumber}</div>
                      </div>
                      <svg className={`w-4 h-4 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''} ${dark ? 'text-gray-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className={`text-xs font-medium ${dark ? 'text-gray-300' : 'text-gray-700'}`}>${score.monthlyRent.toFixed(0)}/mo</span>
                    <span className={`text-xs ${
                      score.signals.daysToExpiryDays < 30 ? 'text-red-500 font-medium' :
                      score.signals.daysToExpiryDays < 60 ? 'text-yellow-500 font-medium' :
                      dark ? 'text-gray-400' : 'text-gray-600'
                    }`}>{score.signals.daysToExpiryDays}d left</span>
                    <TierBadge tier={score.riskTier} score={score.riskScore} dark={dark} />
                  </div>
                </div>
              </div>

              {isExpanded && (
                <>
                  <div className={`mt-3 pt-3 border-t ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
                    <SignalsDetail
                      signals={score.signals}
                      monthlyRent={score.monthlyRent}
                      marketRent={score.marketRent}
                      riskScore={score.riskScore}
                      dark={dark}
                    />
                  </div>
                  <button
                    onClick={() => triggerEvent(score.residentId)}
                    disabled={isTriggering}
                    className="w-full mt-3 px-3 py-2 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2"
                  >
                    {isTriggering ? (
                      <>
                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Sending...
                      </>
                    ) : (
                      'Trigger Event'
                    )}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop table view */}
      <div className={`hidden sm:block overflow-hidden rounded-xl border shadow-sm ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
        <table className="min-w-full divide-y divide-gray-200">
        <thead className={dark ? 'bg-gray-800' : 'bg-gray-50'}>
          <tr>
            <th className={`px-4 sm:px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider w-8 ${dark ? 'text-gray-400 divide-gray-700' : 'text-gray-500'}`}></th>
            <th className={`px-4 sm:px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Resident</th>
            <th className={`px-4 sm:px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Unit</th>
            <th className={`px-4 sm:px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Lease End</th>
            <th className={`px-4 sm:px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Days Left</th>
            <th className={`px-4 sm:px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Risk</th>
            <th className={`px-4 sm:px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Action</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${dark ? 'bg-gray-900 divide-gray-700' : 'bg-white divide-gray-200'}`}>
          {scores.map((score) => {
            const isExpanded = expandedRows.has(score.residentId);
            const isTriggering = triggeringRows.has(score.residentId);

            return [
              <tr
                key={score.residentId}
                className={`transition-colors ${isExpanded ? (dark ? 'bg-gray-800' : 'bg-blue-50') : (dark ? 'hover:bg-gray-800' : 'hover:bg-gray-50')}`}
              >
                <td className="px-4 sm:px-6 py-4">
                  <button
                    onClick={() => toggleRow(score.residentId)}
                    className={`transition-colors ${dark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-700'}`}
                    aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                  >
                    <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </td>

                <td className="px-4 sm:px-6 py-4">
                  <div className={`font-medium text-sm ${dark ? 'text-gray-100' : 'text-gray-900'}`}>{score.residentName}</div>
                  <div className={`text-xs mt-0.5 ${dark ? 'text-gray-500' : 'text-gray-500'}`}>${score.monthlyRent.toFixed(0)}/mo</div>
                </td>

                <td className={`px-4 sm:px-6 py-4 text-sm ${dark ? 'text-gray-300' : 'text-gray-700'}`}>Unit {score.unitNumber}</td>

                <td className={`px-4 sm:px-6 py-4 text-sm ${dark ? 'text-gray-300' : 'text-gray-700'}`}>{score.leaseEndDate}</td>

                <td className="px-4 sm:px-6 py-4">
                  <span className={`text-sm font-medium ${
                    score.signals.daysToExpiryDays < 30 ? 'text-red-500' :
                    score.signals.daysToExpiryDays < 60 ? 'text-yellow-500' :
                    dark ?'text-gray-300' : 'text-gray-700'
                  }`}>
                    {score.signals.daysToExpiryDays}d
                  </span>
                </td>

                <td className="px-4 sm:px-6 py-4">
                  <TierBadge tier={score.riskTier} score={score.riskScore} dark={dark} />
                </td>

                <td className="px-4 sm:px-6 py-4 text-right">
                  <button
                    onClick={() => triggerEvent(score.residentId)}
                    disabled={isTriggering}
                    className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isTriggering ? (
                      <>
                        <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Sending...
                      </>
                    ) : (
                      'Trigger Event'
                    )}
                  </button>
                </td>
              </tr>,

              isExpanded && (
                <tr key={`${score.residentId}-detail`} className={dark ? 'bg-gray-900' : 'bg-gray-50'}>
                  <td colSpan={7} className="px-4 sm:px-6 pb-5">
                    <SignalsDetail
                      signals={score.signals}
                      monthlyRent={score.monthlyRent}
                      marketRent={score.marketRent}
                      riskScore={score.riskScore}
                      dark={dark}
                    />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
