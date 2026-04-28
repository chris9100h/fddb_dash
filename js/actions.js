function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' '+type : '');
  if (type === 'error') haptic('error');
  clearTimeout(toastTimer);
  requestAnimationFrame(() => { t.classList.add('show'); });
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ══════════════════════════════════════
   FULL-PAGE SCREENSHOT
   Captures the active view at its FULL
   scroll height — not just the viewport.
   ══════════════════════════════════════ */
async function takeFullScreenshot() {
  if (typeof html2canvas === 'undefined') {
    showToast('Screenshot-Lib lädt noch…', 'error');
    return;
  }
  const activeView = document.querySelector('.view.active');
  if (!activeView) { showToast('Keine Ansicht aktiv', 'error'); return; }

  const label = (activeView.querySelector('.large-title')?.textContent || 'page').trim();
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `fddb-${label.toLowerCase()}-${dateStr}.png`;

  // Overlay during capture
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:9999;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    color:#fff;font-family:inherit;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)`;
  overlay.innerHTML = `
    <div style="width:48px;height:48px;border:3px solid rgba(255,255,255,.2);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite"></div>
    <div style="font-size:.9rem;color:#fff">Screenshot wird erstellt…</div>
    <div style="font-size:.7rem;color:rgba(255,255,255,.5);letter-spacing:.08em;text-transform:uppercase">bitte kurz warten</div>
  `;
  document.body.appendChild(overlay);

  // ─── Strategy: deep-clone the active view into an offscreen
  // container where it renders in natural document flow. Canvas
  // charts need special treatment — we copy their pixel output
  // onto <img> replacements before cloning.
  // ───────────────────────────────────────────────────────────

  // 0) If we're capturing the Today view and merge-mode is off,
  //    turn it on so the screenshot always shows the consolidated
  //    (merged) servings layout. Restore after capture in `finally`.
  const wasMergeOff = (activeView.id === 'viewMain') && !mergeServings;
  if (wasMergeOff) {
    toggleMergeServings();
    // renderDashboard inside the toggle is synchronous for already-
    // loaded data, so the clone below will pick up the merged DOM.
  }

  // 1) Snapshot all live <canvas> elements in the active view as
  //    data URLs, keyed by source canvas id.
  const liveCanvases = activeView.querySelectorAll('canvas');
  const canvasSnapshots = new Map();
  liveCanvases.forEach((c, i) => {
    try {
      const key = c.id || ('__cx_' + i);
      if (!c.id) c.setAttribute('data-cx-key', key);
      else c.setAttribute('data-cx-key', c.id);
      canvasSnapshots.set(c.getAttribute('data-cx-key'), {
        url: c.toDataURL('image/png'),
        w: c.offsetWidth, h: c.offsetHeight,
      });
    } catch (e) { console.warn('canvas snapshot failed', e); }
  });

  // 2) Build the offscreen capture stage — always use mobile-sized
  //    column layout regardless of desktop grid, so the full content
  //    renders top-to-bottom without sticky/grid interference.
  const CAPTURE_WIDTH = 460;
  const stage = document.createElement('div');
  stage.style.cssText = `
    position: fixed; left: -99999px; top: 0;
    width: ${CAPTURE_WIDTH}px;
    background: ${getComputedStyle(document.body).backgroundColor || '#0a0a0b'};
    z-index: -1; pointer-events: none;
  `;
  // Tag the stage so our override CSS targets only clones inside it
  stage.id = '__screenshotStage';

  const clone = activeView.cloneNode(true);
  // Remove IDs from clone subtree to avoid duplicate-ID conflicts
  // with the live DOM (also neutralises any #id-based CSS selectors).
  clone.removeAttribute('id');
  // Strip the .view class so .view/.view.active rules don't apply.
  clone.className = 'screenshot-clone';

  // Remove header action buttons from the clone — they have accent
  // glows (box-shadow) that render as odd orange blobs in capture.
  clone.querySelectorAll('.header-actions, .date-picker-btn').forEach(el => el.remove());

  // Fix the adherence ring for html2canvas capture.
  // html2canvas has well-known issues rendering SVG <circle> strokes
  // with stroke-dasharray/dashoffset — the stroke ends up offset from
  // the circle geometry, and CSS transforms on the SVG compound the
  // problem, throwing both ring and centered text off-position.
  // Solution: rip the SVG out entirely and rebuild the ring as a pure
  // box-model conic-gradient donut. No SVG, no strokes, no transforms
  // → pixel-perfect capture regardless of browser quirks.
  clone.querySelectorAll('.hero-ring-wrap').forEach(wrap => {
    const liveFg = document.getElementById('heroRingFg');
    const svg = wrap.querySelector('.hero-ring');
    if (!svg) return;
    const fg = svg.querySelector('.ring-fg');
    const r = parseFloat(fg?.getAttribute('r')) || 52;
    const circ = 2 * Math.PI * r;
    const cs = (liveFg || fg) ? getComputedStyle(liveFg || fg) : null;
    const liveOffset = cs ? parseFloat(cs.strokeDashoffset) || 0 : 0;
    const progress = Math.max(0, Math.min(1, 1 - (liveOffset / circ)));
    const rootCs = getComputedStyle(document.documentElement);
    const accent = rootCs.getPropertyValue('--accent').trim() || '#ff6b35';
    const strokeColor = (cs && cs.stroke && cs.stroke !== 'none' && cs.stroke !== 'rgb(0, 0, 0)') ? cs.stroke : accent;

    // Rebuild the ring as an SVG <path> arc instead of a stroked <circle>
    // with dasharray/dashoffset. html2canvas mis-renders dashed strokes,
    // and does NOT support conic-gradient at all — so a plain filled arc
    // path is the only reliable route. Uses the donut formula:
    //   outer circle (r=55, cx=60, cy=60) swept for `progress` of 360°,
    //   minus inner circle (r=45) → 10px-thick ring, matching original.
    const SIZE = 120;
    const CX = 60, CY = 60;
    const R_OUT = 55;   // outer edge of ring
    const R_IN  = 45;   // inner edge of ring (→ 10px stroke width)
    const bgTrack = 'rgba(255,255,255,.06)';

    const ns = 'http://www.w3.org/2000/svg';
    const newSvg = document.createElementNS(ns, 'svg');
    newSvg.setAttribute('width', SIZE);
    newSvg.setAttribute('height', SIZE);
    newSvg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    newSvg.setAttribute('class', 'hero-ring capture-ring');
    newSvg.style.cssText = 'display:block;width:100%;height:100%;position:absolute;inset:0;transform:none;';

    // Background track: two concentric circles via even-odd fill.
    const track = document.createElementNS(ns, 'path');
    track.setAttribute('d',
      `M ${CX-R_OUT},${CY} a ${R_OUT},${R_OUT} 0 1,0 ${R_OUT*2},0 a ${R_OUT},${R_OUT} 0 1,0 ${-R_OUT*2},0 Z ` +
      `M ${CX-R_IN},${CY} a ${R_IN},${R_IN} 0 1,0 ${R_IN*2},0 a ${R_IN},${R_IN} 0 1,0 ${-R_IN*2},0 Z`
    );
    track.setAttribute('fill-rule', 'evenodd');
    track.setAttribute('fill', bgTrack);
    newSvg.appendChild(track);

    if (progress > 0.0001) {
      // Clamp to just under 1 turn so the arc endpoints don't collapse.
      const p = Math.min(progress, 0.9999);
      const angle = p * 2 * Math.PI;
      // Start at 12 o'clock (top), sweep clockwise.
      const startX = CX, startY = CY - R_OUT;
      const endX   = CX + R_OUT * Math.sin(angle);
      const endY   = CY - R_OUT * Math.cos(angle);
      const innerStartX = CX + R_IN * Math.sin(angle);
      const innerStartY = CY - R_IN * Math.cos(angle);
      const innerEndX   = CX, innerEndY = CY - R_IN;
      const largeArc = p > 0.5 ? 1 : 0;

      const arc = document.createElementNS(ns, 'path');
      arc.setAttribute('d',
        `M ${startX} ${startY} ` +
        `A ${R_OUT} ${R_OUT} 0 ${largeArc} 1 ${endX} ${endY} ` +
        `L ${innerStartX} ${innerStartY} ` +
        `A ${R_IN} ${R_IN} 0 ${largeArc} 0 ${innerEndX} ${innerEndY} ` +
        `Z`
      );
      arc.setAttribute('fill', strokeColor);
      newSvg.appendChild(arc);
    }

    svg.replaceWith(newSvg);
  });

  // Replace the date strip with a big, readable date headline for the
  // currently-active date. Much cleaner in a screenshot than a row
  // of calendar pills.
  const dateStrip = clone.querySelector('.date-strip-wrap');
  if (dateStrip) {
    const activeDateStr = (typeof currentDate !== 'undefined' && currentDate)
      ? currentDate
      : (document.getElementById('dateInput')?.value || new Date().toISOString().slice(0, 10));
    const d = new Date(activeDateStr + 'T00:00:00');
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
    const day     = d.getDate();
    const month   = d.toLocaleDateString('en-US', { month: 'long' });
    const year    = d.getFullYear();
    const bigDate = document.createElement('div');
    bigDate.style.cssText = `
      display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;
      padding: 6px 0 2px;
      font-family: 'Bebas Neue', sans-serif;
      letter-spacing: .02em;
    `;
    bigDate.innerHTML = `
      <span style="font-size:2rem;line-height:1;color:var(--accent)">${day}</span>
      <span style="font-size:1.4rem;line-height:1;color:var(--text)">${month}</span>
      <span style="font-size:1rem;line-height:1;color:var(--text-dim);letter-spacing:.08em">${year}</span>
      <span style="font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:600;font-family:inherit;margin-left:auto">${weekday}</span>
    `;
    dateStrip.replaceWith(bigDate);
  }

  // Strip the ::before radial glow on the hero card by overriding
  // via inline marker class (handled in override CSS below).

  // Inject a scoped style that forces single-column flow, no sticky,
  // no animations, no blur, inside the capture stage only.
  // IMPORTANT: We do NOT blanket-apply max-height/overflow resets to
  // every descendant — that would expand collapsed recipes. We only
  // reset the stage root and the clone root.
  const overrideStyle = document.createElement('style');
  overrideStyle.textContent = `
    #__screenshotStage {
      animation: none !important;
      transition: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      transform: none !important;
      max-height: none !important;
      overflow: visible !important;
    }
    #__screenshotStage * {
      animation: none !important;
      transition: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      box-shadow: none !important;
      opacity: 1 !important;
    }
    #__screenshotStage .screenshot-clone {
      display: block !important;
      width: ${CAPTURE_WIDTH}px !important;
      max-width: none !important;
      position: static !important;
      opacity: 1 !important;
      transform: none !important;
    }
    #__screenshotStage .large-header {
      position: static !important;
      top: auto !important;
      margin: 0 !important;
      border-radius: 22px !important;
      padding: 22px 20px 20px !important;
      background: ${getComputedStyle(document.body).backgroundColor} !important;
      border-bottom: 1px solid var(--border) !important;
    }
    #__screenshotStage .screenshot-clone {
      padding-top: 18px !important;
      padding-left: 14px !important;
      padding-right: 14px !important;
    }
    #__screenshotStage .page-content {
      display: flex !important;
      flex-direction: column !important;
      grid-template-columns: none !important;
      gap: 14px !important;
      padding: 14px 16px 24px !important;
      max-width: none !important;
      margin: 0 !important;
    }
    #__screenshotStage .hero-card,
    #__screenshotStage .eaten-card,
    #__screenshotStage .meal-list {
      position: static !important;
      top: auto !important;
      grid-column: auto !important;
      grid-row: auto !important;
      width: auto !important;
    }
    /* Kill the radial glow pseudo-element on the hero card */
    #__screenshotStage .hero-card::before {
      display: none !important;
    }
    /* Ring filter drop-shadow creates a glow that bleeds; keep ring
       color but drop the filter for cleaner capture */
    #__screenshotStage .ring-fg {
      filter: none !important;
    }
    #__screenshotStage .hero-ring {
      /* No longer needed — we replaced the SVG ring with a conic-gradient
         div. Keep as a no-op in case the selector is reused. */
      transform: none !important;
    }
    #__screenshotStage .capture-ring {
      transform: none !important;
    }
    /* Force mobile ring size in screenshot — desktop @media makes it 140px
       which breaks the capture layout */
    #__screenshotStage .hero-ring-wrap {
      width: 120px !important;
      height: 120px !important;
    }
    #__screenshotStage .hero-ring-val {
      font-size: 2rem !important;
    }
    /* Preserve collapsed recipe state */
    #__screenshotStage .recipe-ingredients {
      max-height: 0 !important;
      overflow: hidden !important;
    }
    #__screenshotStage .recipe-row.open .recipe-ingredients {
      max-height: 2000px !important;
      overflow: visible !important;
    }
  `;

  // 3) Replace every cloned <canvas> with an <img> carrying the
  //    snapshot — html2canvas can't re-render chart.js canvases.
  clone.querySelectorAll('canvas').forEach(c => {
    const key = c.getAttribute('data-cx-key');
    const snap = key && canvasSnapshots.get(key);
    if (!snap) return;
    const img = document.createElement('img');
    img.src = snap.url;
    img.style.cssText = `display:block;width:${snap.w}px;height:${snap.h}px`;
    c.replaceWith(img);
  });

  stage.appendChild(clone);
  document.head.appendChild(overrideStyle);
  document.body.appendChild(stage);

  // Wait two frames for layout
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 150));

  // Measure the clone's full natural height
  const fullWidth  = Math.ceil(clone.offsetWidth  || CAPTURE_WIDTH);
  const fullHeight = Math.ceil(Math.max(clone.scrollHeight, clone.offsetHeight, stage.scrollHeight));

  try {
    const bg = getComputedStyle(document.body).backgroundColor || '#0a0a0b';
    const canvas = await html2canvas(clone, {
      backgroundColor: bg,
      scale: Math.min(2, window.devicePixelRatio || 1),
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: fullWidth,
      height: fullHeight,
      windowWidth: fullWidth,
      windowHeight: fullHeight,
      scrollX: 0,
      scrollY: 0,
      x: 0,
      y: 0,
      foreignObjectRendering: false,
    });

    canvas.toBlob(blob => {
      if (!blob) { showToast('Screenshot fehlgeschlagen', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Screenshot gespeichert: ' + filename, 'success');
    }, 'image/png');
  } catch (err) {
    console.error('Screenshot failed:', err);
    showToast('Fehler: ' + (err.message || err), 'error');
  } finally {
    // Clean up: remove the offscreen stage, style override, and overlay
    stage.remove();
    overrideStyle.remove();
    liveCanvases.forEach(c => c.removeAttribute('data-cx-key'));
    overlay.remove();
    // Restore merge-mode if we flipped it on for the capture
    if (wasMergeOff && mergeServings) toggleMergeServings();
  }
}

/* ══════════════════════════════════════
   TWEAKS
   ══════════════════════════════════════ */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#ff6b00",
  "radius": 18,
  "density": 1,
  "blur": 20,
  "hero": "ring"
}/*EDITMODE-END*/;
let tweakState = { ...TWEAK_DEFAULTS };

