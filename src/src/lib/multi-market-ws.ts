'use client';

// === Multi-Market Scanner ===
// Uses ticks_history polling because Deriv public WS rejects tick subscriptions.
// ticks_history (one-time query) works fine without authentication.
// Standard markets tick every ~2-4s, fast (1s) markets every ~1s.

export const SCANNED_MARKETS = [
  { symbol: 'R_100', name: 'Volatility 100',   type: 'standard' as const },
  { symbol: 'R_10',  name: 'Volatility 10',    type: 'standard' as const },
  { symbol: 'R_25',  name: 'Volatility 25',    type: 'standard' as const },
  { symbol: 'R_50',  name: 'Volatility 50',    type: 'standard' as const },
  { symbol: 'R_75',  name: 'Volatility 75',    type: 'standard' as const },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s)', type: 'fast' as const },
  { symbol: '1HZ10V',  name: 'Volatility 10 (1s)',  type: 'fast' as const },
  { symbol: '1HZ25V',  name: 'Volatility 25 (1s)',  type: 'fast' as const },
  { symbol: '1HZ50V',  name: 'Volatility 50 (1s)',  type: 'fast' as const },
  { symbol: '1HZ75V',  name: 'Volatility 75 (1s)',  type: 'fast' as const },
] as const;

export type MarketSymbol = (typeof SCANNED_MARKETS)[number]['symbol'];

export interface MarketTickData {
  digit: number;
  price: string;
  timestamp: number;
}

export interface MarketData {
  symbol: MarketSymbol;
  name: string;
  type: 'standard' | 'fast';
  digits: number[];
  distribution: number[];
  distributionPct: number[];
  lastTick: MarketTickData | null;
  tickCount: number;
  connected: boolean;
}

export type MarketDataMap = Record<MarketSymbol, MarketData>;
export type OnMarketTickCallback = (symbol: MarketSymbol, data: MarketData) => void;

const MAX_DIGITS = 500;
const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

let ws: WebSocket | null = null;
let marketData: MarketDataMap;
let tickCallbacks: Set<OnMarketTickCallback> = new Set();
let isConnected = false;
let pollTimerFast: ReturnType<typeof setInterval> | null = null;
let pollTimerStandard: ReturnType<typeof setInterval> | null = null;
let totalTicksReceived = 0;
let lastTickTime = 0;
let connectTime = 0;
let wsError: string | null = null;
let scanningActive = false;
let reqIdCounter = 1;
let pendingRequests = new Map<number, {
  symbol: MarketSymbol;
  resolve: (data: any) => void;
}>();

function initMarketData(): MarketDataMap {
  const data = {} as MarketDataMap;
  for (const m of SCANNED_MARKETS) {
    data[m.symbol] = {
      symbol: m.symbol,
      name: m.name,
      type: m.type,
      digits: [],
      distribution: new Array(10).fill(0),
      distributionPct: new Array(10).fill(0),
      lastTick: null,
      tickCount: 0,
      connected: false,
    };
  }
  return data;
}

marketData = initMarketData();

function updateDistribution(md: MarketData) {
  const dist = new Array(10).fill(0);
  for (let i = 0; i < md.digits.length; i++) {
    dist[md.digits[i]]++;
  }
  md.distribution = dist;
  const total = md.digits.length || 1;
  for (let i = 0; i < 10; i++) {
    md.distributionPct[i] = (dist[i] / total) * 100;
  }
}

function requestTicksHistory(symbol: string): Promise<{ prices: number[]; times: number[] } | null> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve(null);
      return;
    }
    const reqId = reqIdCounter++;
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      resolve(null);
    }, 5000);
    pendingRequests.set(reqId, {
      symbol: symbol as MarketSymbol,
      resolve: (data) => { clearTimeout(timer); resolve(data); },
    });
    ws.send(JSON.stringify({
      ticks_history: symbol,
      count: 1,
      end: 'latest',
      style: 'ticks',
      req_id: reqId,
    }));
  });
}

function processTick(symbol: MarketSymbol, price: number) {
  const md = marketData[symbol];
  if (!md) return;

  const priceStr = price.toFixed(3);
  const lastDigit = parseInt(priceStr[priceStr.length - 1], 10);

  // Deduplicate: skip if same as last tick
  if (md.lastTick && md.lastTick.price === priceStr) return;

  md.digits.push(lastDigit);
  if (md.digits.length > MAX_DIGITS) md.digits.shift();
  md.lastTick = { digit: lastDigit, price: priceStr, timestamp: Date.now() };
  md.tickCount++;
  totalTicksReceived++;
  lastTickTime = Date.now();
  md.connected = true;
  updateDistribution(md);

  // Notify callbacks
  const snapshot = { ...md };
  for (const cb of tickCallbacks) {
    try { cb(symbol, snapshot); } catch (e) { /* skip */ }
  }
}

