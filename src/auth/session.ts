import { z } from "zod";

export const SESSION_COOKIE = "ivrm_admin_session";

const meSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    discordUserId: z.string().min(1),
    username: z.string(),
    avatar: z.string().nullable().optional(),
  }),
  roles: z.array(z.string()).default([]),
  isAdmin: z.boolean().default(false),
});

export type Session = {
  userId: string;
  discordUserId: string;
  username: string;
  roles: string[];
  isAdmin: boolean;
  /** Forwarded to the policy decision point on behalf of the user. */
  cookie: string;
};

/** The verifier could not decide (network, 5xx, bad response). Callers fail closed. */
export class AuthUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthUnavailableError";
  }
}

export interface SessionVerifier {
  /** Returns null for a missing, invalid or non-member session. */
  verify(cookieHeader: string | undefined): Promise<Session | null>;
}

/** Extract only the session cookie so no other cookie is ever forwarded. */
export function extractSessionCookie(
  cookieHeader: string | undefined
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = rest.join("=");
      return value ? `${SESSION_COOKIE}=${value}` : null;
    }
  }
  return null;
}

export type FetchLike = typeof fetch;

/** Verifies the shared session by asking `api.ivrm.jp/auth/me`. */
export class ApiSessionVerifier implements SessionVerifier {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 3000
  ) {}

  async verify(cookieHeader: string | undefined): Promise<Session | null> {
    const cookie = extractSessionCookie(cookieHeader);
    if (!cookie) return null;

    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/auth/me", this.apiBaseUrl), {
        headers: { cookie, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AuthUnavailableError("session check failed", {
        cause: error,
      });
    }

    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) {
      throw new AuthUnavailableError(`session check status ${response.status}`);
    }

    const parsed = meSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new AuthUnavailableError("session check returned a bad body");
    }
    const { user, roles, isAdmin } = parsed.data;
    return {
      userId: user.id,
      discordUserId: user.discordUserId,
      username: user.username,
      roles,
      isAdmin,
      cookie,
    };
  }
}