const ACCENT_SWATCHES = [
  { key: '#ff6b00', name: 'Orange' },
  { key: '#ff453a', name: 'Red' },
  { key: '#30d158', name: 'Green' },
  { key: '#0a84ff', name: 'Blue' },
  { key: '#bf5af2', name: 'Purple' },
];

function applyTweaks() {
  const root = document.documentElement;
  root.style.setProperty('--accent', tweakState.accent);
  root.style.setProperty('--orange', tweakState.accent);
  // soft variant: 14% alpha
  const hex = tweakState.accent.replace('#','');
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  root.style.setProperty('--accent-soft', `rgba(${r},${g},${b},.14)`);
  root.style.setProperty('--orange-soft', `rgba(${r},${g},${b},.14)`);
  root.style.setProperty('--orange-glow', `0 0 24px rgba(${r},${g},${b},.25)`);
  root.style.setProperty('--radius', tweakState.radius + 'px');
  root.style.setProperty('--radius-sm', Math.max(8, tweakState.radius - 6) + 'px');
  root.style.setProperty('--radius-lg', (tweakState.radius + 6) + 'px');
  root.style.setProperty('--blur', tweakState.blur + 'px');
  document.body.dataset.density = tweakState.density;
  document.body.dataset.hero = tweakState.hero;
}

