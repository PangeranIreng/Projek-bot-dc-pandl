/**
 * utils/logger.js — Structured console logger.
 *
 * Provides .info / .warn / .error / .debug methods used throughout the
 * bot. Each line is prefixed with an ISO timestamp and level label so
 * log entries remain readable across workflow restarts.
 */

const levels = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

// Default to "info"; set LOG_LEVEL=debug to see verbose output.
const MIN_LEVEL = levels[process.env.LOG_LEVEL?.toLowerCase()] ?? levels.info;

function log(level, ...args) {
  if ((levels[level] ?? 0) < MIN_LEVEL) return;
  const ts     = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]`;

  // Pull any trailing Error object out so it's printed with its stack.
  const last = args[args.length - 1];
  const isErr = last instanceof Error;
  const parts = isErr ? args.slice(0, -1) : args;

  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (parts.length > 0) out(prefix, ...parts);
  if (isErr)            out(prefix, last.stack ?? last.message);
}

export const logger = {
  debug: (...args) => log("debug", ...args),
  info:  (...args) => log("info",  ...args),
  warn:  (...args) => log("warn",  ...args),
  error: (...args) => log("error", ...args),
};
