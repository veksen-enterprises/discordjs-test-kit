---
status: accepted
---

# The kit's waits count runnable time

Decided with JP 2026-11-23. Answers the "Time" open question in `VISION.md` for the kit's own waits.

**The problem.** The kit waits on the bot in four places: the quiet spell before a click or pick, the 3-second interaction deadline, how long a run waits on a bot that keeps working, and how long it waits for a reply to show. All four used the wall clock. The bot and the kit share one process. When the OS starves that process (a loaded CI runner, a laptop running several suites), every timer comes due at once when it wakes, and the kit's run before the bot reads the response that arrived meanwhile. The kit then decides the bot went quiet, or missed its deadline, during time the bot never got to run. A bot that works on Discord failed its test.

**The decision.** The kit's own heuristics count runnable time (`src/internal/runnable-clock.ts`): the quiet spell before a click or pick, the quiet spell that ends a run waiting on a deferred reply, and how long a find waits. Discord's own deadline, the interaction's 3 seconds, stays on the wall clock, as does the limit on a bot that keeps working (it bounds the test). A starved bot is late on Discord too, so a runnable deadline would pass a bot slower than Discord allows: of the two errors, a red test for a working bot is the one the vision accepts. A ticker samples every 5ms. A tick that arrives on time counts its wall time. A late one counts only the process's own CPU time during the gap, so a bot that blocks the event loop with synchronous work still spends its deadline, as it would on Discord, while time the OS took away doesn't count.

**Considered.** Fake timers: they would change the bot's own `setTimeout`s, which the guiding principle rules out. Longer defaults: they slow every test and only move the threshold.

## Consequences

- Measured on the six timing-sensitive test files, 78 contended runs per tree: failures in the kit's own waits went from 3 to 0. A small sample; the direction, not a rate.
- On an unloaded machine nothing changes: on-time ticks count their wall time.
- A bot whose work genuinely takes long still fails: the deadline is wall time.
- Revised the same day: the first version also put the interaction deadline on runnable time. Under heavy load (load average 250 on 12 cores) the kit then accepted replies later than the deadline, a false pass, which tests asserting 10062 caught.
- The clock reads `performance.now` and `setTimeout` as they were when the module loaded, so a test that fakes timers doesn't stop it.
- Waits in the facade that use the test's own timers (`waitForMessage` and the other 2-second finds) are unchanged.
