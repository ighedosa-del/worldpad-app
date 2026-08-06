'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  getMarketData, SCANNED_MARKETS, startMultiMarketScan,
  type MarketSymbol, type MarketData,
} from '@/lib/multi-market-ws';
import { useWorldpadStore } from '@/lib/store';
import { useTradeExecution } from '@/hooks/use-trade-execution';
import {
  ArrowUp, ArrowDown, Equal, Hash, CircleDot,
  ChevronDown, CheckCircle2, XCircle, Loader2, TrendingUp, Clock,
} from 'lucide-react';

// === Trade Types ===
type DigitTradeType = 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITEVEN' | 'DIGITODD';

const TRADE_TYPES: { type: DigitTradeType; label: string; short: string; icon: typeof ArrowUp; color: string }[] = [
  { type: 'DIGITOVER',  label: 'Over',  short: 'OVR', icon: ArrowUp,    color: '#22c55e' },
  { type: 'DIGITUNDER', label: 'Under', short: 'UND', icon: ArrowDown,  color: '#3b82f6' },
  { type: 'DIGITMATCH', label: 'Match', short: 'MTCH', icon: Equal,      color: '#a855f7' },
  { type: 'DIGITDIFF',  label: 'Differ', short: 'DIFF', icon: Equal,      color: '#f97316' },
  { type: 'DIGITEVEN', label: 'Even',  short: 'EVN', icon: Hash,        color: '#06b6d4' },
  { type: 'DIGITODD',  label: 'Odd',   short: 'ODD', icon: CircleDot,   color: '#eab308' },
];

// === Digit button ===
function DigitButton({ digit, selected, onClick, dist, total }: {
  digit: number; selected: boolean; onClick: () => void; dist: number; total: number;
}) {
  const pct = total > 0 ? (dist / total) * 100 : 10;
  const hot = pct >= 13;
  const cold = pct <= 7;
  return (
    <button
      onClick={onClick}
      className="relative flex flex-col items-center justify-center w-full aspect-square rounded-xl transition-all duration-200 group"
      style={{
        background: selected ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.03)',
        border: selected ? '1.5px solid rgba(168,85,247,0.6)' : '1px solid rgba(255,255,255,0.06)',
        boxShadow: selected ? '0 0 16px rgba(168,85,247,0.2)' : hot ? `0 0 8px ${hot ? '#22c55e' : '#ef4444'}20` : 'none',
      }}
    >
      <span
        className="text-lg sm:text-xl font-black font-mono transition-all duration-200 group-hover:scale-110"
        style={{
          color: selected ? '#a855f7' : hot ? '#22c55e' : cold ? '#ef4444' : '#e2e8f0',
          textShadow: selected ? '0 0 10px rgba(168,85,247,0.5)' : 'none',
        }}
      >
        {digit}
      </span>
      <span className="text-[9px] font-mono mt-0.5" style={{ color: hot ? '#22c55e' : cold ? '#ef4444' : '#6b7280' }}>
        {pct.toFixed(1)}%
      </span>
    </button>
  );
}

// === Trade history row ===
function TradeRow({ trade }: { trade: { id: string; type: string; symbol: string; stake: number; profit: number; won: boolean; timestamp: number; digit: number } }) {
  const formatCT = (t: string) => {
    const map: Record<string, string> = {
      DIGITOVER: 'Over', DIGITUNDER: 'Under', DIGITMATCH: 'Match',
      DIGITDIFF: 'Differ', DIGITEVEN: 'Even', DIGITODD: 'Odd',
    };
    return map[t] || t;
  };
  const fmtSymbol = (s: string) => s.replace('R_', 'V').replace('1HZ', 'V');
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      {trade.won
        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
        : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-white">{fmtSymbol(trade.symbol)}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{
          background: trade.won ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: trade.won ? '#22c55e' : '#ef4444',
        }}>{formatCT(trade.type)}{trade.digit >= 0 ? ` d${trade.digit}` : ''}</span>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs font-bold font-mono" style={{ color: trade.profit >= 0 ? '#22c55e' : '#ef4444' }}>
          {trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(2)}
        </div>
        <div className="text-[9px] text-gray-600">${trade.stake.toFixed(2)}</div>
      </div>
      <span className="text-[9px] text-gray-600 font-mono shrink-0">
        {new Date(trade.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
    </div>
  );
}

