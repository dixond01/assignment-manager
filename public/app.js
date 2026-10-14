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
  timeLog: [], // time entries: { id, course, courseOriginal, courseColor, date: 'YYYY-MM-DD', minutes, itemId, itemTitle, note }
  minutesByItem: new Map(), // assignment id -> total minutes logged
  semester: null, // { start, end } as 'YYYY-MM-DD'
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
// Local calendar dates as 'YYYY-MM-DD' (time entries store dates this way, not as instants).
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDateKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
// 90 -> "1h 30m", 45 -> "45m", 120 -> "2h"
function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
const fmtHours = (minutes) => (minutes / 60).toFixed(1);

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

// Automatic, stable color per course name, as #rrggbb (hsl(hue, 65%, 50%)).
function autoCourseColor(course) {
  let h = 0;
  for (const ch of course || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const a = 0.65 * 0.5;
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (0.5 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [0, 8, 4].map((n) => channel(n).toString(16).padStart(2, '0')).join('');
}

// The color shown for an item's course: the user's pick, else the automatic one.
const courseColorOf = (item) => item.courseColor || autoCourseColor(item.course);

// A color input wrapped as a field: swatch, optional name and hint, and the current hex value.
function colorField(input, name, hint) {
  ColorPicker.attach(input); // our themed picker instead of the browser's
  const hex = el('span', { class: 'hex' }, input.value);
  input.addEventListener('input', () => (hex.textContent = input.value));
  const text = name && el('span', { class: 'name' }, name, hint && el('span', { class: 'hint' }, hint));
  return el('label', { class: 'color-field' }, input, text, hex);
}

// Call after setting a color input's value in code (which fires no input event).
function syncColorField(input) {
  const hex = input.closest('.color-field')?.querySelector('.hex');
  if (hex) hex.textContent = input.value;
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

// refresh: sync now (the Sync button, saving settings) and report the result in a toast.
async function load(refresh = false) {
  $('#syncBtn').disabled = true;
  $('#syncBtn').textContent = 'Syncing…';
  try {
    const data = await api(`/api/assignments${refresh ? '?refresh=1' : ''}`);
    Object.assign(state, data);
    state.loadError = null;
    indexTime();
  } catch (err) {
    state.loadError = err.message;
  } finally {
    $('#syncBtn').disabled = false;
    $('#syncBtn').textContent = 'Sync';
  }
  render();
  if (refresh) {
    const lines = statusLines();
    showToast(lines.some((l) => l.error) ? 'Sync finished with errors' : 'Synced', lines);
  }
}

let toastTimer = null;
function showToast(title, lines = []) {
  const toast = $('#toast');
  const errors = lines.some((l) => l.error);
  toast.replaceChildren(el('b', {}, title), ...lines.map((l) => el('div', { class: l.error ? 'error' : '' }, l.text)));
  toast.hidden = false;
  toast.classList.remove('leaving');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.classList.add('leaving');
      toastTimer = setTimeout(() => (toast.hidden = true), 300);
    },
    errors ? 8000 : 4000,
  );
}

function visibleItems() {
  return state.items.filter(
    (i) =>
      !i.dismissed &&
      (!state.course || i.course === state.course) &&
      (state.showDone || !i.done) &&
      (state.showHidden || !i.hidden),
  );
}

const isOverdue = (item) => Boolean(item.due) && !item.done && new Date(item.due) < new Date();

async function bulkUpdate(changes) {
  for (const { id, ...rest } of changes) Object.assign(state.items.find((i) => i.id === id), rest);
  render();
  await api('/api/items/bulk', { method: 'POST', body: { changes } });
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
  document.body.classList.toggle('view-time', state.view === 'time');
  $('#showDone').checked = state.showDone;
  $('#showHidden').checked = state.showHidden;
  renderCourseFilter();
  renderStatus();
  renderClearButtons();

  const main = $('#main');
  main.replaceChildren();
  if (!state.configured && !state.items.length) {
    main.append(
      el('div', { class: 'empty' }, 'No sources connected yet. ', el('button', { onclick: openSettings }, 'Open settings'), ' to add your Canvas and Learning Suite feeds.'),
    );
    return;
  }
  main.append({ week: renderWeek, list: renderList, time: renderTime }[state.view]());
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

// One { text, error } line per source, plus a server error if the last load failed.
function statusLines() {
  const labels = { canvas: 'Canvas', learningsuite: 'Learning Suite' };
  const lines = Object.entries(state.sources).map(([name, s]) => {
    if (s.error) return { text: `${labels[name]}: ${s.error}`, error: true };
    const when = s.fetchedAt ? `${fmtShort(new Date(s.fetchedAt))} ${fmtTime(new Date(s.fetchedAt))}` : 'never';
    return { text: `${labels[name]}: ${s.count} items, synced ${when}` };
  });
  if (state.loadError) lines.push({ text: `Could not reach server: ${state.loadError}`, error: true });
  return lines;
}

// The sync status lives in the Sync button's tooltip; only errors are shown on the page.
function renderStatus() {
  const lines = statusLines();
  $('#syncBtn').title = lines.length ? lines.map((l) => l.text).join('\n') : 'No sources connected yet';
  const errors = lines.filter((l) => l.error);
  $('#status').hidden = !errors.length;
  $('#status').replaceChildren(...errors.flatMap((l, i) => [i ? ' · ' : '', el('span', { class: 'error' }, l.text)]));
}

function renderClearButtons() {
  const overdue = visibleItems().filter(isOverdue).length;
  const cleared = state.items.filter((i) => i.dismissed).length;
  $('#clearOverdueBtn').hidden = !overdue;
  $('#clearOverdueBtn').textContent = `Clear overdue (${overdue})`;
  $('#clearedBtn').hidden = !cleared;
  $('#clearedBtn').textContent = `Cleared (${cleared})`;
  if ($('#clearedDialog').open) renderClearedList();
}

function renderClearedList() {
  const cleared = state.items.filter((i) => i.dismissed).sort((a, b) => byDue(b, a));
  $('#clearedList').replaceChildren(
    ...(cleared.length
      ? cleared.map((item) =>
          el(
            'div',
            { class: 'cleared-row', style: `--course: ${courseColorOf(item)}` },
            el(
              'div',
              { class: 'body' },
              el('div', { class: 'title' }, item.title),
              el('div', { class: 'meta' }, `${item.course} · due ${fmtDay(new Date(item.due))}${item.allDay ? '' : ` ${fmtTime(new Date(item.due))}`}`),
            ),
            el('button', { type: 'button', onclick: () => bulkUpdate([{ id: item.id, dismissed: false }]) }, 'Restore'),
          ),
        )
      : [el('small', {}, 'Nothing cleared.')]),
  );
  $('#restoreAllBtn').hidden = !cleared.length;
}

function renderCard(item, { showDate = false } = {}) {
  const due = item.due ? new Date(item.due) : null;
  const overdue = isOverdue(item);
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
    state.minutesByItem.get(item.id) && el('span', { class: 'time-chip', title: 'Time logged' }, `⏱ ${fmtDuration(state.minutesByItem.get(item.id))}`),
  ];
  return el(
    'div',
    { class: `card${item.done ? ' done' : ''}${item.hidden ? ' hidden-item' : ''}`, style: `--course: ${courseColorOf(item)}` },
    el('input', { type: 'checkbox', checked: item.done, title: 'Mark done', onchange: (e) => patchItem(item.id, { done: e.target.checked }) }),
    el('div', { class: 'body' }, el('button', { type: 'button', class: 'title', onclick: () => openDetail(item.id) }, item.title), el('div', { class: 'meta' }, meta)),
    // Shown on hover/focus only, so checking an item off never asks about time.
    el('button', { type: 'button', class: 'log-btn', title: 'Log time', 'aria-label': `Log time for ${item.title}`, onclick: (e) => openLogPopover(item, e.currentTarget) }, '⏱'),
  );
}

// weeks: how many weeks to move, or 0 for the current week.
function shiftWeek(weeks) {
  state.weekStart = weeks ? addDays(state.weekStart, 7 * weeks) : startOfWeek(new Date());
  render();
}

// Centered week switcher above the Week grid and the Time view: ‹ date range › and Today.
function renderPager() {
  const weeksFrom = (from) => Math.round((state.weekStart - from) / (7 * 864e5)); // round: DST makes some weeks an hour short
  const offset = weeksFrom(startOfWeek(new Date()));
  const relative =
    offset === 0 ? 'this week' : offset === -1 ? 'last week' : offset === 1 ? 'next week' : offset < 0 ? `${-offset} weeks ago` : `in ${offset} weeks`;
  const { first, total } = semesterWeeks();
  const n = first ? weeksFrom(first) + 1 : 0;
  return el(
    'div',
    { class: 'pager' },
    el('button', { type: 'button', class: 'arrow', title: 'Previous week (←)', 'aria-label': 'Previous week', onclick: () => shiftWeek(-1) }, '‹'),
    el('div', { class: 'range' }, `${fmtShort(state.weekStart)} – ${fmtShort(addDays(state.weekStart, 6))}`, el('small', {}, n >= 1 && n <= total ? `Week ${n} of ${total} · ${relative}` : relative)),
    el('button', { type: 'button', class: 'arrow', title: 'Next week (→)', 'aria-label': 'Next week', onclick: () => shiftWeek(1) }, '›'),
    el('button', { type: 'button', class: 'today', disabled: offset === 0, onclick: () => shiftWeek(0) }, 'Today'),
  );
}

function renderWeek() {
  const start = state.weekStart;
  const end = addDays(start, 7);
  const items = visibleItems().filter((i) => i.due && new Date(i.due) >= start && new Date(i.due) < end).sort(byDue);
  const today = new Date();
  const sunday = addDays(start, 6);
  // Hide Sunday when it has nothing to show (and isn't today) so the other days get more room.
  const showSunday = sameDay(sunday, today) || items.some((i) => sameDay(new Date(i.due), sunday));

  const days = Array.from({ length: showSunday ? 7 : 6 }, (_, n) => {
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
  return el('div', {}, renderPager(), el('div', { class: `week${showSunday ? '' : ' no-sunday'}` }, days));
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
  dialog.style.setProperty('--course', courseColorOf(item));
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
  renderDetailTime();
  dialog.showModal();
}

function renderDetailTime() {
  const item = state.items.find((i) => i.id === state.detailId);
  if (!item) return;
  const entries = state.timeLog.filter((t) => t.itemId === item.id).sort((a, b) => a.date.localeCompare(b.date));
  const total = entries.reduce((sum, t) => sum + t.minutes, 0);
  $('#detailTimeTotal').textContent = total ? fmtDuration(total) : 'None yet';
  $('#detailTimeTotal').classList.toggle('none', !total);
  $('#detailTimeEntries').replaceChildren(
    ...entries.map((t) =>
      el('div', { class: 'time-section-entry' }, el('span', {}, fmtDay(parseDateKey(t.date))), t.note && el('span', { class: 'note' }, t.note), el('span', { class: 'dur' }, fmtDuration(t.minutes))),
    ),
  );
}
$('#detailLogTime').addEventListener('click', (e) => openLogPopover(state.items.find((i) => i.id === state.detailId), e.currentTarget));

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
  $('#addForm').elements.dueDate.setCustomValidity('');
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
// Save on submit (fires synchronously on the button click or Enter) rather than on the dialog's close event.
$('#addForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = $('#addForm').elements;
  const date = f.dueDate.value;
  const time = f.dueTime.value;
  if (time && !date) {
    e.preventDefault(); // keep the dialog open
    f.dueDate.setCustomValidity('Pick a date for this time, or clear the time.');
    f.dueDate.reportValidity();
    return;
  }
  // A date with no time is an all-day item, due at the end of that day (like all-day feed items).
  const due = date ? new Date(`${date}T${time || '23:59'}`).toISOString() : null;
  await api('/api/manual', {
    method: 'POST',
    body: { title: f.title.value, course: f.course.value, due, allDay: Boolean(date && !time), url: f.url.value },
  });
  load();
});
$('#addForm').elements.dueDate.addEventListener('input', (e) => e.target.setCustomValidity(''));
$('#addForm').elements.dueTime.addEventListener('input', () => $('#addForm').elements.dueDate.setCustomValidity(''));

// Cancel buttons are type="button" (so Enter can't trigger them); they just close their dialog.
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

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
      ? originals.flatMap((original) => courseRow(original, config))
      : [el('small', {}, 'Courses appear here after your first sync.')]),
  );
  $('#settingsDialog').showModal();
}

