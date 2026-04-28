function renderDateStrip(selected) {
  const strip = document.getElementById('dateStrip');
  strip.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build 4 days ending at (today - dateStripOffset)
  if (!Number.isFinite(dateStripOffset) || dateStripOffset < 0) dateStripOffset = 0;
  const rightMost = new Date(today);
  rightMost.setDate(today.getDate() - dateStripOffset);
  const days = [];
  for (let i = -3; i <= 0; i++) {
    const d = new Date(rightMost);
    d.setDate(rightMost.getDate() + i);
    days.push(d);
  }

  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const toLocalISO = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const STATUS_ICON = {
    counted: '<i class="fas fa-check"></i>',
    failed:  '<i class="fas fa-lock"></i>',
    freeze:  '<i class="fas fa-snowflake"></i>',
    sick:    '<i class="fas fa-thermometer-half"></i>',
  };
  days.forEach(d => {
    const iso = toLocalISO(d);
    const pill = document.createElement('button');
    pill.className = 'date-pill';
    if (iso === todayStr) pill.classList.add('today');
    if (iso === selected) pill.classList.add('active');
    const fin = finalizedMap && finalizedMap.get ? finalizedMap.get(iso) : null;
    const statusHtml = fin && STATUS_ICON[fin.status]
      ? `<div class="dp-status ${fin.status}">${STATUS_ICON[fin.status]}</div>`
      : '';
    pill.innerHTML = `<div class="dp-dow">${DOW[d.getDay()]}</div><div class="dp-num">${d.getDate()}</div><div class="dp-mo">${MO[d.getMonth()]}</div>${statusHtml}`;
    pill.onclick = () => {
      document.getElementById('dateInput').value = iso;
      renderDateStrip(iso);
      loadDay();
    };
    // Long-press / right-click → context menu.
    let pressTimer, longFired = false;
    pill.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDateMenu(iso, e.clientX, e.clientY);
    });
    pill.addEventListener('touchstart', (e) => {
      longFired = false;
      const t = e.touches[0];
      pressTimer = setTimeout(() => {
        longFired = true;
        openDateMenu(iso, t.clientX, t.clientY);
      }, 450);
    }, { passive: false });
    const cancelPress = () => clearTimeout(pressTimer);
    pill.addEventListener('touchend', (e) => {
      cancelPress();
      if (longFired) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    pill.addEventListener('touchmove', cancelPress);
    pill.addEventListener('touchcancel', cancelPress);
    strip.appendChild(pill);
  });

  // Toggle arrow: right-arrow disabled when at present (offset === 0)
  const leftArrow  = document.getElementById('dateStripLeft');
  const rightArrow = document.getElementById('dateStripRight');
  if (leftArrow)  leftArrow.disabled  = false;
  if (rightArrow) rightArrow.disabled = dateStripOffset === 0;
}

function shiftDateStrip(dir) {
  // dir: -1 = back in time (older), +1 = forward toward today
  const next = dateStripOffset + (dir === -1 ? 4 : -4);
  dateStripOffset = Math.max(0, next);
  // Preserve current selection
  const currentSel = document.getElementById('dateInput').value || todayStr;
  renderDateStrip(currentSel);
}

function onDateChange() {
  const v = document.getElementById('dateInput').value;
  if (!v) return;
  // Ensure the selected date is within the visible 4-pill window.
  // If earlier than the leftmost pill, shift the window so the selected
  // date sits as the rightmost pill.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const picked = new Date(v + 'T00:00:00');
  const daysAgo = Math.round((today - picked) / 86400000);
  if (daysAgo > dateStripOffset + 3 || daysAgo < dateStripOffset) {
    dateStripOffset = Math.max(0, daysAgo);
  }
  renderDateStrip(v);
  loadDay();
}

/* ── Merge toggle ── */
function toggleMergeServings() {
  mergeServings = !mergeServings;
  const btn = document.getElementById('mergeBtn');
  btn.classList.toggle('active', mergeServings);
  btn.title = mergeServings ? 'Split Servings' : 'Merge Servings';
  document.getElementById('checkedBlock').style.display = mergeServings ? 'none' : '';
  document.getElementById('content').classList.toggle('merge-active', mergeServings);
  renderDashboard(currentDayEntries);
}

/* ── View switching ── */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === id));
  if (id === 'viewRecipes') renderRecipeManage();
  if (id === 'viewStats')   loadStats();
  window.scrollTo(0, 0);
}

/* ── Load recipes ── */
async function loadRecipes() {
  const { data: recipes } = await db.from('fddb_recipes').select('id, name, servings').order('name');
  if (!recipes) return;
  const { data: items } = await db.from('fddb_recipe_items').select('recipe_id, item_name');
  const { data: rcats } = await db.from('fddb_recipe_categories').select('recipe_id, category_id');
  const { data: cats }  = await db.from('fddb_categories').select('id, name').order('name');
  const { data: units } = await db.from('fddb_units').select('unit').order('unit');
  allCategories = (cats || []);
  allUnits = (units || []).map(u => u.unit);
  buildStripRegex();
  allRecipes = (recipes || []).map(r => ({
    id: r.id, name: r.name, servings: r.servings || 1,
    items: (items || []).filter(i => i.recipe_id === r.id).map(i => i.item_name),
    catIds: (rcats || []).filter(c => c.recipe_id === r.id).map(c => c.category_id),
  }));
}

/* ── Scraper trigger ── */
async function triggerScraper() {
  const btn = document.getElementById('syncBtn');
  btn.classList.add('syncing'); btn.disabled = true;
  try {
    const { data, error } = await db.from('fddb_config').select('key, value');
    if (error || !data) { showToast('Config error', 'error'); return; }
    const cfg = Object.fromEntries(data.map(r => [r.key, r.value]));
    const token = cfg['gh_token'], repo = cfg['gh_repo'];
    if (!token || !repo) { showToast('GitHub config missing', 'error'); return; }
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 204) {
      const overlay = document.getElementById('syncCountdown');
      const countEl = document.getElementById('syncCountdownNum');
      overlay.style.display = 'flex';
      let remaining = 30;
      countEl.textContent = remaining;
      const interval = setInterval(() => {
        remaining--;
        countEl.textContent = remaining;
        if (remaining <= 0) {
          clearInterval(interval);
          overlay.style.display = 'none';
          btn.classList.remove('syncing'); btn.disabled = false;
          loadDay();
        }
      }, 1000);
    } else {
      showToast('GitHub error: ' + res.status, 'error');
      btn.classList.remove('syncing'); btn.disabled = false;
    }
  } catch (e) {
    showToast('Network error', 'error');
    btn.classList.remove('syncing'); btn.disabled = false;
  }
}

/* ── Load day ── */
async function loadDay() {
  const dateVal = document.getElementById('dateInput').value;
  if (!dateVal) return;
  document.getElementById('content').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  checkables = [];

  const [macroRes, statusRes, targetsRes, dayTypeRes, waterLogsRes, waterSettingsRes] = await Promise.all([
    db.from('fddb_daily_macros').select('*').eq('date', dateVal).order('meal'),
    db.from('fddb_checklist_status').select('item_key, checked').eq('date', dateVal),
    db.from('fddb_coach_targets').select('*').lte('valid_from', dateVal).order('valid_from', { ascending: false }),
    db.from('fddb_day_type').select('type').eq('date', dateVal).maybeSingle(),
    dbWater.from('water_logs').select('amount').eq('date', dateVal),
    dbWater.from('water_settings').select('goal').eq('id', 1).maybeSingle(),
  ]);

  if (macroRes.error) {
    document.getElementById('content').innerHTML = `<div class="placeholder"><i class="fas fa-exclamation-triangle"></i>Error: ${macroRes.error.message}</div>`;
    return;
  }

  currentDayEntries = macroRes.data || [];
  currentCheckedMap = Object.fromEntries((statusRes.data || []).map(r => [r.item_key, r.checked]));
  currentDate = dateVal;

  const rows = targetsRes.data || [];
  ['training','rest'].forEach(type => {
    const match = rows.find(r => r.type === type);
    if (match) coachTargets[type] = { kcal: match.kcal, p: match.protein, c: match.carbs, f: match.fat };
  });

  const waterDrunk = (waterLogsRes.data || []).reduce((s, r) => s + (r.amount || 0), 0);
  const waterGoal = waterSettingsRes.data?.goal || null;
  waterData = { drunk: waterDrunk, goal: waterGoal };

  currentDayType = dayTypeRes.data?.type || 'training';
  if (!dayTypeRes.data) {
    await db.from('fddb_day_type').upsert({ date: dateVal, type: 'training' }, { onConflict: 'date' });
  }
  renderDayTypeToggle();
  renderDashboard(currentDayEntries);
}

