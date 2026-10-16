import { z } from "zod";

const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    IVRM_API_BASE_URL: z.url().default("https://api.ivrm.jp"),
    AI_ALLOWED_ORIGIN: z.url().default("https://ai.ivrm.jp"),
    // `api`: ask api.ivrm.jp (the policy decision point).
    // `static-allow`: allow everyone who has a session. Never in production.
    AI_POLICY_MODE: z.enum(["api", "static-allow"]).default("api"),
    AWS_REGION: z.string().min(1).default("ap-northeast-1"),
    AI_KILL_SWITCH: boolean,
  })
  .refine(
    (env) => !(env.NODE_ENV === "production" && env.AI_POLICY_MODE !== "api"),
    { message: "AI_POLICY_MODE must be api in production" }
  );

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
