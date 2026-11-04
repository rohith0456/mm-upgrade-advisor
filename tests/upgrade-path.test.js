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
// Incorrectly generated cards must never return.
const pathWithoutDb = compute('9.5.8', '11.7.14', data);
assert(!pathWithoutDb.warnings.some(w => /csrf|pg12_dropped_10_0/.test(w.bug_id)));
assert(pathWithoutDb.warnings.some(w => w.bug_id === 'postgres_verify' && /14/.test(w.title)));
assert(pathWithoutDb.warnings.some(w => w.bug_id === 'mysql_removed'));
assert.equal(pathWithoutDb.clientCompat.desktop, '6.2 ESR or 6.3');
assert.match(pathWithoutDb.clientCompat.mobile, /latest supported/);
const pg12 = compute('9.5.8', '11.7.14', data, {pgVersion: '12'});
const db12 = pg12.warnings.find(w => w.bug_id === 'postgres_requirement');
assert(db12 && /10.6.0/.test(db12.description) && /14/.test(db12.title));
const pg14 = compute('9.5.8', '11.7.14', data, {pgVersion: '14'});
assert(!pg14.warnings.some(w => w.bug_id === 'postgres_requirement'));
const pg13 = compute('9.5.8', '10.11.25', data, {pgVersion: '13'});
assert(!pg13.warnings.some(w => w.bug_id === 'postgres_requirement'));
const pg12To10 = compute('9.5.8', '10.11.25', data, {pgVersion: '12'});
assert(pg12To10.warnings.some(w => w.bug_id === 'postgres_requirement'));
const pg14To12 = compute('11.7.14', '12.0.1', data, {pgVersion: '14'});
assert(pg14To12.warnings.some(w => w.bug_id === 'postgres_requirement' && /15/.test(w.title)));
assert.equal(data.upgrade_notes_by_version['9.10'], undefined);
console.log('ESR, database, CSRF, and client regression tests passed');
