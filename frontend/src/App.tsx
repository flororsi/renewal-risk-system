import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import RenewalRiskPage from './pages/RenewalRiskPage';

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('dark') === 'true');

  function toggleDark() {
    setDark((prev) => {
      localStorage.setItem('dark', String(!prev));
      return !prev;
    });
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PropertySelector dark={dark} onToggleDark={toggleDark} />} />
        <Route path="/properties/:propertyId/renewal-risk" element={<RenewalRiskPage dark={dark} onToggleDark={toggleDark} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

interface Property { id: string; name: string; address: string; }

function PropertySelector({ dark, onToggleDark }: { dark: boolean; onToggleDark: () => void }) {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [manualId, setManualId] = useState('');

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE_URL}/api/v1/properties`)
      .then((r) => r.json())
      .then((data) => setProperties(data.properties ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const d = dark;

  return (
    <div className={`min-h-screen flex items-center justify-center ${d ? 'bg-gray-950' : 'bg-gray-100'}`}>
      <div className={`rounded-2xl shadow-lg border p-8 w-full max-w-md ${d ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center justify-between mb-2">
          <h1 className={`text-2xl font-bold ${d ? 'text-white' : 'text-gray-900'}`}>Renewal Risk Detection</h1>
          <button
            onClick={onToggleDark}
            className={`p-2 rounded-lg transition-colors ${d ? 'bg-gray-800 hover:bg-gray-700 text-yellow-400' : 'bg-gray-100 hover:bg-gray-200 text-gray-600'}`}
          >
            {d ? (
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
        <p className={`text-sm mb-6 ${d ? 'text-gray-400' : 'text-gray-500'}`}>Select a property to view its renewal risk dashboard.</p>

        {loading && <p className={`text-sm ${d ? 'text-gray-500' : 'text-gray-400'}`}>Loading properties...</p>}

        {!loading && properties.length > 0 && (
          <div className="flex flex-col gap-2 mb-6">
            {properties.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/properties/${p.id}/renewal-risk`)}
                className={`w-full text-left border rounded-lg px-4 py-3 transition-colors ${d ? 'border-gray-700 hover:bg-gray-800 hover:border-indigo-500' : 'border-gray-200 hover:bg-indigo-50 hover:border-indigo-300'}`}
              >
                <div className={`font-medium text-sm ${d ? 'text-gray-100' : 'text-gray-900'}`}>{p.name}</div>
                <div className={`text-xs ${d ? 'text-gray-500' : 'text-gray-400'}`}>{p.address}</div>
              </button>
            ))}
          </div>
        )}

        {!loading && properties.length === 0 && (
          <p className="text-sm text-amber-500 mb-4">No properties found. Run the seed first.</p>
        )}

        <div className={`border-t pt-4 ${d ? 'border-gray-700' : 'border-gray-100'}`}>
          <p className={`text-xs mb-2 ${d ? 'text-gray-500' : 'text-gray-400'}`}>Or enter a property ID manually:</p>
          <div className="flex gap-2">
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="Property UUID"
              className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${d ? 'bg-gray-800 border-gray-600 text-gray-100 placeholder-gray-500' : 'bg-white border-gray-300 text-gray-900'}`}
            />
            <button
              onClick={() => manualId.trim() && navigate(`/properties/${manualId.trim()}/renewal-risk`)}
              className="bg-indigo-600 text-white font-semibold rounded-lg px-4 py-2 text-sm hover:bg-indigo-700 transition-colors"
            >
              Go
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
