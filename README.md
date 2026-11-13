# BTC race bot — capitulation reversal

Paper-money bot for make.fun's "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261113-2314`). Long only, one asset (cbBTC/USDC), one open
position at most. TypeScript (Node 22 type stripping), standard library only; the wire protocol is the
kit's SDK shim vendored byte-for-byte under `vendor/`.

## Rule

- **Warm-up:** no trading in the first 240 bars.
- **Arm:** when the trailing 15-bar return falls to −80 bps or worse (panic leg).
  Track the lowest close since arming; the arm expires after 120 bars.
- **Enter:** buy with all cash when the close reclaims 25 bps above that low
  watermark while the trailing 10-bar return is positive.
- **Exit:** trailing stop 100 bps below the peak close since entry; once 100 bps
  ahead, the floor locks to entry + 20 bps; hard time stop at 300 bars.
- **Discipline:** 120-bar cooldown after every exit; no new entries in the last
  30 bars of the 1440-bar window. All decisions are integer math on closed bars
  only: no clock, no randomness, no environment reads.

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

## License

MIT — see `LICENSE`.
