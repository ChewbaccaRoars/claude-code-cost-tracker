const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const scenariosDir = path.join(__dirname, 'scenarios');

function loadScenarios() {
  return fs.readdirSync(scenariosDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(scenariosDir, f), 'utf8')));
}

function checkResponse(response, scenario) {
  const failures = [];
  const lower = response.toLowerCase();

  if (scenario.required_any) {
    const found = scenario.required_in_response.some(term => lower.includes(term.toLowerCase()));
    if (!found) {
      failures.push(`Missing any of: ${scenario.required_in_response.join(', ')}`);
    }
  } else {
    for (const term of (scenario.required_in_response || [])) {
      if (!lower.includes(term.toLowerCase())) {
        failures.push(`Missing required term: "${term}"`);
      }
    }
  }

  for (const term of (scenario.forbidden_in_response || [])) {
    if (lower.includes(term.toLowerCase())) {
      failures.push(`Contains forbidden term: "${term}"`);
    }
  }

  return failures;
}

function runEval(scenario) {
  console.log(`\nRunning: ${scenario.name}`);
  console.log(`  Prompt: "${scenario.user_prompt}"`);

  try {
    const response = execFileSync(
      'claude',
      ['-p', scenario.user_prompt, '--output-format', 'text', '--model', 'sonnet'],
      { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const failures = checkResponse(response, scenario);
    const passed = failures.length === 0;

    console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed) {
      for (const f of failures) console.log(`    - ${f}`);
      console.log(`  Response excerpt: ${response.slice(0, 200)}...`);
    }

    return { name: scenario.name, passed, failures, response };
  } catch (err) {
    console.log(`  Result: ERROR - ${err.message}`);
    return { name: scenario.name, passed: false, failures: [`Execution error: ${err.message}`], response: '' };
  }
}

if (require.main === module) {
  const scenarios = loadScenarios();
  console.log(`Running ${scenarios.length} eval scenarios...\n`);

  const results = scenarios.map(runEval);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { loadScenarios, checkResponse, runEval };
