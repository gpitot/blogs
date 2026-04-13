import pino from "pino";

const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    // Use string level labels (e.g. "info") instead of numeric codes in JSON output
    level: (label) => ({ level: label }),
  },
});

/**
 * Returns a child logger bound to a module name.
 * Each module should call this once at module scope:
 *
 *   const logger = createLogger('my-module')
 */
export function createLogger(name: string): pino.Logger {
  return root.child({ module: name });
}