// One grid row per course: original name, display-name box, color picker, reset-to-automatic.
function courseRow(original, config) {
  const custom = config.courseColors[original];
  const autoColor = () => autoCourseColor(nameInput.value.trim() || original);
  const label = el('span', { class: 'original' }, original);
  const nameInput = el('input', {
    class: 'course-name',
    'data-original': original,
    value: config.courseNames[original] || '',
    placeholder: original,
    'aria-label': `Display name for ${original}`,
  });
  const colorInput = el('input', {
    type: 'color',
    class: 'course-color',
    'data-original': original,
    title: 'Course color',
    'aria-label': `Color for ${original}`,
  });
  const reset = el('button', { type: 'button', class: 'reset-color', title: 'Use the automatic color' }, 'Reset');
  const update = (isCustom, color) => {
    colorInput.dataset.custom = isCustom ? '1' : '';
    colorInput.value = color;
    syncColorField(colorInput);
    label.style.setProperty('--course', color);
    reset.style.visibility = isCustom ? 'visible' : 'hidden';
  };
  colorInput.addEventListener('input', () => update(true, colorInput.value));
  // Cancelling the picker restores the color; also restore whether it was custom or automatic.
  let customBeforePicker = '';
  colorInput.addEventListener('colorpicker:open', () => (customBeforePicker = colorInput.dataset.custom));
  colorInput.addEventListener('colorpicker:cancel', () => update(Boolean(customBeforePicker), colorInput.value));
  reset.addEventListener('click', () => update(false, autoColor()));
  // Automatic colors follow the display name, so keep the preview in sync while renaming.
  nameInput.addEventListener('input', () => colorInput.dataset.custom || update(false, autoColor()));
  const field = colorField(colorInput);
  update(Boolean(custom), custom || autoColor());
  return [label, nameInput, field, reset];
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  const form = $('#settingsForm').elements;
  const body = { clearCanvasToken: form.clearCanvasToken.checked };
  for (const key of ['canvasBaseUrl', 'canvasToken', 'canvasFeedUrl', 'learningSuiteFeedUrl', 'semesterStart', 'semesterEnd']) body[key] = form[key].value;
  body.courseNames = Object.fromEntries([...document.querySelectorAll('#courseNames .course-name')].map((input) => [input.dataset.original, input.value]));
  // Only colors the user picked are saved; '' tells the server to go back to automatic.
  body.courseColors = Object.fromEntries(
    [...document.querySelectorAll('#courseNames .course-color')].map((input) => [input.dataset.original, input.dataset.custom ? input.value : '']),
  );
  await api('/api/config', { method: 'PUT', body });
  load(true);
});

