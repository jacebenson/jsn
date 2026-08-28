// Structured error types with code, message, and optional hint.

export const CodeUsage = 'usage_error';
export const CodeNotFound = 'not_found';
export const CodeAuth = 'auth_error';
export const CodeForbidden = 'forbidden';
export const CodeRateLimit = 'rate_limited';
export const CodeNetwork = 'network_error';
export const CodeAPI = 'api_error';
export const CodeAmbiguous = 'ambiguous';
export const CodeEmptyResult = 'empty_result';
export const CodeConfirmationRequired = 'confirmation_required';

export class AppError extends Error {
  constructor(code, message, hint = '', status = 0, cause = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.cause = cause;
  }

  toString() {
    if (this.hint) {
      return `${this.code}: ${this.message}\nHint: ${this.hint}`;
    }
    return `${this.code}: ${this.message}`;
  }
}

export function errUsage(msg) {
  return new AppError(CodeUsage, msg);
}

export function errUsageHint(msg, hint) {
  return new AppError(CodeUsage, msg, hint);
}

export function errNotFound(resource, identifier) {
  return new AppError(
    CodeNotFound,
    `${resource} not found: ${identifier}`,
    `Check the ${resource} exists and you have access to it.`
  );
}

export function errNotFoundHint(resource, identifier, hint) {
  return new AppError(CodeNotFound, `${resource} not found: ${identifier}`, hint);
}

export function errAuth(msg) {
  return new AppError(CodeAuth, msg, 'Run: jsn auth login');
}

export function errForbidden(msg) {
  return new AppError(CodeForbidden, msg, '', 403);
}

export function errRateLimit(retryAfter) {
  return new AppError(
    CodeRateLimit,
    `Rate limited. Retry after ${retryAfter} seconds.`,
    'Wait before retrying, or use pagination for large queries.'
  );
}

export function errNetwork(cause) {
  return new AppError(
    CodeNetwork,
    `Network error: ${cause.message || cause}`,
    'Check your internet connection and instance URL.',
    0,
    cause
  );
}

export function errAPI(status, msg) {
  let hint = 'Check the API documentation for this endpoint.';
  if (status >= 500) {
    hint = 'The ServiceNow instance may be experiencing issues. Try again later.';
  }

  // Try to extract structured error detail from JSON API error bodies
  let displayMsg = msg;
  if (typeof msg === 'string' && (msg.startsWith('{') || msg.startsWith('['))) {
    try {
      const parsed = JSON.parse(msg);
      const errObj = parsed.error || parsed;
      const detail = errObj.detail || errObj.message || '';
      const message = errObj.message || '';

      if (detail && message) {
        displayMsg = `${message}: ${detail}`;
      } else if (detail) {
        displayMsg = detail;
      } else if (message) {
        displayMsg = message;
      }

      // Detect business rule abortion and add a hint
      if (detail && detail.includes('Business Rule')) {
        hint = 'A Business Rule rejected this operation. Check for overlapping routes, validation rules, or ACLs on this table.';
      }
    } catch {
      // Not valid JSON, use original message
    }
  }

  return new AppError(CodeAPI, `API error (status ${status}): ${displayMsg}`, hint, status);
}

export function errAmbiguous(resource, matches) {
  return new AppError(
    CodeAmbiguous,
    `Multiple ${resource} found matching your query`,
    `Did you mean one of: ${matches.join(', ')}?`
  );
}

/**
 * Structured error for a destructive action that requires confirmation
 * but no human is available to answer (non-TTY, pipes, or AI agents).
 * The hint is written to be machine-parseable: an agent can read the
 * re-run command and either present it to its user or execute it.
 */
export function errConfirmationRequired(question, rerunCmd) {
  return new AppError(
    CodeConfirmationRequired,
    `${question} — confirmation required. Pass --force to skip, or set skip_confirmations on the profile to disable prompts.`,
    `This is a destructive action. Ask your user to confirm, then re-run:\n  ${rerunCmd} --force\nOr set skip_confirmations on the profile to disable prompts:\n  jsn auth login <instance> --skip-confirmations`
  );
}

export function asError(err) {
  if (!err) return null;
  if (err instanceof AppError) return err;
  return new AppError('unknown', err.message || String(err));
}

export function isErrorCode(err, code) {
  return err instanceof AppError && err.code === code;
}