/* ── Helpers ── */
function macroSum(items) {
  return items.reduce((a,e) => ({ kcal: a.kcal+(e.kcal||0), p: a.p+(parseFloat(e.protein)||0), c: a.c+(parseFloat(e.carbs)||0), f: a.f+(parseFloat(e.fat)||0) }), {kcal:0,p:0,c:0,f:0});
}
function pillsHTML(m) {
  return `<div class="mp mp-kcal"><div class="mp-val">${Math.round(m.kcal)}</div><div class="mp-lbl">kcal</div></div><div class="mp mp-p"><div class="mp-val">${m.p.toFixed(1)}</div><div class="mp-lbl">P</div></div><div class="mp mp-c"><div class="mp-val">${m.c.toFixed(1)}</div><div class="mp-lbl">C</div></div><div class="mp mp-f"><div class="mp-val">${m.f.toFixed(1)}</div><div class="mp-lbl">F</div></div>`;
}
function statPillsHTML(m) {
  return `<div class="stat-pill"><div class="stat-val c-kcal">${Math.round(m.kcal)}</div><div class="stat-lbl">Kcal</div></div><div class="stat-pill"><div class="stat-val c-p">${m.p.toFixed(1)}</div><div class="stat-lbl">Protein</div></div><div class="stat-pill"><div class="stat-val c-c">${m.c.toFixed(1)}</div><div class="stat-lbl">Carbs</div></div><div class="stat-pill"><div class="stat-val c-f">${m.f.toFixed(1)}</div><div class="stat-lbl">Fat</div></div>`;
}
function renderDayTypeToggle() {
  document.getElementById('dttTraining')?.classList.toggle('active', currentDayType === 'training');
  document.getElementById('dttRest')?.classList.toggle('active', currentDayType === 'rest');
}
async function setDayType(type) {
  currentDayType = type;
  renderDayTypeToggle();
  renderTargetBlock();
  await db.from('fddb_day_type').upsert({ date: currentDate, type }, { onConflict: 'date' });
}
function adherenceScore(pct) { return Math.max(0, 100 - Math.abs(100 - pct)); }

/* ══════════════════════════════════════
   STREAK — day finalization & streak calc
   ══════════════════════════════════════ */
// Compute day adherence from daily totals + target (same formula as hero ring).
function computeDayAdherence(totals, target) {
  if (!target || !totals) return null;
  const parts = [
    { val: totals.p, goal: target.p },
    { val: totals.c, goal: target.c },
    { val: totals.f, goal: target.f },
  ].filter(m => m.goal > 0);
  if (!parts.length) return null;
  return Math.round(
    parts.reduce((s, m) => s + adherenceScore(Math.round((m.val / m.goal) * 100)), 0) / parts.length
  );
}

async function writeFinalizedDay(date, adherence, goalUsed, status) {
  // NOTE: some older DB schemas have `adherence` as NOT NULL. For freeze/sick
  // (where adherence is conceptually N/A) we persist 0 as a placeholder and
  // rely on `status` to distinguish. Readers must check `status` first.
  const isNonCounted = (status === 'freeze' || status === 'sick');
  const row = {
    date,
    adherence: adherence ?? (isNonCounted ? 0 : null),
    counted: (status === 'counted' || status === 'freeze' || status === 'sick'),
    goal_used: goalUsed ?? null,
    status: status || 'counted',
  };
  // Optimistic: update cache BEFORE the DB round-trip so other code paths
  // (auto-finalize, strip re-render) see the new status immediately and
  // don't race-overwrite it as 'failed'.
  const prev = finalizedMap.get(date);
  finalizedMap.set(date, { ...row });
  try {
    const { error } = await db.from('fddb_day_finalized').upsert(row, { onConflict: 'date' });
    if (error) {
      // Roll back cache so the UI reflects reality on next render.
      if (prev) finalizedMap.set(date, prev); else finalizedMap.delete(date);
      console.error('[writeFinalizedDay] upsert failed:', error.message, row);
      showToast('Save failed: ' + error.message, 'error');
    }
  } catch (e) {
    if (prev) finalizedMap.set(date, prev); else finalizedMap.delete(date);
    console.error('[writeFinalizedDay] threw:', e);
  }
}

async function deleteFinalizedDay(date) {
  try {
    await db.from('fddb_day_finalized').delete().eq('date', date);
    finalizedMap.delete(date);
  } catch (e) { /* silent */ }
}

// In-memory cache of finalized rows keyed by date (declared earlier, hoisted for init).
async function loadFinalizedMap() {
  try {
    const { data } = await db.from('fddb_day_finalized').select('date, counted, adherence, status, goal_used');
    finalizedMap.clear();
    (data || []).forEach(r => finalizedMap.set(r.date, r));
  } catch (e) { /* silent */ }
}

// Count freeze days used in the ISO week containing `date` (Mon-Sun).
function freezesThisWeek(date) {
  const d = new Date(date + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 0=Mon
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const iso = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(mon); day.setDate(mon.getDate() + i);
    const k = iso(day);
    if (k === date) continue; // don't count self
    const row = finalizedMap.get(k);
    if (row && row.status === 'freeze') n++;
  }
  return n;
}

// Streak-Logik mit Status:
//  - counted  → zählt (+1) und unterbricht nicht
//  - freeze   → unterbricht nicht, zählt aber nicht
//  - sick     → unterbricht nicht, zählt aber nicht
//  - failed   → bricht den Streak
//  - (missing)→ bricht den Streak (kein Eintrag = Tag verfehlt)
function calcStreaks(finalizedRows) {
  if (!finalizedRows.length) return { current: 0, record: 0, countedDays: 0 };
  // Fallback: wenn `status` nicht existiert (Migration nicht gelaufen),
  // leite ihn aus `counted` ab.
  const normalizeStatus = (r) => {
    if (r.status) return r.status;
    return r.counted ? 'counted' : 'failed';
  };
  const byDate = new Map(finalizedRows.map(r => [r.date, { ...r, status: normalizeStatus(r) }]));
  const sortedDates = [...byDate.keys()].sort();
  const countedDays = [...byDate.values()].filter(r => r.status === 'counted').length;

  const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const isStreakContinuing = s => s === 'counted' || s === 'freeze' || s === 'sick';
  const isCounted = s => s === 'counted';

  // Record: walk from earliest to latest day by calendar.
  let record = 0, run = 0;
  const first = new Date(sortedDates[0] + 'T00:00:00');
  const last  = new Date(sortedDates[sortedDates.length - 1] + 'T00:00:00');
  for (let c = new Date(first); c <= last; c.setDate(c.getDate() + 1)) {
    const row = byDate.get(iso(c));
    if (row && isStreakContinuing(row.status)) {
      if (isCounted(row.status)) run++; // only counted days add to streak length
      // freeze/sick keep run alive but don't increment
    } else {
      record = Math.max(record, run);
      run = 0;
    }
  }
  record = Math.max(record, run);

  // Current: walk back from today.
  const today = new Date(); today.setHours(0,0,0,0);
  let current = 0;
  let cursor = new Date(today);
  const todayRow = byDate.get(iso(cursor));
  // Grace: skip today if no entry yet (day not finalized).
  if (!todayRow) cursor.setDate(cursor.getDate() - 1);
  while (true) {
    const row = byDate.get(iso(cursor));
    if (!row) break;                             // missing = broken
    if (!isStreakContinuing(row.status)) break;  // failed = broken
    if (isCounted(row.status)) current++;
    // freeze/sick: continue without incrementing
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, record, countedDays };
}

