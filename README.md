# Assignment Manager

A local web app that pulls your assignments from BYU Canvas and Learning Suite into one weekly grid and a due-date list.

## Run it

Use the **Assignment Manager** Desktop shortcut or taskbar pin, or double-click `start.cmd`. The app opens in your browser; there's no console window to manage.

- The server starts hidden the first time, and is reused if it's already running (never duplicated).
- Opening the app again in a new tab closes the older app tab (or pauses it with a notice, if the browser won't let it close).
- About a minute after you close the last app tab, the server stops itself. Its output is in `data/server.log`.

To run it in a visible console instead (for debugging): `npm start`, then open http://localhost:3456. The server listens only on your own machine.

## Connect your classes

Click ⚙ (Settings):

- **Canvas API token** (recommended): Canvas → Account → Settings → **+ New Access Token**. With a token, the app shows submitted/graded/missing status and also lists assignments that have no due date.
- **Canvas calendar feed** (fallback if you don't want a token): Canvas → Calendar → **Calendar Feed** (bottom right). Copy the URL.
- **Learning Suite course feeds**: Learning Suite has one feed per course. In each course: Schedule tab → **Get iCalendar Feed** → copy the link. Paste them one per line.
- **Semester dates**: only assignments due inside this range are shown.

Sources sync when you open the page if the last sync is over an hour old. **Sync** forces a sync and shows the result briefly at the bottom of the page. Hover over **Sync** to see when each source last synced. Sync errors also appear under the toolbar.

## Time tracking

- **Time on an assignment:** hover a card and click its ⏱ button (or use **⏱ Log time** in the assignment's details). Pick +15m/+30m/+1h/+2h or type hours and minutes. Enter logs it. Checking an assignment off never asks about time. Logged time shows on the card (for example ⏱ 1h 30m).
- **Other study time:** the **Time** tab → **+ Log time**. Choose the course and date, and optionally an assignment and a note.
- **The Time tab** shows each course's average hours per week, this week's hours, and the total. Below that is a week-by-week table (click a week to see and edit its entries).
- **Averages** cover only finished Monday–Sunday weeks since your semester start date. Weeks with no time count as zero. The current week is added once it ends.
- **Copy report** copies each course's weekly average as plain text, for end-of-semester reporting.

## Themes and course colors

Click 🎨 (Themes) to switch themes. Built in: **System** (the default; follows Windows light/dark), **Light**, **Dark**, and **BYU**. **Duplicate** or **New theme** opens an editor with six colors (background, surface, text, primary, secondary, tertiary) that previews live. You can edit and delete your own themes, but not the one you're currently using.

The app icon follows the active theme: the browser tab immediately, and the Desktop shortcut (and taskbar pin) within a few seconds.

Course colors are set in ⚙ Settings → **Course names**: pick a color, or **Reset** to go back to the automatic one.

## How it works

- `server.js`: a zero-dependency Node server. It fetches the feeds and the Canvas API, caches the results in `data/cache.json`, and stores your checkmarks, notes, hidden items, manual assignments, and logged time in `data/state.json`.
- `public/`: the front end (plain HTML/CSS/JS). `theme-core.js` (themes and color math) and `icon-core.js` (icon drawing) are shared with the server.
- `lib/icon-file.js`: encodes the icon as PNG and Windows `.ico`.
- `tools/make_icon.js`: regenerates the fallback `public/icon.ico` / `icon.png` (`node tools/make_icon.js [themeId]`).
- `tools/launch.ps1`: starts the server hidden if it isn't running, then opens the app. The shortcut runs it via `conhost.exe --headless` so no window appears.
- `tools/update_shortcut.ps1`: points the Desktop shortcut and taskbar pin at the launcher and an icon file. The server runs it when the theme changes.
- `config.json`: your token, feed URLs, course names and colors, and themes. It is gitignored; don't share it.

Canvas items marked submitted are checked off automatically. Unchecking one keeps it unchecked. Use **Hide** in an item's details for feed entries that aren't real assignments, such as class meetings.
