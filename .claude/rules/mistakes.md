# Lessons from past mistakes

Add new lessons at the top, one bullet each: the rule, then the incident in a
few words.

- **Never pipe the test run into `grep` inside a gate.** The pipe takes grep's exit code, so
  failures pass: 5b9b875 was pushed with 4 failing tests locally. Redirect to a log and test `$?`
  (2026-11-23).
- **Push only after the whole gate, lint included.** c4553f3 went to `main` gated on the
  tests alone and failed CI's lint until 3cbec0a (2026-11-23).
- **Gate the commit on the checks with `&&`.** Running typecheck, lint and tests
  as separate commands then committing lets a failure through. b2b2440 landed on
  `main` with a type error in a test (2026-11-18).
- **Read the reference before citing it.** If a source can't be fetched, say so
  and stop; don't model from memory under its name. The spike cited
  docs.discord.food in the README without one page of it being read (2026-11-17).
- **Default the World to the least privilege Discord would give.** The first
  draft made the bot the guild owner, so every permission check passed and the
  403 tests couldn't fail (spike, 2026-11-17).
