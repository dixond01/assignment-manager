// Assignment Manager — local server. Zero dependencies; requires Node 18+.
// Pulls assignments from a Canvas API token / Canvas iCal feed and a Learning Suite iCal feed,
// merges them with manual items, and stores your checkmarks/notes in ./data.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ThemeCore = require('./public/theme-core.js');

const PORT = Number(process.env.PORT) || 3456;
const HOST = '127.0.0.1'; // local only — config.json holds your Canvas token
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');
const STALE_MS = 60 * 60 * 1000; // auto-refresh sources older than an hour

const DEFAULT_CONFIG = {
  canvasBaseUrl: 'https://byu.instructure.com',
  canvasToken: '',
  canvasFeedUrl: '',
  learningSuiteFeedUrl: '',
  semesterStart: '2026-08-31',
  semesterEnd: '2026-12-19',
  courseNames: {}, // original course name -> display name
  courseColors: {}, // original course name -> #rrggbb
  themes: [], // user-created themes: { id, name, colors }
  activeThemeId: ThemeCore.DEFAULT_THEME_ID,
};

// ---------- storage ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const loadConfig = () => ({ ...structuredClone(DEFAULT_CONFIG), ...readJson(CONFIG_PATH, {}) });
const loadState = () => ({ items: {}, manual: [], ...readJson(STATE_PATH, {}) });
const loadCache = () => ({ sources: {}, ...readJson(CACHE_PATH, {}) });

// ---------- iCal parsing ----------

function unescapeIcs(value) {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const [name, ...rawParams] = line.slice(0, colon).split(';');
      const params = {};
      for (const p of rawParams) {
        const [k, v = ''] = p.split('=');
        params[k.toUpperCase()] = v.replace(/^"|"$/g, '');
      }
      current[name.toUpperCase()] = { value: unescapeIcs(line.slice(colon + 1)), params };
    }
  }
  return events;
}

// Returns { due: ISO string, allDay }. Floating and TZID times are treated as this machine's
// local time, which is fine while the server runs on your own computer in Utah.
function parseIcsDate(prop) {
  if (!prop) return { due: null, allDay: false };
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { due: null, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) {
    return { due: new Date(+y, +mo - 1, +d, 23, 59).toISOString(), allDay: true };
  }
  const date = z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
    : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { due: date.toISOString(), allDay: false };
}

// "Homework 3 [C S 452-001]" -> { title: "Homework 3", course: "C S 452-001" }
function splitCourse(summary) {
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m ? { title: m[1], course: m[2] } : { title: summary, course: null };
}

