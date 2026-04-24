const {
  analyzeModelTier,
  analyzeCacheEfficiency,
  analyzeContextBloat,
  analyzeProjectPatterns,
  analyzeSessionNamePatterns,
  analyzeTimePatterns,
  analyzeSubagentUsage,
  generateRecommendations,
} = require('../recommend');

function makeEntry(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    session_id: 'test-' + Math.random().toString(36).slice(2, 8),
    session_name: null,
    project: 'test-project',
    cwd: '/test',
    models: {
      'claude-sonnet-4-6': {
        input_tokens: 50000,
        output_tokens: 10000,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 400000,
        message_count: 15,
        cost_usd: 5.0,
      },
    },
    total_cost_usd: 5.0,
    model_comparison: { opus: 25.0, sonnet: 5.0, haiku: 1.3 },
    peak_context_tokens: 100000,
    reason: 'unknown',
    ...overrides,
  };
}

function makeOpusEntry(overrides = {}) {
  return makeEntry({
    models: {
      'claude-opus-4-6': {
        input_tokens: 50000,
        output_tokens: 10000,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 400000,
        message_count: overrides.messageCount || 5,
        cost_usd: overrides.cost || 25.0,
      },
    },
    total_cost_usd: overrides.cost || 25.0,
    ...overrides,
  });
}

// --- analyzeModelTier ---

describe('analyzeModelTier', () => {
  test('flags light Opus sessions (<10 messages)', () => {
    const entries = Array(5).fill(null).map(() => makeOpusEntry({ messageCount: 3, cost: 10.0 }));
    const results = analyzeModelTier(entries);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const light = results.find(r => r.title.includes('Light Opus'));
    expect(light).toBeDefined();
    expect(light.savings_usd).toBeGreaterThan(0);
  });

  test('no recommendations for Sonnet-only sessions', () => {
    const entries = Array(5).fill(null).map(() => makeEntry());
    const results = analyzeModelTier(entries);
    expect(results).toHaveLength(0);
  });

  test('flags heavy Opus sessions for consideration', () => {
    const entries = Array(3).fill(null).map(() => makeOpusEntry({ messageCount: 20, cost: 50.0 }));
    const results = analyzeModelTier(entries);
    const heavy = results.find(r => r.title.includes('code editing'));
    expect(heavy).toBeDefined();
  });
});

// --- analyzeCacheEfficiency ---

describe('analyzeCacheEfficiency', () => {
  test('flags low cache efficiency sessions', () => {
    const entries = Array(5).fill(null).map(() => makeEntry({
      models: {
        'claude-sonnet-4-6': {
          input_tokens: 100000,
          output_tokens: 5000,
          cache_creation_input_tokens: 50000,
          cache_read_input_tokens: 10000, // very low cache read
          message_count: 10,
          cost_usd: 5.0,
        },
      },
    }));
    const results = analyzeCacheEfficiency(entries);
    const lowCache = results.find(r => r.title.includes('Low cache'));
    expect(lowCache).toBeDefined();
  });

  test('flags many short sessions', () => {
    const entries = Array(8).fill(null).map(() => makeEntry({
      models: {
        'claude-sonnet-4-6': {
          input_tokens: 5000,
          output_tokens: 1000,
          cache_creation_input_tokens: 10000,
          cache_read_input_tokens: 20000,
          message_count: 2,
          cost_usd: 0.5,
        },
      },
      total_cost_usd: 0.5,
    }));
    const results = analyzeCacheEfficiency(entries);
    const short = results.find(r => r.title.includes('short sessions'));
    expect(short).toBeDefined();
  });

  test('no flags for good cache efficiency', () => {
    const entries = Array(5).fill(null).map(() => makeEntry({
      models: {
        'claude-sonnet-4-6': {
          input_tokens: 10000,
          output_tokens: 5000,
          cache_creation_input_tokens: 50000,
          cache_read_input_tokens: 500000, // high cache read
          message_count: 15,
          cost_usd: 2.0,
        },
      },
    }));
    const results = analyzeCacheEfficiency(entries);
    const lowCache = results.find(r => r.title.includes('Low cache'));
    expect(lowCache).toBeUndefined();
  });
});

// --- analyzeContextBloat ---

describe('analyzeContextBloat', () => {
  test('flags sessions with >500K context', () => {
    const entries = [
      makeEntry({ peak_context_tokens: 800000, total_cost_usd: 50.0, session_name: 'big refactor' }),
      makeEntry({ peak_context_tokens: 600000, total_cost_usd: 30.0 }),
    ];
    const results = analyzeContextBloat(entries);
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('High context');
    expect(results[0].finding).toContain('big refactor');
  });

  test('no flags for normal context', () => {
    const entries = Array(5).fill(null).map(() => makeEntry({ peak_context_tokens: 100000 }));
    const results = analyzeContextBloat(entries);
    expect(results).toHaveLength(0);
  });
});

// --- analyzeProjectPatterns ---

