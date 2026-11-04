let appData = null;

// All v7+ releases remain searchable; only visible suggestions are capped.
let availableVersions = [];
function populateDatalist(data) {
  availableVersions = [...new Set((data.versions || []).map(v => v.version))]
    .filter(v => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) >= 7)
    .sort((a, b) => {
      const x = a.split('.').map(Number), y = b.split('.').map(Number);
      return y[0]-x[0] || y[1]-x[1] || y[2]-x[2];
    });
}
function setupVersionPicker(input) {
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');
  const parent = input.parentNode;
  const menu = document.createElement('div');
  menu.className = 'version-menu';
  menu.hidden = true;
  parent.appendChild(menu);
  const close = () => { menu.hidden = true; };
  const show = () => {
    const q = input.value.trim().replace(/^v/i, '');
    const matches = q ? availableVersions.filter(v => v.startsWith(q)) : availableVersions;
    menu.replaceChildren();
    for (const version of matches.slice(0, 100)) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'version-option';
      option.textContent = version;
      option.addEventListener('pointerdown', e => e.preventDefault());
      option.addEventListener('click', () => { input.value = version; close(); input.focus(); });
      menu.appendChild(option);
    }
    if (matches.length > 100) {
      const hint = document.createElement('div');
      hint.className = 'version-hint';
      hint.textContent = 'Type a version prefix to search all releases from v7 onward';
      menu.appendChild(hint);
    }
    if (!matches.length) {
      const hint = document.createElement('div');
      hint.className = 'version-hint';
      hint.textContent = 'No matching version';
      menu.appendChild(hint);
    }
    menu.hidden = false;
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('pointerdown', e => { if (!parent.contains(e.target)) close(); });
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
  for (const id of ['from-version', 'to-version']) setupVersionPicker(document.getElementById(id));
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
