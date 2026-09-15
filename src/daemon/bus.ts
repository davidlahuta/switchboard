import { EventEmitter } from 'node:events';
import { logger } from '../log.ts';
import type { UiFrame } from '../shared/types.ts';

const log = logger('toast');

/**
 * UI change feed. Producers call `invalidate('state')` / `invalidate('repo:<id>')`; bursts are
 * coalesced so a flurry of hook calls results in one refetch per scope.
 */
export class Bus extends EventEmitter<{ ui: [UiFrame] }> {
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  invalidate(...scopes: string[]): void {
    for (const s of scopes) this.pending.add(s);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 120);
  }

  toast(level: 'info' | 'warn' | 'error', text: string): void {
    // A toast is the daemon explaining itself to whoever had the page open, and only to them: it is
    // gone in seconds, and never reaches anyone who looks later. The log keeps every one.
    log[level](text);
    this.emit('ui', { type: 'toast', level, text });
  }

  private flush(): void {
    this.timer = null;
    if (!this.pending.size) return;
    const scopes = [...this.pending];
    this.pending.clear();
    this.emit('ui', { type: 'invalidate', scopes });
  }
}
