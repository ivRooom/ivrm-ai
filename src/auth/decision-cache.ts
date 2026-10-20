import type {
  AuthorizationQuery,
  Decision,
  PolicyDecisionClient,
} from "./policy.js";
import type { Session } from "./session.js";

/**
 * How long a decision is reused. A revoked grant takes effect within this time:
 * api.ivrm.jp keeps its own 30 second cache for stored grants, so the worst case
 * is bounded and short (docs/design.md section 6).
 */
export const DECISION_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1000;

type Entry = { expiresAt: number; decision: Decision };

/**
 * Remembers recent decisions of the policy decision point, so one request does
 * not become several round trips to api.ivrm.jp (`ai:Use` on every request,
 * `ai:UseModel` for each model of the list).
 *
 * - Keyed by the verified user id, the action and the resource: a decision is
 *   never shared across users.
 * - Only decisions that were actually made are kept (allowed, or explicitly
 *   denied). `decision_unavailable` and thrown errors are never kept, so the
 *   next request asks again.
 * - Identical requests in flight share one call.
 */
export class CachedPolicyDecisionClient implements PolicyDecisionClient {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Decision>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: PolicyDecisionClient,
    options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
  ) {
    this.ttlMs = options.ttlMs ?? DECISION_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  authorize(session: Session, query: AuthorizationQuery): Promise<Decision> {
    const key = JSON.stringify([session.userId, query.action, query.resource]);

    const cached = this.entries.get(key);
    if (cached) {
      if (cached.expiresAt > this.now())
        return Promise.resolve(cached.decision);
      this.entries.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.inner
      .authorize(session, query)
      .then((decision) => {
        if (isDecided(decision)) this.store(key, decision);
        return decision;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  private store(key: string, decision: Decision) {
    const timestamp = this.now();
    if (this.entries.size >= this.maxEntries) {
      // Drop what has expired; if that is not enough, drop the oldest.
      for (const [entryKey, entry] of this.entries) {
        if (entry.expiresAt <= timestamp) this.entries.delete(entryKey);
      }
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { expiresAt: timestamp + this.ttlMs, decision });
  }
}

/** A decision that was actually made (not a failure to decide). */
function isDecided(decision: Decision): boolean {
  return decision.allowed || decision.reason === "denied";
}