// Decide if a date should be auto-finalized (past, or past cutoff today).
function shouldAutoFinalize(date) {
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(date); d.setHours(0,0,0,0);
  if (d < today) return true; // any past day
  if (d > today) return false; // future day
  // Today — finalize only if now >= cutoff.
  const [hh, mm] = (settings.adherenceCutoff || '22:00').split(':').map(Number);
  const cutoff = new Date(); cutoff.setHours(hh||22, mm||0, 0, 0);
  return new Date() >= cutoff;
}

async function ensureDayFinalized(date, adherence, force) {
  // Sick mode: while the global toggle is on, any day on/after sickSince
  // auto-marks as 'sick'. The toggle persists until the user turns it off —
  // you're usually sick for more than a day. Days *before* sickSince keep
  // their original status. Toggle-off deletes today's sick entry so the day
  // can re-auto-finalize from macros.
  if (settings.sickModeActive && settings.sickSince && date >= settings.sickSince) {
    const existing = finalizedMap.get(date);
    if (!existing || existing.status !== 'sick') {
      await writeFinalizedDay(date, null, settings.adherenceGoal, 'sick');
      renderDateStrip(currentDate);
    }
    return;
  }
  if (adherence == null && !force) return;
  if (!force && !shouldAutoFinalize(date)) return;
  if (!force && finalizedMap.has(date)) return;
  const { data } = await db.from('fddb_day_finalized').select('date').eq('date', date).limit(1);
  if (data && data.length && !force) {
    const { data: full } = await db.from('fddb_day_finalized').select('*').eq('date', date).maybeSingle();
    if (full) finalizedMap.set(date, full);
    renderDateStrip(currentDate);
    return;
  }
  if (adherence == null) return;
  const status = adherence >= settings.adherenceGoal ? 'counted' : 'failed';
  await writeFinalizedDay(date, adherence, settings.adherenceGoal, status);
  renderDateStrip(currentDate);
}

async function manualFinalizeDay(date, adherence) {
  if (adherence == null) { showToast('No data for this day', 'error'); return; }
  const goalUsed = settings.adherenceGoal;
  const status = adherence >= goalUsed ? 'counted' : 'failed';
  await writeFinalizedDay(date, adherence, goalUsed, status);
  if (status === 'counted') haptic('streakUp');
  showToast(`Day finalized — ${adherence}% ${status === 'counted' ? 'counted ✓' : 'below goal'}`);
  renderDateStrip(document.getElementById('dateInput').value || todayStr);
  renderStreak();
}

async function setDayStatus(date, status) {
  // status: 'freeze' | 'sick' | null (reset)
  if (status === null) {
    await deleteFinalizedDay(date);
    showToast('Day status reset');
  } else if (status === 'freeze') {
    if (freezesThisWeek(date) >= 2) {
      showToast('Freeze limit reached (2 per week)', 'error');
      return;
    }
    await writeFinalizedDay(date, null, settings.adherenceGoal, 'freeze');
    showToast('Day frozen ❄');
  } else if (status === 'sick') {
    // Sick cannot be set retroactively.
    if (date !== todayStr) {
      showToast('Sick day can only be set for today', 'error');
      return;
    }
    await writeFinalizedDay(date, null, settings.adherenceGoal, 'sick');
    showToast('Marked as sick day 🌡');
  }
  renderDateStrip(document.getElementById('dateInput').value || todayStr);
  renderStreak();
  applySickModeOverlay();
}

async function renderStreak() {
  const cardEl = document.getElementById('streakCard');
  if (!cardEl) return;
  try {
    await loadFinalizedMap();
    const rows = [...finalizedMap.values()];
    const { current, record, countedDays } = calcStreaks(rows);
    document.getElementById('streakCurrent').textContent = current;
    document.getElementById('streakRecord').textContent = record;
    document.getElementById('streakCountedDays').textContent = countedDays;
    const goalHint = document.getElementById('streakGoalHint');
    if (goalHint) goalHint.textContent = `(≥ ${settings.adherenceGoal ?? 80}% adherence)`;

    const lastRecord = parseInt(localStorage.getItem('fddb.streak.lastRecord') || '0', 10);
    if (record > lastRecord && record > 0) {
      localStorage.setItem('fddb.streak.lastRecord', String(record));
      haptic('streakUp');
    }
  } catch (e) { /* silent */ }
}

function adherenceScore2() {} // no-op placeholder retained for future use
function adherenceColor(score) {
  const t = Math.max(0, Math.min(100, score)) / 100;
  let r, g, b;
  if (t < 0.5) {
    const s = t / 0.5;
    r = Math.round(248 + (250-248)*s); g = Math.round(113 + (204-113)*s); b = Math.round(113 + (21-113)*s);
  } else {
    const s = (t - 0.5) / 0.5;
    r = Math.round(250 + (74-250)*s); g = Math.round(204 + (222-204)*s); b = Math.round(21 + (128-21)*s);
  }
  return `rgb(${r},${g},${b})`;
}

/* ── Hero / Target block render ── */
function renderTargetBlock() {
  const tgt = coachTargets[currentDayType];
  const macros = [
    { key: 'kcal', label: 'Kcal',   val: Math.round(totals.kcal), goal: tgt.kcal, color: 'var(--orange)' },
    { key: 'p',    label: 'Protein', val: totals.p.toFixed(1),    goal: tgt.p,    color: 'var(--blue)' },
    { key: 'c',    label: 'Carbs',   val: totals.c.toFixed(1),    goal: tgt.c,    color: 'var(--yellow)' },
    { key: 'f',    label: 'Fat',     val: totals.f.toFixed(1),    goal: tgt.f,    color: 'var(--red)' },
    ...(waterData.goal ? [{ key: 'w', label: 'Water', val: String(waterData.drunk || 0), goal: waterData.goal, color: 'var(--cyan)' }] : []),
  ];

  const adherenceMacros = macros.filter(m => m.key !== 'kcal' && m.key !== 'w');
  const validAdh = adherenceMacros.filter(m => m.goal > 0);
  const overallAdh = validAdh.length > 0
    ? Math.round(validAdh.reduce((s, m) => s + adherenceScore(Math.round((parseFloat(m.val) / m.goal) * 100)), 0) / validAdh.length)
    : null;

  // Hero ring
  const ringFg = document.getElementById('heroRingFg');
  const ringVal = document.getElementById('heroRingVal');
  const circ = 2 * Math.PI * 52; // 326.73
  if (overallAdh !== null) {
    // Cap visual progress at 99% when <100% to avoid round-cap overlap
    // creating a visible bump at 12 o'clock. At exactly 100% draw a full
    // circle with butt caps for a clean closed ring.
    if (overallAdh >= 100) {
      ringFg.style.strokeDashoffset = 0;
      ringFg.style.strokeLinecap = 'butt';
    } else {
      const visual = Math.min(overallAdh, 99);
      const off = circ * (1 - visual / 100);
      ringFg.style.strokeDashoffset = off;
      ringFg.style.strokeLinecap = 'round';
    }
    ringFg.style.stroke = adherenceColor(overallAdh);
    ringVal.textContent = overallAdh + '%';
    ringVal.style.color = adherenceColor(overallAdh);

    // Auto-finalize this day if past cutoff / past date.
    ensureDayFinalized(currentDate, overallAdh);
  } else {
    ringFg.style.strokeDashoffset = circ;
    ringVal.textContent = '–';
    ringVal.style.color = 'var(--muted)';
  }

  // Macro rows
  document.getElementById('heroMacroRows').innerHTML = macros.map(m => {
    const rawPct = m.goal > 0 ? Math.round((parseFloat(m.val) / m.goal) * 100) : 0;
    const dev = rawPct - 100;
    const score = adherenceScore(rawPct);
    const pctColor = m.goal > 0 ? adherenceColor(score) : 'var(--muted)';
    const devDisplay = m.goal > 0 ? (dev > 0 ? '+' : '') + dev + '%' : '–';
    const maxDev = 50;
    const barW = m.goal > 0 ? Math.min(Math.abs(dev), maxDev) / maxDev * 50 : 0;
    const barLeft = dev >= 0;
    return `
      <div class="hmac-row">
        <div class="hmac-lbl" style="color:${m.color}">${m.label}</div>
        <div class="hmac-bar-wrap">
          <div class="hmac-bar-track">
            <div class="hmac-bar-center"></div>
            <div style="position:absolute;top:0;bottom:0;${barLeft?'left:50%;right:0':'right:50%;left:0'};overflow:hidden;border-radius:99px">
              <div class="hmac-bar-fill" style="${barLeft?'left:0':'right:0'};width:${barW*2}%;background:${m.color}"></div>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="hmac-values">
            <span class="hmac-v" style="color:${m.color}">${m.val}</span>
            <span class="hmac-slash">/</span>
            <span class="hmac-v hmac-goal" style="color:${m.color}">${m.goal}</span>
          </div>
          <div class="hmac-pct" style="color:${pctColor}">${devDisplay}</div>
        </div>
      </div>`;
  }).join('');
}

