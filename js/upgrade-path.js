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

  // Resolve ESR versions as tuples
  const esrs = (data.esr_versions || [])
    .map(v => parseVer(v + '.0'))
    .filter(Boolean)
    .sort(compareVer);

  // ESR hops strictly between from and to (exclusive of from, inclusive of to)
  const hops = esrs.filter(esr =>
    compareVer(esr, from) > 0 && compareVer(esr, to) <= 0
  );

  // Full ordered path
  const rawPath = [from, ...hops, to];

  // Deduplicate (in case to IS an ESR already in hops)
  const path = rawPath.reduce((acc, v) => {
    if (!acc.length || compareVer(acc[acc.length - 1], v) !== 0) acc.push(v);
    return acc;
  }, []);

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
    const isESRHop = rec ? rec.release_type === 'esr' : false;

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

  // Algorithmic DB version check — fires when user supplies their PostgreSQL version
  const dbWarnings = [];
  if (options.pgVersion) {
    const userPg = parseFloat(options.pgVersion);
    if (!isNaN(userPg)) {
      for (const step of steps) {
        const rec = step.versionData;
        if (rec && rec.min_pg_version) {
          const minPg = parseFloat(rec.min_pg_version);
          if (!isNaN(minPg) && userPg < minPg) {
            dbWarnings.push({
              bug_id: 'pg_version_check',
              severity: 'critical',
              title: `PostgreSQL upgrade required before v${rec.version}`,
              description: `PostgreSQL ${options.pgVersion} is below the minimum required (${rec.min_pg_version}) for Mattermost v${rec.version}. The server will not start.`,
              workaround: `Upgrade PostgreSQL to ${rec.min_pg_version}+ before upgrading Mattermost to v${rec.version}. Do not upgrade both simultaneously.`,
              source_url: 'https://docs.mattermost.com/install/software-hardware-requirements.html'
            });
            break;
          }
        }
      }
    }
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
  const isSafe = [...pathSpecificWarnings, ...dbWarnings].filter(w => w.severity === 'critical').length === 0;

  let safeReason = '';
  let safeDetail = '';
  if (isSafe) {
    safeReason = 'No tracked issues found for this upgrade path.';
    safeDetail = 'Always back up your database and test in staging before upgrading production.';
  }

  return { from: verToStr(from), to: verToStr(to), steps, warnings, estimatedEffort, totalSteps: steps.length, isSafe, safeReason, safeDetail };
}

// Export for use in app.js (no module system — just globals)
window.UpgradePath = { computePath, parseVer, compareVer };