// === Main Trading Draft Component ===
export function TradingDraft() {
  const { placeTrade, isPlacingTrade } = useTradeExecution();
  const { tradeHistory, totalWins, totalLosses, totalProfit, isAuthorized, accountMode } = useWorldpadStore();

  // Market selection
  const [selectedSymbol, setSelectedSymbol] = useState<MarketSymbol>('R_10');
  const [marketDropdownOpen, setMarketDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Trade config
  const [tradeType, setTradeType] = useState<DigitTradeType>('DIGITDIFF');
  const [selectedDigit, setSelectedDigit] = useState(5);
  const [stake, setStake] = useState(0.5);
  const [duration, setDuration] = useState(1);

  // Result flash
  const [flashResult, setFlashResult] = useState<{ won: boolean; profit: number } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live market data from multi-market-ws polling
  const marketData = useMemo(() => {
    return getMarketData(selectedSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol]);

  // Force re-render on tick changes using a state trigger
  const [tickTrigger, setTickTrigger] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setTickTrigger(t => t + 1);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Read fresh data on each trigger
  const liveData = useMemo(() => getMarketData(selectedSymbol), [selectedSymbol, tickTrigger]);
  const lastDigit = liveData.lastTick?.digit ?? null;
  const tickCount = liveData.tickCount;
  const distribution = liveData.distribution;
  const digitTotal = distribution.reduce((a, b) => a + b, 0);
  const priceStr = liveData.lastTick?.price ?? '---.---';
  const digits = liveData.digits;

  // Recent pattern
  const recentPattern = useMemo(() => digits.slice(-30).map(d => d.toString()), [digits]);

  // Market name
  const marketName = useMemo(() => {
    const m = SCANNED_MARKETS.find(m => m.symbol === selectedSymbol);
    return m ? m.name : selectedSymbol;
  }, [selectedSymbol]);

  // Barrier needed?
  const needsBarrier = tradeType === 'DIGITOVER' || tradeType === 'DIGITUNDER' || tradeType === 'DIGITMATCH' || tradeType === 'DIGITDIFF';

  // Place trade
  const handlePlaceTrade = useCallback(async () => {
    if (isPlacingTrade) return;
    const result = await placeTrade({
      contractType: tradeType,
      barrier: needsBarrier ? selectedDigit : undefined,
      stake,
      symbol: selectedSymbol,
      duration,
      durationUnit: 't',
    });
    if (result) {
      setFlashResult({ won: result.won, profit: result.profit });
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashResult(null), 1500);
    }
  }, [placeTrade, tradeType, needsBarrier, selectedDigit, stake, selectedSymbol, duration, isPlacingTrade]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setMarketDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Filter trade history for manual trades (non-AI)
  const manualTrades = tradeHistory.filter(t => !t.id.startsWith('ai-')).slice(-50).reverse();
  const winRate = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0;

  // Simulate mode indicator
  const isSim = !isAuthorized;

  return (
    <div className="h-[calc(100vh-52px)] flex flex-col overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center gap-3 px-4 py-2 flex-wrap" style={{
        background: 'rgba(22, 27, 34, 0.8)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        {/* Market Selector */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setMarketDropdownOpen(!marketDropdownOpen)}
            className="text-white text-xs font-medium px-3 py-1.5 rounded-lg flex items-center gap-2 transition-all duration-200 hover:border-[rgba(255,255,255,0.2)]"
            style={{
              background: 'rgba(0,212,170,0.08)',
              border: '1px solid rgba(0,212,170,0.2)',
            }}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-wp-pulse" style={{ boxShadow: '0 0 6px rgba(34,197,94,0.6)' }} />
            <span>{marketName}</span>
            <ChevronDown className="w-3 h-3 text-gray-400" />
          </button>
          {marketDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 bg-[#161b22] text-white rounded-lg z-50 min-w-[200px] py-1 max-h-72 overflow-y-auto wp-scroll" style={{
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}>
              <div className="px-3 py-1.5 text-[9px] text-gray-500 uppercase tracking-wider font-bold">Standard Markets</div>
              {SCANNED_MARKETS.filter(m => m.type === 'standard').map(m => (
                <button
                  key={m.symbol}
                  onClick={() => { setSelectedSymbol(m.symbol as MarketSymbol); setMarketDropdownOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${m.symbol === selectedSymbol ? 'font-bold text-[#00d4aa] bg-[rgba(0,212,170,0.06)]' : 'text-gray-300 hover:bg-[rgba(255,255,255,0.05)]'}`}
                >{m.name}</button>
              ))}
              <div className="px-3 py-1.5 text-[9px] text-gray-500 uppercase tracking-wider font-bold mt-1">Fast Markets (1s)</div>
              {SCANNED_MARKETS.filter(m => m.type === 'fast').map(m => (
                <button
                  key={m.symbol}
                  onClick={() => { setSelectedSymbol(m.symbol as MarketSymbol); setMarketDropdownOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${m.symbol === selectedSymbol ? 'font-bold text-[#00d4aa] bg-[rgba(0,212,170,0.06)]' : 'text-gray-300 hover:bg-[rgba(255,255,255,0.05)]'}`}
                >{m.name}</button>
              ))}
            </div>
          )}
        </div>

        {/* Mode badge */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{
          background: isSim ? 'rgba(234,179,8,0.1)' : 'rgba(0,212,170,0.1)',
          border: `1px solid ${isSim ? 'rgba(234,179,8,0.2)' : 'rgba(0,212,170,0.2)'}`,
        }}>
          <div className={`w-1.5 h-1.5 rounded-full ${isSim ? 'bg-yellow-500' : 'bg-green-500'}`} />
          <span className="text-[10px] font-bold" style={{ color: isSim ? '#eab308' : '#00d4aa' }}>{isSim ? 'SIMULATION' : accountMode.toUpperCase()}</span>
        </div>

        {/* Tick count */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{
          background: 'rgba(59,130,246,0.08)',
          border: '1px solid rgba(59,130,246,0.15)',
        }}>
          <span className="text-[10px] font-bold text-blue-400">{tickCount} ticks</span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto wp-scroll p-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 max-w-7xl mx-auto">
          {/* LEFT: Trading Panel */}
          <div className="lg:col-span-2 space-y-4">
            {/* Live Price Display */}
            <div className="rounded-xl p-4 text-center relative overflow-hidden" style={{
              background: 'rgba(22, 27, 34, 0.8)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <div className="absolute inset-0 opacity-20" style={{
                background: 'radial-gradient(ellipse at center, rgba(0,212,170,0.08), transparent 70%)',
              }} />
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 font-medium relative">Live Price</p>
              <p className="text-3xl font-mono font-bold relative" style={{
                color: '#00d4aa',
                textShadow: '0 0 20px rgba(0, 212, 170, 0.4), 0 0 40px rgba(0, 212, 170, 0.15)',
              }}>
                {priceStr}
              </p>
              <div className="flex items-center justify-center gap-4 mt-2 relative">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-500 uppercase">Last Digit:</span>
                  <span className="text-sm font-black font-mono" style={{
                    color: lastDigit !== null ? '#e2e8f0' : '#374151',
                    textShadow: lastDigit !== null ? '0 0 10px rgba(255,255,255,0.3)' : 'none',
                  }}>{lastDigit !== null ? lastDigit : '-'}</span>
                </div>
                <div className="w-px h-4 bg-[#30363d]" />
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-500 uppercase">Market:</span>
                  <span className="text-sm font-bold text-white">{marketName}</span>
                </div>
              </div>

              {/* Flash result overlay */}
              {flashResult && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl" style={{
                  background: flashResult.won ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                  animation: 'fadeInOut 1.2s ease-out forwards',
                }}>
                  <div className="text-center">
                    {flashResult.won ? <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-1" /> : <XCircle className="w-10 h-10 text-red-400 mx-auto mb-1" />}
                    <span className="text-lg font-black font-mono" style={{
                      color: flashResult.won ? '#22c55e' : '#ef4444',
                      textShadow: `0 0 16px ${flashResult.won ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)'}`,
                    }}>
                      {flashResult.won ? '+' : ''}{flashResult.profit.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Trade Type Selector */}
            <div className="rounded-xl p-3" style={{
              background: 'rgba(22, 27, 34, 0.8)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {TRADE_TYPES.map(tt => {
                  const Icon = tt.icon;
                  const active = tradeType === tt.type;
                  return (
                    <button
                      key={tt.type}
                      onClick={() => setTradeType(tt.type)}
                      className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg transition-all duration-200"
                      style={{
                        background: active ? `${tt.color}18` : 'rgba(255,255,255,0.02)',
                        border: active ? `1.5px solid ${tt.color}50` : '1px solid rgba(255,255,255,0.06)',
                        boxShadow: active ? `0 0 12px ${tt.color}20` : 'none',
                      }}
                    >
                      <Icon className="w-4 h-4" style={{ color: active ? tt.color : '#6b7280' }} />
                      <span className="text-[10px] font-bold" style={{ color: active ? tt.color : '#9ca3af' }}>{tt.short}</span>
                      <span className="text-[9px] text-gray-600">{tt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Digit Grid (for barrier types) + Even/Odd display */}
            {needsBarrier ? (
              <div className="rounded-xl p-4" style={{
                background: 'rgba(22, 27, 34, 0.8)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold text-white uppercase tracking-wide" style={{ letterSpacing: '0.08em' }}>
                    Select Digit — <span style={{ color: TRADE_TYPES.find(t => t.type === tradeType)?.color }}>{TRADE_TYPES.find(t => t.type === tradeType)?.label}</span>
                  </h3>
                  <span className="text-[10px] text-gray-500">{tickCount} ticks collected</span>
                </div>
                <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                  {[0,1,2,3,4,5,6,7,8,9].map(d => (
                    <DigitButton
                      key={d}
                      digit={d}
                      selected={selectedDigit === d}
                      onClick={() => setSelectedDigit(d)}
                      dist={distribution[d]}
                      total={digitTotal}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl p-4 text-center" style={{
                background: 'rgba(22, 27, 34, 0.8)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div className="flex items-center justify-center gap-4">
                  <div className="text-center">
                    <div className="flex items-center gap-1.5 justify-center mb-1">
                      <Hash className="w-4 h-4 text-cyan-400" />
                      <span className="text-xs font-bold text-cyan-400">EVEN</span>
                    </div>
                    <span className="text-2xl font-black font-mono text-white">
                      {digitTotal > 0 ? (distribution[0] + distribution[2] + distribution[4] + distribution[6] + distribution[8]) : 0}
                    </span>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      {digitTotal > 0 ? (((distribution[0] + distribution[2] + distribution[4] + distribution[6] + distribution[8]) / digitTotal) * 100).toFixed(1) : 0}%
                    </p>
                  </div>
                  <div className="w-px h-12 bg-[#30363d]" />
                  <div className="text-center">
                    <div className="flex items-center gap-1.5 justify-center mb-1">
                      <CircleDot className="w-4 h-4 text-yellow-400" />
                      <span className="text-xs font-bold text-yellow-400">ODD</span>
                    </div>
                    <span className="text-2xl font-black font-mono text-white">
                      {digitTotal > 0 ? (distribution[1] + distribution[3] + distribution[5] + distribution[7] + distribution[9]) : 0}
                    </span>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      {digitTotal > 0 ? (((distribution[1] + distribution[3] + distribution[5] + distribution[7] + distribution[9]) / digitTotal) * 100).toFixed(1) : 0}%
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Recent Digits Pattern */}
            <div className="rounded-xl p-3" style={{
              background: 'rgba(22, 27, 34, 0.8)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <h3 className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-2">Recent Digits</h3>
              <div className="flex items-center gap-1 flex-wrap">
                {recentPattern.length === 0 ? (
                  <span className="text-xs text-gray-600">Waiting for data...</span>
                ) : recentPattern.map((d, i) => (
                  <span
                    key={i}
                    className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold font-mono"
                    style={{
                      background: i === 0 ? 'rgba(0,212,170,0.15)' : 'rgba(255,255,255,0.04)',
                      color: i === 0 ? '#00d4aa' : '#6b7280',
                      border: i === 0 ? '1px solid rgba(0,212,170,0.3)' : '1px solid rgba(255,255,255,0.04)',
                    }}
                  >{d}</span>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT: Controls + History */}
          <div className="space-y-4">
            {/* Trade Controls */}
            <div className="rounded-xl p-4" style={{
              background: 'rgba(22, 27, 34, 0.8)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <h3 className="text-xs font-bold text-white uppercase tracking-wide mb-4" style={{ letterSpacing: '0.08em' }}>Trade Setup</h3>

              {/* Stake */}
              <div className="mb-3">
                <label className="text-[10px] text-gray-500 uppercase tracking-wider font-medium block mb-1">Stake ($)</label>
                <input
                  type="number"
                  value={stake}
                  onChange={(e) => setStake(parseFloat(e.target.value) || 0)}
                  step={0.1}
                  min={0.35}
                  className="w-full text-white text-sm px-3 py-2 rounded-lg outline-none transition-all duration-200 focus:border-[rgba(0,212,170,0.4)] font-mono"
                  style={{
                    background: '#000000',
                    border: '1px solid rgba(255,255,255,0.1)',
                  }}
                />
              </div>

              {/* Duration */}
              <div className="mb-4">
                <label className="text-[10px] text-gray-500 uppercase tracking-wider font-medium block mb-1">Duration (Ticks)</label>
                <input
                  type="number"
                  value={duration}
                  onChange={(e) => setDuration(parseInt(e.target.value) || 1)}
                  min={1}
                  max={10}
                  className="w-full text-white text-sm px-3 py-2 rounded-lg outline-none transition-all duration-200 focus:border-[rgba(0,212,170,0.4)] font-mono"
                  style={{
                    background: '#000000',
                    border: '1px solid rgba(255,255,255,0.1)',
                  }}
                />
              </div>

              {/* Trade Summary */}
              <div className="rounded-lg p-3 mb-4" style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.04)',
              }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-gray-500 uppercase">Type</span>
                  <span className="text-xs font-bold" style={{ color: TRADE_TYPES.find(t => t.type === tradeType)?.color }}>
                    {TRADE_TYPES.find(t => t.type === tradeType)?.label}
                  </span>
                </div>
                {needsBarrier && (
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] text-gray-500 uppercase">Barrier</span>
                    <span className="text-xs font-bold text-white font-mono">Digit {selectedDigit}</span>
                  </div>
                )}
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-gray-500 uppercase">Stake</span>
                  <span className="text-xs font-bold text-white font-mono">${stake.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500 uppercase">Potential Payout</span>
                  <span className="text-xs font-bold text-green-400 font-mono">
                    ${(stake * (tradeType === 'DIGITMATCH' ? 8.5 : 0.85)).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* BUY Button */}
              <button
                onClick={handlePlaceTrade}
                disabled={isPlacingTrade}
                className="w-full py-3 rounded-xl text-sm font-black transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50"
                style={{
                  background: isPlacingTrade
                    ? 'rgba(107,114,128,0.3)'
                    : `linear-gradient(135deg, ${TRADE_TYPES.find(t => t.type === tradeType)?.color}, ${TRADE_TYPES.find(t => t.type === tradeType)?.color}cc)`,
                  color: tradeType === 'DIGITMATCH' ? '#fff' : '#0d1117',
                  boxShadow: isPlacingTrade ? 'none' : `0 0 20px ${TRADE_TYPES.find(t => t.type === tradeType)?.color}30`,
                }}
              >
                {isPlacingTrade ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />}
                {isPlacingTrade ? 'PLACING...' : `BUY ${TRADE_TYPES.find(t => t.type === tradeType)?.label.toUpperCase()}`}
              </button>
            </div>

            {/* Stats Summary */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl p-3 text-center" style={{
                background: 'rgba(34,197,94,0.04)',
                border: '1px solid rgba(34,197,94,0.12)',
              }}>
                <span className="text-[9px] text-gray-500 uppercase">Wins</span>
                <div className="text-lg font-bold font-mono text-green-400">{totalWins}</div>
              </div>
              <div className="rounded-xl p-3 text-center" style={{
                background: 'rgba(239,68,68,0.04)',
                border: '1px solid rgba(239,68,68,0.12)',
              }}>
                <span className="text-[9px] text-gray-500 uppercase">Losses</span>
                <div className="text-lg font-bold font-mono text-red-400">{totalLosses}</div>
              </div>
              <div className="rounded-xl p-3 text-center" style={{
                background: 'rgba(59,130,246,0.04)',
                border: '1px solid rgba(59,130,246,0.12)',
              }}>
                <span className="text-[9px] text-gray-500 uppercase">Win Rate</span>
                <div className="text-lg font-bold font-mono" style={{ color: winRate >= 50 ? '#22c55e' : '#ef4444' }}>{winRate.toFixed(0)}%</div>
              </div>
              <div className="rounded-xl p-3 text-center" style={{
                background: totalProfit >= 0 ? 'rgba(34,197,94,0.04)' : 'rgba(239,68,68,0.04)',
                border: `1px solid ${totalProfit >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'}`,
              }}>
                <span className="text-[9px] text-gray-500 uppercase">Net P/L</span>
                <div className="text-lg font-bold font-mono" style={{ color: totalProfit >= 0 ? '#22c55e' : '#ef4444' }}>
                  {totalProfit >= 0 ? '+' : ''}{totalProfit.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Trade History */}
            <div className="rounded-xl overflow-hidden" style={{
              background: 'rgba(22, 27, 34, 0.8)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
              <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <h3 className="text-xs font-bold text-white uppercase tracking-wide" style={{ letterSpacing: '0.08em' }}>Trade History</h3>
                <span className="text-[10px] text-gray-500 font-mono">{manualTrades.length} trades</span>
              </div>
              <div className="max-h-72 overflow-y-auto wp-scroll p-2 space-y-1">
                {manualTrades.length === 0 ? (
                  <div className="text-center py-6">
                    <Clock className="w-5 h-5 mx-auto mb-2 text-gray-600" />
                    <p className="text-xs text-gray-500">No trades yet. Select a trade type and click BUY.</p>
                  </div>
                ) : manualTrades.map(t => <TradeRow key={t.id} trade={t} />)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
