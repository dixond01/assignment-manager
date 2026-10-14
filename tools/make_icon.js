// Draw the app icon in a theme's colors.
//
//   node tools/make_icon.js [themeId]
//       Regenerate the static fallback icons public/icon.ico and public/icon.png from a built-in
//       theme (default: byu). The running app redraws the tab and desktop icons for the active theme.
//
//   node tools/make_icon.js --colors '<json>' --ico <path>
//       Write one .ico in the given colors ({ surface, primary, secondary, tertiary }). The server runs
//       this in a child process because drawing every size takes a few seconds.
const fs = require('fs');
const path = require('path');
const ThemeCore = require('../public/theme-core.js');
const { iconPng, iconIco } = require('../lib/icon-file.js');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--colors')) {
  const colors = JSON.parse(flag('--colors'));
  const ico = flag('--ico');
  if (!ico) {
    console.error('--ico <path> is required with --colors');
    process.exit(1);
  }
  fs.writeFileSync(ico, iconIco(colors));
} else {
  const id = args[0] || 'byu';
  const theme = ThemeCore.BUILTIN_THEMES.find((t) => t.id === id);
  if (!theme) {
    console.error(`Unknown theme "${id}". Built-in themes: ${ThemeCore.BUILTIN_THEMES.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }
  const colors = ThemeCore.resolveColors(theme);
  const out = path.join(__dirname, '..', 'public');
  fs.writeFileSync(path.join(out, 'icon.ico'), iconIco(colors));
  fs.writeFileSync(path.join(out, 'icon.png'), iconPng(256, colors));
  console.log(`Wrote public/icon.ico and public/icon.png (${theme.name} colors)`);
}