async function fetchText(url) {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(res.url).host}`);
  return res.text();
}

async function fetchCanvasFeed(url) {
  const events = parseIcs(await fetchText(url));
  return events.map((ev) => {
    const uid = ev.UID?.value || crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex');
    const { title, course } = splitCourse(ev.SUMMARY?.value || '(untitled)');
    const { due, allDay } = parseIcsDate(ev.DTSTART);
    const assignment = uid.match(/^event-assignment-(\d+)/);
    return {
      // Same id shape as the API so checkmarks survive switching to a token.
      id: assignment ? `canvas:assignment-${assignment[1]}` : `canvas:${uid}`,
      source: 'canvas',
      kind: assignment ? 'assignment' : 'event',
      title,
      course: course || 'Canvas',
      due,
      allDay,
      url: ev.URL?.value || null,
      description: ev.DESCRIPTION?.value || '',
    };
  });
}

// Learning Suite has one feed per course; the setting holds one URL per line.
async function fetchLearningSuiteFeeds(urls) {
  const lists = await Promise.all(
    urls
      .split(/\s+/)
      .filter(Boolean)
      .map((url) => fetchLearningSuiteFeed(url)),
  );
  return lists.flat();
}

async function fetchLearningSuiteFeed(url) {
  const text = await fetchText(url);
  const calendarName = text.match(/^X-WR-CALNAME:(.*)$/m)?.[1].trim();
  const events = parseIcs(text);
  return events.map((ev) => {
    const uid = ev.UID?.value || crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex');
    const { title, course } = splitCourse(ev.SUMMARY?.value || '(untitled)');
    // Due at the end of the event. Learning Suite sends multi-day all-day events (e.g. Fri–Sat), and an
    // all-day DTEND is exclusive (the day *after* the last day), so step back one day for those.
    let { due, allDay } = parseIcsDate(ev.DTEND || ev.DTSTART);
    if (allDay && ev.DTEND && due) {
      const last = new Date(due);
      last.setDate(last.getDate() - 1);
      const start = parseIcsDate(ev.DTSTART).due;
      due = !start || last >= new Date(start) ? last.toISOString() : start;
    }
    return {
      id: `ls:${uid}`,
      source: 'learningsuite',
      kind: 'assignment',
      title,
      course: course || ev.CATEGORIES?.value || calendarName || 'Learning Suite',
      due,
      allDay,
      url: ev.URL?.value || null,
      description: ev.DESCRIPTION?.value || '',
    };
  });
}

// ---------- Canvas API ----------

async function canvasGetAll(baseUrl, token, apiPath) {
  let url = new URL(apiPath, baseUrl).toString();
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('Canvas rejected the token (401). Generate a new one in Canvas → Account → Settings.');
    if (!res.ok) throw new Error(`Canvas API HTTP ${res.status} for ${apiPath}`);
    out.push(...(await res.json()));
    const next = (res.headers.get('link') || '').split(',').find((part) => part.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)[1] : null;
  }
  return out;
}

async function fetchCanvasApi(config) {
  const { canvasBaseUrl: base, canvasToken: token, semesterStart } = config;
  const courses = await canvasGetAll(base, token, '/api/v1/courses?enrollment_state=active&include[]=term&per_page=100');
  const current = courses.filter((c) => {
    if (!c.name || c.access_restricted_by_date) return false;
    const termEnd = c.term?.end_at || c.end_at;
    return !termEnd || new Date(termEnd) >= new Date(semesterStart);
  });

  const perCourse = await Promise.all(
    current.map(async (course) => {
      const assignments = await canvasGetAll(
        base,
        token,
        `/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100`,
      );
      return assignments.map((a) => {
        const sub = a.submission || {};
        const submitted = Boolean(sub.submitted_at) || ['submitted', 'graded', 'pending_review'].includes(sub.workflow_state) || sub.excused;
        return {
          id: `canvas:assignment-${a.id}`,
          source: 'canvas',
          kind: 'assignment',
          title: a.name,
          course: course.course_code || course.name,
          due: a.due_at,
          allDay: false,
          url: a.html_url,
          description: '',
          points: a.points_possible,
          submitted,
          missing: Boolean(sub.missing),
          late: Boolean(sub.late),
          score: sub.score ?? null,
          graded: sub.workflow_state === 'graded',
        };
      });
    }),
  );
  return perCourse.flat();
}

// ---------- sync ----------

function activeSources(config) {
  const sources = {};
  // The API supersedes the Canvas feed (it adds submission status and undated assignments).
  if (config.canvasToken) sources.canvas = () => fetchCanvasApi(config);
  else if (config.canvasFeedUrl) sources.canvas = () => fetchCanvasFeed(config.canvasFeedUrl);
  if (config.learningSuiteFeedUrl.trim()) sources.learningsuite = () => fetchLearningSuiteFeeds(config.learningSuiteFeedUrl);
  return sources;
}

let syncInFlight = null;

async function sync({ force = false } = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const config = loadConfig();
    const cache = loadCache();
    const sources = activeSources(config);
    const now = Date.now();

    // Drop cached sources that are no longer configured.
    for (const name of Object.keys(cache.sources)) if (!sources[name]) delete cache.sources[name];

    await Promise.all(
      Object.entries(sources).map(async ([name, fetcher]) => {
        const prev = cache.sources[name];
        if (!force && prev?.fetchedAt && !prev.error && now - Date.parse(prev.fetchedAt) < STALE_MS) return;
        try {
          cache.sources[name] = { items: await fetcher(), fetchedAt: new Date().toISOString(), error: null };
        } catch (err) {
          // Keep the last good items so one bad fetch doesn't wipe your list.
          cache.sources[name] = { items: prev?.items || [], fetchedAt: prev?.fetchedAt || null, error: err.message };
        }
      }),
    );
    writeJson(CACHE_PATH, cache);
    return cache;
  })();
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

function buildResponse(cache) {
  const config = loadConfig();
  const state = loadState();
  const start = new Date(config.semesterStart + 'T00:00:00');
  const end = new Date(config.semesterEnd + 'T23:59:59');

  const synced = Object.values(cache.sources)
    .flatMap((s) => s.items)
    .filter((item) => !item.due || (new Date(item.due) >= start && new Date(item.due) <= end));
  const manual = state.manual.map((m) => ({ ...m, source: 'manual', kind: 'assignment' }));

  const items = [...synced, ...manual].map((item) => {
    const s = state.items[item.id] || {};
    return {
      ...item,
      courseOriginal: item.course,
      course: config.courseNames[item.course] || item.course,
      done: s.done ?? Boolean(item.submitted),
      hidden: Boolean(s.hidden),
      // A cleared overdue item comes back if its due date has since changed (e.g. an extension).
      dismissed: Boolean(s.dismissed) && (s.dismissedDue ?? null) === (item.due ?? null),
      notes: s.notes || '',
    };
  });

  return {
    items,
    sources: Object.fromEntries(
      Object.entries(cache.sources).map(([name, s]) => [name, { fetchedAt: s.fetchedAt, error: s.error, count: s.items.length }]),
    ),
    configured: Object.keys(activeSources(config)).length > 0,
  };
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function applyItemChanges(entry, body) {
  if (typeof body.done === 'boolean') entry.done = body.done;
  if (typeof body.hidden === 'boolean') entry.hidden = body.hidden;
  if (typeof body.notes === 'string') entry.notes = body.notes;
  if (body.dismissed === true) {
    entry.dismissed = true;
    entry.dismissedDue = typeof body.dismissedDue === 'string' ? body.dismissedDue : null;
  } else if (body.dismissed === false) {
    delete entry.dismissed;
    delete entry.dismissedDue;
  }
  return entry;
}

function publicConfig(config) {
  const { canvasToken, themes, activeThemeId, ...rest } = config;
  return { ...rest, hasCanvasToken: Boolean(canvasToken) };
}

// ---------- themes ----------

const allThemes = (config) => [...ThemeCore.BUILTIN_THEMES, ...config.themes];
const findTheme = (config, id) => allThemes(config).find((t) => t.id === id);

function themesResponse(config) {
  const active = findTheme(config, config.activeThemeId) ? config.activeThemeId : ThemeCore.DEFAULT_THEME_ID;
  return { themes: allThemes(config), activeThemeId: active };
}

function cleanTheme(body) {
  return {
    name: body.name.trim(),
    colors: Object.fromEntries(ThemeCore.COLOR_KEYS.map((key) => [key, body.colors[key].toLowerCase()])),
  };
}

async function handleThemes(req, res, pathname, method) {
  const config = loadConfig();

  if (pathname === '/api/themes' && method === 'GET') return send(res, 200, themesResponse(config));

  if (pathname === '/api/themes' && method === 'POST') {
    const body = await readBody(req);
    const error = ThemeCore.validateTheme(body);
    if (error) return send(res, 400, { error });
    const theme = { id: `theme-${crypto.randomUUID().slice(0, 8)}`, ...cleanTheme(body) };
    config.themes.push(theme);
    writeJson(CONFIG_PATH, config);
    return send(res, 201, theme);
  }

  if (pathname === '/api/active-theme' && method === 'PUT') {
    const { id } = await readBody(req);
    if (!findTheme(config, id)) return send(res, 404, { error: 'No such theme.' });
    config.activeThemeId = id;
    writeJson(CONFIG_PATH, config);
    return send(res, 200, themesResponse(config));
  }

  const match = pathname.match(/^\/api\/themes\/([^/]+)$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const theme = findTheme(config, id);
  if (!theme) return send(res, 404, { error: 'No such theme.' });
  if (theme.builtIn) return send(res, 400, { error: 'Built-in themes can’t be changed. Duplicate it instead.' });

  if (method === 'PUT') {
    const body = await readBody(req);
    const error = ThemeCore.validateTheme(body);
    if (error) return send(res, 400, { error });
    Object.assign(theme, cleanTheme(body));
    writeJson(CONFIG_PATH, config);
    return send(res, 200, theme);
  }

  if (method === 'DELETE') {
    if (themesResponse(config).activeThemeId === id) {
      return send(res, 409, { error: 'Switch to another theme before deleting this one.' });
    }
    config.themes = config.themes.filter((t) => t.id !== id);
    writeJson(CONFIG_PATH, config);
    return send(res, 204, '', 'text/plain');
  }

  return false;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/assignments' && method === 'GET') {
    return send(res, 200, buildResponse(await sync({ force: url.searchParams.get('refresh') === '1' })));
  }

  if (pathname.startsWith('/api/themes') || pathname === '/api/active-theme') {
    if ((await handleThemes(req, res, pathname, method)) !== false) return;
  }

  if (pathname === '/api/config' && method === 'GET') return send(res, 200, publicConfig(loadConfig()));

  if (pathname === '/api/config' && method === 'PUT') {
    const body = await readBody(req);
    const config = loadConfig();
    for (const key of ['canvasBaseUrl', 'canvasFeedUrl', 'learningSuiteFeedUrl', 'semesterStart', 'semesterEnd']) {
      if (typeof body[key] === 'string') config[key] = body[key].trim();
    }
    if (body.courseNames && typeof body.courseNames === 'object') {
      config.courseNames = Object.fromEntries(
        Object.entries({ ...config.courseNames, ...body.courseNames })
          .map(([original, display]) => [original, String(display).trim()])
          .filter(([original, display]) => display && display !== original),
      );
    }
    // The token is never sent back to the browser; only overwrite it when a new one is typed in.
    if (body.clearCanvasToken) config.canvasToken = '';
    else if (typeof body.canvasToken === 'string' && body.canvasToken.trim()) config.canvasToken = body.canvasToken.trim();
    writeJson(CONFIG_PATH, config);
    return send(res, 200, publicConfig(config));
  }

  // Apply several item changes in one write: { changes: [{ id, done?, hidden?, notes?, dismissed?, dismissedDue? }] }
  if (pathname === '/api/items/bulk' && method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body.changes)) return send(res, 400, { error: 'changes must be an array' });
    const state = loadState();
    for (const change of body.changes) {
      if (typeof change.id !== 'string') continue;
      state.items[change.id] = applyItemChanges({ ...(state.items[change.id] || {}) }, change);
    }
    writeJson(STATE_PATH, state);
    return send(res, 200, { updated: body.changes.length });
  }

  const itemMatch = pathname.match(/^\/api\/items\/(.+)$/);
  if (itemMatch && method === 'PATCH') {
    const id = decodeURIComponent(itemMatch[1]);
    const body = await readBody(req);
    const state = loadState();
    const entry = applyItemChanges({ ...(state.items[id] || {}) }, body);
    state.items[id] = entry;
    writeJson(STATE_PATH, state);
    return send(res, 200, entry);
  }

  if (pathname === '/api/manual' && method === 'POST') {
    const body = await readBody(req);
    if (!body.title?.trim()) return send(res, 400, { error: 'Title is required' });
    const state = loadState();
    const item = {
      id: `manual:${crypto.randomUUID()}`,
      title: body.title.trim(),
      course: body.course?.trim() || 'Other',
      due: body.due || null,
      allDay: false,
      url: body.url?.trim() || null,
      description: '',
    };
    state.manual.push(item);
    writeJson(STATE_PATH, state);
    return send(res, 201, item);
  }

  const manualMatch = pathname.match(/^\/api\/manual\/(.+)$/);
  if (manualMatch && method === 'DELETE') {
    const id = decodeURIComponent(manualMatch[1]);
    const state = loadState();
    state.manual = state.manual.filter((m) => m.id !== id);
    delete state.items[id];
    writeJson(STATE_PATH, state);
    return send(res, 204, '', 'text/plain');
  }

  send(res, 404, { error: 'Not found' });
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    if (path.basename(file) === 'index.html') {
      // Browsers cache favicons by URL, so version the link by the icon's mtime: a regenerated icon gets a new URL.
      const icon = fs.statSync(path.join(PUBLIC_DIR, 'icon.png'), { throwIfNoEntry: false });
      if (icon) data = data.toString().replace('href="icon.png"', `href="icon.png?v=${Math.round(icon.mtimeMs)}"`);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (err) {
      console.error(err);
      send(res, 500, { error: err.message });
    }
  })
  .listen(PORT, HOST, () => console.log(`Assignment Manager running at http://localhost:${PORT}`));
