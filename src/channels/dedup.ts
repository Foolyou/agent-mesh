// src/channels/dedup.ts
//
// Bounded FIFO dedup set for inbound Feishu event_ids (the lark-cli schema documents event_id as
// globally unique and safe for dedup). Redeliveries — e.g. after a consumer reconnect — must not
// be fed to the router twice. Capacity-bounded so a long-lived backend can't grow it unboundedly;
// the oldest ids are evicted first.

export class BoundedDedup {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly capacity: number;

  constructor(capacity = 1000) {
    this.capacity = Math.max(1, capacity);
  }

  /** Record `id`. Returns true if it was ALREADY present (a duplicate to drop), false if new. */
  check(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}
