// Custom color picker that replaces the browser's built-in one. It is styled entirely with the
// app's theme variables, so it matches the active (or live-previewed) theme.
//
// ColorPicker.attach(input) on an <input type="color">: the input keeps holding the value. While the
// picker is open it sets input.value and fires 'input' (so live previews update); Apply or clicking
// outside fires 'change'; Cancel or Escape restores the original value, fires 'input', then
// 'colorpicker:cancel'. 'colorpicker:open' fires when it opens.
(function () {
  const MAX_SAVED = 24;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- color math ----------

  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbToHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

  // Returns [h, s, l] with s and l in 0-100. h is null for grays (no hue).
  function rgbToHsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [null, 0, l * 100];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s * 100, l * 100];
  }

  function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return [f(0), f(8), f(4)];
  }

  // ---------- state ----------

  let ui = null; // DOM, built on first open
  let target = null; // the <input type="color"> being edited
  let original = ''; // its value when the picker opened
  let finished = true;
  let hsl = { h: 0, s: 100, l: 50 }; // kept as HSL so hue survives grays
  let saved = null; // saved palette, loaded from the server on first open

  const currentRgb = () => hslToRgb(hsl.h, hsl.s, hsl.l);
  const currentHex = () => rgbToHex(currentRgb());

  function setHex(hex) {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    hsl = { h: h ?? hsl.h, s, l };
  }

  // ---------- DOM ----------

  const EYEDROPPER_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';

  function build() {
    const root = document.createElement('div');
    root.className = 'color-picker';
    root.popover = 'auto';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Color picker');
    root.innerHTML = `
      <div class="cp-plane" role="slider" tabindex="0" aria-label="Hue (left to right) and luminosity (top to bottom)">
        <div class="cp-thumb"></div>
      </div>
      <div class="cp-label">Saturation</div>
      <div class="cp-slider" role="slider" tabindex="0" aria-label="Saturation" aria-valuemin="0" aria-valuemax="100">
        <div class="cp-thumb"></div>
      </div>
      <div class="cp-row">
        <div class="cp-preview" title="Original and new color"><span class="cp-old"></span><span class="cp-new"></span></div>
        <label class="cp-field cp-hex"><span>Hex</span><input data-k="hex" maxlength="7" spellcheck="false" autocomplete="off" /></label>
        <button type="button" class="cp-eyedropper" title="Pick a color from the screen" aria-label="Pick a color from the screen">${EYEDROPPER_ICON}</button>
      </div>
      <div class="cp-grid">
        <label class="cp-field"><span>H</span><input data-k="h" type="number" min="0" max="360" aria-label="Hue" /></label>
        <label class="cp-field"><span>S</span><input data-k="s" type="number" min="0" max="100" aria-label="Saturation" /></label>
        <label class="cp-field"><span>L</span><input data-k="l" type="number" min="0" max="100" aria-label="Luminosity" /></label>
        <label class="cp-field"><span>R</span><input data-k="r" type="number" min="0" max="255" aria-label="Red" /></label>
        <label class="cp-field"><span>G</span><input data-k="g" type="number" min="0" max="255" aria-label="Green" /></label>
        <label class="cp-field"><span>B</span><input data-k="b" type="number" min="0" max="255" aria-label="Blue" /></label>
      </div>
      <div class="cp-saved-head">
        <span class="cp-label">Saved colors</span>
        <button type="button" class="cp-save">+ Save</button>
      </div>
      <div class="cp-saved"></div>
      <div class="cp-actions">
        <button type="button" class="cp-cancel">Cancel</button>
        <span class="spacer"></span>
        <button type="button" class="primary cp-apply">Apply</button>
      </div>`;

    const q = (sel) => root.querySelector(sel);
    ui = {
      root,
      plane: q('.cp-plane'),
      planeThumb: q('.cp-plane .cp-thumb'),
      slider: q('.cp-slider'),
      sliderThumb: q('.cp-slider .cp-thumb'),
      oldSwatch: q('.cp-old'),
      newSwatch: q('.cp-new'),
      fields: [...root.querySelectorAll('input[data-k]')],
      saved: q('.cp-saved'),
      eyedropper: q('.cp-eyedropper'),
    };

    // Hue gradient: x = hue, y = luminosity (100 at the top, 0 at the bottom).
    drag(ui.plane, (x, y) => {
      hsl.h = x * 360;
      hsl.l = 100 - y * 100;
    });
    keys(ui.plane, (dx, dy) => {
      hsl.h = clamp(hsl.h + dx, 0, 360);
      hsl.l = clamp(hsl.l - dy, 0, 100);
    });
    drag(ui.slider, (x) => (hsl.s = x * 100));
    keys(ui.slider, (dx, dy) => (hsl.s = clamp(hsl.s + dx - dy, 0, 100)));

    for (const input of ui.fields) {
      input.addEventListener('input', () => editField(input));
      input.addEventListener('blur', () => render()); // tidy partial or out-of-range entries
    }

    if ('EyeDropper' in window) {
      ui.eyedropper.addEventListener('click', async () => {
        try {
          const { sRGBHex } = await new window.EyeDropper().open();
          if (/^#[0-9a-f]{6}$/i.test(sRGBHex)) {
            setHex(sRGBHex.toLowerCase());
            update();
          }
        } catch {
          // Cancelled with Escape.
        }
      });
    } else {
      ui.eyedropper.hidden = true;
    }

    q('.cp-save').addEventListener('click', () => {
      const hex = currentHex();
      saved = [hex, ...saved.filter((c) => c !== hex)].slice(0, MAX_SAVED);
      persistSaved();
    });
    q('.cp-apply').addEventListener('click', () => finish(true));
    q('.cp-cancel').addEventListener('click', () => finish(false));
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // don't also close the dialog underneath
      finish(false);
    });
    // Light dismiss (clicking outside) keeps the color.
    root.addEventListener('toggle', (e) => e.newState === 'closed' && finish(true));
  }

  // Pointer dragging on an area; onMove gets x and y as 0-1 within it.
  function drag(el, onMove) {
    const handle = (e) => {
      const r = el.getBoundingClientRect();
      onMove(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
      update();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.focus();
      el.setPointerCapture(e.pointerId);
      handle(e);
      const up = () => {
        el.removeEventListener('pointermove', handle);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', handle);
      el.addEventListener('pointerup', up);
    });
  }

  // Arrow keys: 1 step, or 10 with Shift. onStep gets (dx, dy) with down positive.
  function keys(el, onStep) {
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!moves[e.key]) return;
      e.preventDefault();
      onStep(...moves[e.key]);
      update();
    });
  }

  function editField(input) {
    const key = input.dataset.k;
    const value = input.value.trim();
    if (key === 'hex') {
      const m = value.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
      if (!m) return;
      const digits = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      setHex('#' + digits.toLowerCase());
    } else {
      const n = Number(value);
      if (value === '' || !Number.isFinite(n)) return;
      if (key === 'h' || key === 's' || key === 'l') {
        hsl[key] = clamp(n, 0, key === 'h' ? 360 : 100);
      } else {
        const rgb = currentRgb();
        rgb['rgb'.indexOf(key)] = clamp(n, 0, 255);
        setHex(rgbToHex(rgb));
      }
    }
    update(input);
  }

  // Redraw everything from hsl. `skip` is a field the user is typing in (left untouched).
  function render(skip) {
    const { h, s, l } = hsl;
    const rgb = currentRgb();
    const hex = rgbToHex(rgb);
    const hues = [0, 60, 120, 180, 240, 300, 360].map((x) => `hsl(${x} ${s}% 50%)`).join(', ');
    ui.plane.style.background = `linear-gradient(to bottom, #fff, rgb(255 255 255 / 0) 50%, rgb(0 0 0 / 0) 50%, #000), linear-gradient(to right, ${hues})`;
    ui.planeThumb.style.left = `${(h / 360) * 100}%`;
    ui.planeThumb.style.top = `${100 - l}%`;
    ui.planeThumb.style.background = hex;
    ui.plane.setAttribute('aria-valuetext', `Hue ${Math.round(h)} degrees, luminosity ${Math.round(l)}%`);
    ui.slider.style.background = `linear-gradient(to right, hsl(${h} 0% ${l}%), hsl(${h} 100% ${l}%))`;
    ui.sliderThumb.style.left = `${s}%`;
    ui.sliderThumb.style.background = hex;
    ui.slider.setAttribute('aria-valuenow', Math.round(s));
    ui.newSwatch.style.background = hex;
    const values = { hex, h: Math.round(h), s: Math.round(s), l: Math.round(l), r: Math.round(rgb[0]), g: Math.round(rgb[1]), b: Math.round(rgb[2]) };
    for (const input of ui.fields) if (input !== skip) input.value = values[input.dataset.k];
    return hex;
  }

  // Redraw, then push the color into the target input.
  function update(skip) {
    const hex = render(skip);
    if (target && target.value !== hex) {
      target.value = hex;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ---------- saved colors ----------

  async function loadSaved() {
    if (saved) return;
    try {
      saved = (await (await fetch('/api/saved-colors')).json()).colors;
    } catch {
      saved = [];
    }
  }

  async function persistSaved() {
    renderSaved();
    try {
      const res = await fetch('/api/saved-colors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ colors: saved }),
      });
      if (res.ok) saved = (await res.json()).colors;
    } catch {
      // Keep the local list; it'll save with the next change.
    }
    renderSaved();
  }

  function renderSaved() {
    if (!saved.length) {
      ui.saved.replaceChildren(Object.assign(document.createElement('small'), { textContent: 'Save colors here to reuse them.' }));
      return;
    }
    ui.saved.replaceChildren(
      ...saved.map((hex) => {
        const remove = () => {
          saved = saved.filter((c) => c !== hex);
          persistSaved();
        };
        const swatch = Object.assign(document.createElement('button'), { type: 'button', className: 'cp-swatch', title: `${hex} (Delete to remove)` });
        swatch.style.background = hex;
        swatch.setAttribute('aria-label', `Use ${hex}`);
        swatch.addEventListener('click', () => {
          setHex(hex);
          update();
        });
        swatch.addEventListener('keydown', (e) => (e.key === 'Delete' || e.key === 'Backspace') && (e.preventDefault(), remove()));
        const x = Object.assign(document.createElement('button'), { type: 'button', className: 'cp-remove', textContent: '×', tabIndex: -1 });
        x.setAttribute('aria-label', `Remove ${hex}`);
        x.addEventListener('click', remove);
        const item = document.createElement('span');
        item.className = 'cp-saved-item';
        item.append(swatch, x);
        return item;
      }),
    );
  }

  // ---------- open / close ----------

  function position(anchor) {
    const r = anchor.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = ui.root;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6); // flip above if it won't fit below
    ui.root.style.top = `${top}px`;
    ui.root.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
  }

  function open(input) {
    if (!ui) build();
    if (!finished) finish(true);
    target = input;
    original = input.value;
    finished = false;
    setHex(original);
    render();
    ui.oldSwatch.style.background = original;
    // Inside an open modal dialog, everything outside it is inert, so host the popover there.
    const dialog = input.closest('dialog');
    (dialog || document.body).append(ui.root);
    if (dialog) dialog.addEventListener('close', () => finish(false), { once: true });
    ui.root.showPopover();
    position(input.closest('.color-field') || input);
    input.dispatchEvent(new Event('colorpicker:open'));
    ui.plane.focus();
    loadSaved().then(renderSaved);
  }

  function finish(apply) {
    if (finished) return;
    finished = true;
    const input = target;
    if (apply) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      if (input.value !== original) {
        input.value = original;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('colorpicker:cancel'));
    }
    if (ui.root.matches(':popover-open')) ui.root.hidePopover();
    if (input.isConnected) input.focus({ preventScroll: true });
  }

  function attach(input) {
    // Prevent the browser's own picker; open ours instead (click, or Enter/Space when focused).
    input.addEventListener('click', (e) => {
      e.preventDefault();
      open(input);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open(input);
    });
  }

  window.ColorPicker = { attach };
})();
