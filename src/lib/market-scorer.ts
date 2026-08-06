'use client';

import type { MarketData, MarketSymbol } from './multi-market-ws';
import { scoreMarketLogic, LogicScore, TradeSignal } from './logic-engine';
import { aiEngine, AIScore } from './ai-engine';

// === Market Scorer v3 ===
// HARD RULE: Only DIGITDIFF (90% win, +EV) and rarely DIGITMATCH (10% win, 8.5x payout).
// DIGITOVER/UNDER/EVEN/ODD are BLOCKED — they're 50/50 with only 0.85x payout = -EV always.

export interface RankedMarket {
  symbol: MarketSymbol;
  name: string;
  type: 'standard' | 'fast';
  combinedScore: number;
  logicScore: LogicScore;
  aiScore: AIScore;
  selectedSignal: TradeSignal | null;
  expectedValue: number;
  evAdjusted: boolean;
  rank: number;
}

export interface ScoringConfig {
  logicWeight: number;
  aiWeight: number;
  minScore: number;
  maxConcurrentTrades: number;
}

const DEFAULT_CONFIG: ScoringConfig = {
  logicWeight: 0.6,
  aiWeight: 0.4,
  minScore: 20,           // v3: lowered from 30 — DIFF signals are common
  maxConcurrentTrades: 10,
};

// Contracts that are PROFITABLE to trade (real edge, not 50/50 house bets)
const ALLOWED_CONTRACTS = new Set(['DIGITDIFF', 'DIGITMATCH']);

// 50/50 bets with negative EV — ALWAYS blocked regardless of score or confidence
const BLOCKED_CONTRACTS = new Set(['DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD']);

// === Real EV calculation (no fake confidence boost) ===
calculateEV(signal: TradeSignal): number {
  if (signal.contractType === 'DIGITDIFF') {
    // 90% real win rate, 0.85x profit
    return (0.90 * 0.85) - (0.10 * 1.0); // = +0.665
  }
  if (signal.contractType === 'DIGITMATCH') {
    // 10% base, but confidence indicates how much the AI leans toward this digit
    // Need >11.8% win rate to break even (payout 8.5x net, cost 1x)
    // Breakeven: p * 8.5 = (1-p) * 1 → p = 1/9.5 = 10.53%
    // We use confidence as an edge indicator: real_prob ≈ 10% + confidence * 10%
    const adjustedProb = 0.10 + signal.confidence * 0.10; // max 20% at full confidence
    return (adjustedProb * 8.5) - ((1 - adjustedProb) * 1.0);
  }
  return -1; // blocked contracts
}

// === Convert any blocked signal to DIGITDIFF ===
function convertToDiff(signal: TradeSignal, reason: string): TradeSignal {
  return {
    contractType: 'DIGITDIFF',
    barrier: signal.barrier,
    reason: `[CONVERTED→DIFF] ${reason}: ${signal.contractType} d${signal.barrier ?? '-'} is a 50/50 bet (-EV)`,
    confidence: 0.7, // DIFF has inherent 90% edge
  };
}

// === Signal consensus ===
function getConsensusSignal(logicSignal: TradeSignal | null, aiSignal: TradeSignal | null): { signal: TradeSignal | null; consensus: boolean } {
  if (!logicSignal && !aiSignal) return { signal: null, consensus: false };
  if (!logicSignal) return { signal: aiSignal, consensus: false };
  if (!aiSignal) return { signal: logicSignal, consensus: false };

  // Both exist — check if they agree on contract type
  if (logicSignal.contractType === aiSignal.contractType) {
    const boosted = {
      ...logicSignal,
      confidence: Math.min(logicSignal.confidence + 0.15, 1.0),
      reason: `[CONSENSUS] ${logicSignal.contractType} — both engines agree: ${logicSignal.reason} | ${aiSignal.reason}`,
    };
    return { signal: boosted, consensus: true };
  }

  // No consensus — use higher confidence signal
  const best = logicSignal.confidence >= aiSignal.confidence ? logicSignal : aiSignal;
  if (best.confidence < 0.3) return { signal: null, consensus: false };
  return { signal: best, consensus: false };
}

// Feed tick data to the AI engine
export function feedTickToAI(symbol: string, data: MarketData) {
  aiEngine.processTick(symbol, data);
}

// Score all markets and return ranked list
export function scoreAllMarkets(
  markets: MarketData[],
  config: Partial<ScoringConfig> = {}
): RankedMarket[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const ranked: RankedMarket[] = [];

  for (const market of markets) {
    const logicScore = scoreMarketLogic(market);
    const aiScore = aiEngine.analyzeMarket(market);

    const combinedScore = logicScore.score * cfg.logicWeight + aiScore.score * cfg.aiWeight;

    // Get consensus signal
    const { signal: consensusSignal, consensus } = getConsensusSignal(
      logicScore.signal,
      aiScore.signal
    );

    let selectedSignal: TradeSignal | null = null;
    let ev = 0;
    let evAdjusted = false;

    if (consensusSignal) {
      // v3: HARD BLOCK all 50/50 bets — convert to DIGITDIFF
      if (BLOCKED_CONTRACTS.has(consensusSignal.contractType)) {
        selectedSignal = convertToDiff(consensusSignal, '50/50 bet blocked');
        ev = calculateEV(selectedSignal);
        evAdjusted = true;
      }
      // v3: DIGITMATCH needs 0.8+ confidence (need strong edge to overcome 10% base rate)
      else if (consensusSignal.contractType === 'DIGITMATCH' && consensusSignal.confidence < 0.8) {
        selectedSignal = convertToDiff(consensusSignal, `MATCH confidence ${Math.round(consensusSignal.confidence * 100)}% < 80%`);
        ev = calculateEV(selectedSignal);
        evAdjusted = true;
      }
      else {
        ev = calculateEV(consensusSignal);
        // v3: Only trade if EV is positive
        if (ev > 0) {
          selectedSignal = consensusSignal;
        } else {
          selectedSignal = null; // negative EV, skip
          evAdjusted = true;
        }
      }
    }

    const consensusBonus = consensus ? 5 : 0;

    ranked.push({
      symbol: market.symbol,
      name: market.name,
      type: market.type,
      combinedScore: combinedScore + consensusBonus,
      logicScore,
      aiScore,
      selectedSignal,
      expectedValue: ev,
      evAdjusted,
      rank: 0,
    });
  }

  ranked.sort((a, b) => b.combinedScore - a.combinedScore);
  ranked.forEach((m, i) => m.rank = i + 1);

  return ranked;
}

// Get the top markets that should be traded
export function selectTrades(
  ranked: RankedMarket[],
  config: Partial<ScoringConfig> = {},
  activeTradeSymbols: Set<string> = new Set(),
  cooldownSymbols: Set<string> = new Set()
): RankedMarket[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return ranked
    .filter(m => {
      if (m.combinedScore < cfg.minScore) return false;
      if (!m.selectedSignal) return false;
      if (activeTradeSymbols.has(m.symbol)) return false;
      if (cooldownSymbols.has(m.symbol)) return false;
      if (m.expectedValue <= 0) return false;
      return true;
    })
    .slice(0, cfg.maxConcurrentTrades);
}