function updateChecked() {
  const ch = checkables.filter(c => c.checked);
  const ck = ch.reduce((a,c) => ({ kcal:a.kcal+c.macros.kcal, p:a.p+c.macros.p, c:a.c+c.macros.c, f:a.f+c.macros.f }), {kcal:0,p:0,c:0,f:0});
  document.getElementById('checkedPills').innerHTML = statPillsHTML(ck);
  const pct = checkables.length > 0 ? (ch.length/checkables.length)*100 : 0;
  document.getElementById('progressFill').style.width = pct+'%';
  document.getElementById('progressLabel').textContent = `${ch.length} / ${checkables.length}`;
  document.getElementById('checkedBlock').classList.toggle('has-data', ch.length > 0);
}

function renderDashboard(entries) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  checkables = [];
  applySickModeOverlay();
  if (!entries.length) {
    content.innerHTML = '<div class="placeholder"><i class="fas fa-bowl-food"></i>No entries for this date</div>';
    totals = {kcal:0,p:0,c:0,f:0};
    renderTargetBlock();
    updateChecked();
    return;
  }

  const grouped = {};
  totals = {kcal:0,p:0,c:0,f:0};
  entries.forEach(e => {
    (grouped[e.meal] = grouped[e.meal]||[]).push(e);
    totals.kcal += e.kcal||0; totals.p += parseFloat(e.protein)||0;
    totals.c += parseFloat(e.carbs)||0; totals.f += parseFloat(e.fat)||0;
  });

  // Render every standard ORDER meal (even if empty) so drop targets stay available
  // after a meal is emptied. Custom meals outside ORDER are appended only if they have items.
  // Skip empty aliases whose label is already used by a non-empty meal (e.g. abendbrot/abendessen → "Dinner").
  const customMeals = Object.keys(grouped).filter(m => ORDER.indexOf(m) < 0);
  const orderedMeals = [...ORDER, ...customMeals.sort()];
  const usedLabels = new Set(
    orderedMeals.filter(m => (grouped[m] || []).length > 0).map(m => LABELS[m] || m)
  );
  const sorted = orderedMeals.filter(m => {
    if ((grouped[m] || []).length > 0) return true;
    // empty → only keep if no non-empty meal shares its display label
    const label = LABELS[m] || m;
    return !usedLabels.has(label);
  });

  sorted.forEach((meal, mi) => {
    const items = grouped[meal] || [];
    const isEmpty = items.length === 0;
    const mealKcal = items.reduce((s,i) => s+(i.kcal||0), 0);
    const card = document.createElement('div');
    card.className = 'meal-card' + (isEmpty ? ' meal-card-empty' : '');
    card.dataset.meal = meal;
    card.style.animationDelay = `${mi*0.05}s`;

    if (isEmpty) {
      card.innerHTML = `<div class="meal-title"><div class="meal-dot"></div><div class="meal-name">${LABELS[meal]||meal}</div><div class="meal-empty-hint">Empty</div></div>`;
    } else if (mergeServings) {
      const mealM = macroSum(items);
      card.innerHTML = `<div class="meal-title"><div class="meal-dot"></div><div class="meal-name">${LABELS[meal]||meal}</div><div class="macro-pills" style="margin-left:auto">${pillsHTML(mealM)}</div></div>`;
    } else {
      card.innerHTML = `<div class="meal-title"><div class="meal-dot"></div><div class="meal-name">${LABELS[meal]||meal}</div><div class="meal-kcal">${Math.round(mealKcal)} kcal</div></div>`;
    }

    const list = document.createElement('div');
    list.className = 'items-list';

    const remaining = items.map((item, idx) => ({ item, idx, used: false }));
    const renderBlocks = [];
    const recipesByLength = [...allRecipes].sort((a,b) => b.items.length - a.items.length);

    recipesByLength.forEach(recipe => {
      if (recipe.items.length === 0) return;
      const matchIndices = [];
      const workingPool = remaining.filter(r => !r.used);
      let allFound = true;
      for (const rName of recipe.items) {
        const found = workingPool.find(r => !matchIndices.includes(r.idx) && stripAmount(r.item.item_name) === rName);
        if (found) matchIndices.push(found.idx);
        else { allFound = false; break; }
      }
      if (allFound && matchIndices.length > 0) {
        matchIndices.forEach(idx => { remaining[idx].used = true; });
        const recipeEntries = matchIndices.map(idx => items[idx]);
        renderBlocks.push({ type: 'recipe', recipe, entries: recipeEntries, firstIdx: Math.min(...matchIndices) });
      }
    });

    remaining.filter(r => !r.used).forEach(r => {
      renderBlocks.push({ type: 'item', entry: r.item, firstIdx: r.idx });
    });

    renderBlocks.sort((a,b) => a.firstIdx - b.firstIdx);

    renderBlocks.forEach(block => {
      if (block.type === 'item') {
        const e = block.entry;
        const m = { kcal: e.kcal||0, p: parseFloat(e.protein)||0, c: parseFloat(e.carbs)||0, f: parseFloat(e.fat)||0 };
        const itemKey = `${meal}::${e.item_name}`;
        const row = document.createElement('div');
        row.className = 'food-item' + (currentCheckedMap[itemKey] ? ' checked' : '');
        row.dataset.meal = meal;
        row.dataset.entryIds = String(e.id);
        row.dataset.checkKeys = itemKey;
        row.dataset.dragKind = 'item';

        if (mergeServings) {
          row.innerHTML = `<div class="cb-box"><i class="fas fa-check"></i></div><div class="food-name" style="font-size:.82rem">${e.item_name}</div>`;
        } else {
          row.innerHTML = `<div class="cb-box"><i class="fas fa-check"></i></div><div class="food-item-body"><div class="food-name">${e.item_name}</div><div class="macro-pills">${pillsHTML(m)}</div></div>`;
        }
        row.addEventListener('click', () => {
          row.classList.toggle('checked');
          persistChecked(itemKey, row.classList.contains('checked'));
          updateChecked();
        });
        checkables.push({ get checked() { return row.classList.contains('checked'); }, macros: m });
        list.appendChild(row);
      } else {
        const { recipe, entries: recEntries } = block;
        const totalM = macroSum(recEntries);
        const servings = recipe.servings || 1;
        const effectiveServings = mergeServings ? 1 : servings;
        const portionM = mergeServings ? totalM : { kcal: totalM.kcal/servings, p: totalM.p/servings, c: totalM.c/servings, f: totalM.f/servings };

        for (let s = 0; s < effectiveServings; s++) {
          const itemKey = mergeServings ? `${meal}::${recipe.name}::0` : `${meal}::${recipe.name}::${s}`;
          const rb = document.createElement('div');
          rb.className = 'recipe-row' + (currentCheckedMap[itemKey] ? ' checked' : '');
          rb.dataset.meal = meal;
          rb.dataset.entryIds = recEntries.map(x => x.id).join(',');
          rb.dataset.checkKeys = (mergeServings
            ? [`${meal}::${recipe.name}::0`]
            : Array.from({length: servings}, (_, i) => `${meal}::${recipe.name}::${i}`)).join('|');
          rb.dataset.dragKind = 'recipe';
          rb.dataset.recipeName = recipe.name;
          const portionLabel = (!mergeServings && servings > 1) ? ` <span class="recipe-portion-tag">${s+1}/${servings}</span>` : (mergeServings && servings > 1 ? ` <span class="recipe-portion-tag">${servings}×</span>` : '');

          const hdr = document.createElement('div');
          hdr.className = 'recipe-row-header';
          if (mergeServings) {
            hdr.innerHTML = `
              <div class="cb-box"><i class="fas fa-check"></i></div>
              <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
                <span class="recipe-row-name" style="font-size:.82rem">${recipe.name}</span>
                <span class="recipe-tag">Recipe</span>
                ${portionLabel}
              </div>`;
          } else {
            hdr.innerHTML = `
              <div class="cb-box"><i class="fas fa-check"></i></div>
              <div class="recipe-row-body">
                <div class="recipe-row-title">
                  <span class="recipe-row-name">${recipe.name}</span>
                  <span class="recipe-tag">Recipe</span>
                  ${portionLabel}
                </div>
                <div class="macro-pills">${pillsHTML(portionM)}</div>
              </div>
              <button class="recipe-chevron"><i class="fas fa-chevron-down"></i></button>`;
          }
          const cbBox = hdr.querySelector('.cb-box');
          const body = hdr.querySelector('.recipe-row-body');
          const chevron = hdr.querySelector('.recipe-chevron');
          const toggleChecked = () => {
            rb.classList.toggle('checked');
            persistChecked(itemKey, rb.classList.contains('checked'));
            updateChecked();
          };
          cbBox.addEventListener('click', e => { e.stopPropagation(); toggleChecked(); });
          if (body) body.addEventListener('click', () => toggleChecked());
          if (chevron) chevron.addEventListener('click', e => { e.stopPropagation(); rb.classList.toggle('open'); });
          if (mergeServings) hdr.addEventListener('click', toggleChecked);

          rb.appendChild(hdr);

          const ingList = document.createElement('div');
          ingList.className = 'recipe-ingredients';
          [...recEntries].sort((a, b) => stripAmount(a.item_name).localeCompare(stripAmount(b.item_name))).forEach(ing => {
            const ingRow = document.createElement('div');
            ingRow.className = 'ingredient-row';
            ingRow.innerHTML = `<span class="ingredient-name">${ing.item_name}</span><div class="ing-pills"><div class="ip ip-kcal">${Math.round((ing.kcal||0)/(mergeServings?1:servings))}</div><div class="ip ip-p">${(parseFloat(ing.protein||0)/(mergeServings?1:servings)).toFixed(1)}</div><div class="ip ip-c">${(parseFloat(ing.carbs||0)/(mergeServings?1:servings)).toFixed(1)}</div><div class="ip ip-f">${(parseFloat(ing.fat||0)/(mergeServings?1:servings)).toFixed(1)}</div></div>`;
            ingList.appendChild(ingRow);
          });
          rb.appendChild(ingList);
          checkables.push({ get checked() { return rb.classList.contains('checked'); }, macros: portionM });
          list.appendChild(rb);
        }
      }
    });

    card.appendChild(list);
    content.appendChild(card);
  });

  renderTargetBlock();
  updateChecked();
}