/**
 * ── Unified error renderer ─────────────────────────────────────────────
 * ONE place owns AppError → (stream, text, exit code). wrap()'s catch
 * block, the middleware guard (guardError/guardExit), and any future
 * entry point all route through renderAppError so the rendering can't
 * diverge again (it had: wrap checked app.output.effectiveFormat() while
 * guardError checked argv.format; 'usage' vs 'usage_error' disagreed).
 *
 * Exit-code contract (observable behavior, pinned by tests):
 *   not_found              → 1   stderr, "Error (not_found): …" + identifier hint
 *   usage / usage_error    → 2   stderr, "Error (usage): …"
 *   system_error           → 3   stderr, "Error (system): …"
 *   confirmation_required  → 1   JSON envelope on stdout in JSON mode
 *                                (machine consumers), else stderr + hint
 *   anything else          → 1   stderr, "Error: …"
 *
 * jsonMode resolution: prefer app.output.effectiveFormat() (respects
 * --json/--quiet/etc. shortcuts AND piped-stdout auto-detection); fall
 * back to argv.format for callers without an App (unit tests).
 */
function resolveJsonMode(app, argv) {
  if (app?.output) return app.output.effectiveFormat() === 'json';
  return argv?.format === 'json';
}

/**
 * Render an error for the terminal/pipe.
 *
 * @param {object} err — Error with optional .code and .hint
 * @param {object} [opts]
 * @param {object} [opts.app] — App instance (format resolution, JSON envelope)
 * @param {object} [opts.argv] — yargs argv (fallback format resolution)
 * @param {string} [opts.identifier] — for not_found: the id that missed
 * @returns {{ stream: 'stdout'|'stderr', text: string|null, exitCode: number, appErr?: boolean }}
 *   text is null when the error was rendered through app.err (envelope).
 */
export function renderAppError(err, { app = null, argv = null, identifier = '' } = {}) {
  const code = err.code || 'unknown';

  if (code === CodeConfirmationRequired) {
    // Structured error for AI agents / piped consumers: the JSON envelope
    // goes to stdout (where tooling reads) so the agent can surface the
    // decision to its user or re-run with --force.
    if (resolveJsonMode(app, argv) && app) {
      return { stream: 'stdout', text: null, exitCode: 1, appErr: true };
    }
    let text = `Error: ${err.message}\n`;
    if (err.hint) text += `\n${err.hint}\n`;
    return { stream: 'stderr', text, exitCode: 1 };
  }

  if (code === CodeNotFound) {
    let text = `Error (${code}): ${err.message}\n`;
    if (identifier) {
      text += `\nHint: The identifier "${identifier}" was not found. Check the name or sys_id.\n`;
    }
    return { stream: 'stderr', text, exitCode: 1 };
  }

  // 'usage' is the legacy literal; CodeUsage ('usage_error') is the
  // exported constant. Both render as the usage class.
  if (code === CodeUsage || code === 'usage') {
    return { stream: 'stderr', text: `Error (usage): ${err.message}\n`, exitCode: 2 };
  }

  if (code === 'system_error') {
    return { stream: 'stderr', text: `Error (system): ${err.message}\n`, exitCode: 3 };
  }

  return { stream: 'stderr', text: `Error: ${err.message}\n`, exitCode: 1 };
}

/**
 * Write + exit for a rendered error. Shared by wrap() and guardExit().
 */
export function exitWithError(err, opts = {}) {
  const { app = null } = opts;
  const r = renderAppError(err, opts);
  if (r.appErr && app) {
    app.err(err);
  } else if (r.stream === 'stdout') {
    process.stdout.write(r.text);
  } else {
    process.stderr.write(r.text);
  }
  process.exit(r.exitCode);
}

/**
 * Format a safety-guard failure (mutation guard middleware in cli.js).
 * In JSON mode writes the documented error envelope to stdout so piped
 * consumers (`jsn ... --json | jq`) get a structured error instead of a
 * raw stderr message. Otherwise writes human text to stderr.
 * Always exits non-zero via guardExit.
 *
 * Routes through the same JSON-mode resolution as renderAppError
 * (app.output.effectiveFormat() when an App is on argv, else argv.format).
 */
export function guardError(argv, { code, message, hint = '' }) {
  if (resolveJsonMode(argv?.app, argv)) {
    return {
      stream: 'stdout',
      text: JSON.stringify({ ok: false, error: message, code, hint }) + '\n',
    };
  }
  let text = `Error: ${message}\n`;
  if (hint) text += `\n${hint}\n`;
  return { stream: 'stderr', text };
}

export function guardExit(argv, opts) {
  const { stream, text } = guardError(argv, opts);
  if (stream === 'stdout') process.stdout.write(text);
  else process.stderr.write(text);
  process.exit(opts.code === CodeUsage || opts.code === 'usage' ? 2 : 1);
}