// ---------- themes ----------

const themeState = { themes: ThemeCore.BUILTIN_THEMES, activeThemeId: ThemeCore.DEFAULT_THEME_ID, editing: null };
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

const activeTheme = () => themeState.themes.find((t) => t.id === themeState.activeThemeId) || ThemeCore.BUILTIN_THEMES[0];

// Inline variables override the stylesheet. System clears them so the stylesheet's light/dark rules apply.
function applyColors(colors) {
  const style = document.documentElement.style;
  for (const name of ThemeCore.VAR_NAMES) style.removeProperty(name);
  const vars = colors ? ThemeCore.themeVars(colors) : null;
  if (vars) for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
  return vars;
}

function iconCanvas(colors, size) {
  const canvas = el('canvas', { width: size, height: size });
  canvas.getContext('2d').putImageData(new ImageData(IconCore.renderIcon(size, colors), size, size), 0, 0);
  return canvas;
}

// Draw the tab icon in the given colors; returns it as a data URL.
function setFavicon(colors) {
  const url = iconCanvas(colors, 64).toDataURL('image/png');
  $('link[rel="icon"]').href = url;
  return url;
}

function applyActiveTheme() {
  const theme = activeTheme();
  const vars = applyColors(theme.colors);
  const favicon = setFavicon(ThemeCore.resolveColors(theme, prefersDark.matches));
  try {
    if (vars) localStorage.setItem('themeVars', JSON.stringify(vars));
    else localStorage.removeItem('themeVars');
    localStorage.setItem('themeFavicon', favicon);
  } catch {}
}