/* ── Persist ── */
const pendingWrites = {};
function persistChecked(itemKey, checked) {
  currentCheckedMap[itemKey] = checked;
  haptic(checked ? 'check' : 'uncheck');
  clearTimeout(pendingWrites[itemKey]);
  pendingWrites[itemKey] = setTimeout(async () => {
    await db.from('fddb_checklist_status').upsert({ date: currentDate, item_key: itemKey, checked }, { onConflict: 'date,item_key' });
  }, 600);
}

/* ── Action chooser ── */
function openActionChooser() { document.getElementById('actionChooserOverlay').classList.add('open'); }
function closeActionChooser() { document.getElementById('actionChooserOverlay').classList.remove('open'); }

/* ── Add unit ── */
function openAddUnit() {
  document.getElementById('newUnitInput').value = '';
  document.getElementById('existingUnits').innerHTML = allUnits.map(u => `<span>${u}</span>`).join('');
  document.getElementById('addUnitOverlay').classList.add('open');
  setTimeout(() => document.getElementById('newUnitInput').focus(), 300);
}
async function saveNewUnit() {
  const val = (document.getElementById('newUnitInput').value || '').trim().toLowerCase();
  if (!val) return;
  if (allUnits.includes(val)) { showToast(`"${val}" already exists`, 'error'); return; }
  const { error } = await db.from('fddb_units').insert({ unit: val });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  allUnits.push(val); allUnits.sort(); buildStripRegex();
  document.getElementById('addUnitOverlay').classList.remove('open');
  showToast(`Unit "${val}" added`, 'success');
}

/* ── Recipe Creator ── */
let creatorStep = 0, creatorMeal = null, creatorSelected = [];
function openCreator() {
  creatorStep = 0; creatorMeal = null; creatorSelected = [];
  document.getElementById('recipeNameInput').value = '';
  renderCreatorStep();
  document.getElementById('creatorOverlay').classList.add('open');
}
function closeCreator() { document.getElementById('creatorOverlay').classList.remove('open'); }
function renderCreatorStep() {
  [0,1,2].forEach(i => {
    document.getElementById(`step-ind-${i}`).classList.toggle('done', i <= creatorStep);
    document.getElementById(`step-panel-${i}`).classList.toggle('active', i === creatorStep);
  });
  const btnBack = document.getElementById('btnBack');
  const btnNext = document.getElementById('btnNext');
  btnBack.style.display = creatorStep === 0 ? 'none' : '';
  btnNext.textContent = creatorStep === 2 ? 'Save' : 'Next';

  if (creatorStep === 0) {
    const meals = [...new Set(currentDayEntries.map(e => e.meal))].sort((a,b) => (ORDER.indexOf(a)<0?99:ORDER.indexOf(a))-(ORDER.indexOf(b)<0?99:ORDER.indexOf(b)));
    document.getElementById('mealChips').innerHTML = meals.map(m => `<div class="chip${creatorMeal===m?' selected':''}" onclick="selectMeal('${m}')">${LABELS[m]||m}</div>`).join('');
    btnNext.disabled = !creatorMeal;
  } else if (creatorStep === 1) {
    const items = [...currentDayEntries.filter(e => e.meal === creatorMeal)].sort((a, b) => stripAmount(a.item_name).localeCompare(stripAmount(b.item_name)));
    const ul = document.getElementById('itemSelectList');
    ul.innerHTML = '';
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'select-item' + (creatorSelected.includes(item.item_name) ? ' selected' : '');
      el.innerHTML = `<div class="sel-box"><i class="fas fa-check"></i></div><div class="sel-name">${item.item_name}</div><div class="sel-kcal">${Math.round(item.kcal||0)} kcal</div>`;
      el.addEventListener('click', () => {
        if (creatorSelected.includes(item.item_name)) creatorSelected = creatorSelected.filter(n => n !== item.item_name);
        else creatorSelected.push(item.item_name);
        renderCreatorStep();
      });
      ul.appendChild(el);
    });
    btnNext.disabled = creatorSelected.length < 2;
  } else if (creatorStep === 2) {
    document.getElementById('selectedSummary').innerHTML = creatorSelected.map(n => `<span class="sel-tag">${n}</span>`).join('');
    btnNext.disabled = document.getElementById('recipeNameInput').value.trim().length === 0;
    document.getElementById('recipeNameInput').oninput = () => {
      btnNext.disabled = document.getElementById('recipeNameInput').value.trim().length === 0;
    };
  }
}
function selectMeal(meal) { creatorMeal = meal; creatorSelected = []; renderCreatorStep(); }
function creatorBack() { if (creatorStep > 0) { creatorStep--; renderCreatorStep(); } }
async function creatorNext() {
  if (creatorStep < 2) { creatorStep++; renderCreatorStep(); return; }
  const name = document.getElementById('recipeNameInput').value.trim();
  document.getElementById('btnNext').disabled = true;
  document.getElementById('btnNext').textContent = '…';
  const { data: recipe, error: recErr } = await db.from('fddb_recipes').insert({ name }).select().single();
  if (recErr) { showToast('Error: ' + recErr.message, 'error'); document.getElementById('btnNext').disabled = false; document.getElementById('btnNext').textContent = 'Save'; return; }
  const itemRows = creatorSelected.map(item_name => ({ recipe_id: recipe.id, item_name: stripAmount(item_name) }));
  const { error: itemErr } = await db.from('fddb_recipe_items').insert(itemRows);
  if (itemErr) { showToast('Error: ' + itemErr.message, 'error'); return; }
  await loadRecipes();
  closeCreator();
  renderDashboard(currentDayEntries);
  showToast(`Recipe "${name}" saved`, 'success');
}

