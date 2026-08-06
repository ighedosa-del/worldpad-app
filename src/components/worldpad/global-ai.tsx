'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useWorldpadStore } from '@/lib/store';
import {
  startMultiMarketScan, stopMultiMarketScan, getAllMarketData,
  isScannerConnected, addTickCallback, getScannerHealth,
  SCANNED_MARKETS, type MarketSymbol,
} from '@/lib/multi-market-ws';
import { aiEngine } from '@/lib/ai-engine';
import { scoreAllMarkets, selectTrades, feedTickToAI, type RankedMarket } from '@/lib/market-scorer';
import { isSimulating } from '@/lib/deriv-ws';

/**
 * GlobalAI — invisible background component that runs the AI brain globally.
 * Mounted once in page.tsx. Scans all 10 markets, scores them, auto-trades,
 * and learns — regardless of which tab the user is on.
 */
export function GlobalAI() {
  const {
    isAuthorized, botConfig, addAutoTraderLog, addTradeResult,
    setGlobalAIRunning, setGlobalAIRankedMarkets, setGlobalAIStatus,
    setGlobalAICycleCount, setGlobalAITotalTrades, setGlobalAITotalProfit,
    setGlobalAILearningStats, setGlobalAIHealth,
  } = useWorldpadStore();

  const runningRef = useRef(false);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTradesRef = useRef<Map<string, { signal: any; startedAt: number }>>(new Map());
  const tradeLocksRef = useRef<Set<string>>(new Set()); // per-market locks
  const totalProfitRef = useRef(0);
  const totalTradesRef = useRef(0);
  const cycleCountRef = useRef(0);
  const lastRankingRef = useRef<RankedMarket[]>([]);
  const mountedRef = useRef(true);

  // === Scoring ===
  const rankingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doUpdateRanking = useCallback(() => {
    try {
      const allData = Object.values(getAllMarketData());
      const ranked = scoreAllMarkets(allData);
      lastRankingRef.current = ranked;
      if (mountedRef.current) {
        setGlobalAIRankedMarkets(ranked);
      }
    } catch (err) {
      console.error('[GlobalAI] Ranking error:', err);
    }
  }, [setGlobalAIRankedMarkets]);

  const updateRankingThrottled = useCallback(() => {
    if (rankingTimerRef.current) return;
    rankingTimerRef.current = setTimeout(() => {
      rankingTimerRef.current = null;
      doUpdateRanking();
    }, 500);
  }, [doUpdateRanking]);

  // Tick callback — feeds AI + triggers ranking
  useEffect(() => {
    const unsubscribe = addTickCallback((symbol, data) => {
      feedTickToAI(symbol, data);
      updateRankingThrottled();
    });
    return unsubscribe;
  }, [updateRankingThrottled]);

  // === Trade execution (waits for next tick in sim mode) ===
  const executeTradeOnMarket = useCallback(async (market: RankedMarket, stake: number) => {
    if (!market.selectedSignal) return;
    if (tradeLocksRef.current.has(market.symbol)) return;
    tradeLocksRef.current.add(market.symbol);

    try {
      const signal = market.selectedSignal;
      const logMsg = `[AI] ${market.name}: ${signal.contractType} d${signal.barrier ?? '-'} @ $${stake.toFixed(2)} | ${signal.reason} | score ${market.combinedScore.toFixed(0)}`;
      addAutoTraderLog(logMsg);

      activeTradesRef.current.set(market.symbol, { signal, startedAt: Date.now() });

      const result = await placeTradeDirect({
        contractType: signal.contractType,
        barrier: signal.barrier,
        stake,
        symbol: market.symbol,
      });

      if (result) {
        const won = result.profit > 0;
        const logResult = won
          ? `[AI] WIN  ${market.name}: +$${result.profit.toFixed(2)}`
          : `[AI] LOSS ${market.name}: $${result.profit.toFixed(2)}`;
        addAutoTraderLog(logResult);

        aiEngine.recordTradeResult(
          market.symbol, signal.contractType, signal.barrier,
          result.profit, market.combinedScore
        );

        addTradeResult({
          id: `ai-${Date.now()}-${market.symbol}`,
          type: signal.contractType,
          symbol: market.symbol,
          stake,
          payout: result.payout || stake * 0.85,
          profit: result.profit,
          digit: signal.barrier ?? -1,
          won,
          timestamp: Date.now(),
        });

        totalProfitRef.current += result.profit;
        totalTradesRef.current += 1;
        if (mountedRef.current) {
          setGlobalAITotalTrades(totalTradesRef.current);
          setGlobalAITotalProfit(totalProfitRef.current);
          setGlobalAILearningStats(aiEngine.getLearningStats());
        }
      }
    } catch (err) {
      addAutoTraderLog(`[AI] Error on ${market.name}: ${(err as Error).message}`);
    } finally {
      activeTradesRef.current.delete(market.symbol);
      tradeLocksRef.current.delete(market.symbol);
    }
  }, [addAutoTraderLog, addTradeResult, setGlobalAITotalTrades, setGlobalAITotalProfit, setGlobalAILearningStats]);

  // === Main AI cycle ===
  const runCycle = useCallback(async () => {
    if (!runningRef.current) return;
    setGlobalAIStatus('scanning');

    const ranked = lastRankingRef.current;
    if (ranked.length === 0) { setGlobalAIStatus('waiting'); return; }

    const trades = selectTrades(ranked, {}, new Set(activeTradesRef.current.keys()));
    if (trades.length === 0) { setGlobalAIStatus('waiting'); return; }

    setGlobalAIStatus('trading');
    cycleCountRef.current += 1;
    if (mountedRef.current) setGlobalAICycleCount(cycleCountRef.current);

    // Fire all trades in parallel (per-market locks prevent duplicates)
    const promises = trades.map(trade => executeTradeOnMarket(trade, botConfig.stake));
    await Promise.all(promises);

    setGlobalAIStatus('waiting');
  }, [executeTradeOnMarket, botConfig.stake, setGlobalAIStatus, setGlobalAICycleCount]);

  // === Start / Stop ===
  const startBot = useCallback(() => {
    aiEngine.loadLearningData();
    setGlobalAILearningStats(aiEngine.getLearningStats());
    runningRef.current = true;
    totalProfitRef.current = 0;
    totalTradesRef.current = 0;
    cycleCountRef.current = 0;
    activeTradesRef.current.clear();
    tradeLocksRef.current.clear();
    setGlobalAIRunning(true);
    setGlobalAICycleCount(0);
    setGlobalAITotalTrades(0);
    setGlobalAITotalProfit(0);

    const simMode = isSimulating() || !isAuthorized;
    addAutoTraderLog(`[AI] === GLOBAL AI STARTED === (${simMode ? 'SIMULATION' : 'LIVE'})`);
    addAutoTraderLog(`[AI] Scanning ${SCANNED_MARKETS.length} markets | Stake: $${botConfig.stake} | Stop Loss: $${botConfig.stopLoss}`);
    addAutoTraderLog(`[AI] Logic 60% + AI 40% | Min score 10 | Max concurrent: 10`);

    const runLoop = async () => {
      if (!runningRef.current) return;
      await runCycle();
      if (runningRef.current) {
        cycleTimerRef.current = setTimeout(runLoop, 3000);
      }
    };
    runLoop();
  }, [isAuthorized, botConfig, addAutoTraderLog, runCycle, setGlobalAIRunning, setGlobalAICycleCount, setGlobalAITotalTrades, setGlobalAITotalProfit, setGlobalAILearningStats]);

  const stopBot = useCallback(() => {
    runningRef.current = false;
    setGlobalAIRunning(false);
    setGlobalAIStatus('idle');
    if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null; }
    activeTradesRef.current.clear();
    tradeLocksRef.current.clear();
    // Clear any pending sim trades
    pendingSimTradesGlobal.clear();
    addAutoTraderLog(`[AI] === GLOBAL AI STOPPED === | Cycles: ${cycleCountRef.current} | Trades: ${totalTradesRef.current} | P/L: ${totalProfitRef.current >= 0 ? '+' : ''}$${totalProfitRef.current.toFixed(2)}`);
    aiEngine.saveLearningData();
  }, [addAutoTraderLog, setGlobalAIRunning, setGlobalAIStatus]);

  // Expose start/stop for AI Scanner buttons
  useEffect(() => {
    (window as any).__globalAI = { startBot, stopBot };
    return () => { delete (window as any).__globalAI; };
  }, [startBot, stopBot]);

  // === Init: start scanning + auto-start bot ===
  useEffect(() => {
    mountedRef.current = true;
    aiEngine.loadLearningData();
    setGlobalAILearningStats(aiEngine.getLearningStats());
    startMultiMarketScan();

    // Auto-start the AI bot after a short delay (let ticks accumulate)
    const autoStartTimer = setTimeout(() => {
      if (mountedRef.current && !runningRef.current) {
        startBot();
      }
    }, 5000);

    return () => {
      mountedRef.current = false;
      runningRef.current = false;
      if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
      if (rankingTimerRef.current) clearTimeout(rankingTimerRef.current);
      clearTimeout(autoStartTimer);
      stopMultiMarketScan();
    };
  }, []);

  // Health monitoring
  useEffect(() => {
    const interval = setInterval(() => {
      if (!mountedRef.current) return;
      const connected = isScannerConnected();
      const health = getScannerHealth();
      if (mountedRef.current) {
        setGlobalAIHealth({
          isConnected: connected,
          totalTicksReceived: health.totalTicksReceived,
          lastTickTime: health.lastTickTime,
          connectTime: health.connectTime,
          ticksPerMarket: health.ticksPerMarket,
          wsError: health.wsError,
          callbackCount: health.callbackCount,
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [setGlobalAIHealth]);

  // Listen for trades from ANY tab and feed AI learning
  useEffect(() => {
    const unsub = useWorldpadStore.subscribe(
      (state) => state.tradeHistory,
      (history) => {
        if (history.length === 0) return;
        const last = history[history.length - 1];
        if (last.id.startsWith('ai-')) return;
        aiEngine.recordTradeResult(
          last.symbol, last.type, last.digit >= 0 ? last.digit : undefined,
          last.profit, 50
        );
      }
    );
    return unsub;
  }, []);

  // This component renders nothing — it's purely a background service
  return null;
}

// === Direct trade function (bypasses useTradeExecution hook to avoid React issues) ===
import { addTickCallback as addTickListener } from '@/lib/multi-market-ws';
import type { TradeResult } from '@/hooks/use-trade-execution';

// Pending simulation trades awaiting next tick
const pendingSimTradesGlobal: Map<string, {
  contractType: string;
  barrier: number | undefined;
  stake: number;
  symbol: string;
  resolve: (result: TradeResult | null) => void;
}> = new Map();

let globalTickListenerRegistered = false;

function registerGlobalTickListener() {
  if (globalTickListenerRegistered) return;
  globalTickListenerRegistered = true;

  addTickListener((symbol, data) => {
    const pending = pendingSimTradesGlobal.get(symbol);
    if (!pending || !data.lastTick) return;

    const nextDigit = data.lastTick.digit;
    pendingSimTradesGlobal.delete(symbol);

    const { contractType, barrier, stake, symbol: tradeSymbol } = pending;
    let won = false;
    switch (contractType) {
      case 'DIGITMATCH': won = nextDigit === barrier; break;
      case 'DIGITDIFF': won = nextDigit !== barrier; break;
      case 'DIGITOVER': won = nextDigit > (barrier ?? 4); break;
      case 'DIGITUNDER': won = nextDigit < (barrier ?? 5); break;
      case 'DIGITEVEN': won = nextDigit % 2 === 0; break;
      case 'DIGITODD': won = nextDigit % 2 === 1; break;
      default: won = Math.random() > 0.5;
    }

    const isMatch = contractType === 'DIGITMATCH';
    const payout = won ? stake * (isMatch ? 8.5 : 0.85) : 0;
    const profit = payout - stake;

    const result: TradeResult = {
      id: `SIM-${Date.now()}`,
      type: contractType,
      symbol: tradeSymbol,
      stake,
      payout,
      profit,
      digit: barrier ?? -1,
      won,
      timestamp: Date.now(),
      simulated: true,
    };

    pending.resolve(result);
  });
}

export function clearPendingSimTrades() {
  pendingSimTradesGlobal.clear();
}

async function placeTradeDirect(params: {
  contractType: string;
  barrier?: number;
  stake: number;
  symbol: string;
}): Promise<TradeResult | null> {
  const { isSimulating: checkSim, getProposalWS, buyContractWS } = await import('@/lib/deriv-ws');
  const simMode = checkSim() || !useWorldpadStore.getState().isAuthorized;

  if (simMode) {
    // Wait for NEXT tick
    if (pendingSimTradesGlobal.has(params.symbol)) return null;

    return new Promise<TradeResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingSimTradesGlobal.delete(params.symbol);
        resolve(null);
      }, 15000);

      registerGlobalTickListener();
      pendingSimTradesGlobal.set(params.symbol, {
        ...params,
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
      });
    });
  }

  // LIVE mode
  try {
    const proposal = await getProposalWS({
      contractType: params.contractType,
      symbol: params.symbol,
      stake: params.stake,
      barrier: params.barrier,
      duration: 1,
      durationUnit: 't',
    });
    const buyResult = await buyContractWS(proposal.id, proposal.ask_price);
    const won = buyResult.profit > 0;
    return {
      id: buyResult.contract_id,
      type: params.contractType,
      symbol: params.symbol,
      stake: params.stake,
      payout: buyResult.payout,
      profit: buyResult.profit,
      digit: params.barrier ?? -1,
      won,
      timestamp: Date.now(),
      simulated: false,
    };
  } catch (err) {
    console.error('[GlobalAI] Live trade error:', err);
    return null;
  }
}
