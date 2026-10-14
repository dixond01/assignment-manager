// Theme definitions and color math, shared by the browser (window.ThemeCore) and the server (require).
// A theme is six user-chosen colors; everything else the UI needs is derived from them.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThemeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLOR_KEYS = ['background', 'surface', 'text', 'primary', 'secondary', 'tertiary'];

  const COLOR_LABELS = {
    background: 'Background',
    surface: 'Surface',
    text: 'Text',
    primary: 'Primary',
    secondary: 'Secondary',
    tertiary: 'Tertiary',
  };

  // Where each color shows up, for the theme editor.
  const COLOR_HINTS = {
    background: 'page behind everything',
    surface: 'cards, dialogs, planner page',
    text: 'all text',
    primary: 'buttons, checkboxes, outlines',
    secondary: 'today, sparkles',
    tertiary: 'soft fills, done items',
  };

  const LIGHT = { background: '#f6f7f9', surface: '#ffffff', text: '#1c2026', primary: '#0b5fff', secondary: '#f2b705', tertiary: '#d5dae1' };
  const DARK = { background: '#15181c', surface: '#1e2227', text: '#e6e8eb', primary: '#5b8cff', secondary: '#c99a1e', tertiary: '#3c434c' };

  // "System" has no colors of its own: it follows the OS light/dark setting.
  const BUILTIN_THEMES = [
    { id: 'system', name: 'System', builtIn: true, colors: null },
    { id: 'light', name: 'Light', builtIn: true, colors: LIGHT },
    { id: 'dark', name: 'Dark', builtIn: true, colors: DARK },
    {
      id: 'navy',
      name: 'Navy',
      builtIn: true,
      colors: { background: '#eef3f9', surface: '#ffffff', text: '#10233a', primary: '#002e5d', secondary: '#0062b8', tertiary: '#b9cde5' },
    },
  ];
  const DEFAULT_THEME_ID = 'system';

  const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

  // t = 0 gives a, t = 1 gives b.
  function mix(a, b, t) {
    const x = parse(a);
    const y = parse(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * t));
  }

  function luminance(hex) {
    const [r, g, b] = parse(hex).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // WCAG contrast ratio, 1 to 21.
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  }

  const readableOn = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111');

  // CSS custom properties for a set of six colors.
  function themeVars(colors) {
    const dark = luminance(colors.background) < 0.2;
    return {
      '--bg': colors.background,
      '--surface': colors.surface,
      '--surface-2': mix(colors.surface, colors.tertiary, 0.45),
      // Input fields sit on the surface (dialogs), so tint the surface rather than using the background.
      '--field': mix(colors.surface, colors.text, 0.04),
      '--border': mix(colors.surface, colors.text, 0.15),
      '--text': colors.text,
      '--muted': mix(colors.text, colors.surface, 0.4),
      '--accent': colors.primary,
      '--accent-text': readableOn(colors.primary),
      '--today': mix(colors.surface, colors.secondary, 0.16),
      '--today-line': colors.secondary,
      '--done-bg': mix(colors.surface, colors.tertiary, 0.25),
      '--danger': dark ? '#ef6b6b' : '#c62828',
      '--warn': dark ? '#f0a742' : '#b26a00',
      '--ok': dark ? '#6cc070' : '#2e7d32',
      'color-scheme': dark ? 'dark' : 'light',
    };
  }

  const VAR_NAMES = Object.keys(themeVars(LIGHT));

  // The colors a theme actually shows. System resolves to Light or Dark.
  const resolveColors = (theme, prefersDark = false) => theme.colors || (prefersDark ? DARK : LIGHT);

  // Readability problems worth warning about (not enforced).
  function contrastWarnings(colors) {
    const warnings = [];
    if (contrast(colors.text, colors.background) < 4.5) warnings.push('Text is hard to read on the background.');
    if (contrast(colors.text, colors.surface) < 4.5) warnings.push('Text is hard to read on the surface color.');
    return warnings;
  }

  // Returns an error message, or null if the theme fields are valid.
  function validateTheme({ name, colors }) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) return 'Theme name must be 1–40 characters.';
    if (!colors || typeof colors !== 'object') return 'Theme colors are missing.';
    for (const key of COLOR_KEYS) if (!isHex(colors[key])) return `${COLOR_LABELS[key]} must be a #rrggbb color.`;
    return null;
  }

  return {
    COLOR_KEYS,
    COLOR_LABELS,
    COLOR_HINTS,
    BUILTIN_THEMES,
    DEFAULT_THEME_ID,
    VAR_NAMES,
    isHex,
    mix,
    contrast,
    themeVars,
    resolveColors,
    contrastWarnings,
    validateTheme,
  };
});
