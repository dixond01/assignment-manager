// The "Assignment Manager" shortcut on macOS and Linux (Windows uses update_shortcut.ps1).
//
//   node tools/shortcut.js --create
//       Make the shortcut, with the icon in the active theme's colors:
//       macOS: ~/Applications/Assignment Manager.app, plus a link to it on the Desktop.
//       Linux: an app-menu entry (~/.local/share/applications) and a Desktop launcher.
//   node tools/shortcut.js --colors '<json>'
//       Redraw the icon in these colors and update shortcuts that already exist. The server runs this
//       in a child process when the theme changes (drawing takes several seconds).
//
// Both launch tools/launch.js with the absolute path of the Node that ran this script, because apps
// opened from the Dock or app menu don't get your shell's PATH. Run --create again after moving the
// folder or reinstalling Node. For testing: --platform darwin|linux and --home <dir>.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ThemeCore = require('../public/theme-core.js');
const { iconPng } = require('../lib/icon-file.js');

const APP = path.join(__dirname, '..');
const DATA = path.join(APP, 'data');
const NAME = 'Assignment Manager';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PLATFORM = flag('--platform') || process.platform;
const HOME = flag('--home') || os.homedir();
const NODE = process.execPath;
const LAUNCHER = path.join(APP, 'tools', 'launch.js');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);

function activeColors() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
  } catch {}
  const themes = [...ThemeCore.BUILTIN_THEMES, ...(config.themes || [])];
  const theme = themes.find((t) => t.id === config.activeThemeId) || ThemeCore.BUILTIN_THEMES[0];
  return ThemeCore.resolveColors(theme);
}

// ---------- macOS: an app bundle ----------

const macApp = () => path.join(HOME, 'Applications', `${NAME}.app`);
const macDesktopLink = () => path.join(HOME, 'Desktop', `${NAME}.app`);

// .icns holding PNGs: 'ic07' = 128 px, 'ic08' = 256 px, 'ic09' = 512 px.
function icns(colors) {
  const entries = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
  ].map(([type, size]) => {
    const png = iconPng(size, colors);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + entries.reduce((sum, e) => sum + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// For a double-quoted sh string.
const shQuote = (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

// Finder caches app icons, so each icon gets a new file name and the bundle's date is bumped.
function macWriteIcon(colors) {
  const resources = path.join(macApp(), 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const data = icns(colors);
  const name = `icon-${hash(data)}`;
  for (const old of fs.readdirSync(resources)) if (old.endsWith('.icns') && old !== `${name}.icns`) fs.rmSync(path.join(resources, old));
  fs.writeFileSync(path.join(resources, `${name}.icns`), data);
  fs.writeFileSync(
    path.join(macApp(), 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${xml(NAME)}</string>
  <key>CFBundleDisplayName</key><string>${xml(NAME)}</string>
  <key>CFBundleIdentifier</key><string>local.assignment-manager</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>${name}</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
  );
  const now = new Date();
  fs.utimesSync(macApp(), now, now);
}

function macCreate(colors) {
  const macos = path.join(macApp(), 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  // LSUIElement: opening it starts the server and the browser without a Dock icon of its own.
  fs.writeFileSync(path.join(macos, 'launch'), `#!/bin/sh\nexec ${shQuote(NODE)} ${shQuote(LAUNCHER)}\n`, { mode: 0o755 });
  fs.chmodSync(path.join(macos, 'launch'), 0o755);
  macWriteIcon(colors);
  const link = macDesktopLink();
  if (fs.existsSync(path.dirname(link)) && !fs.existsSync(link)) {
    try {
      fs.symlinkSync(macApp(), link);
    } catch {}
  }
  return [macApp(), link];
}

// ---------- Linux: .desktop launchers ----------

const DESKTOP_FILE = 'assignment-manager.desktop';

function linuxDesktopDir() {
  if (!flag('--home')) {
    const result = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' });
    const dir = result.status === 0 && result.stdout.trim();
    if (dir && dir !== HOME && fs.existsSync(dir)) return dir;
  }
  const fallback = path.join(HOME, 'Desktop');
  return fs.existsSync(fallback) ? fallback : null;
}

function linuxFiles() {
  const desktop = linuxDesktopDir();
  return [path.join(HOME, '.local', 'share', 'applications', DESKTOP_FILE), desktop && path.join(desktop, DESKTOP_FILE)].filter(Boolean);
}

// An Exec argument: double-quoted with ", `, $, \ escaped, then backslashes and % escaped again for
// the .desktop string format.
const execArg = (s) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');

// Desktops cache icons by path, so each icon gets a new file name in data/.
function linuxWriteIcon(colors) {
  fs.mkdirSync(DATA, { recursive: true });
  const png = iconPng(256, colors);
  const file = path.join(DATA, `shortcut-icon-${hash(png)}.png`);
  for (const old of fs.readdirSync(DATA)) if (/^shortcut-icon-.*\.png$/.test(old) && path.join(DATA, old) !== file) fs.rmSync(path.join(DATA, old));
  fs.writeFileSync(file, png);
  return file;
}

function linuxEntry(icon) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=${NAME}
Comment=Your assignments and study time
Exec=${execArg(NODE)} ${execArg(LAUNCHER)}
Icon=${icon}
Terminal=false
Categories=Education;Office;
StartupNotify=false
`;
}

function linuxSave(file, icon) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, linuxEntry(icon), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  // GNOME only runs Desktop launchers marked as trusted ("Allow Launching").
  if (!flag('--home')) spawnSync('gio', ['set', file, 'metadata::trusted', 'true'], { stdio: 'ignore' });
}

function linuxCreate(colors) {
  const icon = linuxWriteIcon(colors);
  const files = linuxFiles();
  for (const file of files) linuxSave(file, icon);
  return files;
}

function linuxUpdate(colors) {
  const files = linuxFiles().filter((f) => fs.existsSync(f));
  if (!files.length) return [];
  const icon = linuxWriteIcon(colors);
  for (const file of files) linuxSave(file, icon);
  return files;
}

// ---------- CLI ----------

module.exports = { activeColors };

function main() {
  if (PLATFORM !== 'darwin' && PLATFORM !== 'linux') {
    console.error('This script is for macOS and Linux. On Windows, run setup.cmd.');
    process.exit(1);
  }
  if (args.includes('--create')) {
    const colors = activeColors();
    console.log('Drawing the app icon (this can take about 20 seconds)…');
    const made = PLATFORM === 'darwin' ? macCreate(colors) : linuxCreate(colors);
    // Tell the server this icon is current, so it doesn't redraw it on startup.
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'desktop-icon.json'), JSON.stringify({ key: JSON.stringify(colors), updatedAt: new Date().toISOString() }, null, 2));
    for (const f of made) if (fs.existsSync(f)) console.log(`Created ${f}`);
  } else if (flag('--colors')) {
    const colors = JSON.parse(flag('--colors'));
    if (PLATFORM === 'darwin') {
      if (fs.existsSync(macApp())) {
        macWriteIcon(colors);
        console.log(`Updated ${macApp()}`);
      }
    } else {
      for (const f of linuxUpdate(colors)) console.log(`Updated ${f}`);
    }
  } else {
    console.error('Usage: node tools/shortcut.js --create | --colors <json>');
    process.exit(1);
  }
}

if (require.main === module) main();
