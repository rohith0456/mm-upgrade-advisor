/**
 * upgrade-path.js — Pure upgrade path computation. No DOM access.
 */

const VER_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/;

function parseVer(v) {
  if (!v) return null;
  const m = String(v).trim().match(VER_RE);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] || '0', 10)];
}

function compareVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function verToStr(tuple) {
  return tuple.join('.');
}

function majorMinor(tuple) {
  return `${tuple[0]}.${tuple[1]}`;
}

/**
 * computePath(fromStr, toStr, data) → PathResult | { error: string }
 *
 * PathResult:
 *   { from, to, steps[], warnings[], estimatedEffort, totalSteps }
 *
 * Each step:
 *   { fromVer, toVer, versionData, upgradeNotes, breakingChanges, isESRHop }
 */
function computePath(fromStr, toStr, data, options) {
  options = options || {};
  const from = parseVer(fromStr);
  const to = parseVer(toStr);

  if (!from) return { error: `Cannot parse "from" version: ${fromStr}` };
  if (!to)   return { error: `Cannot parse "to" version: ${toStr}` };

  if (compareVer(from, to) === 0) return { error: 'Current and target versions are the same.' };
  if (compareVer(from, to) > 0)  return { error: 'Downgrade paths are not supported.' };

  // Use the newest available GA patch in each verified intermediate ESR series.
  // Never manufacture .0 stops: older initial releases may contain known bugs.
  const allVersions = (data.versions || []).map(r => parseVer(r.version)).filter(Boolean);
  const esrSeries = (data.esr_versions || []).filter(v => /^\d+\.\d+$/.test(v));
  if (!esrSeries.length) return { error: 'Verified ESR release data is unavailable. Cannot calculate a reliable upgrade path.' };
  const hops = [];
  for (const series of esrSeries) {
    const [major, minor] = series.split('.').map(Number);
    const base = [major, minor, 0];
    if (compareVer(base, from) <= 0 || compareVer(base, to) >= 0 || (major === to[0] && minor === to[1])) continue;
    const patches = allVersions.filter(v => v[0] === major && v[1] === minor && compareVer(v, to) < 0);
    if (!patches.length) return { error: `No verified release found for ESR ${series}. Upgrade path cannot be calculated.` };
    patches.sort(compareVer);
    hops.push(patches[patches.length - 1]);
  }
  hops.sort(compareVer);
  const path = [from, ...hops, to];

  // Build a quick lookup map for version records
  const versionMap = {};
  for (const rec of (data.versions || [])) {
    versionMap[rec.version] = rec;
  }

  // Upgrade notes by major.minor
  const notesByMinor = data.upgrade_notes_by_version || {};

  // Build steps
  const steps = [];
  for (let i = 0; i < path.length - 1; i++) {
    const stepFrom = path[i];
    const stepTo   = path[i + 1];
    const toStr2   = verToStr(stepTo);
    const mm       = majorMinor(stepTo);

    const rec = versionMap[toStr2] || null;
    const upgradeNotes = (rec && rec.upgrade_notes) || notesByMinor[mm] || '';
    const breakingChanges = rec ? (rec.breaking_changes || []) : [];
    const isESRHop = esrSeries.includes(mm);

    steps.push({
      fromVer: verToStr(stepFrom),
      toVer: toStr2,
      versionData: rec,
      upgradeNotes,
      breakingChanges,
      isESRHop,
    });
  }

  const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 };

  // Collect warnings from known_bugs
  // pathSpecific = bugs gated on both source AND target (e.g. DB migration bug)
  // general = bugs gated only on target version (e.g. PostgreSQL requirement)
  const pathSpecificWarnings = [];
  const generalWarnings = [];

  for (const bug of (data.known_bugs || []).filter(b => !options.pgVersion || b.category !== 'db_version')) {
    const isPathSpecific = !!bug.affected_source_from;

    // Source gate: if bug requires source >= threshold, skip if source is below
    if (isPathSpecific) {
      const srcThresh = parseVer(bug.affected_source_from);
      if (srcThresh && compareVer(from, srcThresh) < 0) continue;
    }

    // Target gate
    const targetFrom = bug.affected_target_from ? parseVer(bug.affected_target_from) : null;
    const targetTo   = bug.affected_target_to   ? parseVer(bug.affected_target_to)   : null;

    let triggered = false;
    if (targetFrom && targetTo) {
      triggered = compareVer(to, targetFrom) >= 0 && compareVer(to, targetTo) <= 0;
    } else if (targetFrom) {
      // For general bugs (no source gate): only trigger if the upgrade path
      // actually CROSSES the threshold — i.e. from < threshold <= to.
      // If the user is already past the threshold, they know about it.
      if (isPathSpecific) {
        triggered = compareVer(to, targetFrom) >= 0;
      } else {
        triggered = compareVer(from, targetFrom) < 0 && compareVer(to, targetFrom) >= 0;
      }
    }

    if (!triggered) continue;
    if (isPathSpecific) pathSpecificWarnings.push(bug);
    else generalWarnings.push(bug);
  }

  const sortBySeverity = arr => arr.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  sortBySeverity(pathSpecificWarnings);
  sortBySeverity(generalWarnings);

  // Database requirements are release thresholds, not unconditional incidents.
  const dbWarnings = [];
  const dbRules = (data.database_requirements || {}).postgres_minimums || [];
  const orderedRules = [...dbRules].filter(rule => parseVer(rule.from)).sort((a, b) => compareVer(parseVer(a.from), parseVer(b.from)));
  const applicable = orderedRules.filter(rule => compareVer(to, parseVer(rule.from)) >= 0);
  const required = applicable.length ? applicable[applicable.length - 1] : null;
  const dbSource = (data.database_requirements || {}).source_url || 'https://docs.mattermost.com/administration-guide/upgrade/important-upgrade-notes';
  const userPg = options.pgVersion ? Number(options.pgVersion) : null;
  if (required && Number.isFinite(userPg) && userPg > 0 && userPg < Number(required.postgres)) {
    const firstBlocked = orderedRules.find(rule => Number(rule.postgres) > userPg && compareVer(to, parseVer(rule.from)) >= 0 && compareVer(from, parseVer(rule.from)) < 0);
    dbWarnings.push({
      bug_id: 'postgres_requirement', severity: 'critical', category: 'db_version',
      title: 'PostgreSQL upgrade needed: v' + required.postgres + '+ for the target release',
      description: 'Selected PostgreSQL ' + userPg + ' is below the supported minimum of ' + required.postgres + ' for Mattermost ' + verToStr(to) + '.' + (firstBlocked ? ' The path first crosses an incompatible database requirement at v' + firstBlocked.from + '.' : '') + ' Upgrade PostgreSQL before the affected Mattermost hop; unsupported versions can prevent startup.',
      workaround: 'Plan a tested PostgreSQL upgrade to v' + required.postgres + '+ before the Mattermost upgrade. Verify backups, database extensions and compatibility.',
      source_url: dbSource
    });
  } else if (required && (!Number.isFinite(userPg) || !userPg)) {
    const crossing = orderedRules.filter(rule => compareVer(from, parseVer(rule.from)) < 0 && compareVer(to, parseVer(rule.from)) >= 0);
    if (crossing.length) dbWarnings.push({
      bug_id: 'postgres_verify', severity: 'high', category: 'db_version',
      title: 'Verify PostgreSQL ' + required.postgres + '+ before upgrading',
      description: 'The target Mattermost release requires PostgreSQL ' + required.postgres + '+. The upgrade crosses database support changes at ' + crossing.map(rule => 'v' + rule.from + ' (PG ' + rule.postgres + '+)').join(', ') + '. PostgreSQL version was not provided, so compatibility cannot be confirmed.',
      workaround: 'Check your deployed PostgreSQL version and upgrade it before the first incompatible Mattermost hop if necessary.',
      source_url: dbSource
    });
  }
  const mysqlEnd = (data.database_requirements || {}).mysql_unsupported_from;
  if (mysqlEnd && parseVer(mysqlEnd) && compareVer(from, parseVer(mysqlEnd)) < 0 && compareVer(to, parseVer(mysqlEnd)) >= 0) {
    dbWarnings.push({
      bug_id: 'mysql_removed', severity: 'high', category: 'db_version',
      title: 'MySQL is unsupported in Mattermost v11+',
      description: 'If your current deployment uses MySQL, migrate to a supported PostgreSQL version before upgrading to Mattermost v11 or later. This warning is conditional; it does not apply to existing PostgreSQL deployments.',
      workaround: 'Confirm your database engine and follow the official MySQL-to-PostgreSQL migration documentation before upgrading Mattermost.',
      source_url: (data.database_requirements || {}).mysql_source_url || dbSource
    });
  }
  const warnings = [...pathSpecificWarnings, ...generalWarnings, ...dbWarnings];

  // Effort estimate
  const crossesMajor = to[0] > from[0];
  const totalBreaking = steps.reduce((s, st) => s + st.breakingChanges.length, 0);
  const hopCount = steps.length;
  let estimatedEffort = 'patch';
  if (crossesMajor || (totalBreaking > 0 && hopCount > 3)) estimatedEffort = 'significant';
  else if (totalBreaking > 0 || hopCount > 2) estimatedEffort = 'moderate';
  else if (hopCount > 1) estimatedEffort = 'minor';

  // Safety: no critical path-specific bugs and no DB version blockers
  const isSafe = warnings.length === 0;

  let safeReason = '';
  let safeDetail = '';
  if (isSafe) {
    safeReason = 'No tracked issues found for this upgrade path.';
    safeDetail = 'Always back up your database and test in staging before upgrading production.';
  }

  const compatMap = data.client_compatibility || {};
  const clientCompat = compatMap[majorMinor(to)] || null;

  return { from: verToStr(from), to: verToStr(to), steps, warnings, estimatedEffort, totalSteps: steps.length, isSafe, safeReason, safeDetail, clientCompat };
}

// Export for use in app.js (no module system — just globals)
window.UpgradePath = { computePath, parseVer, compareVer };
