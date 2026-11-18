/** Pure LRU index for the thumbnail disk cache (the file work lives in thumb-cache.ts). */
export type LruRecord = { name: string; size: number; used: number };

export class LruIndex {
  private records = new Map<string, LruRecord>();
  private clock = 0;

  load(rows: Record<string, LruRecord>) {
    this.records = new Map(Object.entries(rows));
    for (const r of this.records.values()) this.clock = Math.max(this.clock, r.used);
  }

  toJSON(): Record<string, LruRecord> {
    return Object.fromEntries(this.records);
  }

  has(key: string) {
    return this.records.has(key);
  }

  get(key: string): LruRecord | undefined {
    return this.records.get(key);
  }

  touch(key: string) {
    const r = this.records.get(key);
    if (r) r.used = ++this.clock;
  }

  put(key: string, name: string, size: number) {
    this.records.set(key, { name, size, used: ++this.clock });
  }

  remove(key: string) {
    this.records.delete(key);
  }

  get totalBytes(): number {
    let sum = 0;
    for (const r of this.records.values()) sum += r.size;
    return sum;
  }

  get count(): number {
    return this.records.size;
  }

  keys(): string[] {
    return [...this.records.keys()];
  }

  /** Removes least-recently-used records until total <= capBytes; returns the evicted. */
  evictTo(capBytes: number): LruRecord[] {
    const evicted: LruRecord[] = [];
    if (this.totalBytes <= capBytes) return evicted;
    const order = [...this.records.entries()].sort((a, b) => a[1].used - b[1].used);
    let total = this.totalBytes;
    for (const [key, record] of order) {
      if (total <= capBytes) break;
      this.records.delete(key);
      total -= record.size;
      evicted.push(record);
    }
    return evicted;
  }
}