/* ── Recipe manage ── */
function renderRecipeManage() {
  const el = document.getElementById('recipeManageList');
  const query = (document.getElementById('recipeSearch')?.value || '').toLowerCase().trim();
  const filterRow = document.getElementById('catFilterRow');
  if (filterRow) {
    filterRow.innerHTML = [
      `<div class="cat-dropdown-item${activeFilterCat===null?' active':''}" onclick="setFilterCat(null);closeCatDropdown()">All categories</div>`,
      `<div class="cat-dropdown-item${activeFilterCat==='__none__'?' active':''}" onclick="setFilterCat('__none__');closeCatDropdown()">No category</div>`,
      ...allCategories.map(c => `<div class="cat-dropdown-item${activeFilterCat===c.id?' active':''}" onclick="setFilterCat('${c.id}');closeCatDropdown()">${c.name}</div>`),
      `<div class="cat-dropdown-divider"></div>`,
      `<div class="cat-dropdown-item" style="color:var(--blue)" onclick="manageCategoriesPrompt();closeCatDropdown()"><i class="fas fa-tags"></i> Manage categories</div>`
    ].join('');
    const label = activeFilterCat === null ? 'All categories'
      : activeFilterCat === '__none__' ? 'No category'
      : (allCategories.find(c => c.id === activeFilterCat)?.name ?? 'All categories');
    const trigger = document.getElementById('catDropdownTrigger');
    document.getElementById('catDropdownLabel').textContent = label;
    if (trigger) trigger.classList.toggle('filtered', activeFilterCat !== null);
  }
  const filtered = [...allRecipes].sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .filter(r => {
      if (activeFilterCat === '__none__') {
        if (r.catIds && r.catIds.length > 0) return false;
      } else if (activeFilterCat && !r.catIds.includes(activeFilterCat)) return false;
      if (!query) return true;
      return r.name.toLowerCase().includes(query) || r.items.some(i => i.toLowerCase().includes(query));
    });
  if (!allRecipes.length) { el.innerHTML = '<div class="empty-recipes"><i class="fas fa-book-open"></i>No recipes created yet</div>'; return; }
  if (!filtered.length) { el.innerHTML = '<div class="empty-recipes"><i class="fas fa-search"></i>No recipes found</div>'; return; }
  el.innerHTML = '';

  const makeCard = (recipe, showCatTags) => {
    const catNames = recipe.catIds.map(id => allCategories.find(c => c.id === id)?.name).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'recipe-manage-card';
    card.innerHTML = `
      <div class="recipe-manage-header" onclick="this.closest('.recipe-manage-card').classList.toggle('open')">
        <div style="flex:1;min-width:0">
          <div class="recipe-manage-name">${recipe.name}</div>
          ${showCatTags && catNames.length ? `<div class="recipe-cat-tags">${catNames.map(n=>`<span class="recipe-cat-tag">${n}</span>`).join('')}</div>` : ''}
        </div>
        <div class="recipe-manage-count">${recipe.items.length} · ${recipe.servings}×</div>
        <div class="recipe-manage-actions">
          <button class="btn-icon-sm btn-dupe" onclick="event.stopPropagation(); duplicateRecipe('${recipe.id}')"><i class="fas fa-copy"></i></button>
          <button class="btn-icon-sm btn-edit" onclick="event.stopPropagation(); openEditModal('${recipe.id}')"><i class="fas fa-pen"></i></button>
          <button class="btn-icon-sm btn-delete" onclick="event.stopPropagation(); deleteRecipe('${recipe.id}', '${recipe.name.replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div class="recipe-manage-items">
        ${[...recipe.items].sort((a,b) => stripAmount(a).localeCompare(stripAmount(b))).map(n => `<div class="manage-ingredient"><i class="fas fa-circle" style="font-size:.4rem;color:var(--accent);margin-right:7px;vertical-align:middle"></i>${n}</div>`).join('')}
      </div>`;
    return card;
  };

  if (activeFilterCat === null && !query) {
    const groups = allCategories
      .map(cat => ({ key: cat.id, label: cat.name, recipes: filtered.filter(r => r.catIds.includes(cat.id)) }))
      .filter(g => g.recipes.length > 0);
    const uncategorized = filtered.filter(r => !r.catIds || r.catIds.length === 0);
    if (uncategorized.length) groups.push({ key: '__none__', label: 'Keine Kategorie', recipes: uncategorized });

    _currentGroupKeys = groups.map(g => g.key);
    const allCollapsed = groups.every(g => collapsedSections.has(g.key));
    const ctrl = document.getElementById('recipeSectionControls');
    if (ctrl) {
      ctrl.innerHTML = `<button class="recipe-collapse-btn" onclick="toggleAllSections(${allCollapsed})"><i class="fas fa-angles-${allCollapsed ? 'down' : 'up'}"></i>${allCollapsed ? 'Expand all' : 'Collapse all'}</button>`;
    }

    groups.forEach(group => {
      const isCollapsed = collapsedSections.has(group.key);
      const header = document.createElement('div');
      header.className = 'recipe-section-header';
      header.innerHTML = `
        <span class="recipe-section-title">${group.label}</span>
        <span class="recipe-section-count">${group.recipes.length}</span>
        <i class="fas fa-chevron-down recipe-section-chevron${isCollapsed ? ' collapsed' : ''}"></i>`;
      header.onclick = () => toggleSection(group.key);
      el.appendChild(header);
      if (!isCollapsed) group.recipes.forEach(r => el.appendChild(makeCard(r, false)));
    });
  } else {
    const ctrl = document.getElementById('recipeSectionControls');
    if (ctrl) ctrl.innerHTML = '';
    filtered.forEach(recipe => el.appendChild(makeCard(recipe, true)));
  }
}
function toggleSection(key) {
  collapsedSections.has(key) ? collapsedSections.delete(key) : collapsedSections.add(key);
  renderRecipeManage();
}
function toggleAllSections(expand) {
  if (expand) _currentGroupKeys.forEach(k => collapsedSections.delete(k));
  else _currentGroupKeys.forEach(k => collapsedSections.add(k));
  renderRecipeManage();
}
function setFilterCat(id) { activeFilterCat = id; renderRecipeManage(); }
function toggleCatDropdown(e) {
  e.stopPropagation();
  document.getElementById('catDropdown').classList.toggle('open');
}
function closeCatDropdown() {
  document.getElementById('catDropdown')?.classList.remove('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#catDropdown')) closeCatDropdown();
});
async function duplicateRecipe(id) {
  const recipe = allRecipes.find(r => r.id === id);
  if (!recipe) return;
  const newName = recipe.name + ' (Copy)';
  const { data: newRecipe, error: recErr } = await db.from('fddb_recipes').insert({ name: newName }).select().single();
  if (recErr) { showToast('Error: ' + recErr.message, 'error'); return; }
  if (recipe.items.length > 0) {
    const rows = recipe.items.map(item_name => ({ recipe_id: newRecipe.id, item_name }));
    await db.from('fddb_recipe_items').insert(rows);
  }
  if (recipe.catIds?.length > 0) {
    await db.from('fddb_recipe_categories').insert(recipe.catIds.map(category_id => ({ recipe_id: newRecipe.id, category_id })));
  }
  await loadRecipes(); renderRecipeManage();
  showToast(`"${newName}" created`, 'success');
  openEditModal(newRecipe.id);
}
async function deleteRecipe(id, name) {
  if (!confirm(`Delete recipe "${name}"?`)) return;
  await db.from('fddb_recipes').delete().eq('id', id);
  await loadRecipes(); renderRecipeManage();
  renderDashboard(currentDayEntries);
  showToast(`"${name}" deleted`);
}

