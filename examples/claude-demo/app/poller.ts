/**
 * Reads on a timer, one at a time. `schedule` sets the next read, replacing any that is set; a read asked for while one is
 * under way is not started: the one under way sets the next when it settles, at `nextDelay`. A read that rejects goes to
 * `onError`, and polling goes on.
 */
export interface Poller {
  /** Sets the next read to start in `delayMs`, in place of one already set. */
  schedule(delayMs: number): void;
  /** Whether a read is under way. */
  readonly inFlight: boolean;
}

export interface PollerOptions {
  readonly read: () => Promise<void>;
  /** The delay before the read that follows one that settled. */
  readonly nextDelay: () => number;
  readonly onError: (error: unknown) => void;
}

export function createPoller(options: PollerOptions): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;

  function schedule(delayMs: number): void {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), delayMs);
  }

  async function run(): Promise<void> {
    // The read under way sets the next one when it settles: a second one now would overlap it.
    if (reading) return;
    reading = true;
    try {
      await options.read();
    } catch (error) {
      options.onError(error);
    } finally {
      reading = false;
      schedule(options.nextDelay());
    }
  }

  return {
    schedule,
    get inFlight() {
      return reading;
    },
  };
}
