// The app icon (spiral checklist planner with sparkles) drawn in a theme's colors.
// Shared by the browser (window.IconCore: favicon, theme previews) and the server (require: .ico for the
// desktop shortcut). The backdrop is transparent so the taskbar/tab color shows through.
// Shapes are signed-distance tests, anti-aliased by supersampling.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function sdRoundRect(x, y, x0, y0, x1, y1, r) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const dx = Math.abs(x - cx) - ((x1 - x0) / 2 - r);
    const dy = Math.abs(y - cy) - ((y1 - y0) / 2 - r);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  }

  function sdSegment(x, y, ax, ay, bx, by) {
    const px = x - ax;
    const py = y - ay;
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy)));
    return Math.hypot(px - vx * t, py - vy * t);
  }

  const sparkle = (x, y, cx, cy, r) => Math.sqrt(Math.abs(x - cx)) + Math.sqrt(Math.abs(y - cy)) <= Math.sqrt(r);

  // Planner group (spiral rings + page) spans x 0.15-0.85, y 0.12-0.88: centered on the canvas.
  const PAGE = [0.24, 0.12, 0.85, 0.88];
  const RING_X = [0.15, 0.32];
  const OUTLINE = 0.035;

  // Which theme role paints unit coordinate (x, y): 'surface' | 'primary' | 'secondary' | 'tertiary' | null.
  function roleAt(x, y) {
    let role = null;
    const page = sdRoundRect(x, y, ...PAGE, 0.07);
    if (page <= 0) role = page > -OUTLINE ? 'primary' : 'surface';
    // Spiral rings along the page's left edge.
    for (const ry of [0.25, 0.417, 0.583, 0.75]) {
      if (sdRoundRect(x, y, RING_X[0], ry - 0.026, RING_X[1], ry + 0.026, 0.026) <= 0) role = 'secondary';
    }
    // Checklist: two checked rows, one open.
    [0.31, 0.5, 0.69].forEach((ry, k) => {
      const done = k < 2;
      const box = sdRoundRect(x, y, 0.36, ry - 0.06, 0.48, ry + 0.06, 0.026);
      if (done && box <= 0) {
        role = 'primary';
        const tick = Math.min(sdSegment(x, y, 0.387, ry, 0.413, ry + 0.026), sdSegment(x, y, 0.413, ry + 0.026, 0.455, ry - 0.026));
        if (tick <= 0.013) role = 'surface';
      } else if (!done && Math.abs(box + 0.008) <= 0.015) {
        role = 'primary';
      }
      if (sdSegment(x, y, 0.55, ry, 0.73, ry) <= 0.022) role = done ? 'tertiary' : 'secondary';
    });
    // Sparkles in the open corners.
    for (const [sx, sy, r] of [[0.89, 0.1, 0.075], [0.93, 0.3, 0.035], [0.11, 0.89, 0.07]]) {
      if (sparkle(x, y, sx, sy, r)) role = 'secondary';
    }
    return role;
  }

  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  // RGBA pixels (Uint8ClampedArray, size*size*4) for theme colors { surface, primary, secondary, tertiary }.
  function renderIcon(size, colors, supersample = 4) {
    const rgb = {};
    for (const role of ['surface', 'primary', 'secondary', 'tertiary']) rgb[role] = parse(colors[role]);
    const out = new Uint8ClampedArray(size * size * 4);
    const n = supersample * supersample;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let hits = 0;
        for (let sy = 0; sy < supersample; sy++) {
          for (let sx = 0; sx < supersample; sx++) {
            const role = roleAt((px + (sx + 0.5) / supersample) / size, (py + (sy + 0.5) / supersample) / size);
            if (!role) continue;
            const c = rgb[role];
            r += c[0];
            g += c[1];
            b += c[2];
            hits++;
          }
        }
        const i = (py * size + px) * 4;
        if (hits) {
          out[i] = r / hits;
          out[i + 1] = g / hits;
          out[i + 2] = b / hits;
          out[i + 3] = Math.round((255 * hits) / n);
        }
      }
    }
    return out;
  }

  return { renderIcon };
});
