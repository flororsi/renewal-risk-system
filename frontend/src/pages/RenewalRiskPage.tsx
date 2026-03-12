import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import RiskTable, { type RiskScore } from '../components/RiskTable';

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

interface LatestJob {
  jobId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  asOfDate: string;
  triggerSource: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  totalResidents: number | null;
  flaggedCount: number | null;
  highCount: number | null;
  mediumCount: number | null;
  lowCount: number | null;
}

interface RenewalRiskPageProps {
  dark: boolean;
  onToggleDark: () => void;
}

export default function RenewalRiskPage({ dark, onToggleDark }: RenewalRiskPageProps) {
  const { propertyId } = useParams<{ propertyId: string }>();
  const [scores, setScores] = useState<RiskScore[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tierFilter, setTierFilter] = useState<string>('');
  const [latestJob, setLatestJob] = useState<LatestJob | null>(null);
  const asOfDate = new Date().toISOString().split('T')[0];
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function addToast(message: string, type: 'success' | 'error') {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }

  const fetchLatestJob = useCallback(async () => {
    if (!propertyId) return;
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/v1/properties/${propertyId}/renewal-risk/latest-job`);
      if (!res.ok) return;
      const data = await res.json();
      setLatestJob(data);
    } catch {
      // silent
    }
  }, [propertyId]);

  // Enqueue today's batch job (AUTO, idempotent — won't duplicate if already ran today)
  const enqueueDailyJob = useCallback(async () => {
    if (!propertyId) return;
    try {
      await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/v1/properties/${propertyId}/renewal-risk/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asOfDate, triggerSource: 'AUTO' }),
      });
    } catch {
      // silent — banner will show stale state
    }
  }, [propertyId, asOfDate]);

  const fetchScores = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setError(null);
    try {
      const url = tierFilter
        ? `${import.meta.env.VITE_API_BASE_URL}/api/v1/properties/${propertyId}/renewal-risk?tier=${tierFilter}`
        : `${import.meta.env.VITE_API_BASE_URL}/api/v1/properties/${propertyId}/renewal-risk`;
      const res = await fetch(url);
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed to fetch scores'); }
      const data = await res.json();
      setScores(data.scores ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [propertyId, tierFilter]);

  // On mount: enqueue today's job
  useEffect(() => { enqueueDailyJob(); }, [enqueueDailyJob]);

  // Load scores once on mount (and when tier filter changes)
  useEffect(() => { fetchScores(); }, [fetchScores]);

  // Poll latest job every 3s; refresh scores when job completes
  const prevJobStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const poll = async () => {
      await fetchLatestJob();
    };
    poll();
    pollRef.current = setInterval(async () => {
      await fetchLatestJob();
      // Refresh scores only when job transitions to COMPLETED
      setLatestJob((job) => {
        if (job && job.status === 'COMPLETED' && prevJobStatusRef.current !== 'COMPLETED') {
          fetchScores();
        }
        prevJobStatusRef.current = job?.status ?? null;
        return job;
      });
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchLatestJob, fetchScores]);

  const displayedScores = tierFilter
    ? scores.filter((s) => s.riskTier.toLowerCase() === tierFilter.toLowerCase())
    : scores;

  return (
    <div className={`min-h-screen ${dark ? 'bg-gray-950 text-gray-100' : 'bg-gray-100 text-gray-900'}`}>
      {/* Header */}
      <header className={`border-b shadow-sm ${dark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className={`text-lg sm:text-xl font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>Renewal Risk Dashboard</h1>
            <p className={`text-xs sm:text-sm mt-1 truncate ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
              Property ID: <code className={`font-mono px-1 rounded text-xs ${dark ? 'bg-gray-800' : 'bg-gray-100'}`}>{propertyId}</code>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onToggleDark}
              className={`p-2 rounded-lg transition-colors ${dark ? 'bg-gray-800 hover:bg-gray-700 text-yellow-400' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'}`}
              aria-label="Toggle dark mode"
            >
              {dark ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" viewBox="0 0 24 24">
                  <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 7a5 5 0 100 10A5 5 0 0012 7z"/>
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

        {/* Latest batch job status */}
        {latestJob && (() => {
          const statusStyles: Record<string, { bar: string; text: string; dot: string }> = {
            COMPLETED: { bar: dark ? 'bg-gray-900 border-green-800' : 'bg-green-50 border-green-200', text: dark ? 'text-green-400' : 'text-green-700', dot: 'bg-green-400' },
            RUNNING:   { bar: dark ? 'bg-gray-900 border-blue-800'  : 'bg-blue-50 border-blue-200',   text: dark ? 'text-blue-400'  : 'text-blue-700',  dot: 'bg-blue-400 animate-pulse' },
            PENDING:   { bar: dark ? 'bg-gray-900 border-yellow-800': 'bg-yellow-50 border-yellow-200', text: dark ? 'text-yellow-400': 'text-yellow-700', dot: 'bg-yellow-400 animate-pulse' },
            FAILED:    { bar: dark ? 'bg-gray-900 border-red-800'   : 'bg-red-50 border-red-200',    text: dark ? 'text-red-400'   : 'text-red-700',   dot: 'bg-red-400' },
          };
          const s = statusStyles[latestJob.status] ?? statusStyles.FAILED;
          return (
            <div className={`rounded-xl border px-3 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 text-xs sm:text-sm ${s.bar}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dot}`} />
                <span className={`font-semibold ${s.text}`}>Last batch job: <span className="sm:hidden">{latestJob.status.slice(0, 3)}</span><span className="hidden sm:inline">{latestJob.status}</span></span>
                <span className={`${dark ? 'text-gray-400' : 'text-gray-500'} text-xs`}>
                   {latestJob.asOfDate}
                </span>
                {latestJob.completedAt && (
                  <span className={`${dark ? 'text-gray-500' : 'text-gray-400'} text-xs hidden sm:inline`}>
                    · {new Date(latestJob.completedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
              {latestJob.status === 'COMPLETED' && latestJob.totalResidents !== null && (
                <div className={`flex items-center gap-1 sm:gap-3 text-xs font-medium ${dark ? 'text-gray-400' : 'text-gray-500'} flex-wrap`}>
                  <span className="hidden sm:inline">{latestJob.totalResidents} residents</span>
                  <span className="text-red-500">▲ {latestJob.highCount ?? 0}</span>
                  <span className="text-yellow-500">● {latestJob.mediumCount ?? 0}</span>
                  <span className="text-green-500">✓ {latestJob.lowCount ?? 0}</span>
                </div>
              )}
              {latestJob.status === 'FAILED' && latestJob.errorMessage && (
                <span className={`text-xs truncate max-w-xs sm:max-w-sm ${dark ? 'text-red-400' : 'text-red-600'}`} title={latestJob.errorMessage}>
                  {latestJob.errorMessage}
                </span>
              )}
            </div>
          );
        })()}

        {/* Risk table section */}
        <section>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4 sm:mb-3">
            <h2 className={`text-base font-semibold ${dark ? 'text-white' : 'text-gray-900'}`}>Residents</h2>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <span className={`text-xs sm:text-sm font-medium ${dark ? 'text-gray-400' : 'text-gray-600'}`}>Filter:</span>
              <div className="flex gap-2 flex-wrap">
                {(['', 'high', 'medium', 'low'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTierFilter(t)}
                    className={`px-2 sm:px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                      tierFilter === t
                        ? 'bg-indigo-600 text-white'
                        : dark
                        ? 'bg-gray-800 border border-gray-600 text-gray-300 hover:bg-gray-700'
                        : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t === '' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <div className={`mb-4 rounded-lg border p-4 text-sm ${dark ? 'bg-red-950 border-red-800 text-red-300' : 'bg-red-50 border-red-200 text-red-700'}`}>
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="animate-spin h-8 w-8 text-indigo-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <span className={`ml-3 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>Loading risk scores...</span>
            </div>
          ) : (
            <RiskTable scores={displayedScores} propertyId={propertyId ?? ''} onToast={addToast} dark={dark} />
          )}
        </section>
      </main>

      {/* Toasts */}
      <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 flex flex-col gap-2 z-50 max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-xs sm:text-sm font-medium text-white transition-all ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