async function loadThemes() {
  try {
    Object.assign(themeState, await api('/api/themes'));
  } catch {
    // Keep whatever the page already shows.
  }
  applyActiveTheme();
}

async function switchTheme(id) {
  themeState.activeThemeId = id;
  applyActiveTheme();
  renderThemeList();
  Object.assign(themeState, await api('/api/active-theme', { method: 'PUT', body: { id } }));
}

function renderThemeList() {
  $('#themeList').replaceChildren(
    ...themeState.themes.map((theme) => {
      const colors = ThemeCore.resolveColors(theme, prefersDark.matches);
      const active = theme.id === themeState.activeThemeId;
      const choose = () => active || switchTheme(theme.id);
      const action = (label, fn, props = {}) =>
        el('button', { type: 'button', ...props, onclick: (e) => (e.stopPropagation(), fn()) }, label);
      return el(
        'div',
        {
          class: `theme-row${active ? ' active' : ''}`,
          role: 'button',
          tabindex: 0,
          'aria-pressed': String(active),
          onclick: choose,
          onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose()),
        },
        iconCanvas(colors, 56),
        el('span', { class: 'swatches' }, ThemeCore.COLOR_KEYS.map((key) => el('span', { style: `background: ${colors[key]}`, title: ThemeCore.COLOR_LABELS[key] }))),
        el(
          'div',
          { class: 'name' },
          theme.name,
          el('small', {}, theme.id === 'system' ? 'Built in · follows Windows light/dark' : theme.builtIn ? 'Built in' : 'Your theme'),
        ),
        active && el('span', { class: 'badge active-badge' }, 'Active'),
        action('Duplicate', () => openThemeEditor({ name: `${theme.name} copy`, colors: { ...colors } })),
        !theme.builtIn && action('Edit', () => openThemeEditor(theme)),
        !theme.builtIn &&
          action('Delete', () => deleteTheme(theme), {
            class: 'danger',
            disabled: active,
            title: active ? 'Switch to another theme before deleting this one' : 'Delete this theme',
          }),
      );
    }),
  );
}

function showThemeError(message) {
  $('#themeError').textContent = message;
  $('#themeError').hidden = !message;
}

// theme: an existing user theme (has an id) or a draft { name, colors } for a new one.
function openThemeEditor(theme) {
  themeState.editing = { id: theme.id || null, colors: { ...theme.colors } };
  const form = $('#themesForm').elements;
  form.themeName.value = theme.name;
  $('#themeColors').replaceChildren(
    ...ThemeCore.COLOR_KEYS.map((key) =>
      colorField(
        el('input', {
          type: 'color',
          value: theme.colors[key],
          oninput: (e) => {
            themeState.editing.colors[key] = e.target.value;
            previewEditedTheme();
          },
        }),
        ThemeCore.COLOR_LABELS[key],
        ThemeCore.COLOR_HINTS[key],
      ),
    ),
  );
  $('#themesTitle').textContent = theme.id ? 'Edit theme' : 'New theme';
  showThemeError('');
  $('#themeListView').hidden = true;
  $('#themeEditor').hidden = false;
  previewEditedTheme();
  form.themeName.focus();
}

function previewEditedTheme() {
  const { colors } = themeState.editing;
  applyColors(colors);
  setFavicon(colors);
  const warnings = ThemeCore.contrastWarnings(colors);
  $('#themeWarnings').textContent = warnings.join(' ');
  $('#themeWarnings').hidden = !warnings.length;
}

function closeThemeEditor() {
  themeState.editing = null;
  applyActiveTheme();
  $('#themesTitle').textContent = 'Themes';
  $('#themeEditor').hidden = true;
  $('#themeListView').hidden = false;
  renderThemeList();
}

async function saveEditedTheme() {
  const { id, colors } = themeState.editing;
  const body = { name: $('#themesForm').elements.themeName.value, colors };
  const error = ThemeCore.validateTheme(body);
  if (error) return showThemeError(error);
  try {
    const saved = await api(id ? `/api/themes/${encodeURIComponent(id)}` : '/api/themes', { method: id ? 'PUT' : 'POST', body });
    Object.assign(themeState, await api('/api/themes'));
    if (!id) await switchTheme(saved.id); // a new theme becomes the active one
    closeThemeEditor();
  } catch (err) {
    showThemeError(err.message);
  }
}

async function deleteTheme(theme) {
  if (theme.id === themeState.activeThemeId || !confirm(`Delete the theme "${theme.name}"?`)) return;
  try {
    await api(`/api/themes/${encodeURIComponent(theme.id)}`, { method: 'DELETE' });
  } catch (err) {
    alert(err.message);
  }
  Object.assign(themeState, await api('/api/themes'));
  renderThemeList();
}

