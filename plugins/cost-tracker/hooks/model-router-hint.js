// UserPromptSubmit hook: classifies the prompt the user is about to send and,
// when the active model is Opus but the task looks like routine docs/refactor/test/explore work,
// emits a single one-shot system message suggesting `/model sonnet`.
//
// Cost-optimization rationale: catching tier mismatches BEFORE the prompt is processed
// is cheaper than realizing it after the fact via /cost-optimize.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Categories where Sonnet is generally sufficient. Debug/build are intentionally excluded —
// those frequently benefit from Opus reasoning.
const SONNET_FRIENDLY = {
  docs:     /\b(doc|docs|readme|comment|explain|document|describe|write[- ]?up|description)\b/i,
  refactor: /\b(refactor|cleanup|clean[- ]?up|reorganize|rename|restructure|simplify|extract method)\b/i,
  test:     /\b(write tests?|add tests?|unit tests?|test coverage|jest|pytest|vitest|spec file)\b/i,
  review:   /\b(review|audit|check|inspect|scan|skim|look at|read through)\b/i,
  explore:  /\b(explore|research|investigate|search( for)?|find( all)?|grep|locate|where is)\b/i,
};

// Phrases that typically warrant Opus — when present, suppress the hint.
const OPUS_KEEP = /\b(architect\w*|design|complex|tricky|race condition|deadlock|root cause|hard bug|deep|why does|reason about|prove|invariant|migration plan)\b/i;

function classify(text) {
  if (!text || OPUS_KEEP.test(text)) return null;
  for (const [cat, pat] of Object.entries(SONNET_FRIENDLY)) {
    if (pat.test(text)) return cat;
  }
  return null;
}

function modelTier(model) {
  const lower = (model || '').toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  return null;
}

function getStatePath(sessionId) {
  const dir = path.join(os.tmpdir(), 'claude-cost-monitor');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `${sessionId}-router.json`);
}

function loadState(sessionId) {
  try { return JSON.parse(fs.readFileSync(getStatePath(sessionId), 'utf8')); }
  catch { return { shown: [] }; }
}

function saveState(sessionId, state) {
  fs.writeFileSync(getStatePath(sessionId), JSON.stringify(state));
}

const SUGGESTIONS = {
  docs:     'docs work runs well on Sonnet',
  refactor: 'refactors run well on Sonnet',
  test:     'writing tests runs well on Sonnet',
  review:   'code review runs well on Sonnet',
  explore:  'codebase exploration runs well on Sonnet',
};

function buildMessage(category) {
  const reason = SUGGESTIONS[category];
  if (!reason) return null;
  return `💡 Cost tip: This looks like ${category} — ${reason} (~80% cheaper than Opus). Run \`/model sonnet\` to switch for the rest of this session.`;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  // The active model — Claude Code passes it on the payload as `model.id` or similar.
  // Be defensive about the shape.
  const model = (payload.model && (payload.model.id || payload.model.name))
             || payload.model_id
             || payload.active_model
             || null;
  if (modelTier(model) !== 'opus') process.exit(0);

  const prompt = payload.prompt || payload.user_prompt || payload.message || '';
  const category = classify(prompt);
  if (!category) process.exit(0);

  const state = loadState(sessionId);
  if (state.shown.includes(category)) process.exit(0);
  state.shown.push(category);
  saveState(sessionId, state);

  const message = buildMessage(category);
  if (!message) process.exit(0);

  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`model-router-hint: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { classify, modelTier, buildMessage, SONNET_FRIENDLY, OPUS_KEEP, loadState, saveState, getStatePath };
