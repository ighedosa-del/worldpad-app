'use client';

import type { MarketData, MarketSymbol } from './multi-market-ws';
import { scoreMarketLogic, LogicScore, TradeSignal } from './logic-engine';
import { aiEngine, AIScore } from './ai-engine';

// === Market Scorer v2 ===
// Combines Logic (60%) + AI (40%) scores, ranks all markets,
// and selects the top ones for trading.
// v2: EV filtering, DIGITMATCH penalty, signal consensus, higher minScore

export interface RankedMarket {
  symbol: MarketSymbol;
  name: string;
  type: 'standard' | 'fast';
  combinedScore: number;
  logicScore: LogicScore;
  aiScore: AIScore;
  selectedSignal: TradeSignal | null;
  expectedValue: number;      // v2: EV calculation
  evAdjusted: boolean;        // v2: was the signal adjusted for EV?
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
  minScore: 30,           // v2: raised from 10 to 30 — only real edges
  maxConcurrentTrades: 10,
};

// === Payout tables (Deriv digit contracts) ===
// These are approximate net profit multipliers on a $1 stake
const PAYOUT_PROFIT_MULTIPLIER: Record<string, { profit: number; winProb: number }> = {
  'DIGITMATCH':  { profit: 8.5,  winProb: 0.10 },  // 1-in-10, pays ~9.5x gross = 8.5x net profit
  'DIGITDIFF':   { profit: 0.85, winProb: 0.90 },  // 9-in-10
  'DIGITOVER':   { profit: 0.85, winProb: 0.50 },  // ~50/50
  'DIGITUNDER':  { profit: 0.85, winProb: 0.50 },
  'DIGITEVEN':   { profit: 0.85, winProb: 0.50 },
  'DIGITODD':    { profit: 0.85, winProb: 0.50 },
};

// === v2: Calculate Expected Value for a signal ===
// EV = (adjusted_win_prob × profit) - (loss_prob × 1)
// If EV <= 0, the trade should NOT be taken
calculateEV(signal: TradeSignal, logicScore: LogicScore, aiScore: AIScore): number {
  const payout = PAYOUT_PROFIT_MULTIPLIER[signal.contractType];
  if (!payout) return 0;

  // Base win probability from the contract type
  let baseWinProb = payout.winProb;

  // Boost win probability based on signal confidence
  // confidence ranges 0-1, we use it to shift the base probability
  const confidenceBoost = signal.confidence * 0.15; // max 15% boost at full confidence
  const adjustedWinProb = Math.min(baseWinProb + confidenceBoost, 0.98);

  // EV = (win% × profit_multiplier) - (lose% × 1.0)
  // For a $1 stake, profit_multiplier is what you NET on a win
  const ev = (adjustedWinProb * payout.profit) - ((1 - adjustedWinProb) * 1.0);
  return ev;
}

// === v2: Signal consensus — do Logic and AI agree on the contract type? ===
function getConsensusSignal(logicSignal: TradeSignal | null, aiSignal: TradeSignal | null): { signal: TradeSignal | null; consensus: boolean } {
  if (!logicSignal && !aiSignal) return { signal: null, consensus: false };
  if (!logicSignal) return { signal: aiSignal, consensus: false };
  if (!aiSignal) return { signal: logicSignal, consensus: false };

  // Both exist — check if they agree on contract type
  if (logicSignal.contractType === aiSignal.contractType) {
    // CONSENSUS! Boost confidence
    const boosted = {
      ...logicSignal,
      confidence: Math.min(logicSignal.confidence + 0.15, 1.0),
      reason: `[CONSENSUS] ${logicSignal.contractType} — both engines agree: ${logicSignal.reason} | ${aiSignal.reason}`,
    };
    return { signal: boosted, consensus: true };
  }

  // No consensus — only use the higher-confidence signal if it's strong enough
  // But NEVER use DIGITMATCH without consensus or very high confidence
  const best = logicSignal.confidence >= aiSignal.confidence ? logicSignal : aiSignal;

  // DIGITMATCH without consensus needs 0.8+ confidence, otherwise convert to DIGITDIFF
  if (best.contractType === 'DIGITMATCH' && best.confidence < 0.8) {
    return {
      signal: {
        contractType: 'DIGITDIFF',
        barrier: best.barrier,
        reason: `[CONVERTED MATCH→DIFF] Low confidence (${Math.round(best.confidence * 100)}%): ${best.reason}`,
        confidence: Math.min(best.confidence + 0.1, 0.7),
      },
      consensus: false,
    };
  }

  // For non-MATCH signals without consensus, require at least 0.5 confidence
  if (best.confidence < 0.5) return { signal: null, consensus: false };

  return { signal: best, consensus: false };
}

// Feed tick data to the AI engine (called on every tick)
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

    // v2: Use consensus system instead of raw confidence pick
    const { signal: consensusSignal, consensus } = getConsensusSignal(
      logicScore.signal,
      aiScore.signal
    );

    // v2: Calculate EV for the selected signal
    let selectedSignal: TradeSignal | null = null;
    let ev = 0;
    let evAdjusted = false;

    if (consensusSignal) {
      ev = calculateEV(consensusSignal, logicScore, aiScore);

      // v2: DIGITMATCH hard gate — even with consensus, need 0.75+ confidence
      if (consensusSignal.contractType === 'DIGITMATCH' && consensusSignal.confidence < 0.75) {
        // Convert to DIGITDIFF
        selectedSignal = {
          contractType: 'DIGITDIFF',
          barrier: consensusSignal.barrier,
          reason: `[EV FILTER] MATCH→DIFF: confidence ${Math.round(consensusSignal.confidence * 100)}% < 75% | EV was ${ev.toFixed(3)}`,
          confidence: consensusSignal.confidence,
        };
        ev = calculateEV(selectedSignal, logicScore, aiScore);
        evAdjusted = true;
      }
      // v2: Reject negative EV trades (unless it's DIGITDIFF which is almost always positive)
      else if (ev <= 0 && consensusSignal.contractType !== 'DIGITDIFF') {
        // Signal exists but EV is negative — skip this market
        selectedSignal = null;
        evAdjusted = true;
      } else {
        selectedSignal = consensusSignal;
      }
    }

    // v2: Bonus score for consensus
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

  // Sort by combined score descending
  ranked.sort((a, b) => b.combinedScore - a.combinedScore);

  // Assign ranks
  ranked.forEach((m, i) => m.rank = i + 1);

  return ranked;
}

// Get the top markets that should be traded
export function selectTrades(
  ranked: RankedMarket[],
  config: Partial<ScoringConfig> = {},
  activeTradeSymbols: Set<string> = new Set(),
  cooldownSymbols: Set<string> = new Set()  // v2: per-market loss cooldown
): RankedMarket[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return ranked
    .filter(m => {
      // Must meet minimum score (v2: 30)
      if (m.combinedScore < cfg.minScore) return false;
      // Must have a signal
      if (!m.selectedSignal) return false;
      // Must not already have an active trade on this market
      if (activeTradeSymbols.has(m.symbol)) return false;
      // v2: Must not be in loss cooldown
      if (cooldownSymbols.has(m.symbol)) return false;
      // v2: Must have positive expected value (safety net)
      if (m.expectedValue <= 0) return false;
      return true;
    })
    .slice(0, cfg.maxConcurrentTrades);
}
