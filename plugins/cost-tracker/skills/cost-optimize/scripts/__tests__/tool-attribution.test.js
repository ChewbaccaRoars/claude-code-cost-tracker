const fs = require('fs');
const path = require('path');
const os = require('os');
const { attributeTranscript, aggregate, blockLength, CHARS_PER_TOKEN } = require('../tool-attribution');

describe('blockLength', () => {
  test('string', () => {
    expect(blockLength('hello')).toBe(5);
  });
  test('text block', () => {
    expect(blockLength({ type: 'text', text: 'hello' })).toBe(5);
  });
  test('content string', () => {
    expect(blockLength({ type: 'tool_result', content: 'abc' })).toBe(3);
  });
  test('content array', () => {
    expect(blockLength({ type: 'tool_result', content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: 'ef' }] })).toBe(6);
  });
  test('null', () => {
    expect(blockLength(null)).toBe(0);
  });
});

describe('attributeTranscript', () => {
  let tmpDir;
  let tmpFile;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-attr-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns null for missing file', () => {
    expect(attributeTranscript('/nonexistent.jsonl')).toBeNull();
  });

  test('attributes tool calls and results', () => {
    const lines = [
      JSON.stringify({
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'text', text: "I'll read the file." },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.txt' } },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'a'.repeat(400) },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 200, output_tokens: 300 },
          content: [
            { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
      JSON.stringify({
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu2', content: 'a'.repeat(800) },
            { type: 'tool_result', tool_use_id: 'tu3', content: 'a'.repeat(40) },
          ],
        },
      }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n');

    const result = attributeTranscript(tmpFile);
    expect(result.totalCalls).toBe(3);
    expect(result.perTool.Read.calls).toBe(1);
    expect(result.perTool.Bash.calls).toBe(2);
    // 400 chars / 4 chars/token = 100 tokens
    expect(result.perTool.Read.est_result_tokens).toBe(Math.round(400 / CHARS_PER_TOKEN));
    expect(result.perTool.Bash.est_result_tokens).toBe(Math.round(800 / CHARS_PER_TOKEN) + Math.round(40 / CHARS_PER_TOKEN));
    // Assistant turn 2 emitted 300 output tokens across 2 Bash uses ⇒ 150 each.
    expect(result.perTool.Bash.est_output_tokens).toBeCloseTo(300, 5);
  });

  test('handles transcripts without tool calls', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] },
    }) + '\n');
    const result = attributeTranscript(tmpFile);
    expect(result.totalCalls).toBe(0);
  });
});

describe('aggregate', () => {
  test('merges multiple transcript results', () => {
    const a = { perTool: { Read: { calls: 2, est_result_tokens: 100, est_input_tokens: 5, est_output_tokens: 10 } }, totalCalls: 2 };
    const b = { perTool: { Read: { calls: 1, est_result_tokens: 50, est_input_tokens: 2, est_output_tokens: 5 }, Bash: { calls: 1, est_result_tokens: 20, est_input_tokens: 1, est_output_tokens: 3 } }, totalCalls: 2 };
    const merged = aggregate([a, b, null]);
    expect(merged.totalCalls).toBe(4);
    expect(merged.perTool.Read.calls).toBe(3);
    expect(merged.perTool.Read.est_result_tokens).toBe(150);
    expect(merged.perTool.Bash.calls).toBe(1);
  });
});
