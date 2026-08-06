'use client';

import { useCallback, useRef, useEffect, useState } from 'react';
import { useWorldpadStore } from '@/lib/store';
import { useTradeExecution } from '@/hooks/use-trade-execution';
import {
  startMultiMarketScan, stopMultiMarketScan, getAllMarketData,
  getMarketData, isScannerConnected, addTickCallback, getScannerHealth,
  SCANNED_MARKETS, type MarketData, type MarketSymbol, type MarketTickData,
} from '@/lib/multi-market-ws';
import { aiEngine } from '@/lib/ai-engine';
import { scoreAllMarkets, selectTrades, feedTickToAI, type RankedMarket } from '@/lib/market-scorer';
import { isSimulating } from '@/lib/deriv-ws';

export interface ScannerHealth {
  isConnected: boolean;
  totalTicksReceived: number;
  lastTickTime: number;
  connectTime: number;
  ticksPerMarket: Record<string, number>;
  wsError: string | null;
  callbackCount: number;
}

export interface AIBotState {
  isRunning: boolean;
  rankedMarkets: RankedMarket[];
  activeTrades: Map<string, { signal: any; startedAt: number }>;
  cycleCount: number;
  totalTradesPlaced: number;
  totalProfit: number;
  scannerConnected: boolean;
  scannerHealth: ScannerHealth;
  lastCycleTime: number;
  status: 'idle' | 'scanning' | 'trading' | 'waiting';
}