$('#themesBtn').addEventListener('click', () => {
  renderThemeList();
  $('#themesDialog').showModal();
});
$('#newThemeBtn').addEventListener('click', () => openThemeEditor({ name: 'My theme', colors: { ...ThemeCore.resolveColors(activeTheme(), prefersDark.matches) } }));
$('#themeCancelBtn').addEventListener('click', closeThemeEditor);
$('#themeSaveBtn').addEventListener('click', saveEditedTheme);
// Enter in the name field submits the form; save instead of closing the dialog.
$('#themesForm').addEventListener('submit', (e) => {
  if ($('#themeEditor').hidden) return;
  e.preventDefault();
  saveEditedTheme();
});
// Escape while editing discards the live preview.
$('#themesDialog').addEventListener('cancel', () => themeState.editing && closeThemeEditor());
$('#themesDialog').addEventListener('close', () => themeState.editing && closeThemeEditor());
prefersDark.addEventListener('change', () => {
  if (themeState.editing) return;
  applyActiveTheme(); // System's tab icon follows Windows light/dark
  if ($('#themesDialog').open) renderThemeList();
});

// ---------- time tracking ----------

function indexTime() {
  state.minutesByItem = new Map();
  for (const t of state.timeLog) if (t.itemId) state.minutesByItem.set(t.itemId, (state.minutesByItem.get(t.itemId) || 0) + t.minutes);
}

// Display name and color for an original course name, as the server would give them.
function courseDisplay(original) {
  const item = state.items.find((i) => i.courseOriginal === original) || state.timeLog.find((t) => t.courseOriginal === original);
  return item ? { course: item.course, courseColor: item.courseColor } : { course: original, courseColor: null };
}

// Merge a saved entry from the server into state and redraw whatever shows time.
function storeTimeEntry(saved) {
  const entry = { ...saved, courseOriginal: saved.course, ...courseDisplay(saved.course) };
  const index = state.timeLog.findIndex((t) => t.id === entry.id);
  if (index >= 0) state.timeLog[index] = entry;
  else state.timeLog.push(entry);
  timeChanged();
}

function timeChanged() {
  indexTime();
  render();
  if ($('#detailDialog').open) renderDetailTime();
}

const QUICK_ADD = [
  ['+15m', 15],
  ['+30m', 30],
  ['+1h', 60],
  ['+2h', 120],
];

// Buttons that add to an hours + minutes pair of inputs.
function quickAddChips(hoursInput, minutesInput) {
  return QUICK_ADD.map(([label, add]) =>
    el(
      'button',
      {
        type: 'button',
        onclick: () => {
          const total = (Number(hoursInput.value) || 0) * 60 + (Number(minutesInput.value) || 0) + add;
          hoursInput.value = Math.floor(total / 60);
          minutesInput.value = total % 60;
          minutesInput.setCustomValidity('');
        },
      },
      label,
    ),
  );
}

const enteredMinutes = (hoursInput, minutesInput) => Math.round((Number(hoursInput.value) || 0) * 60 + (Number(minutesInput.value) || 0));

// The quick "Log time" popover for one assignment (from a card's ⏱ button or the details dialog).
function openLogPopover(item, anchor) {
  document.querySelector('.log-popover')?.remove();
  const hours = el('input', { type: 'number', min: 0, max: 24, step: 1, inputMode: 'numeric', 'aria-label': 'Hours' });
  const minutes = el('input', { type: 'number', min: 0, max: 59, step: 1, inputMode: 'numeric', 'aria-label': 'Minutes' });
  const date = el('input', { type: 'date', value: dateKey(new Date()), required: true, 'aria-label': 'Date' });
  const error = el('small', { class: 'warning', hidden: true });
  // Optional: check the assignment off in the same step.
  const markDone = el('input', { type: 'checkbox' });
  const logged = state.minutesByItem.get(item.id);

  const close = () => pop.matches(':popover-open') && pop.hidePopover();
  const pop = el(
    'form',
    {
      class: 'log-popover',
      popover: 'auto',
      onsubmit: async (e) => {
        e.preventDefault();
        const total = enteredMinutes(hours, minutes);
        if (total < 1) {
          error.textContent = 'Enter some time first.';
          error.hidden = false;
          return hours.focus();
        }
        try {
          storeTimeEntry(
            await api('/api/time', {
              method: 'POST',
              body: { course: item.courseOriginal, date: date.value, minutes: total, itemId: item.id, itemTitle: item.title },
            }),
          );
          if (markDone.checked) patchItem(item.id, { done: true });
          close();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      },
      onkeydown: (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation(); // don't also close the details dialog underneath
        close();
      },
      ontoggle: (e) => {
        if (e.newState !== 'closed') return;
        pop.remove();
        if (anchor.isConnected) anchor.focus({ preventScroll: true });
      },
    },
    el('div', { class: 'pop-title' }, 'Log time'),
    el('div', { class: 'pop-sub' }, `${item.title} · ${item.course}`),
    el('div', { class: 'chips' }, quickAddChips(hours, minutes)),
    el('div', { class: 'duration' }, el('label', { class: 'unit' }, hours, 'h'), el('label', { class: 'unit' }, minutes, 'm'), date),
    !item.done && el('label', { class: 'check' }, markDone, 'Mark as done'),
    error,
    el(
      'div',
      { class: 'pop-actions' },
      el('small', {}, logged ? `Logged so far: ${fmtDuration(logged)}` : ''),
      el('div', { class: 'spacer' }),
      el('button', { type: 'button', onclick: close }, 'Cancel'),
      el('button', { class: 'primary' }, 'Log'),
    ),
  );

  // Inside an open modal dialog, everything outside it is inert, so host the popover there.
  (anchor.closest('dialog') || document.body).append(pop);
  pop.showPopover();
  // Below the card (or button), or above it when there's no room; kept on screen.
  const r = (anchor.closest('.card') || anchor).getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = pop;
  const top = r.bottom + 6 + h <= innerHeight ? r.bottom + 6 : Math.max(8, r.top - 6 - h);
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  pop.style.top = `${top}px`;
  hours.focus();
}

// ----- Time view -----

// The semester's Monday-start weeks up to the current one. Only finished weeks count toward averages.
function semesterWeeks() {
  const { start, end } = state.semester || {};
  if (!start || !end) return { weeks: [], total: 0 };
  const first = startOfWeek(parseDateKey(start));
  const last = startOfWeek(parseDateKey(end));
  const current = startOfWeek(new Date());
  const total = Math.round((last - first) / (7 * 864e5)) + 1; // round: DST makes some weeks an hour short
  const weeks = [];
  for (let w = first, n = 1; w <= last && w <= current; w = addDays(w, 7), n++) {
    weeks.push({ start: w, key: dateKey(w), n, complete: w < current });
  }
  return { weeks, total, first, end: parseDateKey(end) };
}

// Courses to show: every course with assignments (except "Other") or logged time, by display name.
function timeCourses() {
  const byName = new Map();
  for (const item of state.items) if (item.course !== 'Other' && !byName.has(item.course)) byName.set(item.course, courseColorOf(item));
  for (const t of state.timeLog) if (!byName.has(t.course)) byName.set(t.course, courseColorOf(t));
  return [...byName]
    .filter(([course]) => !state.course || course === state.course)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([course, color]) => ({ course, color }));
}

