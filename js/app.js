let appData = null;

// Keep suggestions manageable: browsers truncate very large native datalists.
let availableVersions = [];
const MAX_SUGGESTIONS = 80;

function populateDatalist(data) {
  availableVersions = [...new Set((data.versions || []).map(v => v.version))]
    .filter(v => /^\\d+\\.\\d+\\.\\d+$/.test(v))
    .sort((a, b) => {
      const aa = a.split('.').map(Number);
      const bb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (aa[i] !== bb[i]) return bb[i] - aa[i];
      }
      return 0;
    });
  refreshVersionSuggestions('');
}

function refreshVersionSuggestions(query) {
  const q = String(query || '').trim().replace(/^v/i, '');
  const matches = q ? availableVersions.filter(v => v.startsWith(q)) : availableVersions;
  const dl = document.getElementById('version-list');
  dl.replaceChildren(...matches.slice(0, MAX_SUGGESTIONS).map(v => {
    const option = document.createElement('option');
    option.value = v;
    return option;
  }));
}

function updateMeta(data) {
  const el = document.getElementById('data-meta');
  if (!el || !data.meta) return;
  const ts = (data.meta.generated_at || '').slice(0, 10);
  const latest = data.meta.latest_version || '—';
  const bugsReviewed = data.meta.bugs_last_reviewed || '';
  const bugsNote = bugsReviewed ? ` · Bugs reviewed: ${bugsReviewed}` : '';
  el.textContent = `Data updated: ${ts}  ·  Latest: v${latest}${bugsNote}`;
}

function onSubmit(e) {
  e.preventDefault();
  const fromVal = document.getElementById('from-version').value.trim();
  const toVal   = document.getElementById('to-version').value.trim();
  if (!fromVal || !toVal) return;
  const pgVal = (document.getElementById('pg-version').value || '').trim();
  const opts = pgVal ? { pgVersion: pgVal } : {};
  const result = window.UpgradePath.computePath(fromVal, toVal, appData, opts);
  const el = document.getElementById('results');
  window.Render.renderPath(result, el);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function init(data) {
  appData = data;
  populateDatalist(data);
  for (const id of ['from-version', 'to-version']) {
    const input = document.getElementById(id);
    input.addEventListener('input', () => refreshVersionSuggestions(input.value));
    input.addEventListener('focus', () => refreshVersionSuggestions(input.value));
  }
  updateMeta(data);
  document.getElementById('upgrade-form').addEventListener('submit', onSubmit);
  const params = new URLSearchParams(window.location.search);
  if (params.get('from') && params.get('to')) {
    document.getElementById('from-version').value = params.get('from');
    document.getElementById('to-version').value   = params.get('to');
    document.getElementById('upgrade-form').requestSubmit();
  }
}

fetch('./data/versions.json')
  .then(r => { if (!r.ok) throw new Error('no versions.json'); return r.json(); })
  .catch(() => fetch('./data/seed.json').then(r => r.json()))
  .then(data => init(data))
  .catch(err => {
    const el = document.getElementById('results');
    el.innerHTML = `<div class="result-card result-error"><p>Failed to load version data: ${err.message}</p></div>`;
    el.style.display = 'block';
  });
