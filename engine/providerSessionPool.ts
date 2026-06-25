export interface SessionPoolItem {
  hasActiveThread: boolean;
  providerId?: string;
  createdAt?: number;
  lastUsedAt?: number;
  invalidated?: boolean;
}

export function newPoolItem(providerId?: string): SessionPoolItem {
  const now = Date.now();
  return {
    hasActiveThread: false,
    providerId,
    createdAt: now,
    lastUsedAt: now
  };
}

export class ProviderSessionPool {
  private readonly items = new Map<string, SessionPoolItem>();
  private closing = false;

  public acquire(providerId: string): SessionPoolItem {
    const existing = this.items.get(providerId);
    if (existing && !existing.invalidated) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const item = newPoolItem(providerId);
    this.items.set(providerId, item);
    return item;
  }

  public get(providerId: string): SessionPoolItem | undefined {
    return this.items.get(providerId);
  }

  public entries(): Array<[string, SessionPoolItem]> {
    return Array.from(this.items.entries());
  }

  public async invalidate(providerId: string, reason: string): Promise<void> {
    const item = this.items.get(providerId);
    if (!item) return;
    item.invalidated = true;
    this.items.delete(providerId);
  }

  public async closeAll(reason = 'pool shutdown'): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.items.clear();
    this.closing = false;
  }
}
