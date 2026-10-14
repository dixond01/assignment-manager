# Assignment Manager

A local web app that pulls your assignments from BYU Canvas and Learning Suite into one weekly grid and a due-date list.

## Run it

Double-click `start.cmd`, or:

```
npm start
```

Then open http://localhost:3456. The server listens only on your own machine.

## Connect your classes

Click ⚙ (Settings):

- **Canvas API token** (recommended): Canvas → Account → Settings → **+ New Access Token**. With a token, the app shows submitted/graded/missing status and also lists assignments that have no due date.
- **Canvas calendar feed** (fallback if you don't want a token): Canvas → Calendar → **Calendar Feed** (bottom right). Copy the URL.
- **Learning Suite course feeds**: Learning Suite has one feed per course. In each course: Schedule tab → **Get iCalendar Feed** → copy the link. Paste them one per line.
- **Semester dates**: only assignments due inside this range are shown.

Sources sync when you open the page if the last sync is over an hour old. **Refresh** forces a sync.

## How it works

- `server.js`: a zero-dependency Node server. It fetches the feeds and the Canvas API, caches the results in `data/cache.json`, and stores your checkmarks, notes, hidden items, and manual assignments in `data/state.json`.
- `public/`: the front end (plain HTML/CSS/JS).
- `config.json`: your token and feed URLs. It is gitignored; don't share it.

Canvas items marked submitted are checked off automatically. Unchecking one keeps it unchecked. Use **Hide** in an item's details for feed entries that aren't real assignments, such as class meetings.
