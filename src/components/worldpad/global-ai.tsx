'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useWorldpadStore } from '@/lib/store';
import {
  startMultiMarketScan, stopMultiMarketScan, getAllMarketData,
  isScannerConnected, addTickCallback, getScannerHealth,
  SCANNED_MARKETS, addTickCallback as addTickListener,
} from '@/lib/multi-market-ws';
import { aiEngine } from '@/lib/ai-engine';
import { scoreAllMarkets, selectTrades, feedTickToAI, type RankedMarket } from '@/lib/market-scorer';
import { calculateStake, recordRiskResult, resetRiskStates, getSessionPL } from '@/lib/risk-manager';
import { checkLiveTrade, recordLiveTrade, resetLiveSession, getLiveStats, preFlightCheck } from '@/lib/real-money-guard';
import { getProposalWS, buyContractWS, restoreCredentials, getTradeWSStatus } from '@/lib/deriv-ws';
import type { TradeResult } from '@/hooks/use-trade-execution';
import { clearPendingSimTrades } from '@/hooks/use-trade-execution';

// === Pending simulation trades awaiting next tick (for GlobalAI direct trades) ===
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

    // Payout: Deriv pays net profit multiplier on win, 0 on loss
    const isMatch = contractType === 'DIGITMATCH';
    const profitMultiplier = isMatch ? 8.5 : 0.85;
    const profit = won ? stake * profitMultiplier : -stake;
    const payout = won ? stake + profit : 0;

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