function initTweaks() {
  applyTweaks();
  // Register edit-mode listener FIRST
  window.addEventListener('message', ev => {
    if (ev.data?.type === '__activate_edit_mode') {
      document.getElementById('tweaksPanel').classList.add('open');
    } else if (ev.data?.type === '__deactivate_edit_mode') {
      document.getElementById('tweaksPanel').classList.remove('open');
    }
  });
  window.parent.postMessage({ type: '__edit_mode_available' }, '*');

  // Populate swatches
  const sw = document.getElementById('tweakAccents');
  sw.innerHTML = ACCENT_SWATCHES.map(s =>
    `<button data-k="${s.key}" title="${s.name}" style="background:${s.key}" class="${tweakState.accent===s.key?'active':''}"></button>`
  ).join('');
  sw.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      tweakState.accent = b.dataset.k;
      sw.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.k === b.dataset.k));
      applyTweaks();
      persistTweaks();
    };
  });

  const radius = document.getElementById('tweakRadius');
  radius.value = tweakState.radius;
  radius.oninput = () => { tweakState.radius = +radius.value; applyTweaks(); persistTweaks(); };

  const density = document.getElementById('tweakDensity');
  density.value = tweakState.density;
  density.oninput = () => { tweakState.density = +density.value; applyTweaks(); persistTweaks(); };

  const blur = document.getElementById('tweakBlur');
  blur.value = tweakState.blur;
  blur.oninput = () => { tweakState.blur = +blur.value; applyTweaks(); persistTweaks(); };

  const hero = document.getElementById('tweakHero');
  hero.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.v === tweakState.hero);
    b.onclick = () => {
      tweakState.hero = b.dataset.v;
      hero.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.v === tweakState.hero));
      applyTweaks();
      persistTweaks();
    };
  });
}

