// Test setup helper: creates mock App instances for testing commands
// Patterns: https://go.dev/src/internal/commands/testutil_test.go

import { App } from '../../src/app.js';
import { OutputWriter, FormatJSON } from '../../src/output.js';
import { Writable } from 'node:stream';

/**
 * A writable stream that captures all writes into a string buffer.
 */
class CaptureStream extends Writable {
  constructor() {
    super();
    this.buffer = '';
  }
  _write(chunk, encoding, callback) {
    this.buffer += chunk.toString();
    callback();
  }
  toString() { return this.buffer; }
}

/**
 * Create a minimal config for testing.
 */
export function testConfig(overrides = {}) {
  return {
    instance_url: overrides.instance_url || 'https://test-instance.service-now.com',
    format: overrides.format || 'json',
    profiles: overrides.profiles || {
      'test-instance': {
        instance_url: 'https://test-instance.service-now.com',
        username: 'test.user',
      },
    },
    default_profile: overrides.default_profile || '',
    ...overrides,
  };
}

/**
 * Create a mock auth provider that returns test credentials.
 */
export function mockAuthProvider(overrides = {}) {
  return {
    getCredentials: async () => ({
      auth_method: 'oauth',
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: 9999999999,
      ...overrides,
    }),
    getCredentialsFor: async () => ({
      auth_method: 'oauth',
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: 9999999999,
      ...overrides,
    }),
    isAuthenticated: () => true,
    isAuthenticatedFor: () => true,
  };
}

/**
 * Setup a test app with a writable output stream for capturing.
 * Returns { app, output, config, auth }.
 *
 * Usage:
 *   const { app, output, config } = setupTestApp();
 *   app.ok({ hello: 'world' });
 *   assert(output.toString().includes('world'));
 */
export function setupTestApp(options = {}) {
  const cfg = testConfig(options.config || {});
  const outputStream = new CaptureStream();

  // Create App normally, but override output stream
  const app = new App(cfg);
  app.output = new OutputWriter({
    format: options.format || FormatJSON,
    writer: outputStream,
  });

  // Skip context header fetching (would make real API calls)
  app.printContextHeader = async () => {};

  // Mock auth if requested
  if (options.mockAuth) {
    app.auth = {
      ...app.auth,
      ...mockAuthProvider(options.authOverrides),
    };
  }

  return {
    app,
    output: outputStream,
    config: cfg,
  };
}