export function useAIBot() {
  const {
    isAuthorized, botConfig, addAutoTraderLog, addTradeResult,
  } = useWorldpadStore();

  const { placeTrade } = useTradeExecution();

  // State
  const [rankedMarkets, setRankedMarkets] = useState<RankedMarket[]>([]);
  const [scannerConnected, setScannerConnected] = useState(false);
  const [scannerHealth, setScannerHealth] = useState<ScannerHealth>({
    isConnected: false, totalTicksReceived: 0, lastTickTime: 0,
    connectTime: 0, ticksPerMarket: {}, wsError: null, callbackCount: 0,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<AIBotState['status']>('idle');
  const [cycleCount, setCycleCount] = useState(0);
  const [totalTradesPlaced, setTotalTradesPlaced] = useState(0);
  const [learningStats, setLearningStats] = useState(aiEngine.getLearningStats());

  // Refs
  const runningRef = useRef(false);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTradesRef = useRef<Map<string, { signal: any; startedAt: number }>>(new Map());
  const tradeLockRef = useRef(false);
  const totalProfitRef = useRef(0);
  const tickDataRef = useRef<Map<string, MarketTickData | null>>(new Map());
  const lastRankingRef = useRef<RankedMarket[]>([]);
  const mountedRef = useRef(true);

  // Initialize tick data map
  for (const m of SCANNED_MARKETS) {
    tickDataRef.current.set(m.symbol, null);
  }

  // === CORE: Force re-score all markets ===
  const doUpdateRanking = useCallback(() => {
    try {
      const allData = Object.values(getAllMarketData());
      const ranked = scoreAllMarkets(allData);
      lastRankingRef.current = ranked;
      if (mountedRef.current) {
        setRankedMarkets(ranked);
      }
    } catch (err) {
      console.error('[AIBot] Ranking error:', err);
    }
  }, []);

  // Throttled version for tick callbacks (max once per 500ms)
  const rankingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      tickDataRef.current.set(symbol, data.lastTick);
      feedTickToAI(symbol, data);
      updateRankingThrottled();
    });
    return unsubscribe;
  }, [updateRankingThrottled]);

  // === FALLBACK: Poll every 1 second to force re-score ===
  useEffect(() => {
    const interval = setInterval(() => {
      if (!mountedRef.current) return;
      const connected = isScannerConnected();
      setScannerConnected(connected);
      const health = getScannerHealth();
      setScannerHealth(health);
      doUpdateRanking();
    }, 1000);
    return () => clearInterval(interval);
  }, [doUpdateRanking]);

  // Execute a trade on a specific market
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

        // Record to AI engine for learning
        aiEngine.recordTradeResult(
          market.symbol, signal.contractType, signal.barrier,
          result.profit, market.combinedScore
        );

        // Record to global trade history (Trading Draft)
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
        setTotalTradesPlaced(prev => prev + 1);
        setLearningStats(aiEngine.getLearningStats());
      }
    } catch (err) {
      addAutoTraderLog(`[AI] Error on ${market.name}: ${(err as Error).message}`);
    } finally {
      activeTradesRef.current.delete(market.symbol);
      tradeLockRef.current = false;
    }
  }, [placeTrade, addAutoTraderLog, addTradeResult]);

  // Main AI bot cycle
  const runCycle = useCallback(async () => {
    if (!runningRef.current) return;
    setStatus('scanning');
    const ranked = lastRankingRef.current;
    if (ranked.length === 0) { setStatus('waiting'); return; }
    const trades = selectTrades(ranked, {}, new Set(activeTradesRef.current.keys()));
    if (trades.length === 0) { setStatus('waiting'); return; }
    setStatus('trading');
    setCycleCount(prev => prev + 1);
    for (const trade of trades) {
      await executeTradeOnMarket(trade, botConfig.stake);
    }
    setStatus('waiting');
  }, [executeTradeOnMarket, botConfig.stake]);

  // Start the AI bot
  const startBot = useCallback(() => {
    aiEngine.loadLearningData();
    setLearningStats(aiEngine.getLearningStats());
    runningRef.current = true;
    setIsRunning(true);
    totalProfitRef.current = 0;
    setCycleCount(0);
    setTotalTradesPlaced(0);
    activeTradesRef.current.clear();
    const simMode = isSimulating() || !isAuthorized;
    addAutoTraderLog(`[AI] === AI BOT STARTED === (${simMode ? 'SIMULATION' : 'LIVE'})`);
    addAutoTraderLog(`[AI] Scanning ${SCANNED_MARKETS.length} markets | Stake: $${botConfig.stake} | Stop Loss: $${botConfig.stopLoss}`);
    addAutoTraderLog(`[AI] Logic 60% + AI 40% | Min score 55 | Max concurrent: 2`);
    const runLoop = async () => {
      if (!runningRef.current) return;
      await runCycle();
      if (runningRef.current) {
        cycleTimerRef.current = setTimeout(runLoop, 2500);
      }
    };
    runLoop();
  }, [isAuthorized, botConfig, addAutoTraderLog, runCycle]);

  // Stop the AI bot
  const stopBot = useCallback(() => {
    runningRef.current = false;
    setIsRunning(false);
    setStatus('idle');
    if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null; }
    stopMultiMarketScan();
    setTimeout(() => {
      if (mountedRef.current) startMultiMarketScan();
    }, 500);
    activeTradesRef.current.clear();
    addAutoTraderLog(`[AI] === AI BOT STOPPED === | Cycles: ${cycleCount} | P/L: ${totalProfitRef.current >= 0 ? '+' : ''}$${totalProfitRef.current.toFixed(2)}`);
    aiEngine.saveLearningData();
  }, [addAutoTraderLog, cycleCount]);

  // Start scanning on mount
  useEffect(() => {
    mountedRef.current = true;
    startMultiMarketScan();
    aiEngine.loadLearningData();
    return () => {
      mountedRef.current = false;
      runningRef.current = false;
      if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
      if (rankingTimerRef.current) clearTimeout(rankingTimerRef.current);
      stopMultiMarketScan();
    };
  }, []);

  return {
    isRunning, rankedMarkets, scannerConnected, scannerHealth,
    status, cycleCount, totalTradesPlaced,
    totalProfit: totalProfitRef.current,
    learningStats, startBot, stopBot,
  };
}
