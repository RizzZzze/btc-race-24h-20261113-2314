// Capitulation-reversal bot for the make.fun BTC race (paper money, long only).
//
// Protocol: the harness speaks agent-fun/bars-replay/v1. It sends one hello, then
// one batch per minute bar, then done. The bot answers every batch with exactly one
// reply echoing its seq; the orders in a reply fill at the next bar's open, so every
// decision here uses only bars already closed. This file holds the whole strategy;
// the wire protocol lives in the vendored SDK shim under vendor/ (a byte-for-byte
// kit copy).
//
// Rule (fitted on the dev window's structure, no window-specific prices or times):
//   ARM:   after a 240-bar warm-up, arm when the trailing 15-bar return is at or
//          below -80 bps (an extreme panic leg). Track the lowest close since arming.
//   ENTER: buy with all cash when the close reclaims 25 bps above that low watermark
//          while the trailing 10-bar return is positive (confirmation, not the fall
//          itself). The arm expires after 120 bars without confirmation.
//   EXIT:  trailing stop 100 bps below the peak close since entry; once the trade is
//          100 bps ahead, the floor locks to entry + 20 bps; hard time stop at 300
//          bars. After an exit, wait 120 bars before arming again. No new entries in
//          the last 30 bars of the 1440-bar window (a one-bar hold into the final
//          flatten is pure cost). All decisions use integer math on bar closes only:
//          no clock, no randomness, no environment reads, so two runs decide
//          identically.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// --- Rule parameters (bps unless noted) ---
const WARMUP_BARS = 240;
const PANIC_BARS = 15;
const PANIC_BPS = -80n;
const CONFIRM_BPS = 25n;
const CONFIRM_TREND_BARS = 10;
const ARM_EXPIRY_BARS = 120;
const TRAIL_BPS = 100n;
const LOCK_BPS = 100n;
const LOCK_FLOOR_BPS = 20n;
const TIME_STOP_BARS = 300;
const COOLDOWN_BARS = 120;
const END_GUARD_BARS = 30;
const WINDOW_BARS = 1440;
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never miss a fill on a gap

const BPS_UNIT = 10_000n;

let symbol = '';
const closes: bigint[] = []; // closes of bars seen so far, in order
let lastBarT: number | null = null;
let armed = false;
let low = 0n; // lowest close since arming
let armK = 0;
let holding = false;
let entry = 0n; // close at the decision bar of the buy
let entryK = 0;
let peak = 0n; // highest close since entry
let locked = false;
let lastExitK = -1_000_000_000;

/** Floored division (BigInt `/` truncates toward zero; the sweep this mirrors floors). */
function floorDiv(a: bigint, b: bigint): bigint {
  return a >= 0n ? a / b : -((-a + b - 1n) / b);
}

/** Trailing n-bar return ending at bar k, in bps. */
function retBps(k: number, n: number): bigint {
  if (k < n) return 0n;
  return floorDiv((closes[k]! - closes[k - n]!) * BPS_UNIT, closes[k - n]!);
}

function above(price: bigint, bps: bigint): bigint {
  return (price * (BPS_UNIT + bps)) / BPS_UNIT;
}

function below(price: bigint, bps: bigint): bigint {
  return (price * (BPS_UNIT - bps)) / BPS_UNIT;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // Fold in this batch's bar for our symbol, if it carries one. A minute with no
  // bar leaves the symbol absent from the batch: nothing new to decide on.
  const bar = batch.bars.find((b) => b.symbol === symbol);
  if (bar === undefined || bar.t === lastBarT) return [];
  lastBarT = bar.t;
  closes.push(BigInt(bar.c));
  const k = closes.length - 1;
  const close = closes[k]!;

  const held = state.positions.get(symbol);
  if (holding && (held === undefined || held.qty <= 0n)) {
    // Our buy never filled (rejected): drop the position state, cool down.
    holding = false;
    lastExitK = k;
    return [];
  }
  if (holding && held !== undefined) {
    peak = peak > close ? peak : close;
    if (close >= above(entry, LOCK_BPS)) locked = true;
    const floor = locked ? above(entry, LOCK_FLOOR_BPS) : below(peak, TRAIL_BPS);
    if (close <= floor || k - entryK >= TIME_STOP_BARS) {
      holding = false;
      lastExitK = k;
      return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: arm / confirm logic.
  if (k < WARMUP_BARS || k > WINDOW_BARS - 1 - END_GUARD_BARS) return [];
  if (k - lastExitK < COOLDOWN_BARS) return [];
  if (!armed) {
    if (retBps(k, PANIC_BARS) <= PANIC_BPS) {
      armed = true;
      low = close;
      armK = k;
    }
    return [];
  }
  low = low < close ? low : close;
  if (k - armK > ARM_EXPIRY_BARS) {
    armed = false;
    return [];
  }
  if (close >= above(low, CONFIRM_BPS) && retBps(k, CONFIRM_TREND_BARS) > 0n) {
    const room = state.weightRoom(symbol);
    const notional = state.cash < room ? state.cash : room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    armed = false;
    holding = true;
    entry = close;
    entryK = k;
    peak = close;
    locked = false;
    return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0]!.symbol;
  },
  onBatch,
});