// Minutes per week (Monday's date key) per course display name.
function timeTable() {
  const { weeks, total, first, end } = semesterWeeks();
  const courses = timeCourses();
  const minutes = new Map(weeks.map((w) => [w.key, new Map()]));
  for (const t of state.timeLog) {
    const row = minutes.get(dateKey(startOfWeek(parseDateKey(t.date))));
    if (row) row.set(t.course, (row.get(t.course) || 0) + t.minutes);
  }
  const get = (week, course) => minutes.get(week.key).get(course) || 0;
  const complete = weeks.filter((w) => w.complete);
  const stats = new Map(
    courses.map(({ course }) => {
      const completeMinutes = complete.reduce((sum, w) => sum + get(w, course), 0);
      return [
        course,
        {
          average: complete.length ? completeMinutes / complete.length : null,
          completeMinutes,
          total: weeks.reduce((sum, w) => sum + get(w, course), 0),
          thisWeek: weeks.find((w) => !w.complete) ? get(weeks.at(-1), course) : 0,
        },
      ];
    }),
  );
  return { weeks, complete, total, first, end, courses, get, stats };
}

function renderTime() {
  const table = timeTable();
  const { weeks, complete, courses, get, stats } = table;
  const current = weeks.find((w) => !w.complete);
  const selectedKey = dateKey(state.weekStart);

  let heading;
  if (!table.total) heading = 'Set your semester dates in Settings';
  else if (!weeks.length) heading = `Semester starts ${fmtShort(table.first)}`;
  else if (!current) heading = `Semester ended · ${weeks.length} weeks`;
  else heading = `Semester · ${fmtShort(table.first)} – ${fmtShort(table.end)}`;

  const head = el(
    'div',
    { class: 'time-head' },
    el('h2', {}, heading),
    el('div', { class: 'spacer' }),
    el('button', { type: 'button', onclick: (e) => copyReport(e.currentTarget, table), disabled: !complete.length, title: complete.length ? '' : 'Available after the first full week' }, 'Copy report'),
    el('button', { type: 'button', class: 'primary', onclick: () => openTimeDialog() }, '+ Log time'),
  );

  if (!courses.length) return el('div', { class: 'time-view' }, renderPager(), head, el('div', { class: 'empty' }, 'No courses yet. They appear here after your first sync.'));

  const tiles = el(
    'div',
    { class: 'tiles' },
    courses.map(({ course, color }) => {
      const s = stats.get(course);
      return el(
        'div',
        { class: 'tile', style: `--course: ${color}` },
        el('div', { class: 'course' }, course),
        el('div', { class: 'avg' }, s.average == null ? '—' : fmtHours(s.average), el('small', {}, ' h / week avg')),
        el('div', { class: 'sub' }, el('span', {}, 'This week ', el('b', {}, `${fmtHours(s.thisWeek)} h`)), el('span', {}, 'Total ', el('b', {}, `${fmtHours(s.total)} h`))),
      );
    }),
  );

  const max = Math.max(1, ...weeks.flatMap((w) => courses.map(({ course }) => get(w, course))));
  const headRow = el(
    'tr',
    {},
    el('th', {}, 'Week'),
    courses.map(({ course, color }) => el('th', { style: `--course: ${color}` }, el('span', { class: 'dot' }), course)),
    el('th', { class: 'total' }, 'Total'),
  );
  const rows = weeks.map((w) => {
    const sum = courses.reduce((acc, { course }) => acc + get(w, course), 0);
    return el(
      'tr',
      {
        class: [w.complete ? '' : 'current', w.key === selectedKey ? 'selected' : ''].join(' ').trim(),
        title: 'Show this week’s entries',
        onclick: () => {
          state.weekStart = w.start;
          render();
        },
      },
      el('td', {}, `Week ${w.n}`, el('span', { class: 'wk' }, fmtShort(w.start) + (w.complete ? '' : ' · in progress'))),
      courses.map(({ course, color }) => {
        const v = get(w, course);
        return el(
          'td',
          { class: `cell${v ? '' : ' zero'}`, style: `--course: ${color}; --a: ${((v / max) * 0.3).toFixed(3)}` },
          el('span', { class: 'bar' }),
          el('span', { class: 'v' }, v ? fmtHours(v) : '—'),
        );
      }),
      el('td', { class: 'total' }, fmtHours(sum)),
    );
  });
  const allAverage = complete.length ? courses.reduce((acc, { course }) => acc + stats.get(course).average, 0) : null;
  const foot = el(
    'tr',
    {},
    el(
      'td',
      {},
      'Average / week',
      el('small', {}, complete.length ? `${complete.length} full week${complete.length === 1 ? '' : 's'} · weeks with no time count as 0` : 'Starts after the first full week'),
    ),
    courses.map(({ course }) => el('td', {}, complete.length ? fmtHours(stats.get(course).average) : '—')),
    el('td', { class: 'total' }, allAverage == null ? '—' : fmtHours(allAverage)),
  );
  const weekTable = weeks.length
    ? el('div', { class: 'table-wrap' }, el('table', { class: 'weeks' }, el('thead', {}, headRow), el('tbody', {}, rows), el('tfoot', {}, foot)))
    : el('div', { class: 'empty' }, 'Weeks appear here once the semester starts.');

  return el(
    'div',
    { class: 'time-view' },
    renderPager(),
    head,
    tiles,
    el('div', { class: 'time-head' }, el('h2', {}, 'Week by week (hours)')),
    weekTable,
    el('div', { class: 'time-head' }, el('h2', {}, `Entries · ${fmtShort(state.weekStart)} – ${fmtShort(addDays(state.weekStart, 6))}`)),
    renderTimeEntries(),
  );
}