/* ── Strip amount ── */
let stripRegex = /^(?:\d+[.,]?\d*\s*(?:g|kg|ml|l|kcal|stk|pc|el|tl|tbsp|tsp)?|(?:g|kg|ml|l|kcal|stk|pc|el|tl|tbsp|tsp))\s*/i;
function buildStripRegex() {
  if (!allUnits.length) return;
  const units = allUnits.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  stripRegex = new RegExp(`^(?:\\d+[\\.,]?\\d*\\s*(?:${units})?|(?:${units}))\\s*`, 'i');
}
function stripAmount(name) { return name.replace(stripRegex, '').trim(); }

/* ── Edit Modal ── */
let editTargetId = null, editName = '', editItems = [], editServings = 1, editCatIds = [], editAddTab = 'day';
function openEditModal(id) {
  const recipe = allRecipes.find(r => r.id === id);
  if (!recipe) return;
  editTargetId = id; editName = recipe.name; editItems = [...recipe.items];
  editServings = recipe.servings || 1; editCatIds = [...(recipe.catIds || [])]; editAddTab = 'day';
  document.getElementById('editOverlay').classList.add('open');
  renderEditModal();
}
function closeEditModal() { document.getElementById('editOverlay').classList.remove('open'); }
function renderEditModal() {
  document.getElementById('editModalTitle').textContent = editName;
  const dayNames = [...new Set(currentDayEntries.map(e => stripAmount(e.item_name)))].sort((a,b) => a.localeCompare(b));
  const available = dayNames.filter(n => !editItems.includes(n));
  const sortedItems = [...editItems].sort((a,b) => stripAmount(a).localeCompare(stripAmount(b)));
  const body = document.getElementById('editModalBody');
  body.innerHTML = `
    <div class="edit-section">
      <div class="edit-section-title"><i class="fas fa-pen"></i> Name</div>
      <input class="text-input" id="editNameInput" value="${editName.replace(/"/g,'&quot;')}" placeholder="Recipe name…" autocomplete="off">
    </div>
    <div class="edit-section">
      <div class="edit-section-title"><i class="fas fa-utensils"></i> Servings</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <button onclick="changeServings(-1)" style="width:36px;height:36px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:1.1rem;cursor:pointer">−</button>
        <span id="servingsDisplay" style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;color:var(--accent);min-width:24px;text-align:center">${editServings}</span>
        <button onclick="changeServings(1)" style="width:36px;height:36px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:1.1rem;cursor:pointer">+</button>
        <span style="font-size:.78rem;color:var(--text-dim)">Serving${editServings!==1?'s':''}</span>
      </div>
    </div>
    <div class="edit-section">
      <div class="edit-section-title" style="justify-content:space-between;display:flex">
        <span><i class="fas fa-tags"></i> Categories</span>
        <button onclick="promptNewCategory()" style="background:none;border:none;color:var(--accent);font-size:.76rem;cursor:pointer;font-family:inherit">+ New</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px" id="editCatChips">
        ${allCategories.length === 0
          ? `<span style="font-size:.8rem;color:var(--muted)">No categories yet.</span>`
          : allCategories.map(c => `<div class="cat-chip${editCatIds.includes(c.id)?' active':''}" onclick="toggleEditCat('${c.id}')">${c.name}</div>`).join('')}
      </div>
    </div>
    <div class="edit-divider"></div>
    <div class="edit-section">
      <div class="edit-section-title"><i class="fas fa-list"></i> Ingredients (${editItems.length})</div>
      <div id="editIngredientList">
        ${editItems.length === 0
          ? `<div style="font-size:.8rem;color:var(--muted);padding:8px 0">No ingredients – recipe will be deleted on save.</div>`
          : sortedItems.map(item => `
            <div class="edit-ingredient-row">
              <span class="edit-ingredient-name">${item}</span>
              <button class="btn-remove" onclick="editRemoveItem('${item.replace(/'/g,"\\'")}')"><i class="fas fa-times"></i></button>
            </div>`).join('')}
      </div>
    </div>
    <div class="edit-divider"></div>
    <div class="edit-section">
      <div class="edit-section-title"><i class="fas fa-plus"></i> Add Ingredient</div>
      <div class="add-tabs">
        <div class="add-tab ${editAddTab==='day'?'active':''}" onclick="editSwitchTab('day')">From today</div>
        <div class="add-tab ${editAddTab==='text'?'active':''}" onclick="editSwitchTab('text')">Free text</div>
      </div>
      <div class="add-tab-panel ${editAddTab==='day'?'active':''}">
        ${available.length === 0
          ? `<div style="font-size:.8rem;color:var(--muted);padding:8px 0">All items already included.</div>`
          : available.map(n => `
            <div class="select-item" onclick="editAddItem('${n.replace(/'/g,"\\'")}')">
              <div class="sel-box"><i class="fas fa-plus" style="font-size:.6rem"></i></div>
              <div class="sel-name">${n}</div>
            </div>`).join('')}
      </div>
      <div class="add-tab-panel ${editAddTab==='text'?'active':''}">
        <div class="freitext-row">
          <input class="text-input" id="editFreitext" placeholder="e.g. Oats…" autocomplete="off" onkeydown="if(event.key==='Enter') editAddFreitext()">
          <button class="btn-add-item" onclick="editAddFreitext()"><i class="fas fa-plus"></i></button>
        </div>
      </div>
    </div>`;
  document.getElementById('editNameInput').oninput = e => { editName = e.target.value; };
}
function editRemoveItem(name) { editItems = editItems.filter(i => i !== name); renderEditModal(); }
function editAddItem(name) { if (!editItems.includes(name)) editItems.push(name); renderEditModal(); }
function editAddFreitext() {
  const val = (document.getElementById('editFreitext')?.value || '').trim();
  const stripped = stripAmount(val);
  if (!stripped) return;
  if (!editItems.includes(stripped)) editItems.push(stripped);
  renderEditModal();
}
function editSwitchTab(tab) { editAddTab = tab; renderEditModal(); }
function changeServings(delta) {
  editServings = Math.max(1, editServings + delta);
  document.getElementById('servingsDisplay').textContent = editServings;
}
function toggleEditCat(id) {
  if (editCatIds.includes(id)) editCatIds = editCatIds.filter(c => c !== id);
  else editCatIds.push(id);
  const chips = document.getElementById('editCatChips');
  if (chips) chips.innerHTML = allCategories.map(c => `<div class="cat-chip${editCatIds.includes(c.id)?' active':''}" onclick="toggleEditCat('${c.id}')">${c.name}</div>`).join('');
}
async function promptNewCategory() {
  const name = prompt('Category name:');
  if (!name?.trim()) return;
  const { data, error } = await db.from('fddb_categories').insert({ name: name.trim() }).select().single();
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  allCategories.push({ id: data.id, name: data.name });
  allCategories.sort((a,b) => a.name.localeCompare(b.name,'de'));
  editCatIds.push(data.id);
  renderEditModal();
}
async function manageCategoriesPrompt() {
  const name = prompt('Create new category:');
  if (!name?.trim()) return;
  const { error } = await db.from('fddb_categories').insert({ name: name.trim() });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  await loadRecipes(); renderRecipeManage();
  showToast(`Category "${name.trim()}" created`, 'success');
}
async function saveEdit() {
  const name = (document.getElementById('editNameInput')?.value || '').trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }
  if (!editTargetId) return;
  document.getElementById('editSaveBtn').disabled = true;
  const { error: nameErr } = await db.from('fddb_recipes').update({ name, servings: editServings }).eq('id', editTargetId);
  if (nameErr) { showToast('Error: ' + nameErr.message, 'error'); document.getElementById('editSaveBtn').disabled = false; return; }
  await db.from('fddb_recipe_items').delete().eq('recipe_id', editTargetId);
  if (editItems.length > 0) {
    const { error: itemErr } = await db.from('fddb_recipe_items').insert(editItems.map(item_name => ({ recipe_id: editTargetId, item_name })));
    if (itemErr) { showToast('Error: ' + itemErr.message, 'error'); document.getElementById('editSaveBtn').disabled = false; return; }
  }
  await db.from('fddb_recipe_categories').delete().eq('recipe_id', editTargetId);
  if (editCatIds.length > 0) {
    await db.from('fddb_recipe_categories').insert(editCatIds.map(category_id => ({ recipe_id: editTargetId, category_id })));
  }
  document.getElementById('editSaveBtn').disabled = false;
  closeEditModal();
  await loadRecipes(); renderRecipeManage();
  renderDashboard(currentDayEntries);
  showToast(`"${name}" saved`, 'success');
}