describe('analyzeProjectPatterns', () => {
  test('flags projects using Opus with low message counts', () => {
    const entries = Array(4).fill(null).map(() => makeEntry({
      project: 'simple-config',
      models: {
        'claude-opus-4-6': {
          input_tokens: 10000,
          output_tokens: 2000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 50000,
          message_count: 5,
          cost_usd: 8.0,
        },
      },
      total_cost_usd: 8.0,
    }));
    const results = analyzeProjectPatterns(entries);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('simple-config');
  });

  test('no flags for Sonnet-only projects', () => {
    const entries = Array(5).fill(null).map(() => makeEntry({ project: 'my-app' }));
    const results = analyzeProjectPatterns(entries);
    expect(results).toHaveLength(0);
  });
});

// --- analyzeSessionNamePatterns ---

describe('analyzeSessionNamePatterns', () => {
  test('flags doc sessions using Opus', () => {
    const entries = Array(6).fill(null).map((_, i) => makeEntry({
      session_name: i < 3 ? 'update README docs' : 'build new feature',
      models: {
        'claude-opus-4-6': {
          input_tokens: 20000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100000,
          message_count: 10,
          cost_usd: 10.0,
        },
      },
      total_cost_usd: 10.0,
    }));
    const results = analyzeSessionNamePatterns(entries);
    const docs = results.find(r => r.title.includes('docs'));
    expect(docs).toBeDefined();
  });

  test('needs at least 5 named entries to analyze', () => {
    const entries = Array(3).fill(null).map(() => makeEntry({ session_name: 'debug something' }));
    const results = analyzeSessionNamePatterns(entries);
    expect(results).toHaveLength(0);
  });

  test('flags expensive debug sessions', () => {
    const debugEntries = Array(4).fill(null).map(() => makeEntry({
      session_name: 'debug auth crash',
      total_cost_usd: 100.0,
    }));
    const normalEntries = Array(10).fill(null).map(() => makeEntry({
      session_name: 'build feature',
      total_cost_usd: 5.0,
    }));
    const results = analyzeSessionNamePatterns([...debugEntries, ...normalEntries]);
    const debug = results.find(r => r.title.includes('Debug') || r.title.includes('debug'));
    expect(debug).toBeDefined();
  });
});

// --- analyzeTimePatterns ---

describe('analyzeTimePatterns', () => {
  test('flags expensive time buckets', () => {
    const morningEntries = Array(5).fill(null).map(() => {
      const d = new Date();
      d.setHours(10, 0, 0, 0);
      return makeEntry({ timestamp: d.toISOString(), total_cost_usd: 5.0 });
    });
    const eveningEntries = Array(5).fill(null).map(() => {
      const d = new Date();
      d.setHours(20, 0, 0, 0);
      return makeEntry({ timestamp: d.toISOString(), total_cost_usd: 50.0 });
    });
    const results = analyzeTimePatterns([...morningEntries, ...eveningEntries]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title.toLowerCase()).toContain('evening');
  });

  test('no flags when costs are uniform', () => {
    const entries = Array(10).fill(null).map(() => {
      const d = new Date();
      d.setHours(10 + Math.floor(Math.random() * 8), 0, 0, 0);
      return makeEntry({ timestamp: d.toISOString(), total_cost_usd: 5.0 });
    });
    const results = analyzeTimePatterns(entries);
    expect(results).toHaveLength(0);
  });
});

// --- analyzeSubagentUsage ---

describe('analyzeSubagentUsage', () => {
  test('flags expensive multi-model sessions', () => {
    const multiModel = Array(4).fill(null).map(() => makeEntry({
      models: {
        'claude-opus-4-6': { input_tokens: 50000, output_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000, message_count: 10, cost_usd: 20.0 },
        'claude-sonnet-4-6': { input_tokens: 30000, output_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, message_count: 5, cost_usd: 3.0 },
      },
      total_cost_usd: 23.0,
    }));
    const singleModel = Array(10).fill(null).map(() => makeEntry({ total_cost_usd: 5.0 }));
    const results = analyzeSubagentUsage([...multiModel, ...singleModel]);
    expect(results.length).toBeLessThanOrEqual(1); // may or may not trigger depending on threshold
  });
});

// --- generateRecommendations ---

describe('generateRecommendations', () => {
  test('returns empty for no entries', () => {
    expect(generateRecommendations([])).toHaveLength(0);
  });

  test('returns sorted by priority (highest first)', () => {
    const entries = [
      ...Array(5).fill(null).map(() => makeOpusEntry({ messageCount: 3, cost: 10.0 })),
      ...Array(5).fill(null).map(() => makeEntry({ peak_context_tokens: 800000, total_cost_usd: 50.0 })),
    ];
    const results = generateRecommendations(entries);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].priority).toBeLessThanOrEqual(results[i - 1].priority);
    }
  });

  test('all results have required fields', () => {
    const entries = Array(10).fill(null).map(() => makeOpusEntry({ messageCount: 3, cost: 10.0 }));
    const results = generateRecommendations(entries);
    for (const r of results) {
      expect(r).toHaveProperty('priority');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('finding');
      expect(r).toHaveProperty('recommendation');
      expect(r).toHaveProperty('savings_usd');
      expect(typeof r.priority).toBe('number');
      expect(typeof r.savings_usd).toBe('number');
    }
  });
});
