/**
 * render.js — Simple DOM rendering matching the clean widget design.
 */

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildChecklist(from, to) {
  const key = `mm-checklist-${from}-${to}`;
  let state = [];
  try { state = JSON.parse(localStorage.getItem(key)) || []; } catch(e) {}

  const items = [
    'Back up your database (full dump — verify the restore works)',
    'Check plugin compatibility for the target version',
    'Test the full upgrade path in a staging environment first',
    'Plan a maintenance window (users will be offline during upgrade)',
    'Review the upgrade notes for each hop in your path above',
  ];

  const card = document.createElement('div');
  card.className = 'result-card result-checklist';
  card.innerHTML = `<div class="card-title">Before you upgrade</div>` +
    items.map((item, i) => `
      <label class="checklist-item${state[i] ? ' is-checked' : ''}">
        <input type="checkbox" data-i="${i}"${state[i] ? ' checked' : ''}> ${escHtml(item)}
      </label>`).join('');

  card.addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    const boxes = card.querySelectorAll('input[type=checkbox]');
    const newState = Array.from(boxes).map(cb => cb.checked);
    try { localStorage.setItem(key, JSON.stringify(newState)); } catch(e2) {}
    const label = e.target.closest('.checklist-item');
    if (label) label.classList.toggle('is-checked', e.target.checked);
  });

  return card;
}

