'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useWorldpadStore } from '@/lib/store';
import { useTradeExecution } from '@/hooks/use-trade-execution';
import {
  startMultiMarketScan, stopMultiMarketScan, getAllMarketData,
  isScannerConnected, addTickCallback, getScannerHealth,
  SCANNED_MARKETS, type MarketData, type MarketSymbol, type MarketTickData,
} from '@/lib/multi-market-ws';
import { aiEngine } from '@/lib/ai-engine';
import { scoreAllMarkets, selectTrades, feedTickToAI, type RankedMarket } from '@/lib/market-scorer';
import { isSimulating } from '@/lib/deriv-ws';

/**
 * GlobalAI — invisible background component that runs the AI brain globally.
 * Mounted once in page.tsx. Scans all 10 markets, scores them, auto-trades,
 * and learns — regardless of which tab the user is on.
 *
 * All trades from ANY tab (manual, bot, draft) feed back into AI learning
 * via the Zustand store's addTradeResult + recordTradeResult.
 */
export function GlobalAI() {
  const {
    isAuthorized, botConfig, addAutoTraderLog, addTradeResult,
    setGlobalAIRunning, setGlobalAIRankedMarkets, setGlobalAIStatus,
    setGlobalAICycleCount, setGlobalAITotalTrades, setGlobalAITotalProfit,
    setGlobalAILearningStats, setGlobalAIHealth,
    globalAIRunning,
  } = useWorldpadStore();

  const { placeTrade } = useTradeExecution();

  const runningRef = useRef(false);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTradesRef = useRef<Map<string, { signal: any; startedAt: number }>>(new Map());
  const tradeLockRef = useRef(false);
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

  // === Trade execution ===
  const executeTradeOnMarket = useCallback(async (market: RankedMarket, stake: number) => {
    if (!market.selectedSignal || tradeLockRef.current) return;
    tradeLockRef.current = true;

    try {
      const signal = market.selectedSignal;
      const logMsg = `[AI] ${market.name}: ${signal.contractType} d${signal.barrier ?? '-'} @ $${stake.toFixed(2)} | ${signal.reason} | score ${market.combinedScore.toFixed(0)}`;
      addAutoTraderLog(logMsg);

      activeTradesRef.current.set(market.symbol, { signal, startedAt: Date.now() });

      const result = await placeTrade({
        contractType: signal.contractType,
        barrier: signal.barrier,
        stake,
        symbol: market.symbol,
        duration: 1,
        durationUnit: 't',
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
      tradeLockRef.current = false;
    }
  }, [placeTrade, addAutoTraderLog, addTradeResult, setGlobalAITotalTrades, setGlobalAITotalProfit, setGlobalAILearningStats]);

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

    for (const trade of trades) {
      await executeTradeOnMarket(trade, botConfig.stake);
    }
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
    setGlobalAIRunning(true);
    setGlobalAICycleCount(0);
    setGlobalAITotalTrades(0);
    setGlobalAITotalProfit(0);

    const simMode = isSimulating() || !isAuthorized;
    addAutoTraderLog(`[AI] === GLOBAL AI STARTED === (${simMode ? 'SIMULATION' : 'LIVE'})`);
    addAutoTraderLog(`[AI] Scanning ${SCANNED_MARKETS.length} markets | Stake: $${botConfig.stake} | Stop Loss: $${botConfig.stopLoss}`);
    addAutoTraderLog(`[AI] Logic 60% + AI 40% | Trading ALL markets with signals`);

    const runLoop = async () => {
      if (!runningRef.current) return;
      await runCycle();
      if (runningRef.current) {
        cycleTimerRef.current = setTimeout(runLoop, 2500);
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
        // Only record non-AI trades (AI trades are already recorded)
        if (last.id.startsWith('ai-')) return;
        aiEngine.recordTradeResult(
          last.symbol, last.type, last.digit >= 0 ? last.digit : undefined,
          last.profit, 50 // moderate signal strength for manual trades
        );
      }
    );
    return unsub;
  }, []);

  // This component renders nothing — it's purely a background service
  return null;
}
