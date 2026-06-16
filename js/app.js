let appData = null;

function populateDatalist(data) {
  const versions = (data.versions || []).map(v => v.version).sort((a, b) => {
    const parse = x => x.split('.').map(Number);
    const [am, bm] = [a, b].map(parse);
    for (let i = 0; i < 3; i++) { const d = (am[i]||0)-(bm[i]||0); if (d) return d; }
    return 0;
  });
  const dl = document.getElementById('version-list');
  dl.innerHTML = versions.map(v => `<option value="${v}">`).join('');
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
