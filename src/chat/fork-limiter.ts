/** Storage-copy guard for the current single-process deployment. Not an AI budget ledger. */
export class ForkLimiter {
  private readonly owners = new Map<
    string,
    {
      day: number;
      minute: number;
      daily: number;
      recent: number;
      busy: boolean;
    }
  >();
  constructor(private readonly now: () => number = Date.now) {}

  /** Returns a release callback, or retry seconds, without evicting an active owner's quota. */
  acquire(owner: string): (() => void) | number {
    const at = this.now();
    for (const [id, entry] of this.owners)
      if (!entry.busy && at - entry.day >= 86_400_000) this.owners.delete(id);
    let entry = this.owners.get(owner);
    if (!entry) {
      if (this.owners.size >= 1024) return 60;
      entry = { day: at, minute: at, daily: 0, recent: 0, busy: false };
      this.owners.set(owner, entry);
    }
    if (at - entry.minute >= 60_000) {
      entry.minute = at;
      entry.recent = 0;
    }
    if (entry.busy) return 1;
    if (entry.daily >= 50)
      return Math.max(1, Math.ceil((entry.day + 86_400_000 - at) / 1000));
    if (entry.recent >= 6)
      return Math.max(1, Math.ceil((entry.minute + 60_000 - at) / 1000));
    entry.busy = true;
    entry.recent++;
    entry.daily++;
    return () => {
      entry.busy = false;
    };
  }
}