function renderTimeEntries() {
  const start = dateKey(state.weekStart);
  const end = dateKey(addDays(state.weekStart, 7));
  const entries = state.timeLog
    .filter((t) => t.date >= start && t.date < end && (!state.course || t.course === state.course))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!entries.length) return el('div', { class: 'empty small' }, 'No time logged this week.');
  return el(
    'div',
    { class: 'entries' },
    entries.map((t) => {
      const item = t.itemId && state.items.find((i) => i.id === t.itemId);
      const title = item?.title || t.itemTitle || 'Study time';
      return el(
        'div',
        { class: 'entry', style: `--course: ${courseColorOf(t)}` },
        el('span', { class: 'when' }, fmtDay(parseDateKey(t.date))),
        el('div', { class: 'what' }, el('div', { class: 't' }, title), el('div', { class: 'm' }, [t.course, t.note].filter(Boolean).join(' · '))),
        el('span', { class: 'dur' }, fmtDuration(t.minutes)),
        el('button', { type: 'button', onclick: () => openTimeDialog(t) }, 'Edit'),
        el('button', { type: 'button', class: 'danger', onclick: () => deleteTimeEntry(t) }, 'Delete'),
      );
    }),
  );
}

async function deleteTimeEntry(entry) {
  if (!confirm(`Delete ${fmtDuration(entry.minutes)} logged for ${entry.course} on ${fmtDay(parseDateKey(entry.date))}?`)) return;
  await api(`/api/time/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
  state.timeLog = state.timeLog.filter((t) => t.id !== entry.id);
  timeChanged();
}

async function copyReport(button, { complete, courses, stats }) {
  const range = `${fmtShort(complete[0].start)} – ${fmtShort(addDays(complete.at(-1).start, 6))}`;
  const lines = [
    `Average weekly time, ${range} (${complete.length} full week${complete.length === 1 ? '' : 's'})`,
    ...courses.map(({ course }) => {
      const s = stats.get(course);
      return `${course}: ${fmtHours(s.average)} h/week (${fmtHours(s.completeMinutes)} h total)`;
    }),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    button.textContent = 'Copied ✓';
  } catch {
    button.textContent = 'Could not copy';
  }
  setTimeout(() => (button.textContent = 'Copy report'), 1500);
}

// ----- Log time dialog: study time, or editing any entry -----

const timeDialog = { editing: null };

function openTimeDialog(entry = null) {
  timeDialog.editing = entry;
  const form = $('#timeForm');
  const f = form.elements;
  form.reset();
  $('#timeError').hidden = true;
  $('#timeDialogTitle').textContent = entry ? 'Edit time' : 'Log time';
  $('#timeSaveBtn').textContent = entry ? 'Save' : 'Log time';

  // One option per original course name, labelled by display name (time follows renames).
  const courses = new Map();
  for (const i of [...state.items, ...state.timeLog]) if (!courses.has(i.courseOriginal)) courses.set(i.courseOriginal, i.course);
  courses.delete('Other');
  f.course.replaceChildren(
    el('option', { value: '', disabled: true }, 'Choose a course…'),
    ...[...courses].sort(([, a], [, b]) => a.localeCompare(b)).map(([original, display]) => el('option', { value: original }, display)),
    el('option', { value: 'Other' }, 'Other (no course)'),
  );
  f.course.value = entry ? entry.courseOriginal : ([...courses].find(([, display]) => display === state.course)?.[0] ?? '');
  f.date.value = entry ? entry.date : dateKey(new Date());
  f.hours.value = entry ? Math.floor(entry.minutes / 60) : '';
  f.minutes.value = entry ? entry.minutes % 60 : '';
  f.note.value = entry?.note || '';
  fillAssignmentOptions(entry?.itemId || '');
  $('#timeDialog').showModal();
  (entry ? f.hours : f.course.value ? f.hours : f.course).focus();
}

// Assignments in the chosen course (any course merged under the same display name).
function fillAssignmentOptions(selected) {
  const f = $('#timeForm').elements;
  const display = courseDisplay(f.course.value).course;
  const items = state.items.filter((i) => i.course === display && i.kind !== 'event').sort(byDue);
  const options = items.map((i) => el('option', { value: i.id }, i.due ? `${i.title} (due ${fmtShort(new Date(i.due))})` : i.title));
  // Keep an entry's assignment selectable even if it has dropped out of its feed.
  const entry = timeDialog.editing;
  if (selected && !items.some((i) => i.id === selected) && entry?.itemId === selected) options.unshift(el('option', { value: selected }, entry.itemTitle || 'Removed assignment'));
  f.itemId.replaceChildren(el('option', { value: '' }, 'None — general study'), ...options);
  f.itemId.value = selected;
}

$('#timeChips').append(...quickAddChips($('#timeForm').elements.hours, $('#timeForm').elements.minutes));
$('#timeForm').elements.course.addEventListener('change', () => fillAssignmentOptions(''));
$('#timeForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault(); // close only once it's saved
  const f = $('#timeForm').elements;
  const minutes = enteredMinutes(f.hours, f.minutes);
  const showError = (message) => {
    $('#timeError').textContent = message;
    $('#timeError').hidden = false;
  };
  if (minutes < 1) return showError('Enter some time first.');
  const item = state.items.find((i) => i.id === f.itemId.value);
  const entry = timeDialog.editing;
  const body = {
    course: f.course.value,
    date: f.date.value,
    minutes,
    itemId: f.itemId.value,
    itemTitle: item?.title || (f.itemId.value && entry?.itemTitle) || '',
    note: f.note.value,
  };
  try {
    storeTimeEntry(await api(entry ? `/api/time/${encodeURIComponent(entry.id)}` : '/api/time', { method: entry ? 'PUT' : 'POST', body }));
    $('#timeDialog').close();
  } catch (err) {
    showError(err.message);
  }
});

// ---------- toolbar ----------

document.querySelectorAll('.segmented button').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = prefs.view = b.dataset.view;
    savePrefs();
    render();
  }),
);
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
$('#syncBtn').addEventListener('click', () => load(true));

$('#clearOverdueBtn').addEventListener('click', () => {
  const overdue = visibleItems().filter(isOverdue);
  const scope = state.course ? ` in ${state.course}` : '';
  if (!overdue.length || !confirm(`Remove ${overdue.length} overdue assignment${overdue.length === 1 ? '' : 's'}${scope} from your list? You can restore them from "Cleared".`)) return;
  bulkUpdate(overdue.map((i) => ({ id: i.id, dismissed: true, dismissedDue: i.due })));
});
$('#clearedBtn').addEventListener('click', () => {
  renderClearedList();
  $('#clearedDialog').showModal();
});
$('#restoreAllBtn').addEventListener('click', () => {
  bulkUpdate(state.items.filter((i) => i.dismissed).map((i) => ({ id: i.id, dismissed: false })));
});

document.addEventListener('keydown', (e) => {
  if (state.view === 'list' || document.querySelector('dialog[open], :popover-open') || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') shiftWeek(-1);
  if (e.key === 'ArrowRight') shiftWeek(1);
});

// ---------- app lifetime and single tab ----------

// This connection tells the server a tab is open; it shuts down a minute after the last one closes.
// EventSource reconnects on its own, so the banner clears when the app is started again.
function connectToServer() {
  const events = new EventSource('/api/events');
  let failures = 0;
  events.addEventListener('open', () => {
    failures = 0;
    $('#stoppedBanner').hidden = true;
  });
  events.addEventListener('error', () => {
    if (++failures >= 2) $('#stoppedBanner').hidden = false;
  });
}

// Opening the app again makes the newest tab the active one. Older tabs close themselves when the
// browser allows it (a tab opened from the shortcut usually can); otherwise they show a notice.
const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('assignment-manager') : null;

function claimThisTab() {
  $('#otherTabNotice').hidden = true;
  tabChannel?.postMessage('opened');
}

tabChannel?.addEventListener('message', (e) => {
  if (e.data !== 'opened') return;
  window.close();
  // Still here: the browser didn't allow closing, so pause this tab instead.
  setTimeout(() => {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('#otherTabNotice').hidden = false;
  }, 300);
});

$('#useHereBtn').addEventListener('click', () => {
  claimThisTab();
  loadThemes();
  load();
});

claimThisTab();
connectToServer();
loadThemes();
load();
