"""Capitulation-reversal bot for the make.fun BTC race (paper money, long only).

Protocol: the harness speaks agent-fun/bars-replay/v1. It sends one hello, then one
batch per minute bar, then done. The bot answers every batch with exactly one reply
echoing its seq; the orders in a reply fill at the next bar's open, so every decision
here uses only bars already closed. This file holds the whole strategy; the wire
protocol lives in the vendored SDK shim under vendor/ (a byte-for-byte kit copy).

Rule (fitted on the dev window's structure, no window-specific prices or times):
  ARM:   after a 240-bar warm-up, arm when the trailing 15-bar return is at or below
         -80 bps (an extreme panic leg). Track the lowest close since arming.
  ENTER: buy with all cash when the close reclaims 25 bps above that low watermark
         while the trailing 10-bar return is positive (confirmation, not the fall
         itself). The arm expires after 120 bars without confirmation.
  EXIT:  trailing stop 100 bps below the peak close since entry; once the trade is
         100 bps ahead, the floor locks to entry + 20 bps; hard time stop at 300 bars.
         After an exit, wait 120 bars before arming again. No new entries in the last
         30 bars of the 1440-bar window (a one-bar hold into the final flatten is
         pure cost). All decisions use integer math on bar closes only: no clock, no
         randomness, no environment reads, so two runs decide identically.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = None  # resolved from hello: the universe holds one asset

# --- Rule parameters (bps unless noted) ---
WARMUP_BARS = 240
PANIC_BARS = 15
PANIC_BPS = -80
CONFIRM_BPS = 25
CONFIRM_TREND_BARS = 10
ARM_EXPIRY_BARS = 120
TRAIL_BPS = 100
LOCK_BPS = 100
LOCK_FLOOR_BPS = 20
TIME_STOP_BARS = 300
COOLDOWN_BARS = 120
END_GUARD_BARS = 30
WINDOW_BARS = 1440
MAX_SLIPPAGE_BPS = 10_000  # wide open: never miss a fill on a gap

_closes = []          # closes of bars seen so far, in order
_last_bar_t = None    # close time of the last bar folded in
_armed = False
_low = 0              # lowest close since arming
_arm_k = 0
_holding = False
_entry = 0            # close at the decision bar of the buy
_entry_k = 0
_peak = 0             # highest close since entry
_locked = False
_last_exit_k = -10**9


def _ret_bps(k, n):
    """Trailing n-bar return ending at bar k, in bps (integer math)."""
    if k < n:
        return 0
    return (_closes[k] - _closes[k - n]) * 10_000 // _closes[k - n]


def _above(price, bps):
    return price * (10_000 + bps) // 10_000


def _below(price, bps):
    return price * (10_000 - bps) // 10_000


def on_batch(state, batch):
    global SYMBOL, _last_bar_t, _armed, _low, _arm_k
    global _holding, _entry, _entry_k, _peak, _locked, _last_exit_k

    if SYMBOL is None:
        SYMBOL = state.hello["symbols"][0]["symbol"]

    # Fold in this batch's bar for our symbol, if it carries one. A minute with no
    # bar leaves the symbol absent from the batch: nothing new to decide on.
    bar = None
    for b in batch["bars"]:
        if b["symbol"] == SYMBOL:
            bar = b
            break
    if bar is None or bar["t"] == _last_bar_t:
        return []
    _last_bar_t = bar["t"]
    _closes.append(int(bar["c"]))
    k = len(_closes) - 1
    close = _closes[k]

    held = state.positions.get(SYMBOL)
    if _holding and (held is None or held.qty <= 0):
        # Our buy never filled (rejected): drop the position state, cool down.
        _holding = False
        _last_exit_k = k
        return []
    if _holding:
        _peak = max(_peak, close)
        if close >= _above(_entry, LOCK_BPS):
            _locked = True
        floor = _above(_entry, LOCK_FLOOR_BPS) if _locked else _below(_peak, TRAIL_BPS)
        if close <= floor or k - _entry_k >= TIME_STOP_BARS:
            _holding = False
            _last_exit_k = k
            return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        return []

    # Flat: arm / confirm logic.
    if k < WARMUP_BARS or k > WINDOW_BARS - 1 - END_GUARD_BARS:
        return []
    if k - _last_exit_k < COOLDOWN_BARS:
        return []
    if not _armed:
        if _ret_bps(k, PANIC_BARS) <= PANIC_BPS:
            _armed = True
            _low = close
            _arm_k = k
        return []
    _low = min(_low, close)
    if k - _arm_k > ARM_EXPIRY_BARS:
        _armed = False
        return []
    if close >= _above(_low, CONFIRM_BPS) and _ret_bps(k, CONFIRM_TREND_BARS) > 0:
        notional = min(state.cash, state.weight_room(SYMBOL))
        min_notional = int(state.hello["fees"]["min_notional_quote_units"])
        if notional < min_notional:
            return []
        _armed = False
        _holding = True
        _entry = close
        _entry_k = k
        _peak = close
        _locked = False
        return [{"side": "buy", "symbol": SYMBOL, "notional_quote_units": notional,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]
    return []


makefun_bars.run(on_batch)
