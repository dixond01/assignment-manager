// Open the Assignment Manager on any OS: start the server in the background if it isn't already
// running, then open the app in the default browser. The server stops itself about a minute after
// its last tab closes. This is what `npm start` and the macOS/Linux shortcuts run.
//
//   node tools/launch.js [--no-browser]
//
// Server output goes to data/server.log and data/server-error.log. PORT overrides the port (3456).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3456;
const URL = `http://localhost:${PORT}`;

// Any HTTP response means something is already serving the app. Ask 127.0.0.1, not localhost:
// the server listens on IPv4 only, and some systems try IPv6 (::1) first.
function isRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function startServer() {
  const data = path.join(APP, 'data');
  fs.mkdirSync(data, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT) },
    detached: true, // keeps running after this launcher exits
    windowsHide: true,
    stdio: ['ignore', fs.openSync(path.join(data, 'server.log'), 'w'), fs.openSync(path.join(data, 'server-error.log'), 'w')],
  });
  child.unref();
}

function openBrowser() {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', URL]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [URL]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open ${URL} in your browser.`));
  child.unref();
}

(async () => {
  if (!(await isRunning())) {
    startServer();
    // Wait up to ~10 seconds for it to start listening.
    for (let i = 0; i < 50 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 200));
    if (!(await isRunning())) {
      console.error(`The server didn't start. See ${path.join('data', 'server-error.log')}.`);
      process.exit(1);
    }
  }
  console.log(`Assignment Manager is running at ${URL}`);
  if (!process.argv.includes('--no-browser')) openBrowser();
})();
