import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { createLogger } from "./logger.ts";

const logger = createLogger("secrets");

const ssm = new SSMClient({});

const PARAM_NAMES = {
  RESEND_API_KEY: process.env.SSM_RESEND_API_KEY_PARAM,
  PROXY_SECRET: process.env.SSM_PROXY_SECRET_PARAM,
};

let loadPromise: Promise<void> | null = null;

/**
 * Fetch secrets from SSM once per Lambda container and set them on process.env.
 * Memoized — subsequent calls return the same in-flight promise.
 */
export function loadSecrets(): Promise<void> {
  if (loadPromise) return loadPromise;

  const wanted: Array<[envKey: string, paramName: string]> = [];
  if (PARAM_NAMES.RESEND_API_KEY && !process.env.RESEND_API_KEY) {
    wanted.push(["RESEND_API_KEY", PARAM_NAMES.RESEND_API_KEY]);
  }
  if (PARAM_NAMES.PROXY_SECRET && !process.env.PROXY_SECRET) {
    wanted.push(["PROXY_SECRET", PARAM_NAMES.PROXY_SECRET]);
  }

  if (wanted.length === 0) {
    loadPromise = Promise.resolve();
    return loadPromise;
  }

  loadPromise = (async () => {
    const resp = await ssm.send(
      new GetParametersCommand({
        Names: wanted.map(([, n]) => n),
        WithDecryption: true,
      }),
    );
    const byName = new Map((resp.Parameters ?? []).map((p) => [p.Name, p.Value]));
    for (const [envKey, paramName] of wanted) {
      const val = byName.get(paramName);
      if (val) {
        process.env[envKey] = val;
      } else {
        logger.warn({ paramName, envKey }, "SSM parameter not found");
      }
    }
    logger.info({ count: wanted.length }, "Secrets loaded from SSM");
  })().catch((err) => {
    loadPromise = null;
    logger.error({ err: (err as Error).message }, "Failed to load secrets from SSM");
    throw err;
  });

  return loadPromise;
}