function persistTweaks() {
  window.parent.postMessage({ type: '__edit_mode_set_keys', edits: tweakState }, '*');
}

initTweaks();

/* ══════════════════════════════════════════
   DRAG & DROP — move food items / recipes
   between meal cards. Long-press on touch,
   move-threshold on mouse. Supabase-persisted.
   ══════════════════════════════════════════ */
(function(){
  const LONG_PRESS_MS = 260;
  const MOVE_TOLERANCE = 8;
  let state = null;
  let lockedScrollY = 0;

  // Swallows native touchmove while a drag is active so iOS
  // doesn't take over the touch stream for scrolling. Registered
  // once, globally — cheap, and only preventDefaults while state
  // is in "started" mode.
  function touchMoveBlocker(ev) {
    if (state && state.started) {
      ev.preventDefault();
    }
  }
  document.addEventListener('touchmove', touchMoveBlocker, { passive: false });

  function lockBodyScroll() {
    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    // Set top BEFORE flipping position:fixed so there's no
    // intermediate layout where body jumps to top:0.
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.classList.add('dnd-active');
  }
  function unlockBodyScroll() {
    document.body.classList.remove('dnd-active');
    document.body.style.top = '';
    window.scrollTo(0, lockedScrollY);
  }

  function findDraggable(el) {
    while (el && el !== document.body) {
      if (el.dataset && (el.dataset.dragKind === 'item' || el.dataset.dragKind === 'recipe')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findMealCardAtPoint(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      const card = el.closest ? el.closest('.meal-card') : null;
      if (card && card.dataset.meal) return card;
    }
    return null;
  }

  function cancelDrag(restore = true) {
    if (!state) return;
    const wasStarted = state.started;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    clearTimeout(state.pressTimer);
    if (state.ghost) state.ghost.remove();
    if (state.src && restore) state.src.classList.remove('dnd-source');
    document.querySelectorAll('.meal-card.dnd-hover').forEach(c => c.classList.remove('dnd-hover'));
    state = null;
    document.body.classList.remove('is-dragging');
    // unlockBodyScroll removes .dnd-active AND restores scroll.
    // Only needed if we actually locked (i.e. drag was started).
    if (wasStarted) unlockBodyScroll();
  }

  function beginDrag(src, clientX, clientY) {
    // Lock body scroll FIRST so subsequent rect measurements
    // reflect the pinned layout. position:fixed + top:-scrollY
    // keeps visible content in place, so viewport-relative
    // coordinates remain valid.
    lockBodyScroll();

    const rect = src.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.add('dnd-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);

    src.classList.add('dnd-source');

    state.ghost = ghost;
    state.baseLeft = rect.left;
    state.baseTop = rect.top;
    state.offsetX = clientX - rect.left;
    state.offsetY = clientY - rect.top;
    state.started = true;
    document.body.classList.add('is-dragging');

    if (settings.haptics) { try { _safariPulse(1, 0); } catch(_){} if (navigator.vibrate) try { navigator.vibrate(12); } catch(_) {} }
    moveGhost(clientX, clientY);
  }

  function moveGhost(x, y) {
    if (!state || !state.ghost) return;
    const tx = x - state.offsetX - state.baseLeft;
    const ty = y - state.offsetY - state.baseTop;
    state.ghost.style.transform = `translate(${tx}px, ${ty}px) scale(1.03) rotate(-1.5deg)`;
  }

  function onDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const src = findDraggable(ev.target);
    if (!src) return;
    // ignore interactive children
    if (ev.target.closest('.cb-box, .recipe-chevron')) return;

    state = {
      src,
      startX: ev.clientX,
      startY: ev.clientY,
      pointerType: ev.pointerType || 'mouse',
      started: false,
      pressTimer: null,
      ghost: null,
      dropCard: null,
    };

    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);

    if (state.pointerType !== 'mouse') {
      state.pressTimer = setTimeout(() => {
        if (!state) return;
        beginDrag(state.src, state.startX, state.startY);
      }, LONG_PRESS_MS);
    }
  }

  function onMove(ev) {
    if (!state) return;
    const dx = ev.clientX - state.startX;
    const dy = ev.clientY - state.startY;
    const dist = Math.hypot(dx, dy);

    if (!state.started) {
      if (state.pointerType === 'mouse') {
        if (dist > MOVE_TOLERANCE) beginDrag(state.src, state.startX, state.startY);
      } else {
        // touch: with touch-action:none iOS can't hijack to scroll,
        // so finger jitter during the press window shouldn't kill
        // the drag. Only abort on a *large* movement (clear intent
        // to move before lift) — tolerate normal finger wiggle.
        if (dist > 28) {
          clearTimeout(state.pressTimer);
          cancelDrag(true);
          return;
        }
      }
    }
    if (!state || !state.started) return;
    ev.preventDefault();

    moveGhost(ev.clientX, ev.clientY);

    const card = findMealCardAtPoint(ev.clientX, ev.clientY);
    if (card !== state.dropCard) {
      document.querySelectorAll('.meal-card.dnd-hover').forEach(c => c.classList.remove('dnd-hover'));
      state.dropCard = card;
      if (card && card.dataset.meal !== state.src.dataset.meal) card.classList.add('dnd-hover');
    }

    const EDGE = 70, vh = window.innerHeight;
    // Body ist gelockt (position:fixed), also kann window.scrollBy
    // nicht wirken. Stattdessen die virtuelle Lock-Position anpassen
    // und über body.style.top "scrollen".
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
    if (ev.clientY < EDGE && lockedScrollY > 0) {
      lockedScrollY = Math.max(0, lockedScrollY - 10);
      document.body.style.top = `-${lockedScrollY}px`;
    } else if (ev.clientY > vh - EDGE && lockedScrollY < maxScroll) {
      lockedScrollY = Math.min(maxScroll, lockedScrollY + 10);
      document.body.style.top = `-${lockedScrollY}px`;
    }
  }

  async function onUp(ev) {
    if (!state) return;
    const wasStarted = state.started;
    const dropCard = state.dropCard;
    const src = state.src;
    const ghost = state.ghost;
    clearTimeout(state.pressTimer);

    if (!wasStarted) {
      cancelDrag(true);
      return;
    }

    if (dropCard && dropCard.dataset.meal !== src.dataset.meal) {
      const targetRect = dropCard.getBoundingClientRect();
      const srcRect = src.getBoundingClientRect();
      const gx = targetRect.left + targetRect.width/2 - srcRect.width/2 - state.baseLeft;
      const gy = targetRect.top + 20 - state.baseTop;
      ghost.style.transition = 'transform .25s cubic-bezier(.4,1.4,.5,1), opacity .25s';
      ghost.style.transform = `translate(${gx}px, ${gy}px) scale(.85)`;
      ghost.style.opacity = '0';

      const newMeal = dropCard.dataset.meal;
      const ids = src.dataset.entryIds.split(',').map(s => s.trim()).filter(Boolean);
      const oldKeys = src.dataset.checkKeys.split('|').filter(Boolean);
      const kind = src.dataset.dragKind;
      const recipeName = src.dataset.recipeName;

      // Swallow click that follows the pointerup
      const swallow = e => { e.stopPropagation(); e.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 80);

      cancelDrag(false);
      await moveEntries({ ids, fromMeal: src.dataset.meal, toMeal: newMeal, kind, oldKeys, recipeName });
    } else {
      ghost.style.transition = 'transform .22s cubic-bezier(.4,1.4,.5,1), opacity .22s';
      ghost.style.transform = 'translate(0,0) scale(1)';
      ghost.style.opacity = '0';
      setTimeout(() => cancelDrag(true), 220);
      const swallow = e => { e.stopPropagation(); e.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 80);
    }
  }

  async function moveEntries({ ids, fromMeal, toMeal, kind, oldKeys, recipeName }) {
    if (!ids.length || fromMeal === toMeal) return;

    // Optimistic: patch local arrays (ids are UUID strings)
    const idSet = new Set(ids);
    currentDayEntries.forEach(e => { if (idSet.has(e.id)) e.meal = toMeal; });

    // Migrate check keys locally
    const keyMoves = [];
    oldKeys.forEach(oldK => {
      const parts = oldK.split('::');
      parts[0] = toMeal;
      const newK = parts.join('::');
      if (currentCheckedMap[oldK] !== undefined) {
        const v = currentCheckedMap[oldK];
        delete currentCheckedMap[oldK];
        if (v) currentCheckedMap[newK] = v;
        keyMoves.push({ oldK, newK, v });
      }
    });

    renderDashboard(currentDayEntries);

    try {
      const updateRes = await db.from('fddb_daily_macros').update({ meal: toMeal }).in('id', ids);
      if (updateRes.error) throw updateRes.error;

      for (const { oldK, newK, v } of keyMoves) {
        await db.from('fddb_checklist_status').delete().eq('date', currentDate).eq('item_key', oldK);
        if (v) await db.from('fddb_checklist_status').upsert(
          { date: currentDate, item_key: newK, checked: true },
          { onConflict: 'date,item_key' }
        );
      }

      if (settings.haptics) { try { _safariPulse(1, 0); } catch(_){} if (navigator.vibrate) try { navigator.vibrate(8); } catch(_) {} }
      showMoveToast(kind === 'recipe' ? recipeName : 'Item', toMeal);
    } catch (err) {
      console.error('Move failed:', err);
      alert('Verschieben fehlgeschlagen. Lade neu...');
      loadDay();
    }
  }

  function showMoveToast(name, toMeal) {
    const existing = document.getElementById('dndToast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = 'dndToast';
    t.className = 'dnd-toast';
    const label = (typeof LABELS !== 'undefined' && LABELS[toMeal]) || toMeal;
    t.innerHTML = `<i class="fas fa-arrow-right-long"></i> Moved to <strong>${label}</strong>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
  }

  document.addEventListener('pointerdown', onDown);
})();

/* ──────────────────────────────────────────────────────────
   PWA · Service Worker registration
   Caches the app shell so FDDB Dash launches offline from the
   iOS home screen after the first visit. Skips silently when
   service workers aren't supported (e.g. private Safari tabs).
   ────────────────────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('[PWA] Service worker registration failed:', err);
    });
  });
}

async function clearCacheAndReload() {
  const btn = document.getElementById('clearCacheBtn');
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Clearing…'; btn.disabled = true; }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (e) { /* silent — reload regardless */ }
  location.reload(true);
}

