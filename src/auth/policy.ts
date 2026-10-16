import { z } from "zod";
import type { FetchLike, Session } from "./session.js";

export const AI_RESOURCE_ALL = "ivrm:ai:*";

export type AuthorizationQuery = {
  /** e.g. `ai:Use`, `ai:UseModel`, `ai:UseTool`. */
  action: string;
  /** e.g. `ivrm:ai:*` or `ivrm:ai:model/<id>`. */
  resource: string;
};

export type Decision =
  | { allowed: true }
  | { allowed: false; reason: "denied" | "decision_unavailable" };

/** Policy decision point client. ivrm-ai keeps no policy of its own. */
export interface PolicyDecisionClient {
  authorize(session: Session, query: AuthorizationQuery): Promise<Decision>;
}

const decisionSchema = z.object({ allowed: z.boolean() });

/**
 * Asks `api.ivrm.jp` (POST /auth/authorize), the policy decision point.
 *
 * That endpoint does not exist yet (docs/design.md section 6; to be added in
 * ivrm-web). Until it does, every call ends in `decision_unavailable`, which is
 * a denial: nobody is let in on a guess.
 */
export class ApiPolicyDecisionClient implements PolicyDecisionClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 3000
  ) {}

  async authorize(
    session: Session,
    query: AuthorizationQuery
  ): Promise<Decision> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL("/auth/authorize", this.apiBaseUrl),
        {
          method: "POST",
          headers: {
            cookie: session.cookie,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(query),
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      );
    } catch {
      return { allowed: false, reason: "decision_unavailable" };
    }

    if (response.status === 401 || response.status === 403) {
      return { allowed: false, reason: "denied" };
    }
    if (!response.ok) {
      return { allowed: false, reason: "decision_unavailable" };
    }
    const parsed = decisionSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!parsed.success) {
      return { allowed: false, reason: "decision_unavailable" };
    }
    return parsed.data.allowed
      ? { allowed: true }
      : { allowed: false, reason: "denied" };
  }
}

/** Always allows. For tests and local development only; never in production. */
export class StaticAllowPolicyDecisionClient implements PolicyDecisionClient {
  async authorize(): Promise<Decision> {
    return { allowed: true };
  }
}
