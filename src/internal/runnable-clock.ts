/**
 * Time the process could run, for the kit's own waits: the quiet spell before a click, the
 * interaction deadline, how long a run waits on a busy bot.
 *
 * The bot and the kit share one process. When the OS starves it (a loaded CI runner, a laptop
 * running ten suites), every wall-clock timer comes due at once when it wakes, and the kit's
 * timers run before the bot reads the response that arrived meanwhile: the kit decides the bot
 * went quiet, or missed its deadline, during time the bot never got to run. A wait that counts
 * runnable time doesn't see those stalls.
 *
 * A ticker samples every TICK_MS. A tick that arrives on time counts its wall time. A late one
 * counts only what the process did with the gap: its own CPU time, so a bot that blocks the event
 * loop with synchronous work still spends its deadline, as it would on Discord.
 */

// Taken at load, so a test that fakes timers or `performance` doesn't stop the kit's clock.
const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now.bind(performance);

const TICK_MS = 5;
/** How late a tick can be and still count in full: timer jitter, not a stall. */
const LATE_MS = 15;

interface Pending {
  due: number;
  fn: () => void;
}

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

class RunnableClock {
  private elapsed = 0;
  private lastWall = realNow();
  private lastCpu = cpuMs();
  private timer: ReturnType<typeof realSetTimeout> | undefined;
  private readonly pending = new Set<Pending>();
  /** Holders (open mocks) that need `now()` to advance between timers. */
  private holders = 0;

  /** Runnable milliseconds since the clock started. */
  now(): number {
    this.sample();
    return this.elapsed;
  }

  setTimeout(fn: () => void, ms: number): Pending {
    const entry = { due: this.now() + ms, fn };
    this.pending.add(entry);
    this.ensureTicking();
    return entry;
  }

  clearTimeout(entry: Pending | undefined) {
    if (entry) this.pending.delete(entry);
  }

  /** Keeps `now()` advancing while `release` hasn't been called. */
  hold(): () => void {
    this.holders++;
    this.ensureTicking();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders--;
    };
  }

  private sample() {
    const wall = realNow();
    const cpu = cpuMs();
    const gap = wall - this.lastWall;
    this.elapsed +=
      gap <= TICK_MS + LATE_MS
        ? gap
        : Math.min(gap, TICK_MS + (cpu - this.lastCpu));
    this.lastWall = wall;
    this.lastCpu = cpu;
  }

  private ensureTicking() {
    if (this.timer) return;
    this.sample();
    this.timer = realSetTimeout(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private tick() {
    this.timer = undefined;
    const now = this.now();
    for (const entry of [...this.pending])
      if (entry.due <= now) {
        this.pending.delete(entry);
        entry.fn();
      }
    if (this.pending.size || this.holders) {
      this.timer = realSetTimeout(() => this.tick(), TICK_MS);
      // A pending wait keeps the process alive, as the real timer it replaces did.
      if (!this.pending.size) this.timer.unref?.();
    }
  }
}

// One clock per process: Vitest may evaluate this module again for each test file.
const KEY = Symbol.for("discordjs-test-kit.runnable-clock");
const store = globalThis as typeof globalThis & { [KEY]?: RunnableClock };
export const runnable: RunnableClock = (store[KEY] ??= new RunnableClock());
