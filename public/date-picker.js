// Custom calendar that replaces the browser's built-in date picker. It is styled entirely with the
// app's theme variables, and days after the input's max (for example, days that haven't come yet when
// logging time) are shown faintly instead of blocked out.
//
// DatePicker.attach(input) on an <input type="date">: the input is hidden but keeps holding the value
// (code reads and sets input.value as before), and a button showing the date takes its place. Browsers
// treat date fields differently (Firefox opens its own picker on any click in one and won't focus a
// read-only one), but a button behaves the same everywhere. Clicking the button (or Enter / Space /
// Alt+Down) opens the calendar; choosing a day, Today, or Clear (only for fields that weren't required)
// sets the value and fires 'input' and 'change'. Escape or clicking outside closes it unchanged.
// The hidden input drops `required` (the browser can't point at a hidden field), so callers check for a
// missing date themselves; the calendar never offers a day outside min/max.
(function () {
  const DAY = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']; // weeks start Monday, like the rest of the app

  const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parse = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  // ---------- state ----------

  let ui = null; // DOM, built on first open
  let target = null; // the <input type="date"> being edited
  const fields = new WeakMap(); // input -> { button, required }
  const fmt = (key) => parse(key)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  let month = null; // first day of the month shown
  let focused = null; // the day keyboard focus is on

  // ---------- DOM ----------

  function build() {
    const root = document.createElement('div');
    root.className = 'dp-root';
    root.popover = 'auto';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Choose a date');
    root.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav dp-prev" aria-label="Previous month">‹</button>
        <div class="dp-title" aria-live="polite"></div>
        <button type="button" class="dp-nav dp-next" aria-label="Next month">›</button>
      </div>
      <div class="dp-grid" role="grid"></div>
      <div class="dp-foot">
        <button type="button" class="dp-clear">Clear</button>
        <button type="button" class="dp-today">Today</button>
      </div>`;
    const q = (sel) => root.querySelector(sel);
    ui = { root, title: q('.dp-title'), grid: q('.dp-grid'), prev: q('.dp-prev'), next: q('.dp-next'), today: q('.dp-today'), clear: q('.dp-clear') };

    ui.prev.addEventListener('click', () => showMonth(-1));
    ui.next.addEventListener('click', () => showMonth(1));
    ui.today.addEventListener('click', () => choose(new Date()));
    ui.clear.addEventListener('click', () => setValue(''));
    ui.grid.addEventListener('keydown', onGridKey);
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // don't also close the dialog or popover underneath
      close(true);
    });
  }

  const maxDate = () => parse(target?.max);
  const minDate = () => parse(target?.min);
  const allowed = (d) => !(maxDate() && d > maxDate()) && !(minDate() && d < minDate());

  function render() {
    const today = keyOf(new Date());
    const selected = target.value;
    ui.title.textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const max = maxDate();
    const min = minDate();
    ui.next.disabled = Boolean(max) && new Date(month.getFullYear(), month.getMonth() + 1, 1) > max;
    ui.prev.disabled = Boolean(min) && addDays(month, -1) < min;
    ui.today.disabled = !allowed(parse(today));
    ui.clear.hidden = fields.get(target).required || !target.value;

    const start = addDays(month, -((month.getDay() + 6) % 7)); // the Monday on or before the 1st
    const cells = DAY.map((d) => {
      const head = document.createElement('div');
      head.className = 'dp-dow';
      head.textContent = d;
      return head;
    });
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const key = keyOf(day);
      const ok = allowed(day);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dp-day';
      b.textContent = day.getDate();
      b.dataset.key = key;
      b.tabIndex = key === keyOf(focused) ? 0 : -1;
      b.classList.toggle('dp-other', day.getMonth() !== month.getMonth());
      b.classList.toggle('dp-today-mark', key === today);
      b.classList.toggle('dp-selected', key === selected);
      b.setAttribute('aria-label', day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
      if (key === selected) b.setAttribute('aria-selected', 'true');
      if (ok) b.addEventListener('click', () => choose(day));
      else {
        // Not disabled, so the tooltip still shows; it just can't be chosen.
        b.classList.add('dp-unavailable');
        b.setAttribute('aria-disabled', 'true');
        b.title = max && day > max ? 'Not available yet' : 'Not available';
      }
      cells.push(b);
    }
    ui.grid.replaceChildren(...cells);
  }

  function showMonth(step) {
    month = new Date(month.getFullYear(), month.getMonth() + step, 1);
    // Keep keyboard focus on a choosable day in the new month.
    const day = Math.min(focused.getDate(), new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate());
    focused = new Date(month.getFullYear(), month.getMonth(), day);
    if (!allowed(focused)) focused = maxDate() && focused > maxDate() ? maxDate() : minDate() || focused;
    render();
  }

  function onGridKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      // Choose here rather than through the click these keys make, which browsers don't all send.
      e.preventDefault();
      return choose(focused);
    }
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = null;
    if (moves[e.key] != null) next = addDays(focused, moves[e.key]);
    else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const step = e.key === 'PageUp' ? -1 : 1;
      next = new Date(focused.getFullYear(), focused.getMonth() + step, Math.min(focused.getDate(), 28));
    } else if (e.key === 'Home') next = addDays(focused, -((focused.getDay() + 6) % 7));
    else if (e.key === 'End') next = addDays(focused, 6 - ((focused.getDay() + 6) % 7));
    if (!next) return;
    e.preventDefault();
    if (!allowed(next)) return;
    focused = next;
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) month = new Date(next.getFullYear(), next.getMonth(), 1);
    render();
    ui.grid.querySelector(`[data-key="${keyOf(focused)}"]`)?.focus();
  }

  // ---------- position ----------

  function position() {
    const r = fields.get(target).button.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = ui.root;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6); // flip above if it won't fit below
    ui.root.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    ui.root.style.top = `${top}px`;
  }

  // ---------- open / close ----------

  function open(input, { focusGrid = false } = {}) {
    if (!ui) build();
    if (target === input && isOpen()) return;
    close(false);
    target = input;
    const picked = parse(input.value);
    focused = picked && allowed(picked) ? picked : maxDate() && new Date() > maxDate() ? maxDate() : new Date();
    focused = new Date(focused.getFullYear(), focused.getMonth(), focused.getDate());
    month = new Date(focused.getFullYear(), focused.getMonth(), 1);
    render();
    // Inside an open modal dialog (or popover), host the calendar there so it isn't inert or dismissed.
    (input.closest('dialog, [popover]') || document.body).append(ui.root);
    ui.root.showPopover();
    position();
    if (focusGrid) ui.grid.querySelector('[tabindex="0"]')?.focus();
  }

  const isOpen = () => Boolean(ui?.root.matches(':popover-open'));

  function close(refocus) {
    if (!isOpen()) return;
    ui.root.hidePopover();
    const button = target && fields.get(target).button;
    if (refocus && button?.isConnected) button.focus({ preventScroll: true });
  }

  function choose(day) {
    if (allowed(day)) setValue(keyOf(day));
  }

  function setValue(value) {
    target.value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
  }

  function attach(input) {
    const label = input.getAttribute('aria-label') || input.labels?.[0]?.firstChild?.textContent?.trim() || 'Date';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dp-field';
    button.setAttribute('aria-haspopup', 'dialog');
    fields.set(input, { button, required: input.required });
    input.required = false;
    input.hidden = true;
    input.after(button);

    // Show the input's value on the button, whenever code or the calendar sets it, or the form resets.
    const show = () => {
      const text = fmt(input.value);
      button.textContent = text || 'Choose a date';
      button.classList.toggle('dp-empty', !text);
      button.setAttribute('aria-label', `${label}: ${text || 'not set'}`);
    };
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => native.get.call(input),
      set: (v) => {
        native.set.call(input, v);
        show();
      },
    });
    input.form?.addEventListener('reset', () => setTimeout(show));
    show();

    // Mouse clicks open it. Keys are handled here rather than through the click they'd make, because
    // browsers differ on that (Firefox doesn't always turn Enter on this button into a click).
    button.addEventListener('click', (e) => {
      if (e.detail === 0) return; // a keyboard click: handled on keydown
      isOpen() && target === input ? close(true) : open(input);
    });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
        e.preventDefault();
        open(input, { focusGrid: true });
      } else if (e.key === 'Escape' && isOpen() && target === input) {
        e.preventDefault();
        e.stopPropagation(); // close only the calendar, not the dialog or popover around it
        close(true);
      }
    });
    // A click on the field's label (which targets the hidden input) opens it too.
    input.addEventListener('click', () => open(input));
  }

  window.DatePicker = { attach };
})();
