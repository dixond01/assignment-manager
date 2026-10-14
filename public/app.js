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
  $('#weekNav').hidden = state.view !== 'week';
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
  ];
  return el(
    'div',
    { class: `card${item.done ? ' done' : ''}${item.hidden ? ' hidden-item' : ''}`, style: `--course: ${courseColorOf(item)}` },
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
  if (state.view !== 'week' || document.querySelector('dialog[open]') || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') $('#prevWeek').click();
  if (e.key === 'ArrowRight') $('#nextWeek').click();
});

loadThemes();
load();
