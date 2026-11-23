# Vision

> Status: living document. The north star, principle and values are settled.
> The **Open questions** at the bottom are deliberately unanswered, so we decide
> them on purpose.

## North star

**A passing bot test means the bot works on Discord.** Tests run the bot's real
code, through a stock discord.js `Client`, against a fake Discord that follows
Discord's rules. Today a discord.js bot is tested by calling its handlers with
hand-built objects, so the test proves the handler agrees with the test author's
idea of Discord, not with Discord.

## Purpose

- First consumers: sin-bot and the d2armory bot. Scope follows what they use.
- A craft project, published on npm (ADR 0006).

## Guiding principle: test the bot as it ships

The bot under test changes in one place only: it accepts client options, so the
test can point it at the mock. No mocking discord.js, no patching modules, no
test-only branches in bot code. Everything between the bot's handler and the
network (payload parsing, caching, REST queueing, rate-limit handling, gateway
resume) runs for real.

Every feature is measured against this: does it let a test exercise more of the
shipped code path, or does it ask the bot to bend for the test?

## Values

They pull against each other. When they conflict, name the trade-off.

- **Fidelity.** The mock answers what Discord answers, and refuses what Discord
  refuses: missing permissions, missing intents, unregistered commands, a late
  interaction reply. A mock that's wrong is worse than no test, because it turns
  a broken bot green. We'd rather model fewer routes faithfully than many
  loosely. A route we don't model fails the test (a Gap), it never answers with
  a guess.
- **Speed.** A test boots a mock, logs a bot in and runs a flow in
  milliseconds. Each test gets its own mock on its own port, so suites run in
  parallel with no shared state.
- **Reads like what users do.** A test says "alice runs /join, the leaderboard
  shows alice", not "stub GET /channels/123 to return this JSON". Failure
  injection reads the same way: "this route is rate limited once".

## Scope

- **REST and Gateway**, both, because a bot is driven by gateway events and
  answers over REST. One without the other can't test a flow.
- **Driven by real flows.** A route or event gets built when a consumer's flow
  needs it, with a test from that flow. No speculative API coverage.
- **Failure modes are first-class**: 5xx, dropped connections, route and global
  rate limits, permission errors, gateway disconnects. These are the paths
  nobody tests today and where bots break in production.

## Non-goals

- **A dev server for running bots locally.** It's a test fixture; no UI, no
  persistence.
- **Voice.** Neither consumer uses it, and it's a separate protocol (UDP, RTP).
- **User-account (selfbot) APIs.** docs.discord.food documents them; bots can't
  use them.
- **Exact rate-limit numbers.** Discord doesn't publish per-route limits. The
  mock injects 429s on demand; it doesn't simulate bucket sizes.
- **Mocking discord.js.** If a test needs to reach inside discord.js, the mock
  is missing a feature.

## Open questions

- **Checking the model against real Discord.** A contract test that runs the
  same scenarios against a private test guild and diffs the shapes. Needs a
  bot token as a CI secret, a guild, and a schedule. Without it, fidelity is
  "modelled from the docs", never "checked".
- **Other libraries.** The mock speaks Discord's protocol, not discord.js's
  API, so any library could connect to it. Do we test that, or stay
  discord.js-only?
- **Time.** The 3s interaction deadline and `Retry-After` use the real clock.
  Do we support fake timers, or keep real time with short configurable
  durations? The kit's own waits now count time the process could run
  (ADR 0007); fake timers for the bot stay open.
- **Test-runner helpers.** Vitest matchers (`expect(channel).toHaveMessage(...)`)
  in this package, or none?
