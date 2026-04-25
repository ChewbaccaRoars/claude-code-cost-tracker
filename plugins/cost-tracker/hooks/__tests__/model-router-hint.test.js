const fs = require('fs');
const { classify, modelTier, buildMessage, loadState, saveState, getStatePath } = require('../model-router-hint');

describe('classify', () => {
  test('flags docs work', () => {
    expect(classify('please update the README and add docs for this function')).toBe('docs');
  });

  test('flags refactor work', () => {
    expect(classify('refactor this module and rename the helper')).toBe('refactor');
  });

  test('flags test-writing work', () => {
    expect(classify('write tests for the auth flow')).toBe('test');
  });

  test('flags review work', () => {
    expect(classify('review this PR and check for problems')).toBe('review');
  });

  test('flags exploration', () => {
    expect(classify('search for all usages of getUser')).toBe('explore');
  });

  test('returns null when nothing matches', () => {
    expect(classify('hello, can you help me build a dashboard?')).toBeNull();
  });

  test('keeps Opus when prompt mentions architecture', () => {
    expect(classify('refactor this — but first walk through the architecture')).toBeNull();
  });

  test('keeps Opus when prompt mentions root cause / hard bug', () => {
    expect(classify('document the root cause of this hard bug')).toBeNull();
  });

  test('keeps Opus on race conditions', () => {
    expect(classify('refactor the queue handler — there is a race condition')).toBeNull();
  });

  test('returns null on empty prompt', () => {
    expect(classify('')).toBeNull();
    expect(classify(null)).toBeNull();
  });
});

describe('modelTier', () => {
  test('detects opus', () => {
    expect(modelTier('claude-opus-4-7')).toBe('opus');
    expect(modelTier('Claude-OPUS')).toBe('opus');
  });
  test('detects sonnet', () => {
    expect(modelTier('claude-sonnet-4-6')).toBe('sonnet');
  });
  test('detects haiku', () => {
    expect(modelTier('claude-haiku-4-5-20251001')).toBe('haiku');
  });
  test('returns null for unknowns', () => {
    expect(modelTier('gpt-4')).toBeNull();
    expect(modelTier(null)).toBeNull();
  });
});

describe('buildMessage', () => {
  test('docs message mentions Sonnet', () => {
    const m = buildMessage('docs');
    expect(m).toContain('Sonnet');
    expect(m).toContain('/model sonnet');
  });
  test('returns null for unknown category', () => {
    expect(buildMessage('build')).toBeNull();
  });
});

describe('state management', () => {
  const id = 'router-test-' + Date.now();
  afterAll(() => { try { fs.unlinkSync(getStatePath(id)); } catch {} });

  test('loadState returns empty for missing', () => {
    expect(loadState('missing-' + Date.now())).toEqual({ shown: [] });
  });

  test('roundtrip', () => {
    saveState(id, { shown: ['docs'] });
    expect(loadState(id)).toEqual({ shown: ['docs'] });
  });
});
