const DEFAULT_INSTANCE = 'https://dev.example.service-now.com';

/** Build the small App surface used by command-handler tests. */
export function makeApp({ sdk = {}, format = 'json', config, instance = DEFAULT_INSTANCE, ...overrides } = {}) {
  const outputCalls = [];
  const app = {
    sdk: mockSdk(sdk),
    config: config ?? { profiles: {}, activeProfile: null },
    output: { getFormat: () => format },
    getEffectiveInstance: () => instance,
    ok: (data, opts = {}) => {
      app.lastOk = { data, opts };
      outputCalls.push(app.lastOk);
    },
    requireInstance() {},
    outputCalls,
    ...overrides,
  };
  return app;
}

/** Supply harmless defaults while allowing each test to override SDK calls. */
export function mockSdk(overrides = {}) {
  return {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    ...overrides,
  };
}
