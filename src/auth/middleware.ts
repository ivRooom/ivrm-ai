import { createMiddleware } from "hono/factory";
import { AI_RESOURCE_ALL, type PolicyDecisionClient } from "./policy.js";
import { AuthUnavailableError, type SessionVerifier } from "./session.js";
import type { Session } from "./session.js";

export type AuthEnv = { Variables: { session: Session } };

export type AuthDeps = {
  verifier: SessionVerifier;
  policy: PolicyDecisionClient;
  /** The only Origin allowed to make state-changing requests. */
  allowedOrigin: string;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requires a verified member session that the policy allows to use ivrm-ai.
 * 401 no/invalid session, 403 not allowed, 503 when a decision cannot be made.
 */
export function requireAiAccess(deps: AuthDeps) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    // The session cookie is shared across *.ivrm.jp, which is same-site, so
    // SameSite=Lax alone does not stop another subdomain from forging a
    // request. Require the exact Origin on anything that changes state.
    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header("origin") !== deps.allowedOrigin) {
        return c.json({ error: "forbidden" }, 403);
      }
    }

    let session;
    try {
      session = await deps.verifier.verify(c.req.header("cookie"));
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        return c.json({ error: "auth_unavailable" }, 503);
      }
      throw error;
    }
    if (!session) return c.json({ error: "unauthorized" }, 401);

    const decision = await deps.policy.authorize(session, {
      action: "ai:Use",
      resource: AI_RESOURCE_ALL,
    });
    if (!decision.allowed) {
      return c.json(
        { error: "forbidden" },
        decision.reason === "decision_unavailable" ? 503 : 403
      );
    }

    c.set("session", session);
    await next();
  });
}
