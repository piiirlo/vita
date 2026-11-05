/** Runs at most `limit` tasks at once. Waiting tasks that are visible on screen go first;
 * otherwise first come, first served. */

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export type QueuedTask<T> = {
  promise: Promise<T>;
  /** Move the task ahead of invisible ones (no effect once it has started). */
  setVisible(visible: boolean): void;
  /** Drop the task if it hasn't started (its promise rejects with CancelledError). */
  cancel(): void;
};

type Job = {
  run(): Promise<unknown>;
  visible: boolean;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

export class RequestQueue {
  private running = 0;
  private waiting: Job[] = [];
  private pumpScheduled = false;

  constructor(readonly limit: number) {}

  get active(): number {
    return this.running;
  }

  get pending(): number {
    return this.waiting.length;
  }

  schedule<T>(run: () => Promise<T>, visible = false): QueuedTask<T> {
    let job!: Job;
    const promise = new Promise<T>((resolve, reject) => {
      job = { run, visible, resolve: resolve as (value: unknown) => void, reject };
    });
    this.waiting.push(job);
    this.schedulePump();
    return {
      promise,
      setVisible: (v) => {
        if (job.visible !== v) {
          job.visible = v;
          this.schedulePump();
        }
      },
      cancel: () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          job.reject(new CancelledError());
        }
      },
    };
  }

  /** Start tasks on the next tick, so tasks scheduled together are ordered by visibility
   * before any of them starts. */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.pump();
    }, 0);
  }

  private pump(): void {
    while (this.running < this.limit && this.waiting.length > 0) {
      const index = Math.max(0, this.waiting.findIndex((j) => j.visible));
      const [job] = this.waiting.splice(index, 1);
      this.running += 1;
      job!
        .run()
        .then(job!.resolve, job!.reject)
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }
}