function renderPath(result, container) {
  if (result.error) {
    container.innerHTML = `<div class="result-card result-error"><p>${escHtml(result.error)}</p></div>`;
    container.style.display = 'block';
    return;
  }

  const parts = [];

  // ── Primary status card ───────────────────────────────────────────────
  const criticalWarnings = result.warnings.filter(w => w.severity === 'critical');
  const highWarnings = result.warnings.filter(w => w.severity === 'high');

  if (result.isSafe && criticalWarnings.length === 0) {
    const disclaimer = result.safeDetail
      ? `<p class="safe-detail">${escHtml(result.safeDetail)}</p>`
      : `<p class="safe-detail">Always back up your database and test in staging before upgrading production.</p>`;
    parts.push(`
      <div class="result-card result-safe">
        <div class="card-title"><span class="card-icon">✓</span> No tracked issues found</div>
        <p>${escHtml(result.safeReason)}</p>
        ${disclaimer}
      </div>`);
  } else {
    for (const bug of criticalWarnings) {
      const fixed = bug.fixed_in ? ` Fix available in <strong>v${escHtml(bug.fixed_in)}</strong>.` : '';
      const src = bug.source_url ? ` <a href="${escHtml(bug.source_url)}" target="_blank" rel="noopener">Source ↗</a>` : '';
      parts.push(`
        <div class="result-card result-warning">
          <div class="card-title"><span class="card-icon">⚠</span> ${escHtml(bug.title)}</div>
          <p>${escHtml(bug.description)}${fixed}</p>
          ${bug.workaround ? `<div class="workaround-box"><strong>Workaround:</strong> ${escHtml(bug.workaround)}${src}</div>` : ''}
        </div>`);
    }
  }

  // ── Upgrade path card ─────────────────────────────────────────────────
  const hasESRHops = result.steps.some(s => s.isESRHop);

  // Build collapsed upgrade notes per step
  const stepNotesHtml = result.steps.map(step => {
    const notes = (step.upgradeNotes || '').trim();
    const breaking = step.breakingChanges || [];
    if (!notes && !breaking.length) return '';
    const items = [];
    breaking.forEach(b => items.push(`<li class="note-breaking">${escHtml(b)}</li>`));
    if (notes) {
      const short = notes.length > 280 ? notes.slice(0, 277) + '…' : notes;
      items.push(`<li>${escHtml(short)}</li>`);
    }
    const label = breaking.length
      ? `v${escHtml(step.toVer)} — ${breaking.length} breaking change${breaking.length !== 1 ? 's' : ''}`
      : `v${escHtml(step.toVer)} upgrade notes`;
    return `<details class="step-detail"><summary>${label}</summary><ul class="notes-list">${items.join('')}</ul></details>`;
  }).filter(Boolean).join('');

  const pathArrows = result.steps.map((step, i) => {
    const rec = step.versionData;
    const isESR = rec && rec.release_type === 'esr';
    const isLast = i === result.steps.length - 1;
    const badge = isESR ? ' <span class="path-badge">ESR</span>' : '';
    const dlLink = rec && rec.download_url
      ? `<a href="${escHtml(rec.download_url)}" target="_blank" rel="noopener" class="path-link">↓</a>` : '';
    return `
      <span class="path-node ${isLast ? 'path-target' : ''}">
        ${escHtml(step.toVer)}${badge}${dlLink}
      </span>`;
  }).join('<span class="path-arrow">→</span>');

  const fromNode = `<span class="path-node path-from">${escHtml(result.from)}<span class="path-you">you are here</span></span>`;

  const esrNote = hasESRHops
    ? `<p class="path-note">This path hops through each ESR in sequence — the only fully tested upgrade route. Skipping an ESR is technically supported but not tested by Mattermost.</p>`
    : '';

  parts.push(`
    <div class="result-card result-path">
      <div class="card-title"><span class="card-icon">✓</span> ${hasESRHops ? 'ESR-to-ESR path' : 'Upgrade path'}</div>
      ${esrNote}
      <div class="path-row">${fromNode}<span class="path-arrow">→</span>${pathArrows}</div>
      ${stepNotesHtml ? `<div class="step-notes">${stepNotesHtml}</div>` : ''}
      ${result.clientCompat ? `<p class="compat-note">After this upgrade — Desktop app ${escHtml(result.clientCompat.desktop_min)}+ &middot; Mobile app ${escHtml(result.clientCompat.mobile_min)}+ required &middot; <a href="https://docs.mattermost.com/about/server-client-compatibility-matrix.html" target="_blank" rel="noopener">Full matrix ↗</a></p>` : ''}
    </div>`);

  // ── High-severity (non-critical) warnings ─────────────────────────────
  for (const bug of highWarnings) {
    const src = bug.source_url ? ` <a href="${escHtml(bug.source_url)}" target="_blank" rel="noopener">Source ↗</a>` : '';
    parts.push(`
      <div class="result-card result-warn-high">
        <div class="card-title"><span class="card-icon">⚠</span> ${escHtml(bug.title)}</div>
        <p>${escHtml(bug.description)}</p>
        ${bug.workaround ? `<div class="workaround-box"><strong>Workaround:</strong> ${escHtml(bug.workaround)}${src}</div>` : ''}
      </div>`);
  }

  // ── Footer note ───────────────────────────────────────────────────────
  const noteBug = result.warnings.find(w => w.severity === 'critical') || result.warnings[0] || null;
  const bugNote = noteBug
    ? `Tracked issue: ${noteBug.title.toLowerCase()}.${noteBug.fixed_in ? ` Fix in v${noteBug.fixed_in}.` : ''} <a href="${escHtml(noteBug.source_url || 'https://docs.mattermost.com/upgrade/important-upgrade-notes.html')}" target="_blank" rel="noopener">Source ↗</a>`
    : `No tracked issues for this path. <a href="https://docs.mattermost.com/upgrade/important-upgrade-notes.html" target="_blank" rel="noopener">Official upgrade notes ↗</a>`;

  parts.push(`<p class="result-footer">Based on official Mattermost docs and known bug reports. ${bugNote}</p>`);

  // Checklist placeholder — replaced post-render so event listeners attach properly
  parts.push(`<div id="checklist-slot"></div>`);

  container.innerHTML = parts.join('');
  container.style.display = 'block';

  // Inject interactive checklist
  const slot = container.querySelector('#checklist-slot');
  if (slot) slot.replaceWith(buildChecklist(result.from, result.to));
}

window.Render = { renderPath };
