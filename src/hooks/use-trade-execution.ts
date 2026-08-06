'use client';

import { useCallback } from 'react';
import { useWorldpadStore } from '@/lib/store';
import { isSimulating, getProposalWS, buyContractWS } from '@/lib/deriv-ws';
import { addTickCallback, getMarketData, type MarketSymbol, type MarketTickData } from '@/lib/multi-market-ws';

export interface TradeParams {
  contractType: string;  // DIGITOVER, DIGITUNDER, DIGITMATCH, DIGITDIFF, DIGITEVEN, DIGITODD
  barrier?: number;      // 0-9 for digit barrier
  stake: number;
  symbol?: string;      // Optional: specific market symbol (for AI multi-market)
  duration?: number;
  durationUnit?: string;
}

export interface TradeResult {
  id: string;
  type: string;
  symbol: string;
  stake: number;
  payout: number;
  profit: number;
  digit: number;
  won: boolean;
  timestamp: number;
  simulated: boolean;
}

export interface PendingSimTrade {
  params: TradeParams;
  tradeSymbol: string;
  resolve: (result: TradeResult | null) => void;
  symbol: MarketSymbol;
}

// Global queue of pending simulation trades waiting for the next tick
const pendingSimTrades: Map<string, PendingSimTrade> = new Map();

// Register a global tick listener that resolves pending sim trades
let globalTickListenerRegistered = false;

function registerGlobalTickListener() {
  if (globalTickListenerRegistered) return;
  globalTickListenerRegistered = true;

  addTickCallback((symbol, data) => {
    const pending = pendingSimTrades.get(symbol);
    if (!pending || !data.lastTick) return;

    // The NEW tick just arrived — THIS is the digit we trade against
    const nextDigit = data.lastTick.digit;
    pendingSimTrades.delete(symbol);

    const { params, tradeSymbol } = pending;
    let won = false;
    switch (params.contractType) {
      case 'DIGITMATCH': won = nextDigit === params.barrier; break;
      case 'DIGITDIFF': won = nextDigit !== params.barrier; break;
      case 'DIGITOVER': won = nextDigit > (params.barrier ?? 4); break;
      case 'DIGITUNDER': won = nextDigit < (params.barrier ?? 5); break;
      case 'DIGITEVEN': won = nextDigit % 2 === 0; break;
      case 'DIGITODD': won = nextDigit % 2 === 1; break;
      default: won = Math.random() > 0.5;
    }

    const isMatch = params.contractType === 'DIGITMATCH';
    const isDiffer = params.contractType === 'DIGITDIFF';
    const payout = won
      ? params.stake * (isMatch ? 8.5 : isDiffer ? 0.85 : 0.85)
      : 0;
    const profit = payout - params.stake;

    const result: TradeResult = {
      id: `SIM-${Date.now()}`,
      type: params.contractType,
      symbol: tradeSymbol,
      stake: params.stake,
      payout,
      profit,
      digit: params.barrier ?? -1,
      won,
      timestamp: Date.now(),
      simulated: true,
    };

    // Get store reference to log
    const { useWorldpadStore: getStore } = await import('@/lib/store');
    const store = getStore.getState();
    store.addTradeResult(result);
    store.addAutoTraderLog(`[SIM] ${won ? 'WIN' : 'LOSS'}: ${params.contractType} on ${tradeSymbol} barrier ${params.barrier ?? '-'} | next digit was ${nextDigit} | ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);

    pending.resolve(result);
  });
}

export function useTradeExecution() {
  const {
    isAuthorized, activeMarket, addTradeResult,
    setIsPlacingTrade, isPlacingTrade, addAutoTraderLog, currentDigit,
  } = useWorldpadStore();

  // Register the global tick listener once
  if (typeof window !== 'undefined') {
    registerGlobalTickListener();
  }

  const placeTrade = useCallback(async (params: TradeParams): Promise<TradeResult | null> => {
    const tradeSymbol = params.symbol || activeMarket;
    const simMode = isSimulating() || !isAuthorized;

    try {
      if (simMode) {
        // === SIMULATION MODE — wait for NEXT tick ===
        const marketSymbol = (params.symbol || activeMarket) as MarketSymbol;

        // If there's already a pending sim trade for this market, skip
        if (pendingSimTrades.has(marketSymbol)) {
          return null;
        }

        // Wait for the next tick to arrive (max 15s timeout)
        const result = await new Promise<TradeResult | null>((resolve) => {
          const timeout = setTimeout(() => {
            pendingSimTrades.delete(marketSymbol);
            resolve(null);
          }, 15000);

          pendingSimTrades.set(marketSymbol, {
            params,
            tradeSymbol,
            resolve: (r) => { clearTimeout(timeout); resolve(r); },
            symbol: marketSymbol,
          });
        });

        return result;
      }

      // === LIVE MODE via WebSocket ===
      addAutoTraderLog(`Placing ${params.contractType} trade on ${tradeSymbol}...`);

      // Step 1: Get proposal via WebSocket
      const proposal = await getProposalWS({
        contractType: params.contractType,
        symbol: tradeSymbol,
        stake: params.stake,
        barrier: params.barrier,
        duration: params.duration || 1,
        durationUnit: params.durationUnit || 't',
      });

      addAutoTraderLog(`Proposal received — payout: $${proposal.payout.toFixed(2)}`);

      // Step 2: Buy the contract via WebSocket
      const buyResult = await buyContractWS(proposal.id, proposal.ask_price);

      const won = buyResult.profit > 0;
      const result: TradeResult = {
        id: buyResult.contract_id,
        type: params.contractType,
        symbol: tradeSymbol,
        stake: params.stake,
        payout: buyResult.payout,
        profit: buyResult.profit,
        digit: params.barrier ?? -1,
        won,
        timestamp: Date.now(),
        simulated: false,
      };

      addTradeResult(result);
      addAutoTraderLog(`${won ? 'WIN' : 'LOSS'}: ${params.contractType} — ${won ? '+$' : '-$'}${Math.abs(result.profit).toFixed(2)}`);
      return result;
    } catch (err) {
      addAutoTraderLog(`ERROR on ${tradeSymbol}: ${(err as Error).message}`);
      return null;
    }
  }, [isAuthorized, activeMarket, currentDigit, addTradeResult, addAutoTraderLog]);

  const quickTrade = useCallback(async (type: 'match' | 'differ' | 'over' | 'under' | 'even' | 'odd', digit: number, stake: number) => {
    const contractMap = {
      match: 'DIGITMATCH',
      differ: 'DIGITDIFF',
      over: 'DIGITOVER',
      under: 'DIGITUNDER',
      even: 'DIGITEVEN',
      odd: 'DIGITODD',
    };
    return placeTrade({
      contractType: contractMap[type],
      barrier: digit,
      stake,
      duration: 1,
      durationUnit: 't',
    });
  }, [placeTrade]);

  return { placeTrade, quickTrade, isPlacingTrade };
}