async function placeTradeDirect(params: {
  contractType: string;
  barrier?: number;
  stake: number;
  symbol: string;
}): Promise<TradeResult | null> {
  // v5 FIX: Only check isAuthorized. isSimulating() refers to the single-market WS
  // which is irrelevant — GlobalAI uses multi-market-ws for ticks (always real data).
  const authorized = useWorldpadStore.getState().isAuthorized;
  const simMode = !authorized;
  const wsStatus = getTradeWSStatus();
  console.log('[GlobalAI] placeTradeDirect: isAuthorized=', authorized, 'simMode=', simMode, 'ws=', wsStatus);

  if (simMode) {
    console.warn('[GlobalAI] SIMULATION TRADE — NOT sending to Deriv. isAuthorized=', authorized);
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

  // LIVE mode — sending real trade to Deriv
  try {
    console.log('[GlobalAI] LIVE TRADE — sending to Deriv WS (ready:', wsStatus.wsReady, 'token:', wsStatus.tokenPreview, ')');
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

/**
 * GlobalAI v2 — invisible background component that runs the AI brain globally.
 * Mounted once in page.tsx. Scans all 10 markets, scores them, auto-trades,
 * and learns — regardless of which tab the user is on.
 * v4: Full system — Pattern Library + Regime Filter + Backtesting +
 * Strategy Rotation + Kelly Staking + EV filtering + stop-loss + cooldowns
 */

// v2: Per-market loss cooldown tracker (shared with use-ai-bot)
const lossCooldownsGlobal: Map<string, number> = new Map();
const LOSS_COOLDOWN_TICKS = 4;
const marketTickCountsGlobal: Map<string, number> = new Map();

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
  const tradeLocksRef = useRef<Set<string>>(new Set());
  const totalProfitRef = useRef(0);
  const totalTradesRef = useRef(0);
  const cycleCountRef = useRef(0);
  const lastRankingRef = useRef<RankedMarket[]>([]);
  const mountedRef = useRef(true);
  const sessionWinsRef = useRef(0);
  const sessionLossesRef = useRef(0);

  // Init tick counters
  for (const m of SCANNED_MARKETS) {
    if (!marketTickCountsGlobal.has(m.symbol)) marketTickCountsGlobal.set(m.symbol, 0);
  }

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

  // Tick callback — feeds AI + triggers ranking + manages cooldowns
  useEffect(() => {
    const unsubscribe = addTickCallback((symbol, data) => {
      feedTickToAI(symbol, data);
      updateRankingThrottled();

      // v2: Decrement cooldowns
      const currentTicks = (marketTickCountsGlobal.get(symbol) || 0) + 1;
      marketTickCountsGlobal.set(symbol, currentTicks);
      const cdRemaining = lossCooldownsGlobal.get(symbol);
      if (cdRemaining !== undefined && currentTicks >= cdRemaining) {
        lossCooldownsGlobal.delete(symbol);
      }
    });
    return unsubscribe;
  }, [updateRankingThrottled]);

  // v2: Build cooldown set
  const getCooldownSet = useCallback((): Set<string> => {
    const set = new Set<string>();
    for (const [symbol, untilTick] of lossCooldownsGlobal) {
      if ((marketTickCountsGlobal.get(symbol) || 0) < untilTick) set.add(symbol);
    }
    return set;
  }, []);

  // v2: Stop-loss check
  const isStopLossHit = useCallback((): boolean => {
    if (botConfig.stopLoss <= 0) return false;
    return totalProfitRef.current <= -botConfig.stopLoss;
  }, [botConfig.stopLoss]);

  // === Trade execution ===
  const executeTradeOnMarket = useCallback(async (market: RankedMarket, stake: number) => {
    if (!market.selectedSignal) return;
    if (tradeLocksRef.current.has(market.symbol)) return;

    // v5: Real Money Guard — check safety rules
    // v5 FIX: Only check isAuthorized (isSimulating checks wrong WS)
    const simMode = !isAuthorized;
    const guardResult = checkLiveTrade(stake, !simMode);
    if (!guardResult.allowed) {
      addAutoTraderLog(`[AI] BLOCKED: ${guardResult.reason}`);
      if (guardResult.warnings.length > 0) {
        for (const w of guardResult.warnings) addAutoTraderLog(`[AI] WARNING: ${w}`);
      }
      return;
    }
    if (guardResult.warnings.length > 0) {
      for (const w of guardResult.warnings) addAutoTraderLog(`[AI] WARNING: ${w}`);
    }

    tradeLocksRef.current.add(market.symbol);

    try {
      const signal = market.selectedSignal;
      // v4: Dynamic stake via Kelly criterion
      const { stake: kellyStake, reason: stakeReason } = calculateStake(
        market.symbol, signal.contractType, 0.90, { baseStake: guardResult.cappedStake }
      );
      let finalStake = kellyStake > 0 ? kellyStake : guardResult.cappedStake;

      // v5: Re-apply live stake caps after Kelly adjustment
      if (!simMode) {
        finalStake = Math.max(0.35, Math.min(5.0, finalStake));
      }

      const logMsg = `[AI] ${market.name}: ${signal.contractType} d${signal.barrier ?? '-'} @ $${finalStake.toFixed(2)}${simMode ? ' ⚠️SIM' : ' LIVE'} | ${signal.reason} | score ${market.combinedScore.toFixed(0)} | ${stakeReason}`;
      addAutoTraderLog(logMsg);

      activeTradesRef.current.set(market.symbol, { signal, startedAt: Date.now() });

      const result = await placeTradeDirect({
        contractType: signal.contractType,
        barrier: signal.barrier,
        stake: finalStake,
        symbol: market.symbol,
      });

      if (result) {
        const won = result.profit > 0;

        // v5: Record live trade for safety tracking
        if (!simMode) {
          const liveResult = recordLiveTrade(result.profit);
          if (liveResult.shouldPause) {
            addAutoTraderLog(`[AI] PAUSED: ${liveResult.message}`);
          }
          if (liveResult.shouldStop) {
            addAutoTraderLog(`[AI] HARD STOP: ${liveResult.message}`);
            runningRef.current = false;
            setGlobalAIRunning(false);
            setGlobalAIStatus('idle');
            aiEngine.saveLearningData();
            return;
          }
        }

        // v2: Per-market loss cooldown
        if (!won) {
          const ct = marketTickCountsGlobal.get(market.symbol) || 0;
          lossCooldownsGlobal.set(market.symbol, ct + LOSS_COOLDOWN_TICKS);
          sessionLossesRef.current++;
          sessionWinsRef.current = 0;
        } else {
          sessionWinsRef.current++;
          sessionLossesRef.current = 0;
        }

        addAutoTraderLog(won
          ? `[AI] WIN  ${market.name}: +$${result.profit.toFixed(2)} | W:${sessionWinsRef.current} L:${sessionLossesRef.current}${!simMode ? ' [LIVE]' : ''}`
          : `[AI] LOSS ${market.name}: $${result.profit.toFixed(2)} | W:${sessionWinsRef.current} L:${sessionLossesRef.current} | cooldown ${LOSS_COOLDOWN_TICKS} ticks${!simMode ? ' [LIVE]' : ''}`);

        aiEngine.recordTradeResult(
          market.symbol, signal.contractType, signal.barrier,
          result.profit, market.combinedScore
        );

        // v4: Record to risk manager
        recordRiskResult(market.symbol, result.profit);

        addTradeResult({
          id: `ai-${Date.now()}-${market.symbol}`,
          type: signal.contractType,
          symbol: market.symbol,
          stake: finalStake,
          payout: result.payout || finalStake * 0.85,
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
  }, [isAuthorized, addAutoTraderLog, addTradeResult, setGlobalAITotalTrades, setGlobalAITotalProfit, setGlobalAILearningStats]);

  // === Main AI cycle ===
  const runCycle = useCallback(async () => {
    if (!runningRef.current) return;

    // v2: STOP-LOSS ENFORCEMENT
    if (isStopLossHit()) {
      runningRef.current = false;
      if (mountedRef.current) setGlobalAIRunning(false);
      setGlobalAIStatus('idle');
      addAutoTraderLog(`[AI] ⛔ STOP LOSS HIT: -$${Math.abs(totalProfitRef.current).toFixed(2)} exceeded $${botConfig.stopLoss} limit. Bot stopped.`);
      addAutoTraderLog(`[AI] Session: ${totalTradesRef.current} trades | W:${sessionWinsRef.current} L:${sessionLossesRef.current}`);
      aiEngine.saveLearningData();
      return;
    }

    setGlobalAIStatus('scanning');

    const ranked = lastRankingRef.current;
    if (ranked.length === 0) { setGlobalAIStatus('waiting'); return; }

    // v2: Pass cooldown set
    const cooldownSet = getCooldownSet();
    const trades = selectTrades(ranked, {}, new Set(activeTradesRef.current.keys()), cooldownSet);
    if (trades.length === 0) { setGlobalAIStatus('waiting'); return; }

    setGlobalAIStatus('trading');
    cycleCountRef.current += 1;
    if (mountedRef.current) setGlobalAICycleCount(cycleCountRef.current);

    // v2: Log EV summary for each trade
    for (const t of trades) {
      if (t.selectedSignal) {
        addAutoTraderLog(`[AI] → ${t.name}: ${t.selectedSignal.contractType} d${t.selectedSignal.barrier ?? '-'} | EV=${t.expectedValue.toFixed(3)} | score=${t.combinedScore.toFixed(0)} | conf=${Math.round((t.selectedSignal.confidence || 0) * 100)}%`);
      }
    }

    // Fire all trades in parallel (per-market locks prevent duplicates)
    const promises = trades.map(trade => executeTradeOnMarket(trade, botConfig.stake));
    await Promise.all(promises);

    setGlobalAIStatus('waiting');
  }, [executeTradeOnMarket, botConfig.stake, botConfig.stopLoss, setGlobalAIStatus, setGlobalAICycleCount, isStopLossHit, getCooldownSet]);

  // === Start / Stop ===
  const startBot = useCallback(() => {
    // v2: Reset everything on fresh start
    lossCooldownsGlobal.clear();
    sessionWinsRef.current = 0;
    sessionLossesRef.current = 0;
    resetRiskStates(); // v4: reset Kelly staking

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

    // v5 FIX: Only check isAuthorized (isSimulating checks wrong WS)
    const simMode = !isAuthorized;

    // v5: Pre-flight safety check for live trading
    if (!simMode) {
      const preflight = preFlightCheck(true);
      addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
      addAutoTraderLog(`[AI] === GLOBAL AI v5 STARTED === (LIVE MODE)`);
      addAutoTraderLog(`[AI] REAL MONEY GUARD ACTIVE`);
      addAutoTraderLog(`[AI] Min stake: $0.35 | Max stake: $5.00`);
      addAutoTraderLog(`[AI] Session stop-loss: $10 | Daily stop-loss: $25`);
      addAutoTraderLog(`[AI] Auto-pause after 5 consecutive losses (30s cooldown)`);
      addAutoTraderLog(`[AI] Auto-evaluate every 50 live trades`);
      if (!preflight.allowed) {
        addAutoTraderLog(`[AI] BLOCKED: ${preflight.reason}`);
        runningRef.current = false;
        setGlobalAIRunning(false);
        addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
        return;
      }
      addAutoTraderLog(`[AI] Preflight: ${preflight.reason}`);
      const stats = getLiveStats();
      addAutoTraderLog(`[AI] Live session: ${stats.totalLiveTrades} trades | P/L: ${stats.totalLiveProfit >= 0 ? '+' : ''}$${stats.totalLiveProfit.toFixed(2)}`);
      addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
    } else {
      addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
      addAutoTraderLog(`[AI] ⚠️  SIMULATION MODE — NOT connected to Deriv`);
      addAutoTraderLog(`[AI] ⚠️  Trades are FAKE — no real money used`);
      addAutoTraderLog(`[AI] ⚠️  Click CONNECT ACCOUNT to trade for real`);
      addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
      addAutoTraderLog(`[AI] Scanning ${SCANNED_MARKETS.length} markets | Stake: $${botConfig.stake} | Stop Loss: $${botConfig.stopLoss}`);
    }

    const runLoop = async () => {
      if (!runningRef.current) return;
      await runCycle();
      if (runningRef.current) {
        // v2: 4s cycle (was 3s) — more selective
        cycleTimerRef.current = setTimeout(runLoop, 4000);
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
    pendingSimTradesGlobal.clear();
    addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
    addAutoTraderLog(`[AI] === GLOBAL AI v5 STOPPED ===`);
    addAutoTraderLog(`[AI] Cycles: ${cycleCountRef.current} | Trades: ${totalTradesRef.current} | P/L: ${totalProfitRef.current >= 0 ? '+' : ''}$${totalProfitRef.current.toFixed(2)}`);
    addAutoTraderLog(`[AI] Session W/L: ${sessionWinsRef.current}/${sessionLossesRef.current}`);
    addAutoTraderLog(`[AI] ═══════════════════════════════════════`);
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

    // v5: Restore Deriv credentials from persisted store so trades work after reload
    const store = useWorldpadStore.getState();
    console.log('[GlobalAI] INIT — isAuthorized:', store.isAuthorized, 'mode:', store.accountMode, 'hasDemoToken:', !!store.demoToken, 'hasRealToken:', !!store.realToken, 'accountId:', store.selectedAccountId);
    if (store.isAuthorized && store.selectedAccountId) {
      const token = store.accountMode === 'demo' ? store.demoToken : store.realToken;
      if (token && store.derivAppId) {
        restoreCredentials(token, store.derivAppId, store.selectedAccountId);
        const wsCheck = getTradeWSStatus();
        console.log('[GlobalAI] Restored Deriv credentials for', store.accountMode, 'trading. WS status:', wsCheck);
      } else {
        console.warn('[GlobalAI] isAuthorized=true but MISSING token or appId! token=', !!token, 'appId=', !!store.derivAppId);
      }
    } else {
      console.warn('[GlobalAI] NOT authorized. isAuthorized=', store.isAuthorized, 'accountId=', store.selectedAccountId);
    }

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

  return null;
}