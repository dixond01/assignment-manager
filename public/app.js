// Assignment Manager — front end. Plain DOM, no build step.

const $ = (sel) => document.querySelector(sel);

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('prefs')) || {};
  } catch {
    return {};
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem('prefs', JSON.stringify(prefs));
  } catch {}
};

const state = {
  items: [],
  sources: {},
  configured: true,
  view: prefs.view || 'week',
  course: prefs.course || '',
  showDone: prefs.showDone ?? true,
  showHidden: false,
  weekStart: startOfWeek(new Date()),
  detailId: null,
};

// ---------- helpers ----------

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// Stable color per course name.
function courseColor(course) {
  let h = 0;
  for (const ch of course || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 50%)`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------- data ----------

async function load(refresh = false) {
  $('#refreshBtn').disabled = true;
  $('#refreshBtn').textContent = 'Syncing…';
  try {
    const data = await api(`/api/assignments${refresh ? '?refresh=1' : ''}`);
    Object.assign(state, data);
  } catch (err) {
    state.loadError = err.message;
  } finally {
    $('#refreshBtn').disabled = false;
    $('#refreshBtn').textContent = 'Refresh';
  }
  render();
}

function visibleItems() {
  return state.items.filter(
    (i) =>
      (!state.course || i.course === state.course) &&
      (state.showDone || !i.done) &&
      (state.showHidden || !i.hidden),
  );
}

const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title);

async function patchItem(id, changes) {
  const item = state.items.find((i) => i.id === id);
  Object.assign(item, changes);
  render();
  await api(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
}

// ---------- rendering ----------

function render() {
  document.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === state.view));
  $('#weekNav').hidden = state.view !== 'week';
  $('#showDone').checked = state.showDone;
  $('#showHidden').checked = state.showHidden;
  renderCourseFilter();
  renderStatus();

  const main = $('#main');
  main.replaceChildren();
  if (!state.configured && !state.items.length) {
    main.append(
      el('div', { class: 'empty' }, 'No sources connected yet. ', el('button', { onclick: openSettings }, 'Open settings'), ' to add your Canvas and Learning Suite feeds.'),
    );
    return;
  }
  main.append(state.view === 'week' ? renderWeek() : renderList());
}

function renderCourseFilter() {
  const courses = [...new Set(state.items.map((i) => i.course))].sort();
  const select = $('#courseFilter');
  select.replaceChildren(el('option', { value: '' }, 'All courses'), ...courses.map((c) => el('option', { value: c }, c)));
  if (!courses.includes(state.course)) state.course = '';
  select.value = state.course;
}

// One option per displayed course. The value is the course's original name, so a manual item
// keeps following any later rename; renamed-together courses collapse into one option.
function courseOptions() {
  const byDisplay = new Map();
  for (const item of state.items) {
    if (item.course !== 'Other' && !byDisplay.has(item.course)) byDisplay.set(item.course, item.courseOriginal);
  }
  return [...byDisplay].sort(([a], [b]) => a.localeCompare(b)).map(([display, original]) => ({ display, original }));
}

function renderStatus() {
  const labels = { canvas: 'Canvas', learningsuite: 'Learning Suite' };
  const parts = Object.entries(state.sources).map(([name, s]) => {
    if (s.error) return el('span', { class: 'error' }, `${labels[name]}: ${s.error}`);
    const when = s.fetchedAt ? `${fmtShort(new Date(s.fetchedAt))} ${fmtTime(new Date(s.fetchedAt))}` : 'never';
    return el('span', {}, `${labels[name]}: ${s.count} items, synced ${when}`);
  });
  if (state.loadError) parts.push(el('span', { class: 'error' }, `Could not reach server: ${state.loadError}`));
  $('#status').replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
}

function renderCard(item, { showDate = false } = {}) {
  const due = item.due ? new Date(item.due) : null;
  const overdue = due && !item.done && due < new Date();
  const meta = [
    showDate && due && el('span', { class: 'list-date' }, fmtDay(due)),
    due && !item.allDay && el('span', {}, fmtTime(due)),
    el('span', {}, item.course),
    item.points != null && el('span', {}, `${item.points} pts`),
    item.submitted && el('span', { class: 'badge submitted' }, item.graded && item.score != null ? `Graded ${item.score}/${item.points}` : 'Submitted'),
    item.missing && el('span', { class: 'badge missing' }, 'Missing'),
    item.late && el('span', { class: 'badge late' }, 'Late'),
    overdue && !item.missing && el('span', { class: 'badge overdue' }, 'Overdue'),
    item.source === 'manual' && el('span', { class: 'badge' }, 'manual'),
    item.notes && el('span', { title: item.notes }, '📝'),
  ];
  return el(
    'div',
    { class: `card${item.done ? ' done' : ''}${item.hidden ? ' hidden-item' : ''}`, style: `--course: ${courseColor(item.course)}` },
    el('input', { type: 'checkbox', checked: item.done, title: 'Mark done', onchange: (e) => patchItem(item.id, { done: e.target.checked }) }),
    el('div', { class: 'body' }, el('button', { type: 'button', class: 'title', onclick: () => openDetail(item.id) }, item.title), el('div', { class: 'meta' }, meta)),
  );
}

function renderWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  $('#weekLabel').textContent = `${fmtShort(start)} – ${fmtShort(addDays(start, 6))}`;
  const items = visibleItems().filter((i) => i.due && new Date(i.due) >= start && new Date(i.due) < end).sort(byDue);
  const today = new Date();

  const days = Array.from({ length: 7 }, (_, n) => {
    const day = addDays(start, n);
    const dayItems = items.filter((i) => sameDay(new Date(i.due), day));
    const open = dayItems.filter((i) => !i.done).length;
    return el(
      'section',
      { class: `day${sameDay(day, today) ? ' today' : ''}` },
      el('div', { class: 'day-head' }, fmtDay(day), el('span', {}, dayItems.length ? `${open} left` : '')),
      el('div', { class: 'day-items' }, dayItems.map((i) => renderCard(i))),
    );
  });
  return el('div', { class: 'week' }, days);
}

function renderList() {
  const now = new Date();
  const weekEnd = addDays(startOfWeek(now), 7);
  const groups = { Overdue: [], 'This week': [], Later: [], 'No due date': [], 'Earlier (done)': [] };
  for (const item of visibleItems().sort(byDue)) {
    const due = item.due ? new Date(item.due) : null;
    if (!due) groups['No due date'].push(item);
    else if (due < now) groups[item.done ? 'Earlier (done)' : 'Overdue'].push(item);
    else if (due < weekEnd) groups['This week'].push(item);
    else groups.Later.push(item);
  }
  groups['Earlier (done)'].reverse(); // most recent first

  const sections = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([name, list]) =>
      el(
        'section',
        { class: 'group' },
        el('h2', { class: name === 'Overdue' ? 'overdue' : '' }, `${name} (${list.length})`),
        el('div', { class: 'items' }, list.map((i) => renderCard(i, { showDate: true }))),
      ),
    );
  return sections.length ? el('div', {}, sections) : el('div', { class: 'empty' }, 'Nothing to show. 🎉');
}

// ---------- dialogs ----------

function openDetail(id) {
  const item = state.items.find((i) => i.id === id);
  state.detailId = id;
  const dialog = $('#detailDialog');
  dialog.style.setProperty('--course', courseColor(item.course));
  $('#detailCourse').textContent = item.course;
  $('#detailTitle').textContent = item.title;
  const due = item.due ? new Date(item.due) : null;
  $('#detailMeta').textContent = [
    due ? `Due ${fmtDay(due)}${item.allDay ? '' : ` at ${fmtTime(due)}`}` : 'No due date',
    item.points != null ? `${item.points} pts` : null,
    { canvas: 'Canvas', learningsuite: 'Learning Suite', manual: 'Added manually' }[item.source],
  ]
    .filter(Boolean)
    .join(' · ');
  $('#detailLink').hidden = !item.url;
  $('#detailLink').href = item.url || '#';
  $('#detailDescription').textContent = (item.description || '').trim();
  $('#detailNotes').value = item.notes;
  $('#detailHide').textContent = item.hidden ? 'Unhide' : 'Hide';
  $('#detailDelete').hidden = item.source !== 'manual';
  dialog.showModal();
}

function saveNotes() {
  const item = state.items.find((i) => i.id === state.detailId);
  const notes = $('#detailNotes').value;
  if (item && notes !== item.notes) patchItem(item.id, { notes });
}
$('#detailNotes').addEventListener('change', saveNotes);
$('#detailDialog').addEventListener('close', saveNotes);
$('#detailHide').addEventListener('click', () => {
  const item = state.items.find((i) => i.id === state.detailId);
  patchItem(item.id, { hidden: !item.hidden });
  $('#detailDialog').close();
});
$('#detailDelete').addEventListener('click', async () => {
  if (!confirm('Delete this assignment?')) return;
  const id = state.detailId;
  state.detailId = null;
  $('#detailDialog').close();
  await api(`/api/manual/${encodeURIComponent(id)}`, { method: 'DELETE' });
  load();
});

$('#addBtn').addEventListener('click', () => {
  $('#addForm').reset();
  const options = courseOptions();
  const select = $('#addForm').elements.course;
  select.replaceChildren(
    el('option', { value: '', disabled: true }, 'Choose a course…'),
    ...options.map((o) => el('option', { value: o.original }, o.display)),
    el('option', { value: 'Other' }, 'Other (no course)'),
  );
  // Preselect the course being filtered on, if any.
  select.value = options.find((o) => o.display === state.course)?.original ?? '';
  $('#addDialog').showModal();
});
// Save on submit (fires synchronously on the button click) rather than on the dialog's close event.
$('#addForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = $('#addForm').elements;
  await api('/api/manual', {
    method: 'POST',
    body: {
      title: f.title.value,
      course: f.course.value,
      due: f.due.value ? new Date(f.due.value).toISOString() : null,
      url: f.url.value,
    },
  });
  load();
});

async function openSettings() {
  const config = await api('/api/config');
  const form = $('#settingsForm').elements;
  for (const key of ['canvasBaseUrl', 'canvasFeedUrl', 'learningSuiteFeedUrl', 'semesterStart', 'semesterEnd']) form[key].value = config[key] || '';
  form.canvasToken.value = '';
  form.clearCanvasToken.checked = false;
  $('#tokenStatus').textContent = config.hasCanvasToken ? 'A token is saved. Leave blank to keep it.' : 'No token saved.';

  const originals = [...new Set(state.items.map((i) => i.courseOriginal))].sort();
  $('#courseNames').replaceChildren(
    ...(originals.length
      ? originals.flatMap((original) => [
          el('span', { class: 'original', style: `--course: ${courseColor(config.courseNames[original] || original)}` }, original),
          el('input', { 'data-original': original, value: config.courseNames[original] || '', placeholder: original, 'aria-label': `Display name for ${original}` }),
        ])
      : [el('small', {}, 'Courses appear here after your first sync.')]),
  );
  $('#settingsDialog').showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  const form = $('#settingsForm').elements;
  const body = { clearCanvasToken: form.clearCanvasToken.checked };
  for (const key of ['canvasBaseUrl', 'canvasToken', 'canvasFeedUrl', 'learningSuiteFeedUrl', 'semesterStart', 'semesterEnd']) body[key] = form[key].value;
  body.courseNames = Object.fromEntries([...document.querySelectorAll('#courseNames input')].map((input) => [input.dataset.original, input.value]));
  await api('/api/config', { method: 'PUT', body });
  load(true);
});

// ---------- toolbar ----------

document.querySelectorAll('.segmented button').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = prefs.view = b.dataset.view;
    savePrefs();
    render();
  }),
);
$('#prevWeek').addEventListener('click', () => ((state.weekStart = addDays(state.weekStart, -7)), render()));
$('#nextWeek').addEventListener('click', () => ((state.weekStart = addDays(state.weekStart, 7)), render()));
$('#thisWeek').addEventListener('click', () => ((state.weekStart = startOfWeek(new Date())), render()));
$('#courseFilter').addEventListener('change', (e) => {
  state.course = prefs.course = e.target.value;
  savePrefs();
  render();
});
$('#showDone').addEventListener('change', (e) => {
  state.showDone = prefs.showDone = e.target.checked;
  savePrefs();
  render();
});
$('#showHidden').addEventListener('change', (e) => ((state.showHidden = e.target.checked), render()));
$('#refreshBtn').addEventListener('click', () => load(true));

document.addEventListener('keydown', (e) => {
  if (state.view !== 'week' || document.querySelector('dialog[open]') || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') $('#prevWeek').click();
  if (e.key === 'ArrowRight') $('#nextWeek').click();
});

load();