/* ── Targets Modal ── */
let targetsEditType = 'training';
let targetsDraft = { training: null, rest: null };
let targetsHistory = [];
async function openTargetsModal() {
  targetsEditType = currentDayType;
  targetsDraft.training = { ...coachTargets.training };
  targetsDraft.rest = { ...coachTargets.rest };
  const { data } = await db.from('fddb_coach_targets').select('*').order('valid_from', { ascending: false });
  targetsHistory = data || [];
  renderTargetsModal();
  document.getElementById('targetsOverlay').classList.add('open');
}
function closeTargetsModal() { document.getElementById('targetsOverlay').classList.remove('open'); }
function saveDraftFromInputs() {
  const kcal = parseInt(document.getElementById('t_kcal')?.value) || 0;
  const p = parseFloat(document.getElementById('t_p')?.value) || 0;
  const c = parseFloat(document.getElementById('t_c')?.value) || 0;
  const f = parseFloat(document.getElementById('t_f')?.value) || 0;
  targetsDraft[targetsEditType] = { kcal, p, c, f };
}
function switchTargetsType(type) { saveDraftFromInputs(); targetsEditType = type; renderTargetsModal(); }
function recalcTargetsKcal() {
  const p = parseFloat(document.getElementById('t_p')?.value) || 0;
  const c = parseFloat(document.getElementById('t_c')?.value) || 0;
  const f = parseFloat(document.getElementById('t_f')?.value) || 0;
  const kcalEl = document.getElementById('t_kcal');
  if (kcalEl) kcalEl.value = Math.round(p * 4 + c * 4 + f * 9);
}
function renderTargetsModal() {
  const t = targetsDraft[targetsEditType];
  const hist = targetsHistory.filter(r => r.type === targetsEditType).slice(0, 5);
  document.getElementById('targetsModalTitle').textContent = targetsEditType === 'training' ? 'Training Goals' : 'Rest Goals';
  document.getElementById('targetsModalBody').innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:18px;">
      <div class="add-tab${targetsEditType==='training'?' active':''}" style="flex:1;text-align:center;cursor:pointer" onclick="switchTargetsType('training')"><i class="fas fa-dumbbell"></i> Training</div>
      <div class="add-tab${targetsEditType==='rest'?' active':''}" style="flex:1;text-align:center;cursor:pointer" onclick="switchTargetsType('rest')"><i class="fas fa-bed"></i> Rest</div>
    </div>
    ${[
      { id:'t_kcal', label:'Calories (kcal)', val: t.kcal, color:'var(--orange)', ro: true },
      { id:'t_p',    label:'Protein (g)',     val: t.p,    color:'var(--blue)'   },
      { id:'t_c',    label:'Carbs (g)',       val: t.c,    color:'var(--yellow)' },
      { id:'t_f',    label:'Fat (g)',         val: t.f,    color:'var(--red)'    },
    ].map(f => `
      <div class="edit-section" style="margin-bottom:12px">
        <div class="edit-section-title" style="color:${f.color}"><i class="fas fa-circle" style="font-size:.4rem"></i> ${f.label}${f.ro ? ' <span style="font-size:.6rem;color:var(--muted);font-family:\'DM Sans\',sans-serif;font-weight:400;text-transform:none;letter-spacing:0">· auto</span>' : ''}</div>
        <input class="text-input" id="${f.id}" type="number" min="0" value="${f.val}" style="margin-bottom:0${f.ro ? ';opacity:.55;cursor:default' : ''}" ${f.ro ? 'readonly' : 'oninput="recalcTargetsKcal()"'}>
      </div>`).join('')}
    ${hist.length > 1 ? `
      <div class="edit-divider"></div>
      <div class="edit-section-title" style="margin-bottom:8px"><i class="fas fa-history"></i> History</div>
      ${hist.map((r, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);opacity:${i===0?'1':'0.5'}">
          <div style="font-size:.75rem;color:var(--muted);flex-shrink:0;width:80px">${r.valid_from}${i===0?' <span style="color:var(--accent);font-size:.6rem">Now</span>':''}</div>
          <div style="flex:1;display:flex;gap:8px;font-size:.75rem;font-family:'Bebas Neue',sans-serif">
            <span style="color:var(--orange)">${r.kcal}</span>
            <span style="color:var(--blue)">${r.protein}p</span>
            <span style="color:var(--yellow)">${r.carbs}c</span>
            <span style="color:var(--red)">${r.fat}f</span>
          </div>
          ${i > 0 ? `<button onclick="deleteTargetRow('${r.id}')" style="background:rgba(248,113,113,.12);color:var(--red);border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:.65rem"><i class="fas fa-trash"></i></button>` : ''}
        </div>`).join('')}` : ''}`;
}
async function deleteTargetRow(id) {
  await db.from('fddb_coach_targets').delete().eq('id', id);
  targetsHistory = targetsHistory.filter(r => r.id !== id);
  renderTargetsModal();
  showToast('Entry deleted');
}
async function saveTargets() {
  saveDraftFromInputs();
  document.getElementById('targetsSaveBtn').disabled = true;
  const today = new Date().toISOString().split('T')[0];
  const [r1, r2] = await Promise.all([
    db.from('fddb_coach_targets').insert({ type: 'training', valid_from: today, kcal: targetsDraft.training.kcal, protein: targetsDraft.training.p, carbs: targetsDraft.training.c, fat: targetsDraft.training.f }),
    db.from('fddb_coach_targets').insert({ type: 'rest', valid_from: today, kcal: targetsDraft.rest.kcal, protein: targetsDraft.rest.p, carbs: targetsDraft.rest.c, fat: targetsDraft.rest.f }),
  ]);
  document.getElementById('targetsSaveBtn').disabled = false;
  if (r1.error || r2.error) { showToast('Error saving', 'error'); return; }
  coachTargets.training = { ...targetsDraft.training };
  coachTargets.rest = { ...targetsDraft.rest };
  closeTargetsModal();
  renderTargetBlock();
  showToast('Goals updated ✓', 'success');
}

/* ══════════════════════════════════════
   STATISTICS (preserved)
   ══════════════════════════════════════ */
let statsPeriod = 'week';
let statsLineChart = null, statsBarChart = null;

