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

export function asError(err) {
  if (!err) return null;
  if (err instanceof AppError) return err;
  return new AppError('unknown', err.message || String(err));
}

export function isErrorCode(err, code) {
  return err instanceof AppError && err.code === code;
}
