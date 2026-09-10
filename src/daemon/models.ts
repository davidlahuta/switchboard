import { VERSION } from '../config.ts';
import { logger } from '../log.ts';
import type { Model } from '../shared/types.ts';

const log = logger('models');
const API = process.env.SWITCHBOARD_OAUTH_API ?? 'https://api.anthropic.com';
const TTL_MS = 6 * 3600_000;
const MIN_CONTEXT = 1_000_000;

interface ApiModel {
  id?: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

/**
 * Models offered when starting a session. The list comes from the API rather than a hardcoded
 * table, so new models appear on their own; only models that actually have a 1M-token context
 * are offered, since that is the point of running them here.
 */
export class ModelCatalog {
  private readonly token: () => Promise<string | null>;
  private cache: Model[] = [];
  private fetchedAt = 0;
  private inFlight: Promise<Model[]> | null = null;

  constructor(token: () => Promise<string | null>) {
    this.token = token;
  }

  /** Cached list; refreshes in the background when stale. Never throws. */
  list(): Model[] {
    if (Date.now() - this.fetchedAt > TTL_MS) void this.refresh();
    return this.cache;
  }

  async refresh(): Promise<Model[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<Model[]> {
    const token = await this.token();
    if (!token) return this.cache;
    try {
      const res = await fetch(`${API}/v1/models?limit=100`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'User-Agent': `switchboard/${VERSION}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn(`model list returned HTTP ${res.status}`);
        return this.cache;
      }
      const body = (await res.json()) as { data?: ApiModel[] };
      const models = (body.data ?? [])
        .filter((m): m is ApiModel & { id: string } => typeof m.id === 'string' && (m.max_input_tokens ?? 0) >= MIN_CONTEXT)
        .map((m) => ({
          id: m.id,
          displayName: m.display_name ?? m.id,
          maxInputTokens: m.max_input_tokens ?? MIN_CONTEXT,
          maxOutputTokens: m.max_tokens ?? null,
        }));
      if (models.length) {
        this.cache = models;
        this.fetchedAt = Date.now();
        log.debug(`${models.length} models with >=1M context`);
      }
      return this.cache;
    } catch (err) {
      log.warn('model list fetch failed', err instanceof Error ? err.message : err);
      return this.cache;
    }
  }

  /** Reject a model id that is not in the catalog, so typos fail before a session starts. */
  validate(id: string): void {
    if (!this.cache.length) return; // catalog unavailable: let claude decide
    if (!this.cache.some((m) => m.id === id)) {
      throw Object.assign(new Error(`Unknown model "${id}". Available: ${this.cache.map((m) => m.id).join(', ')}`), { status: 400 });
    }
  }
}
