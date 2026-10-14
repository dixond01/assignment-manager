# Assignment Manager

A local-only web app that pulls a student's assignments from Canvas and other iCal calendar feeds into a weekly grid, a due-date list, and a time tracker. Single user per install. Windows, macOS, and Linux each get a desktop shortcut with a themed icon; `npm start` is the fallback everywhere. Node 18+. See README.md for user-facing docs.

## Hard rules

- **Never commit `config.json` or `data/`** (both gitignored). `config.json` holds the user's **Canvas API token** and private iCal feed URLs. Before every commit, scan staged files for secrets:
  `git grep --cached -n -i -E 'feeds/calendars/user_[0-9]|iCalFeed\.php\?|courseID=|[0-9]{4,5}~[A-Za-z0-9]{20,}' -- ':!CLAUDE.md'` (exit 1 = clean; this file is excluded because it contains the pattern).
- **Commit only when asked.** End commit messages with the Co-Authored-By trailer.
- **Zero dependencies, no build step.** Plain Node standard library on the server; plain HTML/CSS/JS in `public/`. Don't add npm packages.
- **Keep it school-neutral.** No school names, URLs, or course names in code, defaults, placeholders, or docs.

## Running and testing

- Opening the app: Windows shortcut → `tools/launch.ps1` via `conhost.exe --headless` (no console window); macOS app bundle, Linux `.desktop` launcher, and `npm start` → `tools/launch.js` (detached server, then opens the browser). The server stops itself ~60 s after the last app tab closes. `npm run dev` runs the server in the foreground for debugging.
- Only Windows can be tested on this machine. Test macOS/Linux shortcut generation with `node tools/shortcut.js --create --platform darwin|linux --home <temp dir>` **from a copy of the app** (it writes icons and `desktop-icon.json` into the app's own `data/`). WSL Ubuntu (no Node) can validate files: Python `plistlib`, `sh -n`.
- **A test copy of the app must never update the real shortcut.** On startup the server redraws the shortcut icon unless `data/desktop-icon.json` matches the active theme, and the Windows script points shortcuts at *its own* folder. Before starting a server from a copy, write that marker (key = `JSON.stringify(ThemeCore.resolveColors(activeTheme))`).
- **The user's own copy is usually running on port 3456. Don't stop it or test against it in ways that write data.** Test server changes on a spare port: `PORT=3460 node server.js` (run in the background, then stop it).
- Tests that write data (themes, saved colors, manual items, time entries, clearing, settings) touch the real `config.json` / `data/state.json`. **Back them up to a temp folder first, restore afterward (verify with sha256), and delete the config backup** because it contains the token.
- Front-end-only changes can be checked in the running app as long as nothing is saved (for example, `applyColors(...)` in the page, or opening and then cancelling dialogs). Opening a second app tab pauses the first one, so prefer a spare-port server.
- Static files are re-read on every request, so front-end changes only need a page reload. Server changes need a restart (close the app's tabs, wait a minute, reopen).
- Use real key and mouse events (browser `computer` actions) when testing Enter, Escape, or drags. Synthetic events don't trigger implicit form submission.
- When showing rendered images (for example, design options), send PNG files rather than embedding base64 in an inline widget.

## Architecture

- `server.js`: HTTP server on 127.0.0.1. Syncs sources, caches them in `data/cache.json` (refreshed when older than 1 h or on `?refresh=1`; a failed source keeps its last good items), and merges in user state.
  - Canvas: the API token (`/api/v1/courses`, assignments with `include[]=submission` → submitted/graded/missing/late) supersedes the Canvas iCal feed. Requires `canvasBaseUrl`.
  - Other calendar feeds (`calendarFeedUrls`, one URL per line): any iCal feed; item ids `ical:<UID>`, source `calendar`.
  - User state in `data/state.json`: per-item `done` / `hidden` / `notes` / `dismissed` (+ `dismissedDue`), manual items, and `timeLog`.
  - Settings in `config.json`: Canvas URL/token/feed, `calendarFeedUrls`, semester dates, `courseNames`, `courseColors`, `themes`, `activeThemeId`, `savedColors`. Defaults are blank (no school assumed). `loadConfig()` must `structuredClone` the defaults (a shallow merge once mutated the shared defaults).
- `public/theme-core.js` and `public/icon-core.js` are UMD modules shared by the browser (`window.ThemeCore` / `window.IconCore`) and the server (`require`).
- `public/color-picker.js`: custom themed picker that replaces the native `<input type="color">` popup.
- `lib/icon-file.js`: PNG/.ico encoder. `tools/make_icon.js`: regenerates the fallback `public/icon.*` (Navy colors) or draws one .ico from `--colors`.
- `tools/setup.js` (`npm run setup`, `setup.cmd`, `setup.command`): Windows → `tools/update_shortcut.ps1 -Create`; macOS/Linux → `tools/shortcut.js --create`; then `tools/launch.js`.
- `tools/update_shortcut.ps1`: without `-Create` it only updates existing shortcuts and taskbar pins (the server calls it on theme changes), pointing them at the launcher and a content-hashed icon copy in `data/`.
- `tools/shortcut.js`: macOS `~/Applications/Assignment Manager.app` (sh `launch` script with the absolute Node path, `LSUIElement`, `.icns` of 128/256/512 PNGs named by hash) + Desktop symlink; Linux `~/.local/share/applications/assignment-manager.desktop` + Desktop copy (marked trusted with `gio`), icon `data/shortcut-icon-<hash>.png`. `--colors` redraws and updates existing shortcuts only (the server's theme-change hook on macOS/Linux). Drawing takes ~20 s, so it always runs in a child process.

## Behavior decisions (keep these)

- **Course identity:** courses are keyed by their *original* name. Renames (`courseNames`), colors (`courseColors`), manual items' `course`, and time entries' `course` all store the original, so they survive renames. Same display name = merged course.
- **iCal dates:** all-day `DTEND` is exclusive. Some feeds send multi-day all-day events (for example, Fri–Sat), so due = `DTEND` minus one day (never before `DTSTART`). Timed events use `DTEND`. Floating/TZID times are treated as the machine's local time.
- **Semester dates:** blank means no limit on that side. Canvas courses are filtered by term end only when a start date is set.
- **Manual items:** separate date and optional time; date-only items are `allDay`, due 23:59 local.
- **Clear overdue:** sets `dismissed` + `dismissedDue`. An item reappears automatically if its due date changes. This is separate from Hide.
- **Time tracking:** `state.timeLog` entries `{ id, course (original name), date 'YYYY-MM-DD', minutes, itemId, itemTitle, note }` via `/api/time`. Checking off never prompts; logging is the card's hover-only ⏱ button (its popover has an optional "Mark as done"), the details dialog, or the Time tab. Weeks start Monday; the average counts only *finished* weeks since `semesterStart` (zero weeks count, the current week doesn't).
- **Week view:** a centered pager (‹ range ›, "Week N of M", Today) sits above the grid and the Time view, not in the toolbar, so the toolbar fits on one line. Sunday is hidden when it has no visible items and isn't today.
- **Sync status:** shown in the Sync button's tooltip; a toast reports the result of a manual sync; the status line under the toolbar appears only for errors.
- **Dialogs:** Cancel buttons are `type="button"` with `data-close`, so Enter submits with the save button (the first submit button). Save on the form `submit` event, not the dialog `close` event.
- **Themes:** six colors (background, surface, text, primary, secondary, tertiary). Everything else is derived in `ThemeCore.themeVars` (muted, border, `--field` = surface tinted 4% toward text, `--today`, `--done-bg`, `--accent-text`, …). Built-ins: **System (default, follows OS light/dark)**, Light, Dark, Navy. Built-ins can't be edited or deleted; **the active theme can't be deleted** (UI and server). The stylesheet's `:root` / dark-mode values must equal `themeVars()` for Light/Dark. Active vars and favicon are cached in localStorage and applied in `<head>` before first paint.
- Form fields use `--field`, never `--bg` (a dark background made fields dark inside light dialogs). Native checkboxes use `accent-color: var(--accent)`.
- **Color picker:** hue × luminosity plane + saturation slider; H/S/L, R/G/B, and hex fields; saved colors (max 24, server-stored); eyedropper; draggable header (position remembered per session). Live `input` events; Apply/outside click keeps, Cancel/Escape restores (Escape must not close the dialog underneath). It's a popover appended *inside* the open modal dialog (outside it would be inert). The Log time popover follows the same rules.

## Icon

- Design: a centered spiral checklist planner (two checked boxes, one open) with three sparkles, on a **transparent** backdrop so the taskbar/tab shows through. It's drawn with four theme roles: surface = page, primary = outline/checkboxes, secondary = sparkles/rings/open item's line, tertiary = checked items' lines.
- The icon follows the active theme: the tab favicon is drawn client-side; the desktop shortcut icon (Windows shortcut/taskbar pin, macOS app, Linux launchers) is redrawn by the server in a child process (~3 s on Windows, ~20 s for the macOS .icns) on theme change, edits to the active theme, and startup (skipped if the colors are unchanged, via `data/desktop-icon.json`).
- **Windows and browsers cache icons by path/URL.** Always change the path: hashed `data/shortcut-icon-<hash>.ico` / `.png`, hashed `icon-<hash>.icns` in the macOS bundle (plus a bumped bundle date), and `icon.png?v=<mtime>` in index.html.

## Windows gotchas learned

- Windows PowerShell's `Invoke-WebRequest http://localhost:…` tries IPv6 first and times out; the server listens on IPv4 only → use `127.0.0.1` in scripts.
- `Start-Process … -Wait` on the headless conhost blocks until the server exits (the server shares that console).
- In Git Bash, never write temp files to `/` paths; use a temp folder.