function handleMessage(event: MessageEvent) {
  try {
    const msg = JSON.parse(event.data);

    // Handle ticks_history response
    if (msg.msg_type === 'history' && msg.history && msg.history.prices) {
      const reqId = msg.req_id;
      if (reqId !== undefined && pendingRequests.has(reqId)) {
        const pending = pendingRequests.get(reqId)!;
        pendingRequests.delete(reqId);
        const prices = msg.history.prices;
        if (prices.length > 0) {
          processTick(pending.symbol, prices[prices.length - 1]);
        }
        pending.resolve(msg.history);
      }
      return;
    }

    // Handle errors
    if (msg.error) {
      const reqId = msg.req_id;
      if (reqId !== undefined && pendingRequests.has(reqId)) {
        const pending = pendingRequests.get(reqId)!;
        pendingRequests.delete(reqId);
        console.warn('[MultiMarketWS] Error for', pending.symbol, ':', msg.error.message);
        wsError = msg.error.message;
        pending.resolve(null);
      }
    }
  } catch {
    // ignore
  }
}

async function pollMarkets(type: 'standard' | 'fast') {
  const markets = SCANNED_MARKETS.filter(m => m.type === type);
  // Fire all requests in parallel, then await all
  const promises = markets.map(m => requestTicksHistory(m.symbol));
  await Promise.all(promises);
}

function startPolling() {
  stopPolling();
  pollTimerFast = setInterval(() => pollMarkets('fast'), 1500);
  pollTimerStandard = setInterval(() => pollMarkets('standard'), 2500);
  // Immediate first poll
  pollMarkets('fast');
  pollMarkets('standard');
}

function stopPolling() {
  if (pollTimerFast) { clearInterval(pollTimerFast); pollTimerFast = null; }
  if (pollTimerStandard) { clearInterval(pollTimerStandard); pollTimerStandard = null; }
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectInternal();
  }, 3000);
}

function connectInternal() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  wsError = null;
  connectTime = Date.now();

  try {
    ws = new WebSocket(DERIV_WS_URL);
  } catch (e) {
    wsError = 'WS create failed: ' + (e as Error).message;
    console.error('[MultiMarketWS]', wsError);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    console.log('[MultiMarketWS] Connected - polling', SCANNED_MARKETS.length, 'markets');
    startPolling();
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    console.log('[MultiMarketWS] Closed');
    isConnected = false;
    stopPolling();
    for (const m of SCANNED_MARKETS) marketData[m.symbol].connected = false;
    if (scanningActive) scheduleReconnect();
  };

  ws.onerror = () => {
    wsError = 'WS error';
    console.warn('[MultiMarketWS] Connection error');
  };
}

// === PUBLIC API ===

export function startMultiMarketScan(onTick?: OnMarketTickCallback): void {
  if (onTick) tickCallbacks.add(onTick);
  scanningActive = true;
  connectInternal();
}

export function stopMultiMarketScan(): void {
  scanningActive = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopPolling();
  for (const [, p] of pendingRequests) p.resolve(null);
  pendingRequests.clear();
  if (ws) { ws.close(); ws = null; }
  isConnected = false;
  for (const m of SCANNED_MARKETS) marketData[m.symbol].connected = false;
}

export function getMarketData(symbol: MarketSymbol): MarketData {
  return marketData[symbol];
}

export function getAllMarketData(): MarketDataMap {
  return marketData;
}

export function isScannerConnected(): boolean {
  return isConnected;
}

export function getScannerHealth() {
  const ticksPerMarket: Record<string, number> = {};
  for (const m of SCANNED_MARKETS) {
    ticksPerMarket[m.symbol] = marketData[m.symbol].tickCount;
  }
  return {
    isConnected,
    totalTicksReceived,
    lastTickTime,
    connectTime,
    ticksPerMarket,
    wsError,
    callbackCount: tickCallbacks.size,
  };
}

export function addTickCallback(cb: OnMarketTickCallback): () => void {
  tickCallbacks.add(cb);
  return () => { tickCallbacks.delete(cb); };
}

export function resetMarketData(): void {
  marketData = initMarketData();
  totalTicksReceived = 0;
  lastTickTime = 0;
}
