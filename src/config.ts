import { z } from "zod";

const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  IVRM_API_BASE_URL: z.url().default("https://api.ivrm.jp"),
  AWS_REGION: z.string().min(1).default("ap-northeast-1"),
  AI_KILL_SWITCH: boolean,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
