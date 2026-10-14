# Assignment Manager

A small app that runs on your own computer and pulls your assignments from **Canvas** and any other **calendar feeds** into one place:

- **Week view**: a Monday–Sunday grid of everything due, color-coded by course.
- **List view**: overdue, this week, later, and no due date.
- **Time tracking**: log the time you spend on each assignment or studying. See your weekly hours and your average per week for each course, and copy a report at the end of the semester.
- Check items off, add notes, hide items that aren't real assignments, and add your own assignments.
- Themes (light, dark, navy, or your own colors), and an app icon that matches your theme.

Everything stays on your computer. The app only talks to Canvas and the calendar feeds you add, and nobody else can open it.

## What you need

- **Windows 10 or 11** for the Desktop shortcut and the themed icon. On macOS or Linux, the app itself works, but you start it from a terminal (see [Run it on macOS or Linux](#run-it-on-macos-or-linux)).
- **Node.js 18 or newer.** Nothing else; the app has no other dependencies to install.
- **Git**, to download the app and get updates. You can also download it as a ZIP instead.
- A **Canvas** account (any school that uses Canvas), and/or calendar feed links for your courses.

## 1. Install Node.js

Check whether you already have it. Open PowerShell (or Terminal) and run:

```
node --version
```

If it prints `v18` or higher, skip to the next step. Otherwise, install the **LTS** version from [nodejs.org](https://nodejs.org), or on Windows run:

```
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell after installing so `node` is found.

## 2. Download the app

```
cd $HOME\Documents
git clone https://github.com/dixond01/assignment-manager.git
```

This makes an `assignment-manager` folder in your Documents. You can put it anywhere, but don't move it after step 3 (the shortcut points to it).

No Git? On the GitHub page, click **Code → Download ZIP** and unzip it where you want it.

## 3. Create the Desktop shortcut (Windows)

In the `assignment-manager` folder, double-click **`setup.cmd`**.

It creates an **Assignment Manager** shortcut on your Desktop and opens the app in your browser. To pin it to the taskbar, right-click the shortcut → **Show more options → Pin to taskbar**.

From now on, open the app from the shortcut. There's no console window: the app runs in the background and stops by itself about a minute after you close its last browser tab.

## 4. Connect your classes

The first time it opens, the app has no data. Click **⚙ Settings** and fill in:

### Canvas

- **Canvas URL**: your school's Canvas address, for example `https://yourschool.instructure.com`. It's the start of the address you see when you're signed in to Canvas.
- **API token** (recommended): in Canvas, go to **Account → Settings**, scroll to **Approved Integrations**, and click **+ New Access Token**. Give it a name such as "Assignment Manager", leave the expiration blank (or pick the end of the semester), and copy the token into Settings. With a token, the app shows which assignments are submitted, graded, missing, or late, and it also lists assignments with no due date.
- **Calendar feed URL** (if you'd rather not use a token, or your school doesn't allow tokens): in Canvas, open **Calendar** and click **Calendar Feed** at the bottom right. Copy the link. The feed only has dated items and no submission status.

### Other calendar feeds

Paste any other calendar subscription links (`.ics` or `webcal://`), one per line: for example, course schedules from another learning system your school uses, or a class calendar your instructor shares. Each event becomes an assignment due at the event's end.

The course name comes from the event title when it ends in brackets (`Homework 3 [MATH 213]`), otherwise from the feed's category or calendar name. You can rename courses afterward (see below).

### Semester

Set the **Start** and **End** dates of your semester. Only assignments due between them are shown, and weekly time averages count from the start date. If you leave them blank, everything is shown and time averages are turned off.

Click **Save & sync**. Your assignments appear in a few seconds.

### Course names and colors

After the first sync, your courses appear in Settings under **Course names**. You can give each one a shorter name (for example `CS 235` instead of `CS 235-001: Data Structures`) and pick its color. Giving two courses the same name merges them, which is handy when Canvas and a calendar feed list the same class differently.

## Using it

- **Week / List / Time** at the top switch views. In the Week view, use the ‹ › buttons above the grid (or the arrow keys) to change weeks. Sunday is hidden when nothing is due that day.
- Click an assignment's title for details, notes, the link to where it came from, and **Hide** (for calendar entries that aren't assignments, such as class meetings).
- **+ Add** adds your own assignment.
- **Clear overdue** removes past-due items you're not going to do. They come back if the due date changes, and you can restore them from **Cleared**.
- **Sync** checks Canvas and your calendar feeds now; hover over it to see when each last synced. The app also syncs on its own when you open it if the last sync is more than an hour old.

### Time tracking

- **Time on an assignment:** hover over a card and click its ⏱ button. Pick +15m, +30m, +1h, or +2h, or type hours and minutes, then press Enter. Check **Mark as done** to check the assignment off in the same step. Checking an assignment off by itself never asks about time.
- **Other study time:** open the **Time** tab and click **+ Log time**.
- The **Time** tab shows each course's average hours per week, this week's hours, and the total, plus a week-by-week table. Click a week to see and edit its entries.
- Averages count only finished Monday–Sunday weeks since your semester start. Weeks with no time count as zero, and the current week counts once it ends.
- **Copy report** copies each course's weekly average as plain text.

### Themes

Click 🎨 to switch themes: **System** (follows your computer's light or dark mode), **Light**, **Dark**, or **Navy**. **New theme** or **Duplicate** lets you pick your own six colors. On Windows, the Desktop shortcut and taskbar icon change to match within a few seconds.

## Run it on macOS or Linux

The Desktop shortcut and icon are Windows-only, but the app itself works the same. In a terminal:

```
cd assignment-manager
npm start
```

Then open <http://localhost:3456> in your browser. Leave the terminal open while you use the app. It stops by itself about a minute after you close the last tab, or press Ctrl+C.

## Updating

```
cd $HOME\Documents\assignment-manager
git pull
```

Then close the app's tab, wait a minute, and open it again. Your settings and data are not touched by updates.

## Your data and privacy

- Everything is stored in the app's folder:
  - `config.json`: your Canvas URL, **API token**, feed links, semester dates, course names and colors, and themes.
  - `data/`: your checkmarks, notes, hidden items, your own assignments, logged time, and a cache of what was synced.
- Both are in `.gitignore`, so Git never uploads them. **Don't share `config.json`**: the token gives access to your Canvas account, and feed links are usually private.
- The app only accepts connections from your own computer (`127.0.0.1`), so no one else on your network can open it.
- To back up your data, copy `config.json` and the `data` folder. To remove the app, delete the folder and the Desktop shortcut, and delete the token in Canvas (**Account → Settings → Approved Integrations**).

## Troubleshooting

- **No assignments show up.** Check the semester dates in Settings: only assignments due between them are shown. Then click **Sync**.
- **"Set your Canvas URL in Settings."** You added a token but no Canvas URL. Add your school's Canvas address.
- **"Canvas rejected the token (401)."** The token expired or was deleted. Make a new one in Canvas and paste it into Settings.
- **A red sync error under the toolbar.** That source couldn't be reached. The app keeps showing what it last synced, and you can try **Sync** again later.
- **"The app has stopped."** You closed the app's last tab, so it shut down. Open it again from the shortcut; the old tab reconnects by itself.
- **Port 3456 is already used by another program.** Start the app on another port: `set PORT=3460` then `npm start` in the same Command Prompt (or `PORT=3460 npm start` on macOS/Linux), and open `http://localhost:3460`.
- **The shortcut does nothing.** Make sure `node --version` works in a new PowerShell window. If you moved the folder, run `setup.cmd` again.

## How it works

- `server.js`: a Node server with no dependencies. It fetches Canvas (API or calendar feed) and your other calendar feeds, caches them in `data/cache.json`, and stores your changes in `data/state.json`.
- `public/`: the web page (plain HTML, CSS, and JavaScript; no build step). `theme-core.js` (theme colors) and `icon-core.js` (icon drawing) are shared with the server.
- `lib/icon-file.js`: writes the icon as PNG and Windows `.ico`.
- `setup.cmd`: creates the Desktop shortcut and opens the app. `start.cmd` just opens the app.
- `tools/launch.ps1`: starts the server in the background if it isn't running, then opens the app. The shortcut runs it through `conhost.exe --headless`, so no window appears.
- `tools/update_shortcut.ps1`: creates or updates the Desktop shortcut and taskbar pin and their icon. The server runs it when you change themes.
- `tools/make_icon.js`: redraws the default icon in `public/` (`node tools/make_icon.js [themeId]`).
- `CLAUDE.md`: notes for working on the code with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE)
