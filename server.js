// Assignment Manager — local server. Zero dependencies; requires Node 18+.
// Pulls assignments from Canvas (API token or iCal feed) and any other iCal calendar feeds,
// merges them with manual items, and stores your checkmarks/notes in ./data.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ThemeCore = require('./public/theme-core.js');

const PORT = Number(process.env.PORT) || 3456;
const HOST = '127.0.0.1'; // local only — config.json holds your Canvas token
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');
const DESKTOP_ICON_PATH = path.join(DATA_DIR, 'desktop-icon.json');
const STALE_MS = 60 * 60 * 1000; // auto-refresh sources older than an hour
const MAX_SAVED_COLORS = 24;

const DEFAULT_CONFIG = {
  canvasBaseUrl: '', // e.g. https://yourschool.instructure.com
  canvasToken: '',
  canvasFeedUrl: '',
  calendarFeedUrls: '', // other iCal feeds, one URL per line
  semesterStart: '', // 'YYYY-MM-DD'; blank shows everything
  semesterEnd: '',
  courseNames: {}, // original course name -> display name
  courseColors: {}, // original course name -> #rrggbb
  themes: [], // user-created themes: { id, name, colors }
  savedColors: [], // the color picker's saved palette, newest first
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
const loadState = () => ({ items: {}, manual: [], timeLog: [], ...readJson(STATE_PATH, {}) });
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
// local time, which is fine while the server runs on your own computer in your own time zone.
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

// Other calendar feeds (often one per course); the setting holds one URL per line.
async function fetchCalendarFeeds(urls) {
  const lists = await Promise.all(
    urls
      .split(/\s+/)
      .filter(Boolean)
      .map((url) => fetchCalendarFeed(url)),
  );
  return lists.flat();
}

async function fetchCalendarFeed(url) {
  const text = await fetchText(url);
  const calendarName = text.match(/^X-WR-CALNAME:(.*)$/m)?.[1].trim();
  const events = parseIcs(text);
  return events.map((ev) => {
    const uid = ev.UID?.value || crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex');
    const { title, course } = splitCourse(ev.SUMMARY?.value || '(untitled)');
    // Due at the end of the event. Some feeds send multi-day all-day events (e.g. Fri–Sat), and an
    // all-day DTEND is exclusive (the day *after* the last day), so step back one day for those.
    let { due, allDay } = parseIcsDate(ev.DTEND || ev.DTSTART);
    if (allDay && ev.DTEND && due) {
      const last = new Date(due);
      last.setDate(last.getDate() - 1);
      const start = parseIcsDate(ev.DTSTART).due;
      due = !start || last >= new Date(start) ? last.toISOString() : start;
    }
    return {
      id: `ical:${uid}`,
      source: 'calendar',
      kind: 'assignment',
      title,
      course: course || ev.CATEGORIES?.value || calendarName || 'Calendar',
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
  if (!base) throw new Error('Set your Canvas URL in Settings (for example https://yourschool.instructure.com).');
  const courses = await canvasGetAll(base, token, '/api/v1/courses?enrollment_state=active&include[]=term&per_page=100');
  const current = courses.filter((c) => {
    if (!c.name || c.access_restricted_by_date) return false;
    const termEnd = c.term?.end_at || c.end_at;
    return !termEnd || !semesterStart || new Date(termEnd) >= new Date(semesterStart);
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
  if (config.calendarFeedUrls.trim()) sources.calendar = () => fetchCalendarFeeds(config.calendarFeedUrls);
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
  // Blank semester dates leave that side open.
  const start = config.semesterStart ? new Date(config.semesterStart + 'T00:00:00') : null;
  const end = config.semesterEnd ? new Date(config.semesterEnd + 'T23:59:59') : null;

  const synced = Object.values(cache.sources)
    .flatMap((s) => s.items)
    .filter((item) => !item.due || ((!start || new Date(item.due) >= start) && (!end || new Date(item.due) <= end)));
  const manual = state.manual.map((m) => ({ ...m, source: 'manual', kind: 'assignment' }));

  const items = [...synced, ...manual].map((item) => {
    const s = state.items[item.id] || {};
    return {
      ...item,
      courseOriginal: item.course,
      course: config.courseNames[item.course] || item.course,
      courseColor: config.courseColors[item.course] || null,
      done: s.done ?? Boolean(item.submitted),
      hidden: Boolean(s.hidden),
      // A cleared overdue item comes back if its due date has since changed (e.g. an extension).
      dismissed: Boolean(s.dismissed) && (s.dismissedDue ?? null) === (item.due ?? null),
      notes: s.notes || '',
    };
  });

  // Time entries are keyed by the original course name too, so they follow renames and colors.
  const timeLog = state.timeLog.map((entry) => ({
    ...entry,
    courseOriginal: entry.course,
    course: config.courseNames[entry.course] || entry.course,
    courseColor: config.courseColors[entry.course] || null,
  }));

  return {
    items,
    timeLog,
    semester: { start: config.semesterStart, end: config.semesterEnd },
    sources: Object.fromEntries(
      Object.entries(cache.sources).map(([name, s]) => [name, { fetchedAt: s.fetchedAt, error: s.error, count: s.items.length }]),
    ),
    configured: Object.keys(activeSources(config)).length > 0,
  };
}

// ---------- lifetime ----------

// The app runs without a console window (tools/launch.ps1), so the server stops itself once no tab has
// it open. Each tab holds an /api/events connection, which closes the moment the tab does.
const IDLE_EXIT_MS = Number(process.env.IDLE_EXIT_MS) || 60_000; // grace period for reloads
const STARTUP_GRACE_MS = 2 * 60_000; // time for the first tab to connect after launch
const tabConnections = new Set();
let idleTimer = null;

function scheduleIdleExit(ms = IDLE_EXIT_MS) {
  clearTimeout(idleTimer);
  if (tabConnections.size) return;
  idleTimer = setTimeout(async () => {
    if (tabConnections.size) return;
    console.log('No open tabs; shutting down.');
    await desktopIconQueue; // let a shortcut-icon update finish first
    process.exit(0);
  }, ms);
}

function handleEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n'); // how fast a tab reconnects if the connection drops
  tabConnections.add(res);
  clearTimeout(idleTimer);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    tabConnections.delete(res);
    scheduleIdleExit();
  });
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

// A time entry from a request body: { course, date: 'YYYY-MM-DD', minutes, itemId?, itemTitle?, note? }.
// Returns { entry } or { error }. itemTitle is a snapshot so the entry still reads well if the
// assignment later drops out of its feed.
function cleanTimeEntry(body) {
  const course = typeof body.course === 'string' ? body.course.trim() : '';
  const minutes = Math.round(Number(body.minutes));
  if (!course) return { error: 'Choose a course.' };
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return { error: 'Choose a date.' };
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return { error: 'Enter between 1 minute and 24 hours.' };
  const itemId = typeof body.itemId === 'string' && body.itemId ? body.itemId : null;
  return {
    entry: {
      course,
      date: body.date,
      minutes,
      itemId,
      itemTitle: itemId && typeof body.itemTitle === 'string' ? body.itemTitle.trim() : '',
      note: typeof body.note === 'string' ? body.note.trim() : '',
    },
  };
}

function publicConfig(config) {
  const { canvasToken, themes, activeThemeId, savedColors, ...rest } = config;
  return { ...rest, hasCanvasToken: Boolean(canvasToken) };
}

// ---------- themes ----------

const allThemes = (config) => [...ThemeCore.BUILTIN_THEMES, ...config.themes];
const findTheme = (config, id) => allThemes(config).find((t) => t.id === id);

function themesResponse(config) {
  const active = findTheme(config, config.activeThemeId) ? config.activeThemeId : ThemeCore.DEFAULT_THEME_ID;
  return { themes: allThemes(config), activeThemeId: active };
}

// ---------- desktop icon ----------

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

// Redraw the desktop shortcut's icon in the active theme's colors (Windows, macOS, Linux). Drawing and
// the shortcut update run in child processes so the server stays responsive. Requests made while one
// is running collapse into a single follow-up with the latest colors.
let desktopIconQueue = Promise.resolve();
let desktopIconPending = false;

function syncDesktopIcon() {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || desktopIconPending) return;
  desktopIconPending = true;
  desktopIconQueue = desktopIconQueue.then(async () => {
    desktopIconPending = false;
    const config = loadConfig();
    const colors = ThemeCore.resolveColors(findTheme(config, config.activeThemeId) || ThemeCore.BUILTIN_THEMES[0]);
    const key = JSON.stringify(colors);
    if (readJson(DESKTOP_ICON_PATH, {}).key === key) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (process.platform === 'win32') {
        const ico = path.join(DATA_DIR, 'theme-icon.ico');
        await run(process.execPath, [path.join(ROOT, 'tools', 'make_icon.js'), '--colors', key, '--ico', ico]);
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'update_shortcut.ps1'), '-Source', ico]);
      } else {
        // Updates the macOS app or Linux launchers if they exist; does nothing otherwise.
        await run(process.execPath, [path.join(ROOT, 'tools', 'shortcut.js'), '--colors', key]);
      }
      writeJson(DESKTOP_ICON_PATH, { key, updatedAt: new Date().toISOString() });
      console.log('Desktop shortcut icon updated to match the theme.');
    } catch (err) {
      console.error('Could not update the desktop shortcut icon:', err.message);
    }
  });
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
    syncDesktopIcon();
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
    if (themesResponse(config).activeThemeId === id) syncDesktopIcon();
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

  if (pathname === '/api/ping') return send(res, 200, { ok: true });
  if (pathname === '/api/events' && method === 'GET') return handleEvents(req, res);

  if (pathname === '/api/assignments' && method === 'GET') {
    return send(res, 200, buildResponse(await sync({ force: url.searchParams.get('refresh') === '1' })));
  }

  if (pathname.startsWith('/api/themes') || pathname === '/api/active-theme') {
    if ((await handleThemes(req, res, pathname, method)) !== false) return;
  }

  if (pathname === '/api/saved-colors' && method === 'GET') return send(res, 200, { colors: loadConfig().savedColors });

  if (pathname === '/api/saved-colors' && method === 'PUT') {
    const body = await readBody(req);
    if (!Array.isArray(body.colors)) return send(res, 400, { error: 'colors must be an array' });
    const config = loadConfig();
    config.savedColors = [...new Set(body.colors.filter(ThemeCore.isHex).map((c) => c.toLowerCase()))].slice(0, MAX_SAVED_COLORS);
    writeJson(CONFIG_PATH, config);
    return send(res, 200, { colors: config.savedColors });
  }

  if (pathname === '/api/config' && method === 'GET') return send(res, 200, publicConfig(loadConfig()));

  if (pathname === '/api/config' && method === 'PUT') {
    const body = await readBody(req);
    const config = loadConfig();
    for (const key of ['canvasBaseUrl', 'canvasFeedUrl', 'calendarFeedUrls', 'semesterStart', 'semesterEnd']) {
      if (typeof body[key] === 'string') config[key] = body[key].trim();
    }
    if (body.courseNames && typeof body.courseNames === 'object') {
      config.courseNames = Object.fromEntries(
        Object.entries({ ...config.courseNames, ...body.courseNames })
          .map(([original, display]) => [original, String(display).trim()])
          .filter(([original, display]) => display && display !== original),
      );
    }
    // Same shape as courseNames; a non-color value (e.g. '') resets that course to its automatic color.
    if (body.courseColors && typeof body.courseColors === 'object') {
      config.courseColors = Object.fromEntries(
        Object.entries({ ...config.courseColors, ...body.courseColors })
          .filter(([, color]) => ThemeCore.isHex(color))
          .map(([original, color]) => [original, color.toLowerCase()]),
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
      allDay: Boolean(body.due && body.allDay),
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

  if (pathname === '/api/time' && method === 'POST') {
    const { entry, error } = cleanTimeEntry(await readBody(req));
    if (error) return send(res, 400, { error });
    const state = loadState();
    const saved = { id: `time:${crypto.randomUUID()}`, ...entry, createdAt: new Date().toISOString() };
    state.timeLog.push(saved);
    writeJson(STATE_PATH, state);
    return send(res, 201, saved);
  }

  const timeMatch = pathname.match(/^\/api\/time\/(.+)$/);
  if (timeMatch && (method === 'PUT' || method === 'DELETE')) {
    const id = decodeURIComponent(timeMatch[1]);
    const state = loadState();
    const index = state.timeLog.findIndex((t) => t.id === id);
    if (index < 0) return send(res, 404, { error: 'No such time entry.' });
    if (method === 'DELETE') {
      state.timeLog.splice(index, 1);
      writeJson(STATE_PATH, state);
      return send(res, 204, '', 'text/plain');
    }
    const { entry, error } = cleanTimeEntry(await readBody(req));
    if (error) return send(res, 400, { error });
    state.timeLog[index] = { ...state.timeLog[index], ...entry };
    writeJson(STATE_PATH, state);
    return send(res, 200, state.timeLog[index]);
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
  .on('error', (err) => {
    // Another copy is already serving the app; this one isn't needed.
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} is already in use (the app is probably already running); exiting.`);
      process.exit(0);
    }
    throw err;
  })
  .listen(PORT, HOST, () => {
    console.log(`Assignment Manager running at http://localhost:${PORT}`);
    syncDesktopIcon(); // catch up if the theme changed while the app wasn't running
    scheduleIdleExit(STARTUP_GRACE_MS);
  });
