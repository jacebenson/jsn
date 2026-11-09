import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('API error rendering', () => {
  it('uses the existing envelope path for JSON, quiet, and argv JSON with an app', async () => {
    const { AppError, CodeAPI, renderAppError } = await import('../src/errors.js');
    const error = new AppError(CodeAPI, 'provider refused', 'inspect before retrying');
    for (const options of [
      { app: { output: { effectiveFormat: () => 'json' } } },
      { app: { output: { effectiveFormat: () => 'quiet' } } },
      { app: {}, argv: { format: 'json' } },
    ]) {
      assert.deepStrictEqual(renderAppError(error, options), {
        stream: 'stdout', text: null, exitCode: 1, appErr: true,
      });
    }
  });

  it('preserves exact human text, exit code, and fallback behavior', async () => {
    const { AppError, CodeAPI, renderAppError } = await import('../src/errors.js');
    const error = new AppError(CodeAPI, 'provider refused', 'inspect before retrying');
    const expected = { stream: 'stderr', text: 'Error: provider refused\n', exitCode: 1 };
    assert.deepStrictEqual(renderAppError(error, { app: { output: { effectiveFormat: () => 'styled' } }, argv: { format: 'json' } }), expected);
    assert.deepStrictEqual(renderAppError(error, { argv: { format: 'json' } }), expected);
    assert.deepStrictEqual(renderAppError(error), expected);
    assert.deepStrictEqual(renderAppError(new Error('provider refused'), { app: { output: { effectiveFormat: () => 'json' } } }), expected);
  });
});

describe('AppError', () => {
  it('creates structured errors with all properties', async () => {
    const { AppError, CodeUsage } = await import('../src/errors.js');
    const e = new AppError(CodeUsage, 'test message', 'test hint', 400);
    assert.strictEqual(e.name, 'AppError');
    assert.strictEqual(e.code, 'usage_error');
    assert.strictEqual(e.message, 'test message');
    assert.strictEqual(e.hint, 'test hint');
    assert.strictEqual(e.status, 400);
    assert.strictEqual(e.cause, null);
  });

  it('formats toString with hint', async () => {
    const { AppError, CodeUsage } = await import('../src/errors.js');
    const e = new AppError(CodeUsage, 'test', 'hint');
    assert.ok(e.toString().includes('hint'));
  });

  it('formats toString without hint', async () => {
    const { AppError, CodeUsage } = await import('../src/errors.js');
    const e = new AppError(CodeUsage, 'test');
    assert.strictEqual(e.toString(), 'usage_error: test');
  });
});

describe('errUsage', () => {
  it('creates usage error', async () => {
    const { errUsage } = await import('../src/errors.js');
    const e = errUsage('invalid option');
    assert.strictEqual(e.code, 'usage_error');
    assert.strictEqual(e.message, 'invalid option');
  });
});

describe('errUsageHint', () => {
  it('creates usage error with hint', async () => {
    const { errUsageHint } = await import('../src/errors.js');
    const e = errUsageHint('invalid', 'try this instead');
    assert.strictEqual(e.code, 'usage_error');
    assert.strictEqual(e.hint, 'try this instead');
  });
});

describe('errNotFound', () => {
  it('creates not found error', async () => {
    const { errNotFound } = await import('../src/errors.js');
    const e = errNotFound('incident', 'INC001');
    assert.strictEqual(e.code, 'not_found');
    assert.ok(e.message.includes('INC001'));
    assert.ok(e.hint);
  });
});

describe('errAuth', () => {
  it('creates auth error with default hint', async () => {
    const { errAuth } = await import('../src/errors.js');
    const e = errAuth('no token');
    assert.strictEqual(e.code, 'auth_error');
    assert.strictEqual(e.hint, 'Run: jsn auth login');
  });
});

describe('errAPI', () => {
  it('creates API error with 5xx hint', async () => {
    const { errAPI } = await import('../src/errors.js');
    const e = errAPI(503, 'Service Unavailable');
    assert.strictEqual(e.code, 'api_error');
    assert.strictEqual(e.status, 503);
    assert.ok(e.hint.includes('issues'));
  });

  it('creates API error with 4xx hint', async () => {
    const { errAPI } = await import('../src/errors.js');
    const e = errAPI(400, 'Bad Request');
    assert.strictEqual(e.hint.includes('API documentation'), true);
  });
});

describe('errNetwork', () => {
  it('creates network error', async () => {
    const { errNetwork } = await import('../src/errors.js');
    const cause = new Error('ECONNREFUSED');
    const e = errNetwork(cause);
    assert.strictEqual(e.code, 'network_error');
    assert.strictEqual(e.cause, cause);
  });
});

describe('errForbidden', () => {
  it('creates forbidden error', async () => {
    const { errForbidden } = await import('../src/errors.js');
    const e = errForbidden('access denied');
    assert.strictEqual(e.status, 403);
  });
});

describe('errRateLimit', () => {
  it('creates rate limit error', async () => {
    const { errRateLimit } = await import('../src/errors.js');
    const e = errRateLimit(30);
    assert.strictEqual(e.code, 'rate_limited');
    assert.ok(e.message.includes('30'));
  });
});

describe('errAmbiguous', () => {
  it('creates ambiguous error', async () => {
    const { errAmbiguous } = await import('../src/errors.js');
    const e = errAmbiguous('flow', ['flow1', 'flow2']);
    assert.strictEqual(e.code, 'ambiguous');
    assert.ok(e.hint.includes('flow1'));
  });
});

describe('asError', () => {
  it('wraps plain Error as AppError', async () => {
    const { asError, AppError } = await import('../src/errors.js');
    const result = asError(new Error('something broke'));
    assert.ok(result instanceof AppError);
    assert.strictEqual(result.code, 'unknown');
  });

  it('passes through AppError', async () => {
    const { asError, AppError, CodeUsage } = await import('../src/errors.js');
    const original = new AppError(CodeUsage, 'test');
    const result = asError(original);
    assert.strictEqual(result, original);
  });

  it('returns null for null input', async () => {
    const { asError } = await import('../src/errors.js');
    assert.strictEqual(asError(null), null);
  });
});

describe('isErrorCode', () => {
  it('checks error code', async () => {
    const { isErrorCode, AppError, CodeAuth } = await import('../src/errors.js');
    const e = new AppError(CodeAuth, 'test');
    assert.strictEqual(isErrorCode(e, 'auth_error'), true);
    assert.strictEqual(isErrorCode(e, 'usage_error'), false);
  });
});
