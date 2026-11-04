// Regression checks for the ESR path rules. Run: node tests/upgrade-path.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const data = JSON.parse(fs.readFileSync('data/versions.json', 'utf8'));
const context = {window: {}};
vm.runInNewContext(fs.readFileSync('js/upgrade-path.js', 'utf8'), context);
const compute = context.window.UpgradePath.computePath;
function check(from, to, expected) {
  const result = compute(from, to, data);
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(Array.from(result.steps, s => s.toVer), expected);
}
check('9.5.8', '11.7.14', ['9.11.18', '10.5.14', '10.11.25', '11.7.14']);
check('10.11.25', '11.7.14', ['11.7.14']);
check('11.7.13', '11.7.14', ['11.7.14']);
assert(!data.esr_versions.includes('11.0'));
assert(!data.esr_versions.includes('11.6'));
assert(data.esr_versions.includes('10.11'));
assert(data.esr_versions.includes('11.7'));
console.log('ESR path regression tests passed');
