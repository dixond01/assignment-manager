// First-time setup on any OS (`npm run setup`, setup.cmd, or setup.command): create the desktop
// shortcut, then open the app. Safe to run again, for example after moving the folder.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { activeColors } = require('./shortcut.js');

const TOOLS = __dirname;
const DATA = path.join(TOOLS, '..', 'data');
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;

let ok;
if (process.platform === 'win32') {
  // Reuse the server's themed icon if it's current; otherwise use the default icon and clear the
  // server's marker so it redraws the themed one when it next starts.
  const marker = path.join(DATA, 'desktop-icon.json');
  const themed = path.join(DATA, 'theme-icon.ico');
  let current = false;
  try {
    current = JSON.parse(fs.readFileSync(marker, 'utf8')).key === JSON.stringify(activeColors()) && fs.existsSync(themed);
  } catch {}
  if (!current) fs.rmSync(marker, { force: true });
  const source = current ? ['-Source', themed] : [];
  ok = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, 'update_shortcut.ps1'), '-Create', ...source]);
} else if (process.platform === 'darwin' || process.platform === 'linux') {
  ok = run(process.execPath, [path.join(TOOLS, 'shortcut.js'), '--create']);
} else {
  console.log(`No desktop shortcut for ${process.platform}; open the app with "npm start".`);
  ok = true;
}
if (!ok) console.error('Could not create the shortcut. You can still open the app with "npm start".');

run(process.execPath, [path.join(TOOLS, 'launch.js')]);
