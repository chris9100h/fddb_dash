/* ════════════════════════════════════════════════════════
   FDDB · CHECK — app logic (redesigned)
   Functionality preserved 1:1 from original.
   ════════════════════════════════════════════════════════ */

// ── DB ──
const SUPABASE_URL = 'https://lzhkbbwcjfsvpkpmcwdu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6aGtiYndjamZzdnBrcG1jd2R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4NTUzNDUsImV4cCI6MjA5MTQzMTM0NX0.GhbRy4qhwHbcLgPcp0v5JEtC_oS95O7sh0yl7VXxgDI';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const WATER_URL = 'https://ebbuvdzgstrhrcsbrlez.supabase.co';
const WATER_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImViYnV2ZHpnc3RyaHJjc2JybGV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwMjc4ODAsImV4cCI6MjA5MTYwMzg4MH0.RyTzHiqV1TPSZtM7lgenBJbUCTjj5fCUhoWauifjlIE';
const dbWater = supabase.createClient(WATER_URL, WATER_KEY);

const ORDER = ['frühstück','zwischenmahlzeit 1','snack_2','mittagessen','zwischenmahlzeit 2','snack_4','abendbrot','abendessen'];
const LABELS = { 'frühstück':'Breakfast','zwischenmahlzeit 1':'Snack 1','snack_2':'Snack 2','mittagessen':'Lunch','zwischenmahlzeit 2':'Snack 3','snack_4':'Snack 4','abendbrot':'Dinner','abendessen':'Dinner','weekly_treat':'Weekly Treat','meal_of_choice':'Meal of Choice' };
const WEEKLY_TREAT_MEAL = 'weekly_treat';
const MEAL_OF_CHOICE = 'meal_of_choice';
const MOC_KCAL = 1200;

let checkables = [];
let totals = { kcal:0, p:0, c:0, f:0 };
let allRecipes = [];
let allCategories = [];
let allUnits = [];
let activeFilterCat = null;
let expandedSections = new Set();
let _currentGroupKeys = [];
let currentDayEntries = [];
let currentCheckedMap = {};
let currentDate = '';
let coachTargets = { training: {kcal:0,p:0,c:0,f:0}, rest: {kcal:0,p:0,c:0,f:0} };
let currentDayType = 'training';
let mergeServings = false;
let timelineMode = false;
let itemTimeMap = {};
let waterData = { drunk: null, goal: null };
let currentAdherence = null;
let mocUsedThisWeek = null; // null = unknown, false = not used, string = date it was used

// Sentinel minute-value for the training Intra Workout row.
// Stored in fddb_item_times like any other assignment; outside the normal
// 180–1320 range so it never collides with real time slots.
const INTRA_WORKOUT_SLOT = 1440;

function getWeekBounds(dateStr) {
  const d = new Date(dateStr);
  const dow = d.getDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d); mon.setDate(d.getDate() + diffToMon);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = x => x.toISOString().split('T')[0];
  return { monday: fmt(mon), sunday: fmt(sun) };
}

// ── Init ──
// Hoisted cache for finalized-day rows (used by renderDateStrip on first paint).
// Use var so it's hoisted and safe to reference from function bodies before init.
var finalizedMap = new Map();
const todayStr = new Date().toISOString().split('T')[0];
document.getElementById('dateInput').value = todayStr;
currentDate = todayStr;
renderDateStrip(todayStr);
document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));

// ── Auth ──
(async function initAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    document.getElementById('loginOverlay').classList.add('hidden');
    initApp();
  }
  db.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      document.getElementById('loginOverlay').classList.remove('hidden');
    }
  });
})();

function initApp() {
  loadFinalizedMap().then(() => renderDateStrip(currentDate));
  setTimeout(initSettingsUI, 0);
  loadRecipes().then(() => loadDay());
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('loginError');
  errorEl.classList.remove('show');
  btn.classList.add('loading');
  btn.disabled = true;
  const { error } = await db.auth.signInWithPassword({ email, password });
  btn.classList.remove('loading');
  btn.disabled = false;
  if (error) {
    errorEl.textContent = error.message;
    errorEl.classList.add('show');
    return;
  }
  document.getElementById('loginOverlay').classList.add('hidden');
  initApp();
}

async function doLogout() {
  await db.auth.signOut();
  document.getElementById('loginOverlay').classList.remove('hidden');
}

/* ══════════════════════════════════════
   SETTINGS (Supabase-backed, localStorage cache)
   ══════════════════════════════════════ */
const SETTINGS_CACHE_KEY = 'fddb.settings.cache.v1';
const SETTINGS_DEFAULTS = {
  adherenceGoal: 80,        // % — threshold for a day to count
  adherenceCutoff: '22:00', // HH:MM — auto-finalize time
  sickModeActive: false,    // when true, every day (incl. today) is auto-marked 'sick'
  sickSince: null,          // YYYY-MM-DD — date sick mode started
  freezePerWeek: 2,         // max freeze days allowed per window
  freezeWindow: 1,          // window size in weeks (1 / 2 / 4)
  weeklyTreatMaxKcal: 0,    // 0 = no limit; excess kcal above threshold count against totals
  mocKcal: 1200,            // kcal budget for one Meal of Choice
  showWeightChart:   true,   // overlay weight as secondary axis on deviation chart
  showInsulinChip:   false,  // show synthetic Insulin – Novorapid chip in timeline
  showTrainingChip:  false,  // show draggable Training block in timeline
  trainingDuration:  60,     // training window length in minutes (global)
  showDateStripInTimeline: false,
  showMealRail:      true,   // show meal-category coloured rail on the left of the timeline
  showNowLine:       true,   // show current-time indicator line in timeline
  timelinePrimary:   false,  // timeline is the default view; dashboard is read-only
};
let settings = { ...SETTINGS_DEFAULTS };

// Hydrate from cache immediately so UI doesn't flash defaults.
try {
  const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
  if (raw) settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
} catch (e) { /* ignore */ }

// Apply timeline-primary DOM state synchronously so the page never renders
// with the wrong tab active or without the tl-mode class. Everything here
// mirrors what setTodayView() does, but without triggering a data render.
if (settings.timelinePrimary) {
  timelineMode = true;
  document.getElementById('tsnDashboard')?.classList.remove('active');
  document.getElementById('tsnTimeline')?.classList.add('active');
  document.getElementById('todaySubNav')?.classList.add('tl-primary');
  document.getElementById('viewMain')?.classList.add('tl-mode');
  if (settings.showDateStripInTimeline) document.getElementById('viewMain')?.classList.add('tl-show-date-strip');
  const cb = document.getElementById('checkedBlock'); if (cb) cb.style.display = 'none';
  const eyebrow = document.querySelector('#viewMain .large-header .eyebrow');
  const title   = document.querySelector('#viewMain .large-header .large-title');
  if (eyebrow) eyebrow.textContent = 'Daily Schedule';
  if (title)   title.textContent   = 'Timeline';
}

function cacheSettings() {
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings)); } catch (e) {}
}

// Map camelCase setting key ⇆ Supabase row key.
// Using snake_case in DB matches the convention of other fddb_ tables.
const SETTING_DB_KEYS = {
  adherenceGoal:       'adherence_goal',
  adherenceCutoff:     'adherence_cutoff',
  sickModeActive:      'sick_mode_active',
  sickSince:           'sick_since',
  freezePerWeek:       'freeze_per_week',
  freezeWindow:        'freeze_window',
  weeklyTreatMaxKcal:  'weekly_treat_max_kcal',
  mocKcal:             'moc_kcal',
  showWeightChart:     'show_weight_chart',
  showInsulinChip:     'show_insulin_chip',
  showTrainingChip:    'show_training_chip',
  trainingDuration:    'training_duration',
  showDateStripInTimeline: 'show_date_strip_in_timeline',
  showMealRail:        'show_meal_rail',
  showNowLine:         'show_now_line',
  timelinePrimary:     'timeline_primary',
};

async function writeSettingToDb(key, value) {
  const dbKey = SETTING_DB_KEYS[key];
  if (!dbKey) return;
  try {
    await db.from('fddb_settings').upsert(
      { key: dbKey, value: JSON.stringify(value) },
      { onConflict: 'key' }
    );
  } catch (e) { /* silent — cache still holds value */ }
}

async function loadSettingsFromDb() {
  try {
    const { data, error } = await db.from('fddb_settings').select('key, value');
    if (error || !data) return;
    const map = {};
    for (const row of data) {
      let v = row.value;
      // value is stored as JSON — may arrive as object or JSON string.
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
      map[row.key] = v;
    }
    let changed = false;
    for (const [camelKey, dbKey] of Object.entries(SETTING_DB_KEYS)) {
      if (map[dbKey] !== undefined && map[dbKey] !== settings[camelKey]) {
        settings[camelKey] = map[dbKey];
        changed = true;
      }
    }
    if (changed) {
      cacheSettings();
      applySettingsToUI();
    }
  } catch (e) { /* offline — keep cached values */ }
}

// Applies the timeline-primary setting after a live toggle in the settings
// panel: swaps tab order, syncs checkbox, and switches view with a full render.
function applyTimelinePrimary() {
  document.getElementById('todaySubNav')?.classList.toggle('tl-primary', !!settings.timelinePrimary);
  const el = document.getElementById('setTimelinePrimary');
  if (el) el.checked = !!settings.timelinePrimary;
  setTodayView(settings.timelinePrimary ? 'timeline' : (timelineMode ? 'timeline' : 'dashboard'));
}

function applySettingsToUI() {
  const goalEl = document.getElementById('setAdherenceGoal');
  const cutoffEl = document.getElementById('setAdherenceCutoff');
  const sickEl = document.getElementById('setSickMode');
  const sickSubEl = document.getElementById('sickModeSub');
  if (!goalEl) return;
  goalEl.value = settings.adherenceGoal;
  cutoffEl.value = settings.adherenceCutoff;
  if (sickEl) sickEl.checked = !!settings.sickModeActive;
  if (sickSubEl) {
    sickSubEl.textContent = settings.sickModeActive
      ? `Active since ${settings.sickSince || '—'} · all days marked sick`
      : 'Off';
  }
  applyTimelinePrimary();
  const freezePerWeekEl   = document.getElementById('setFreezePerWeek');
  const freezeWindowEl    = document.getElementById('setFreezeWindow');
  const treatMaxKcalEl    = document.getElementById('setTreatMaxKcal');
  const mocKcalEl         = document.getElementById('setMocKcal');
  const showWeightChartEl = document.getElementById('setShowWeightChart');
  if (freezePerWeekEl)   freezePerWeekEl.value   = settings.freezePerWeek;
  if (freezeWindowEl)    freezeWindowEl.value    = settings.freezeWindow;
  if (treatMaxKcalEl)    treatMaxKcalEl.value    = settings.weeklyTreatMaxKcal;
  if (mocKcalEl)         mocKcalEl.value         = settings.mocKcal;
  if (showWeightChartEl) showWeightChartEl.checked = !!settings.showWeightChart;
  applySickModeOverlay();
}

// Show the sick overlay on the hero card iff the *currently viewed day*
// is marked as sick in finalizedMap. Unrelated to the global sickModeActive
// toggle — a day can be sick without the toggle being on (manual override),
// and the toggle being on doesn't paint past/future non-sick days.
function applySickModeOverlay() {
  const heroCard = document.querySelector('.hero-card');
  if (!heroCard) return;
  const row = finalizedMap.get(currentDate);
  const isSick = row && row.status === 'sick';
  heroCard.classList.toggle('sick-mode', !!isSick);
}

function initSettingsUI() {
  const goalEl = document.getElementById('setAdherenceGoal');
  const cutoffEl = document.getElementById('setAdherenceCutoff');
  if (!goalEl) return;

  applySettingsToUI();

  goalEl.addEventListener('change', () => {
    const v = parseInt(goalEl.value, 10);
    settings.adherenceGoal = Number.isFinite(v) ? v : SETTINGS_DEFAULTS.adherenceGoal;
    cacheSettings();
    writeSettingToDb('adherenceGoal', settings.adherenceGoal);
  });
  cutoffEl.addEventListener('change', () => {
    const v = cutoffEl.value || SETTINGS_DEFAULTS.adherenceCutoff;
    settings.adherenceCutoff = v;
    cacheSettings();
    writeSettingToDb('adherenceCutoff', v);
  });

  const sickEl = document.getElementById('setSickMode');
  if (sickEl) {
    sickEl.addEventListener('change', async () => {
      const on = sickEl.checked;
      settings.sickModeActive = on;
      settings.sickSince = on ? todayISO() : null;
      cacheSettings();
      applySettingsToUI(); // refresh sub-label
      await writeSettingToDb('sickModeActive', on);
      await writeSettingToDb('sickSince', settings.sickSince);
      const today = todayISO();
      if (on) {
        // Force-apply sick to today
        await writeFinalizedDay(today, null, settings.adherenceGoal, 'sick');
      } else {
        // Turning off: remove today's sick entry so it can re-auto-finalize normally
        const row = finalizedMap.get(today);
        if (row && row.status === 'sick') {
          await deleteFinalizedDay(today);
        }
      }
      if (typeof renderDateStrip === 'function') renderDateStrip(currentDate || today);
      if (typeof renderStreak === 'function') renderStreak();
      applySickModeOverlay();
      showToast(on ? 'Sick mode on' : 'Sick mode off');
    });
  }

  const freezePerWeekEl = document.getElementById('setFreezePerWeek');
  if (freezePerWeekEl) {
    freezePerWeekEl.addEventListener('change', () => {
      settings.freezePerWeek = parseInt(freezePerWeekEl.value, 10);
      cacheSettings();
      writeSettingToDb('freezePerWeek', settings.freezePerWeek);
    });
  }

  const freezeWindowEl = document.getElementById('setFreezeWindow');
  if (freezeWindowEl) {
    freezeWindowEl.addEventListener('change', () => {
      settings.freezeWindow = parseInt(freezeWindowEl.value, 10);
      cacheSettings();
      writeSettingToDb('freezeWindow', settings.freezeWindow);
    });
  }

  const treatMaxKcalEl = document.getElementById('setTreatMaxKcal');
  if (treatMaxKcalEl) {
    treatMaxKcalEl.addEventListener('change', () => {
      settings.weeklyTreatMaxKcal = parseInt(treatMaxKcalEl.value, 10);
      cacheSettings();
      writeSettingToDb('weeklyTreatMaxKcal', settings.weeklyTreatMaxKcal);
      if (currentDate) renderDashboard(currentDayEntries);
    });
  }

  const mocKcalEl = document.getElementById('setMocKcal');
  if (mocKcalEl) {
    mocKcalEl.addEventListener('change', () => {
      settings.mocKcal = parseInt(mocKcalEl.value, 10);
      cacheSettings();
      writeSettingToDb('mocKcal', settings.mocKcal);
    });
  }

  const showWeightChartEl = document.getElementById('setShowWeightChart');
  if (showWeightChartEl) {
    showWeightChartEl.addEventListener('change', () => {
      settings.showWeightChart = showWeightChartEl.checked;
      cacheSettings();
      writeSettingToDb('showWeightChart', settings.showWeightChart);
    });
  }

  const showInsulinEl = document.getElementById('setShowInsulinChip');
  if (showInsulinEl) {
    showInsulinEl.checked = !!settings.showInsulinChip;
    showInsulinEl.addEventListener('change', () => {
      settings.showInsulinChip = showInsulinEl.checked;
      cacheSettings();
      writeSettingToDb('showInsulinChip', settings.showInsulinChip);
      if (timelineMode) renderDashboard(currentDayEntries);
    });
  }

  const showTrainingEl = document.getElementById('setShowTrainingChip');
  if (showTrainingEl) {
    showTrainingEl.checked = !!settings.showTrainingChip;
    showTrainingEl.addEventListener('change', () => {
      settings.showTrainingChip = showTrainingEl.checked;
      cacheSettings();
      writeSettingToDb('showTrainingChip', settings.showTrainingChip);
      if (timelineMode) renderDashboard(currentDayEntries);
    });
  }

  const trainingDurationEl = document.getElementById('setTrainingDuration');
  if (trainingDurationEl) {
    trainingDurationEl.value = settings.trainingDuration;
    trainingDurationEl.addEventListener('change', () => {
      const v = parseInt(trainingDurationEl.value, 10);
      if (Number.isFinite(v) && v >= 15) {
        settings.trainingDuration = v;
        cacheSettings();
        writeSettingToDb('trainingDuration', settings.trainingDuration);
        if (timelineMode) renderDashboard(currentDayEntries);
      }
    });
  }

  const showNowLineEl = document.getElementById('setShowNowLine');
  if (showNowLineEl) {
    showNowLineEl.checked = !!settings.showNowLine;
    showNowLineEl.addEventListener('change', () => {
      settings.showNowLine = showNowLineEl.checked;
      cacheSettings();
      writeSettingToDb('showNowLine', settings.showNowLine);
      if (timelineMode) { updateNowLine(); }
    });
  }

  const showDateStripEl = document.getElementById('setShowDateStripInTimeline');
  if (showDateStripEl) {
    showDateStripEl.checked = !!settings.showDateStripInTimeline;
    showDateStripEl.addEventListener('change', () => {
      settings.showDateStripInTimeline = showDateStripEl.checked;
      cacheSettings();
      writeSettingToDb('showDateStripInTimeline', settings.showDateStripInTimeline);
      document.getElementById('viewMain').classList.toggle('tl-show-date-strip', settings.showDateStripInTimeline);
    });
  }

  const showMealRailEl = document.getElementById('setShowMealRail');
  if (showMealRailEl) {
    showMealRailEl.checked = !!settings.showMealRail;
    showMealRailEl.addEventListener('change', () => {
      settings.showMealRail = showMealRailEl.checked;
      cacheSettings();
      writeSettingToDb('showMealRail', settings.showMealRail);
      if (timelineMode) renderTimelineDashboard(currentDayEntries);
    });
  }

  const tlPrimaryEl = document.getElementById('setTimelinePrimary');
  if (tlPrimaryEl) {
    tlPrimaryEl.checked = !!settings.timelinePrimary;
    tlPrimaryEl.addEventListener('change', () => {
      settings.timelinePrimary = tlPrimaryEl.checked;
      cacheSettings();
      writeSettingToDb('timelinePrimary', settings.timelinePrimary);
      applyTimelinePrimary();
    });
  }

  // Background refresh from server — overrides cache if newer values exist.
  loadSettingsFromDb();

  initSettingsCollapse();
}

function initSettingsCollapse() {
  document.querySelectorAll('#viewSettings .settings-section').forEach(section => {
    const title = section.querySelector('.settings-section-title');
    const alwaysOpen = section.hasAttribute('data-always-open');
    const chev = document.createElement('i');
    chev.className = 'fas fa-chevron-down settings-chevron';
    title.appendChild(chev);
    if (!alwaysOpen) {
      section.classList.add('collapsed');
      title.addEventListener('click', () => section.classList.toggle('collapsed'));
    }
  });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ── Date Strip ── */
// Window-offset: 0 means today is the rightmost pill, 4 means 4 days back, etc.
var dateStripOffset = 0;

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
  document.getElementById('checkedBlock').style.display = (mergeServings || timelineMode) ? 'none' : '';
  document.getElementById('content').classList.toggle('merge-active', mergeServings);
  renderDashboard(currentDayEntries);
}

/* ── Timeline toggle ── */
let _nowLineTimer = null;

function updateNowLine() {
  const wrap = document.querySelector('.timeline-view');
  wrap?.querySelector('.tl-now-line')?.remove();
  if (!wrap || !timelineMode || !settings.showNowLine) return;

  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur < 180 || cur > 1320) return;

  const slot = Math.floor(cur / 30) * 30;
  const anchor = wrap.querySelector(`[data-hour="${slot}"]`);
  if (!anchor) return;

  const line = document.createElement('div');
  line.className = 'tl-now-line';
  line.innerHTML = `<span class="tl-now-label">▶ ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}</span>`;
  anchor.after(line);
}

function setTodayView(mode) {
  timelineMode = (mode === 'timeline');
  document.getElementById('tsnDashboard').classList.toggle('active', !timelineMode);
  document.getElementById('tsnTimeline').classList.toggle('active', timelineMode);
  document.getElementById('viewMain').classList.toggle('tl-mode', timelineMode);
  document.getElementById('viewMain').classList.toggle('tl-show-date-strip', timelineMode && !!settings.showDateStripInTimeline);
  document.getElementById('checkedBlock').style.display = (timelineMode || mergeServings) ? 'none' : '';
  if (!timelineMode) { clearInterval(_nowLineTimer); _nowLineTimer = null; }
  const eyebrow = document.querySelector('#viewMain .large-header .eyebrow');
  const title   = document.querySelector('#viewMain .large-header .large-title');
  if (eyebrow) eyebrow.textContent = timelineMode ? 'Daily Schedule' : 'Daily Intake';
  if (title)   title.textContent   = timelineMode ? 'Timeline'        : 'Checklist';
  renderDashboard(currentDayEntries);
}

const tlTimePending = {};
function saveItemTime(itemKey, minutes) {
  if (minutes === null) delete itemTimeMap[itemKey];
  else itemTimeMap[itemKey] = minutes;
  clearTimeout(tlTimePending[itemKey]);
  tlTimePending[itemKey] = setTimeout(async () => {
    if (minutes === null) {
      await db.from('fddb_item_times').delete().eq('date', currentDate).eq('item_key', itemKey);
    } else {
      await db.from('fddb_item_times').upsert({ date: currentDate, item_key: itemKey, minutes }, { onConflict: 'date,item_key' });
    }
  }, 400);
}

function formatSlot(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`;
}

const TL_COLORS = {
  'frühstück':'#a78bfa','zwischenmahlzeit 1':'#4ade80','snack_2':'#34d399',
  'mittagessen':'#60a5fa','zwischenmahlzeit 2':'#f97316','snack_4':'#fb923c',
  'abendbrot':'#f472b6','abendessen':'#f472b6',
};

// Maps each time range to its meal category. Used when a chip is dropped
// onto a timeline slot so the dashboard category follows the time placement.
const TIME_TO_MEAL = [
  { from: 180,  to: 300,  meal: 'frühstück'        }, // 03:00–05:00
  { from: 330,  to: 450,  meal: 'zwischenmahlzeit 1' }, // 05:30–07:30
  { from: 480,  to: 660,  meal: 'snack_2'           }, // 08:00–11:00
  { from: 690,  to: 870,  meal: 'mittagessen'       }, // 11:30–14:30
  { from: 900,  to: 1020, meal: 'zwischenmahlzeit 2' }, // 15:00–17:00
  { from: 1050, to: 1170, meal: 'snack_4'           }, // 17:30–19:30
  { from: 1200, to: 1320, meal: 'abendbrot'         }, // 20:00–22:00
];
function getMealForTime(minutes) {
  if (minutes == null) return null;
  const slot = TIME_TO_MEAL.find(s => minutes >= s.from && minutes <= s.to);
  return slot ? slot.meal : null;
}

// Returns the set of recipe names that have been "exploded" into per-serving DB rows.
// A recipe is considered exploded only when its entries span ≥2 distinct non-null
// serving_index values across all meals for the current day. This correctly handles
// both NULL defaults and integer 0 defaults for the serving_index column.
function computeExplodedRecipes() {
  const recipeTemplateMap = new Map(allRecipes.map(r => [r.id, r]));
  const exploded = new Set();
  allRecipes.forEach(recipe => {
    if ((recipe.servings || 1) <= 1) return;
    const effectiveItems = recipe.templateId
      ? [...new Set([...(recipeTemplateMap.get(recipe.templateId)?.items || []), ...recipe.items])]
      : recipe.items;
    if (!effectiveItems.length) return;
    const indices = new Set(
      currentDayEntries
        .filter(e => effectiveItems.includes(stripAmount(e.item_name)))
        .map(e => e.serving_index)
        .filter(v => v != null)
    );
    if (indices.size >= 2) exploded.add(recipe.name);
  });
  return exploded;
}

function buildTlRenderBlocks(meal, items) {
  const renderBlocks = [];
  const recipeTemplateMap = new Map(allRecipes.map(r => [r.id, r]));
  const recipesByLength = [...allRecipes].map(r => {
    if (r.templateId) {
      const tmpl = recipeTemplateMap.get(r.templateId);
      if (tmpl) return { ...r, effectiveItems: [...new Set([...tmpl.items, ...r.items])] };
    }
    return { ...r, effectiveItems: r.items };
  }).sort((a, b) => b.effectiveItems.length - a.effectiveItems.length);

  const explodedRecipeNames = computeExplodedRecipes();
  const remaining = items.map((item, idx) => ({ item, idx, used: false }));

  recipesByLength.forEach(recipe => {
    if (recipe.effectiveItems.length === 0) return;
    const isExploded = explodedRecipeNames.has(recipe.name);

    if (isExploded) {
      // Recipe was explicitly split: group items in this meal by serving_index,
      // match the recipe independently within each group.
      const siGroups = {};
      remaining.forEach(r => {
        if (r.used) return;
        const si = r.item.serving_index ?? 0;
        (siGroups[si] = siGroups[si] || []).push(r);
      });
      for (const [si, pool] of Object.entries(siGroups)) {
        const matched = [];
        let allFound = true;
        for (const rName of recipe.effectiveItems) {
          const found = pool.find(r => !matched.includes(r) && stripAmount(r.item.item_name) === rName);
          if (found) matched.push(found);
          else { allFound = false; break; }
        }
        if (allFound && matched.length > 0) {
          matched.forEach(r => { remaining[r.idx].used = true; });
          const recEntries = matched.map(r => r.item);
          const servingIdx = parseInt(si, 10);
          renderBlocks.push({
            type: 'recipe', recipe, entries: recEntries,
            serving: servingIdx, servings: recipe.servings || 1, isExploded: true,
            firstIdx: Math.min(...matched.map(r => r.idx)), meal,
            tlKey: `${meal}::${recipe.name}::${servingIdx}`,
          });
        }
      }
    } else {
      // Standard: all entries in this meal represent all servings combined.
      const matchIndices = [];
      const workingPool = remaining.filter(r => !r.used);
      let allFound = true;
      for (const rName of recipe.effectiveItems) {
        const found = workingPool.find(r => !matchIndices.includes(r.idx) && stripAmount(r.item.item_name) === rName);
        if (found) matchIndices.push(found.idx);
        else { allFound = false; break; }
      }
      if (allFound && matchIndices.length > 0) {
        matchIndices.forEach(idx => { remaining[idx].used = true; });
        const servings = recipe.servings || 1;
        const recEntries = matchIndices.map(idx => items[idx]);
        const baseIdx = Math.min(...matchIndices);
        for (let s = 0; s < servings; s++) {
          renderBlocks.push({ type: 'recipe', recipe, entries: recEntries, serving: s, servings, isExploded: false, firstIdx: baseIdx + s * 0.001, meal, tlKey: `${meal}::${recipe.name}::${s}` });
        }
      }
    }
  });

  remaining.filter(r => !r.used).forEach(r => {
    renderBlocks.push({ type: 'item', entry: r.item, firstIdx: r.idx, meal, tlKey: `${meal}::${r.item.item_name}` });
  });

  renderBlocks.sort((a, b) => a.firstIdx - b.firstIdx);
  return renderBlocks;
}

function renderTimelineDashboard(entries) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  checkables = [];
  applySickModeOverlay();

  totals = {kcal:0,p:0,c:0,f:0};
  entries.forEach(e => {
    if (e.meal !== WEEKLY_TREAT_MEAL) {
      totals.kcal += e.kcal||0; totals.p += parseFloat(e.protein)||0;
      totals.c += parseFloat(e.carbs)||0; totals.f += parseFloat(e.fat)||0;
    }
  });
  const treatItems = entries.filter(e => e.meal === WEEKLY_TREAT_MEAL);
  if (treatItems.length && settings.weeklyTreatMaxKcal > 0) {
    const treatKcal = treatItems.reduce((s,e) => s+(e.kcal||0), 0);
    if (treatKcal > settings.weeklyTreatMaxKcal) {
      const f = (treatKcal - settings.weeklyTreatMaxKcal) / treatKcal;
      treatItems.forEach(e => {
        totals.kcal += (e.kcal||0)*f; totals.p += (parseFloat(e.protein)||0)*f;
        totals.c += (parseFloat(e.carbs)||0)*f; totals.f += (parseFloat(e.fat)||0)*f;
      });
    }
  }

  if (!entries.length) {
    content.innerHTML = '<div class="placeholder"><i class="fas fa-bowl-food"></i>No entries for this date</div>';
    renderTargetBlock(); updateChecked();
    return;
  }

  // Build recipe-grouped blocks per meal, then group by assigned slot (minutes)
  const tlEntries = entries; // treat + MoC included; styled distinctly in makeTlChip
  const grouped = {};
  tlEntries.forEach(e => (grouped[e.meal] = grouped[e.meal] || []).push(e));

  const allBlocks = [];
  if (settings.showInsulinChip) {
    allBlocks.push({ type: 'insulin', tlKey: 'insulin::novorapid', meal: null });
  }
  if (settings.showTrainingChip) {
    allBlocks.push({ type: 'training', tlKey: 'training::session', meal: null });
  }
  for (const meal of Object.keys(grouped)) {
    const items = (grouped[meal] || []).slice().sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    allBlocks.push(...buildTlRenderBlocks(meal, items));
  }

  const bySlot = {};
  allBlocks.forEach(block => {
    const m = itemTimeMap[block.tlKey] ?? null;
    const key = m == null ? 'null' : m;
    (bySlot[key] = bySlot[key] || []).push(block);
  });

  // Compute training macro sum: items assigned to Intra Workout row
  const trainingSlot = settings.showTrainingChip ? (itemTimeMap['training::session'] ?? null) : null;
  if (trainingSlot != null) {
    const wm = { kcal: 0, p: 0, c: 0, f: 0 };
    allBlocks.forEach(block => {
      if (block.type === 'training' || block.type === 'insulin') return;
      const m = itemTimeMap[block.tlKey] ?? null;
      if (m === INTRA_WORKOUT_SLOT) {
        if (block.type === 'item') {
          const e = block.entry;
          wm.kcal += e.kcal||0; wm.p += parseFloat(e.protein)||0;
          wm.c += parseFloat(e.carbs)||0; wm.f += parseFloat(e.fat)||0;
        } else {
          const pm = macroSum(block.entries);
          const d = block.isExploded ? 1 : block.servings;
          wm.kcal += pm.kcal/d; wm.p += pm.p/d;
          wm.c += pm.c/d; wm.f += pm.f/d;
        }
      }
    });
    const trainingBlock = allBlocks.find(b => b.type === 'training');
    if (trainingBlock) trainingBlock.windowMacros = wm;
  }

  // Compute insulin window macro sum before rendering so the chip can display it
  const insulinSlot = settings.showInsulinChip ? (itemTimeMap['insulin::novorapid'] ?? null) : null;
  if (insulinSlot != null) {
    const endSlot = Math.min(insulinSlot + 4 * 60, 1320);
    const wm = { kcal: 0, p: 0, c: 0, f: 0 };
    allBlocks.forEach(block => {
      if (block.type === 'insulin') return;
      const m = itemTimeMap[block.tlKey] ?? null;
      if (m != null && m >= insulinSlot && m <= endSlot) {
        if (block.type === 'item') {
          const e = block.entry;
          wm.kcal += e.kcal||0; wm.p += parseFloat(e.protein)||0;
          wm.c += parseFloat(e.carbs)||0; wm.f += parseFloat(e.fat)||0;
        } else {
          const pm = macroSum(block.entries);
          const d = block.isExploded ? 1 : block.servings;
          wm.kcal += pm.kcal/d; wm.p += pm.p/d;
          wm.c += pm.c/d; wm.f += pm.f/d;
        }
      }
    });
    const insulinBlock = allBlocks.find(b => b.type === 'insulin');
    if (insulinBlock) insulinBlock.windowMacros = wm;
  }

  const wrap = document.createElement('div');
  wrap.className = 'timeline-view';
  const nullBlocks = bySlot['null'] || [];
  if (nullBlocks.length) {
    const hdr = document.createElement('div');
    hdr.className = 'tl-unassigned-header';
    hdr.innerHTML = '<i class="fas fa-clock"></i> No time slot';
    wrap.appendChild(hdr);
  }
  wrap.appendChild(buildTlRow('null', nullBlocks));
  for (let m = 180; m <= 1320; m += 30) wrap.appendChild(buildTlRow(m, bySlot[m] || []));
  // Intra Workout row only needed when the training chip is placed — otherwise
  // it has no parent block and floats loose in the DOM, appearing during drag.
  if (trainingSlot != null) {
    wrap.appendChild(buildTlRow(INTRA_WORKOUT_SLOT, bySlot[INTRA_WORKOUT_SLOT] || []));
  }

  // Build insulin block: a visual box wrapping the header chip row, all window
  // rows with items, and the macro summary footer.
  if (insulinSlot != null) {
    const endSlot = Math.min(insulinSlot + 4 * 60, 1320);
    const wm = allBlocks.find(b => b.type === 'insulin')?.windowMacros;

    // Create the wrapper and insert it where the insulin row sits
    const insulinRow = wrap.querySelector(`[data-hour="${insulinSlot}"]`);
    const block = document.createElement('div');
    block.className = 'tl-insulin-block';
    wrap.insertBefore(block, insulinRow);

    // Extract the insulin chip into a standalone chip-bar header (not a tl-row)
    // so the insulin slot row itself becomes the first droppable window slot.
    const chipBar = document.createElement('div');
    chipBar.className = 'tl-insulin-chip-bar';
    const insulinChip = insulinRow.querySelector('.tl-chip-insulin');
    if (insulinChip) chipBar.appendChild(insulinChip);
    block.appendChild(chipBar);

    // Move all window rows into block starting at insulinSlot (not +30).
    // First row gets tl-insulin-window-start so it stays visible at rest.
    for (let m = insulinSlot; m <= endSlot; m += 30) {
      const row = wrap.querySelector(`[data-hour="${m}"]`);
      if (!row) continue;
      row.classList.add('tl-insulin-range');
      if (m === insulinSlot) {
        row.classList.add('tl-insulin-window-start');
        // If we pulled the only chip out, the row is now empty
        if (!row.querySelector('.tl-chip')) row.classList.remove('tl-has-items');
      }
      block.appendChild(row);
    }

    // Append macro summary footer
    const summary = document.createElement('div');
    summary.className = 'tl-insulin-summary';
    summary.innerHTML =
      `<span class="tl-insulin-summary-label"><i class="fas fa-syringe" style="margin-right:5px"></i>Active until ${formatSlot(Math.min(insulinSlot + 4 * 60, 1320))}</span>` +
      `<span class="tl-insulin-summary-vals">` +
        `<span>${Math.round(wm?.kcal ?? 0)}<small>kcal</small></span>` +
        `<span>${Math.round(wm?.p ?? 0)}<small>P</small></span>` +
        `<span>${Math.round(wm?.c ?? 0)}<small>C</small></span>` +
        `<span>${Math.round(wm?.f ?? 0)}<small>F</small></span>` +
      `</span>`;
    block.appendChild(summary);
  }

  // Build training block: chip-bar header + Intra Workout row + footer.
  // No regular time-slot rows are used, so no conflict with the insulin window.
  if (trainingSlot != null) {
    const slots = Math.floor(settings.trainingDuration / 30);
    const wm = allBlocks.find(b => b.type === 'training')?.windowMacros;

    const trainingRow = wrap.querySelector(`[data-hour="${trainingSlot}"]`);
    const block = document.createElement('div');
    block.className = 'tl-training-block';
    wrap.insertBefore(block, trainingRow);

    // Extract chip into standalone chip-bar (leaves trainingRow in the wrap
    // as a normal empty/occupied slot visible to other blocks e.g. insulin).
    const chipBar = document.createElement('div');
    chipBar.className = 'tl-training-chip-bar';
    const trainingChip = trainingRow.querySelector('.tl-chip-training');
    if (trainingChip) chipBar.appendChild(trainingChip);
    if (!trainingRow.querySelector('.tl-chip')) trainingRow.classList.remove('tl-has-items');
    block.appendChild(chipBar);

    // Move Intra Workout row into block (always visible, always droppable)
    const intraRow = wrap.querySelector(`[data-hour="${INTRA_WORKOUT_SLOT}"]`);
    if (intraRow) block.appendChild(intraRow);

    const durLabel = '<i class="fas fa-dumbbell" style="margin-right:5px"></i>Ends ' + formatSlot(trainingSlot + slots * 30);
    const summary = document.createElement('div');
    summary.className = 'tl-training-summary';
    summary.innerHTML =
      `<span class="tl-training-summary-label">${durLabel}</span>` +
      `<span class="tl-training-summary-vals">` +
        `<span>${Math.round(wm?.kcal ?? 0)}<small>kcal</small></span>` +
        `<span>${Math.round(wm?.p ?? 0)}<small>P</small></span>` +
        `<span>${Math.round(wm?.c ?? 0)}<small>C</small></span>` +
        `<span>${Math.round(wm?.f ?? 0)}<small>F</small></span>` +
      `</span>`;
    block.appendChild(summary);
  }

  content.appendChild(wrap);

  // Meal-category rail
  if (settings.showMealRail) wrap.classList.add('tl-has-rail');

  renderTargetBlock(); updateChecked();

  // Day-summary footer
  const tgt = coachTargets[currentDayType] || {};
  const adhParts = [
    { val: totals.p, goal: tgt.p },
    { val: totals.c, goal: tgt.c },
    { val: totals.f, goal: tgt.f },
  ].filter(m => m.goal > 0);
  const adh = adhParts.length
    ? Math.round(adhParts.reduce((s, m) => s + adherenceScore(Math.round(m.val / m.goal * 100)), 0) / adhParts.length)
    : null;
  const hasTargets = (tgt.kcal > 0) || (tgt.p > 0) || (tgt.c > 0) || (tgt.f > 0);
  const fmtT = v => (v > 0) ? Math.round(v) : '–';

  const dayFoot = document.createElement('div');
  dayFoot.className = 'tl-day-summary';
  dayFoot.innerHTML =
    `<div class="tl-day-summary-grid">` +
      `<span class="tl-ds-lbl"></span>` +
      `<span class="tl-ds-hdr tl-ds-kcal">kcal</span>` +
      `<span class="tl-ds-hdr tl-ds-p">P</span>` +
      `<span class="tl-ds-hdr tl-ds-c">C</span>` +
      `<span class="tl-ds-hdr tl-ds-f">F</span>` +
      (hasTargets
        ? `<span class="tl-ds-lbl">Target</span>` +
          `<span class="tl-ds-kcal">${fmtT(tgt.kcal)}</span>` +
          `<span class="tl-ds-p">${fmtT(tgt.p)}</span>` +
          `<span class="tl-ds-c">${fmtT(tgt.c)}</span>` +
          `<span class="tl-ds-f">${fmtT(tgt.f)}</span>`
        : '') +
      `<span class="tl-ds-lbl">Planned</span>` +
      `<span class="tl-ds-kcal">${Math.round(totals.kcal)}</span>` +
      `<span class="tl-ds-p">${Math.round(totals.p)}</span>` +
      `<span class="tl-ds-c">${Math.round(totals.c)}</span>` +
      `<span class="tl-ds-f">${Math.round(totals.f)}</span>` +
    `</div>` +
    (adh != null ? (() => {
      const perfect = adh >= 97;
      const goalMet = adh >= settings.adherenceGoal;
      const badgeHtml = perfect
        ? `<span class="hero-badge badge-perfect"><i class="fas fa-star"></i> Perfect</span>`
        : goalMet
          ? `<span class="hero-badge badge-goal"><i class="fas fa-check"></i> Goal</span>`
          : '';
      return `<div class="tl-day-summary-adh">Adherence ${adh}%${badgeHtml ? ' ' + badgeHtml : ''}</div>`;
    })() : '');
  content.appendChild(dayFoot);

  // Now-line: draw immediately, then refresh every minute
  updateNowLine();
  clearInterval(_nowLineTimer);
  _nowLineTimer = settings.showNowLine ? setInterval(updateNowLine, 60_000) : null;

  // Rail must be measured after now-line is in the DOM (it's a 16px flow element
  // that shifts all rows below it — measuring before would give wrong positions).
  if (settings.showMealRail) refreshMealRail(false);
}

function refreshMealRail(dragActive) {
  const wrap = document.querySelector('.timeline-view');
  if (!wrap || !settings.showMealRail) return;
  wrap.querySelector('.tl-meal-rail')?.remove();

  const rowSel = dragActive ? '.tl-row[data-hour]' : '.tl-row.tl-has-items[data-hour]';
  const inBlockRows = new Set([
    ...wrap.querySelectorAll('.tl-training-block .tl-row'),
    ...wrap.querySelectorAll('.tl-insulin-block .tl-row'),
  ]);
  const measured = [];
  [...wrap.querySelectorAll(rowSel)]
    .filter(r => !inBlockRows.has(r))
    .forEach(r => {
      const h = parseInt(r.dataset.hour, 10);
      const meal = !isNaN(h) ? getMealForTime(h) : null;
      if (meal) measured.push({ el: r, meal, top: r.offsetTop, bottom: r.offsetTop + r.offsetHeight });
    });
  measured.sort((a, b) => a.top - b.top);

  const groups = [];
  for (const item of measured) {
    if (!groups.length || groups[groups.length - 1].meal !== item.meal) {
      groups.push({ meal: item.meal, top: item.top, bottom: item.bottom });
    } else {
      const g = groups[groups.length - 1];
      g.bottom = Math.max(g.bottom, item.bottom);
    }
  }

  const rail = document.createElement('div');
  rail.className = 'tl-meal-rail';
  const GAP = 4;
  for (const { meal, top, bottom } of groups) {
    const seg = document.createElement('div');
    seg.className = 'tl-meal-rail-seg';
    seg.style.top    = (top    + GAP) + 'px';
    seg.style.height = (bottom - top - GAP * 2) + 'px';
    seg.dataset.label = LABELS[meal] || meal;
    rail.appendChild(seg);
  }
  wrap.appendChild(rail);
}

function buildTlRow(minutes, blocks) {
  const isNull = minutes === 'null';
  const row = document.createElement('div');
  row.className = 'tl-row' + (isNull ? ' tl-unassigned' : '') + (blocks.length ? ' tl-has-items' : '');
  row.dataset.hour = minutes;

  const lbl = document.createElement('div');
  lbl.className = 'tl-time-label';
  lbl.textContent = isNull ? '–'
    : minutes === INTRA_WORKOUT_SLOT ? 'Intra Workout'
    : formatSlot(minutes);

  const slot = document.createElement('div');
  slot.className = 'tl-slot';
  if (isNull && !blocks.length) {
    slot.innerHTML = '<div class="tl-empty-hint">Drag items here to unassign</div>';
  }
  blocks.forEach(b => slot.appendChild(makeTlChip(b)));

  row.appendChild(lbl);
  row.appendChild(slot);
  return row;
}

function makeTlChip(block) {
  const chip = document.createElement('div');

  if (block.type === 'insulin') {
    const placed = itemTimeMap['insulin::novorapid'] != null;
    chip.className = 'tl-chip tl-chip-insulin' + (placed ? ' tl-chip-insulin-placed' : '');
    chip.dataset.entryIds = '';
    chip.dataset.checkKeys = 'insulin::novorapid';
    chip.dataset.dragKind = 'item';
    chip.dataset.meal = 'insulin';
    chip.innerHTML = placed
      ? `<span class="tl-insulin-summary-label">
           <i class="fas fa-syringe" style="margin-right:5px"></i>Novorapid &middot; injected ${formatSlot(itemTimeMap['insulin::novorapid'])}
         </span>
         <div class="tl-chip-grip"><i class="fas fa-grip-lines"></i></div>`
      : `<div class="tl-chip-grip"><i class="fas fa-grip-lines"></i></div>
         <i class="fas fa-syringe tl-chip-insulin-icon"></i>
         <div class="tl-chip-body">
           <div class="tl-chip-name-row">
             <span class="tl-chip-name">Novorapid</span>
           </div>
         </div>`;
    return chip;
  }

  if (block.type === 'training') {
    const placed = itemTimeMap['training::session'] != null;
    const timeStr = placed ? formatSlot(itemTimeMap['training::session']) : '';
    chip.className = 'tl-chip tl-chip-training' + (placed ? ' tl-chip-training-placed' : '');
    chip.dataset.entryIds = '';
    chip.dataset.checkKeys = 'training::session';
    chip.dataset.dragKind = 'item';
    chip.dataset.meal = 'training';
    chip.innerHTML = placed
      ? `<span class="tl-training-summary-label">
           <i class="fas fa-dumbbell" style="margin-right:5px"></i>Training &middot; ${timeStr}
         </span>
         <div class="tl-chip-grip"><i class="fas fa-grip-lines"></i></div>`
      : `<div class="tl-chip-grip"><i class="fas fa-grip-lines"></i></div>
         <i class="fas fa-dumbbell tl-chip-training-icon"></i>
         <div class="tl-chip-body">
           <div class="tl-chip-name-row">
             <span class="tl-chip-name">Training</span>
           </div>
         </div>`;
    return chip;
  }

  chip.className = 'tl-chip';
  let returnEl = chip;
  const meal = block.meal;
  const isTreat = meal === WEEKLY_TREAT_MEAL;
  const isMoc   = meal === MEAL_OF_CHOICE;
  if (isTreat) chip.className += ' tl-chip-treat';
  else if (isMoc) chip.className += ' tl-chip-moc';

  const mealTag = isTreat
    ? `<span class="tl-chip-meal-tag tl-treat-tag">⭐ Treat</span>`
    : isMoc
    ? `<span class="tl-chip-meal-tag tl-moc-tag">🍽️ MoC</span>`
    : '';

  if (block.type === 'item') {
    const e = block.entry;
    const m = { kcal: e.kcal||0, p: parseFloat(e.protein)||0, c: parseFloat(e.carbs)||0, f: parseFloat(e.fat)||0 };
    chip.dataset.entryIds = String(e.id);
    chip.dataset.checkKeys = block.tlKey;
    chip.dataset.dragKind = 'item';
    chip.dataset.meal = meal;
    chip.innerHTML = `
      <div class="tl-chip-grip"><i class="fas fa-grip-lines"></i></div>
      <div class="tl-chip-body">
        <div class="tl-chip-name-row">
          <span class="tl-chip-name">${e.item_name}</span>${mealTag}
        </div>
        <div class="tl-chip-macros">${tlMacrosHTML(m)}</div>
      </div>
      <div class="tl-chip-cb"><i class="fas fa-check"></i></div>`;
  } else {
    const { recipe, entries, serving, servings, isExploded } = block;
    const totalM = macroSum(entries);
    // Exploded entries already carry per-serving macros; merged entries must be divided.
    const portionM = isExploded
      ? totalM
      : { kcal: totalM.kcal/servings, p: totalM.p/servings, c: totalM.c/servings, f: totalM.f/servings };
    const displayName = recipe.templateId
      ? ((allRecipes.find(r => r.id === recipe.templateId)?.name ?? '') + ' · ' + recipe.name)
      : recipe.name;
    const portionLabel = servings > 1 ? ` <span class="tl-chip-portion">${serving+1}/${servings}</span>` : '';
    chip.dataset.entryIds = entries.map(e => e.id).join(',');
    chip.dataset.checkKeys = block.tlKey;
    chip.dataset.dragKind = 'recipe';
    chip.dataset.meal = meal;
    chip.dataset.recipeName = recipe.name;
    chip.dataset.serving = String(serving);
    chip.dataset.servings = String(servings);
    chip.dataset.isExploded = String(!!isExploded);
    chip.innerHTML = `
      <div class="tl-chip-grip"><i class="fas fa-grip-lines"></i></div>
      <div class="tl-chip-body">
        <div class="tl-chip-name-row">
          <span class="tl-chip-name">${displayName}${portionLabel}</span>${mealTag}
        </div>
        <div class="tl-chip-macros">${tlMacrosHTML(portionM)}</div>
      </div>
      <button class="tl-recipe-chevron" title="Zutaten anzeigen"><i class="fas fa-chevron-down"></i></button>
      <div class="tl-chip-cb"><i class="fas fa-check"></i></div>`;

    // Build ingredient list
    const ingList = document.createElement('div');
    ingList.className = 'tl-recipe-ingredients';
    entries.forEach(ing => {
      const row = document.createElement('div');
      row.className = 'tl-ingredient-row';
      row.innerHTML =
        `<span class="tl-ing-name">${ing.item_name}</span>` +
        `<div class="ing-pills">` +
          `<div class="ip ip-kcal">${Math.round((ing.kcal||0)/(isExploded ? 1 : servings))}</div>` +
          `<div class="ip ip-p">${(parseFloat(ing.protein||0)/(isExploded ? 1 : servings)).toFixed(1)}</div>` +
          `<div class="ip ip-c">${(parseFloat(ing.carbs||0)/(isExploded ? 1 : servings)).toFixed(1)}</div>` +
          `<div class="ip ip-f">${(parseFloat(ing.fat||0)/(isExploded ? 1 : servings)).toFixed(1)}</div>` +
        `</div>`;
      ingList.appendChild(row);
    });

    const recipeWrap = document.createElement('div');
    recipeWrap.className = 'tl-recipe-wrap';
    recipeWrap.appendChild(chip);
    recipeWrap.appendChild(ingList);
    returnEl = recipeWrap;

    chip.querySelector('.tl-recipe-chevron').addEventListener('click', e => {
      e.stopPropagation();
      recipeWrap.classList.toggle('tl-recipe-open');
      const ing = recipeWrap.querySelector('.tl-recipe-ingredients');
      if (ing) {
        ing.addEventListener('transitionend', () => refreshMealRail(false), { once: true });
      } else {
        refreshMealRail(false);
      }
    });
  }
  if (currentCheckedMap[block.tlKey]) chip.classList.add('tl-chip-done');
  chip.querySelector('.tl-chip-grip').addEventListener('pointerdown', ev => ev.stopPropagation());
  chip.querySelector('.tl-chip-grip').addEventListener('click', ev => {
    ev.stopPropagation();
    if (typeof showTlContextMenu === 'function') showTlContextMenu(chip);
  });
  chip.querySelector('.tl-chip-cb').addEventListener('pointerdown', ev => ev.stopPropagation());
  chip.querySelector('.tl-chip-cb').addEventListener('click', ev => {
    ev.stopPropagation();
    const nowChecked = !currentCheckedMap[block.tlKey];
    currentCheckedMap[block.tlKey] = nowChecked;
    chip.classList.toggle('tl-chip-done', nowChecked);
    persistChecked(block.tlKey, nowChecked);
  });
  return returnEl;
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
  const { data: recipes } = await db.from('fddb_recipes').select('id, name, servings, template_id, is_template').order('name');
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
    isTemplate: !!r.is_template,
    templateId: r.template_id || null,
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
      document.getElementById('syncRingWrap').classList.add('syncing');
      setTimeout(() => {
        document.getElementById('syncRingWrap').classList.remove('syncing');
        btn.classList.remove('syncing'); btn.disabled = false;
        loadDay();
      }, 30000);
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

  const { monday, sunday } = getWeekBounds(dateVal);
  const [macroRes, statusRes, targetsRes, dayTypeRes, waterLogsRes, waterSettingsRes, mocWeekRes, timesRes] = await Promise.all([
    db.from('fddb_daily_macros').select('*').eq('date', dateVal).order('meal'),
    db.from('fddb_checklist_status').select('item_key, checked').eq('date', dateVal),
    db.from('fddb_coach_targets').select('*').lte('valid_from', dateVal).order('valid_from', { ascending: false }),
    db.from('fddb_day_type').select('type').eq('date', dateVal).maybeSingle(),
    dbWater.from('water_logs').select('amount').eq('date', dateVal),
    dbWater.from('water_settings').select('goal').eq('id', 1).maybeSingle(),
    db.from('fddb_daily_macros').select('date').eq('meal', MEAL_OF_CHOICE).gte('date', monday).lte('date', sunday).limit(1),
    db.from('fddb_item_times').select('item_key,minutes').eq('date', dateVal),
  ]);

  if (macroRes.error) {
    document.getElementById('content').innerHTML = `<div class="placeholder"><i class="fas fa-exclamation-triangle"></i>Error: ${macroRes.error.message}</div>`;
    return;
  }

  currentDayEntries = macroRes.data || [];
  currentCheckedMap = Object.fromEntries((statusRes.data || []).map(r => [r.item_key, r.checked]));
  itemTimeMap = Object.fromEntries((timesRes.data || []).map(r => [r.item_key, r.minutes]));
  currentDate = dateVal;

  const rows = targetsRes.data || [];
  ['training','rest'].forEach(type => {
    const match = rows.find(r => r.type === type);
    if (match) coachTargets[type] = { kcal: match.kcal, p: match.protein, c: match.carbs, f: match.fat };
  });

  const waterDrunk = (waterLogsRes.data || []).reduce((s, r) => s + (r.amount || 0), 0);
  const waterGoal = waterSettingsRes.data?.goal || null;
  waterData = { drunk: waterDrunk, goal: waterGoal };

  const mocWeekRows = mocWeekRes.data || [];
  mocUsedThisWeek = mocWeekRows.length > 0 ? mocWeekRows[0].date : false;

  currentDayType = dayTypeRes.data?.type || 'training';
  if (!dayTypeRes.data) {
    await db.from('fddb_day_type').upsert({ date: dateVal, type: 'training' }, { onConflict: 'date' });
  }
  renderDayTypeToggle();
  setTodayView(timelineMode ? 'timeline' : 'dashboard');
}

/* ── Helpers ── */
function macroSum(items) {
  return items.reduce((a,e) => ({ kcal: a.kcal+(e.kcal||0), p: a.p+(parseFloat(e.protein)||0), c: a.c+(parseFloat(e.carbs)||0), f: a.f+(parseFloat(e.fat)||0) }), {kcal:0,p:0,c:0,f:0});
}
function tlMacrosHTML(m) {
  return `<span>${Math.round(m.kcal)}<small>kcal</small></span>` +
         `<span>${m.p.toFixed(1)}<small>P</small></span>` +
         `<span>${m.c.toFixed(1)}<small>C</small></span>` +
         `<span>${m.f.toFixed(1)}<small>F</small></span>`;
}
function pillsHTML(m) {
  return `<span>${Math.round(m.kcal)}<small>kcal</small></span>` +
         `<span>${m.p.toFixed(1)}<small>P</small></span>` +
         `<span>${m.c.toFixed(1)}<small>C</small></span>` +
         `<span>${m.f.toFixed(1)}<small>F</small></span>`;
}
function statPillsHTML(m) {
  return `<div class="stat-pill"><div class="stat-val c-kcal">${Math.round(m.kcal)}</div><div class="stat-lbl">Kcal</div></div><div class="stat-pill"><div class="stat-val c-p">${m.p.toFixed(1)}</div><div class="stat-lbl">Protein</div></div><div class="stat-pill"><div class="stat-val c-c">${m.c.toFixed(1)}</div><div class="stat-lbl">Carbs</div></div><div class="stat-pill"><div class="stat-val c-f">${m.f.toFixed(1)}</div><div class="stat-lbl">Fat</div></div>`;
}
function renderDayTypeToggle() {
  document.getElementById('dttTraining')?.classList.toggle('active', currentDayType === 'training');
  document.getElementById('dttRest')?.classList.toggle('active', currentDayType === 'rest');
}
async function setDayType(type, date = currentDate) {
  await db.from('fddb_day_type').upsert({ date, type }, { onConflict: 'date' });
  if (date === currentDate) {
    currentDayType = type;
    renderDayTypeToggle();
    renderTargetBlock();
    if (timelineMode) renderTimelineDashboard(currentDayEntries);
  }
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

async function writeFinalizedDay(date, adherence, goalUsed, status, totals = null) {
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
    kcal: totals ? Math.round(totals.kcal) : null,
    protein: totals ? Math.round(totals.p * 10) / 10 : null,
    carbs: totals ? Math.round(totals.c * 10) / 10 : null,
    fat: totals ? Math.round(totals.f * 10) / 10 : null,
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
    const { data } = await db.from('fddb_day_finalized').select('date, counted, adherence, status, goal_used, kcal, protein, carbs, fat');
    finalizedMap.clear();
    (data || []).forEach(r => finalizedMap.set(r.date, r));
  } catch (e) { /* silent */ }
}

// Count freeze days used in the configured window ending on the Sunday of date's week.
// Window = settings.freezeWindow weeks (default 1). Excludes `date` itself.
function freezesInWindow(date) {
  const weeks = settings.freezeWindow || 1;
  const d = new Date(date + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 0=Mon
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const windowStart = new Date(mon); windowStart.setDate(mon.getDate() - (weeks - 1) * 7);
  const iso = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  let n = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const day = new Date(windowStart); day.setDate(windowStart.getDate() + i);
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

async function ensureDayFinalized(date, adherence, force, totals = null) {
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
  await writeFinalizedDay(date, adherence, settings.adherenceGoal, status, totals);
  renderDateStrip(currentDate);
}

async function manualFinalizeDay(date, adherence, totals = null) {
  if (adherence == null) { showToast('No data for this day', 'error'); return; }
  const goalUsed = settings.adherenceGoal;
  const status = adherence >= goalUsed ? 'counted' : 'failed';
  await writeFinalizedDay(date, adherence, goalUsed, status, totals);
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
    if (freezesInWindow(date) >= settings.freezePerWeek) {
      const wLabel = settings.freezeWindow > 1 ? `${settings.freezeWindow} weeks` : 'week';
      showToast(`Freeze limit reached (${settings.freezePerWeek}/${wLabel})`, 'error');
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
  currentAdherence = overallAdh;

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

    const perfect = overallAdh >= 97;
    const goalMet = overallAdh >= settings.adherenceGoal;
    const badge = document.getElementById('heroBadge');
    const heroCard = document.getElementById('heroCard');
    if (perfect) {
      badge.className = 'hero-badge badge-perfect';
      badge.innerHTML = '<i class="fas fa-star"></i> Perfect';
    } else if (goalMet) {
      badge.className = 'hero-badge badge-goal';
      badge.innerHTML = '<i class="fas fa-check"></i> Goal';
    } else {
      badge.className = 'hero-badge';
      badge.innerHTML = '';
    }
    heroCard.classList.toggle('hero-goal-met', goalMet && !perfect);
    heroCard.classList.toggle('hero-goal-perfect', perfect);

    // Auto-finalize this day if past cutoff / past date.
    ensureDayFinalized(currentDate, overallAdh, false, totals);
  } else {
    ringFg.style.strokeDashoffset = circ;
    ringVal.textContent = '–';
    ringVal.style.color = 'var(--muted)';
    document.getElementById('heroBadge').className = 'hero-badge';
    document.getElementById('heroBadge').innerHTML = '';
    document.getElementById('heroCard').classList.remove('hero-goal-met', 'hero-goal-perfect');
  }

  // Ratio pill: Plan vs Ziel
  const planSegs = [totals.p * 4, totals.c * 4, totals.f * 9];
  const tgtSegs  = [tgt.p * 4,    tgt.c * 4,    tgt.f * 9];
  const planTotal = planSegs.reduce((s, v) => s + v, 0) || 1;
  const tgtTotal  = tgtSegs.reduce((s, v) => s + v, 0) || 1;
  [['hrpP','hrzP'],['hrpC','hrzC'],['hrpF','hrzF']].forEach(([pId, zId], i) => {
    const pp = planSegs[i] / planTotal * 100, zp = tgtSegs[i] / tgtTotal * 100;
    const pe = document.getElementById(pId), ze = document.getElementById(zId);
    pe.style.width = pp + '%'; pe.style.display = pp > 0 ? '' : 'none';
    ze.style.width = zp + '%'; ze.style.display = zp > 0 ? '' : 'none';
  });

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
  const pKcal = ck.p * 4, cKcal = ck.c * 4, fKcal = ck.f * 9;
  const totalMacroKcal = pKcal + cKcal + fKcal || 1;
  [['embP', pKcal],['embC', cKcal],['embF', fKcal]].forEach(([id, val]) => {
    const el = document.getElementById(id);
    const pct = val / totalMacroKcal * 100;
    el.style.width = pct + '%';
    el.style.display = pct > 0 ? '' : 'none';
  });
  const block = document.getElementById('checkedBlock');
  block.classList.toggle('has-data', ch.length > 0);
  const fillPct = totals.kcal > 0 ? Math.min(ck.kcal / totals.kcal, 1) : 0;
  const rect = document.getElementById('eatenBorderRect');
  const goalMet = currentAdherence !== null && currentAdherence >= settings.adherenceGoal;
  rect.style.stroke = goalMet ? 'var(--gold)' : adherenceColor(currentAdherence ?? 0);
  rect.style.strokeDashoffset = 1 - fillPct;
  rect.style.opacity = fillPct > 0 ? 1 : 0;
}

function renderDashboard(entries) {
  if (timelineMode) { renderTimelineDashboard(entries); return; }
  const content = document.getElementById('content');
  content.innerHTML = '';
  checkables = [];
  applySickModeOverlay();
  if (!entries.length) {
    content.innerHTML = '<div class="placeholder"><i class="fas fa-bowl-food"></i>No entries for this date</div>';
    totals = {kcal:0,p:0,c:0,f:0};
    renderWeeklyTreatCard([], content);
    renderMealOfChoiceCard([], content);
    renderTargetBlock();
    updateChecked();
    return;
  }

  const grouped = {};
  totals = {kcal:0,p:0,c:0,f:0};
  entries.forEach(e => {
    (grouped[e.meal] = grouped[e.meal]||[]).push(e);
    if (e.meal !== WEEKLY_TREAT_MEAL) {
      totals.kcal += e.kcal||0; totals.p += parseFloat(e.protein)||0;
      totals.c += parseFloat(e.carbs)||0; totals.f += parseFloat(e.fat)||0;
    }
  });

  // If a calorie cap is set, add back the excess fraction of the treat's macros
  const treatItems = grouped[WEEKLY_TREAT_MEAL] || [];
  if (treatItems.length > 0 && settings.weeklyTreatMaxKcal > 0) {
    const treatKcal = treatItems.reduce((s, e) => s + (e.kcal||0), 0);
    if (treatKcal > settings.weeklyTreatMaxKcal) {
      const excessFraction = (treatKcal - settings.weeklyTreatMaxKcal) / treatKcal;
      treatItems.forEach(e => {
        totals.kcal += (e.kcal||0)                  * excessFraction;
        totals.p    += (parseFloat(e.protein)||0)    * excessFraction;
        totals.c    += (parseFloat(e.carbs)||0)      * excessFraction;
        totals.f    += (parseFloat(e.fat)||0)        * excessFraction;
      });
    }
  }

  // Render every standard ORDER meal (even if empty) so drop targets stay available
  // after a meal is emptied. Custom meals outside ORDER are appended only if they have items.
  // Skip empty aliases whose label is already used by a non-empty meal (e.g. abendbrot/abendessen → "Dinner").
  // weekly_treat and meal_of_choice are handled separately below — exclude from the standard loop.
  const customMeals = Object.keys(grouped).filter(m => ORDER.indexOf(m) < 0 && m !== WEEKLY_TREAT_MEAL && m !== MEAL_OF_CHOICE);
  const orderedMeals = [...ORDER, ...customMeals.sort()];
  const usedLabels = new Set(
    orderedMeals.filter(m => (grouped[m] || []).length > 0).map(m => LABELS[m] || m)
  );
  const seenEmptyLabels = new Set();
  const sorted = orderedMeals.filter(m => {
    if ((grouped[m] || []).length > 0) return true;
    // empty → only keep if no meal (empty or not) with this label already included
    const label = LABELS[m] || m;
    if (usedLabels.has(label) || seenEmptyLabels.has(label)) return false;
    seenEmptyLabels.add(label);
    return true;
  });

  sorted.forEach((meal, mi) => {
    const items = (grouped[meal] || []).slice().sort((a, b) => {
      const ao = a.sort_order ?? Infinity;
      const bo = b.sort_order ?? Infinity;
      return ao - bo;
    });
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

    // Build render blocks, using computeExplodedRecipes() to distinguish recipes
    // that have been individually split across meals from unmodified multi-serving ones.
    const dashRenderBlocks = [];
    const recipeTemplateMap = new Map(allRecipes.map(r => [r.id, r]));
    const recipesByLength = [...allRecipes].map(r => {
      if (r.templateId) {
        const tmpl = recipeTemplateMap.get(r.templateId);
        if (tmpl) {
          const effectiveItems = [...new Set([...tmpl.items, ...r.items])];
          return { ...r, effectiveItems };
        }
      }
      return { ...r, effectiveItems: r.items };
    }).sort((a, b) => b.effectiveItems.length - a.effectiveItems.length);

    const explodedRecipeNames = computeExplodedRecipes();
    const dashRemaining = items.map((item, idx) => ({ item, idx, used: false }));

    recipesByLength.forEach(recipe => {
      if (recipe.effectiveItems.length === 0) return;
      const isExploded = explodedRecipeNames.has(recipe.name);

      if (isExploded) {
        const siGroups = {};
        dashRemaining.forEach(r => {
          if (r.used) return;
          const si = r.item.serving_index ?? 0;
          (siGroups[si] = siGroups[si] || []).push(r);
        });
        for (const [si, pool] of Object.entries(siGroups)) {
          const matched = [];
          let allFound = true;
          for (const rName of recipe.effectiveItems) {
            const found = pool.find(r => !matched.includes(r) && stripAmount(r.item.item_name) === rName);
            if (found) matched.push(found);
            else { allFound = false; break; }
          }
          if (allFound && matched.length > 0) {
            matched.forEach(r => { dashRemaining[r.idx].used = true; });
            const recipeEntries = matched.map(r => r.item);
            dashRenderBlocks.push({ type: 'recipe', recipe, entries: recipeEntries, isExploded: true, overrideServingIdx: parseInt(si, 10), firstIdx: Math.min(...matched.map(r => r.idx)) });
          }
        }
      } else {
        const matchIndices = [];
        const workingPool = dashRemaining.filter(r => !r.used);
        let allFound = true;
        for (const rName of recipe.effectiveItems) {
          const found = workingPool.find(r => !matchIndices.includes(r.idx) && stripAmount(r.item.item_name) === rName);
          if (found) matchIndices.push(found.idx);
          else { allFound = false; break; }
        }
        if (allFound && matchIndices.length > 0) {
          matchIndices.forEach(idx => { dashRemaining[idx].used = true; });
          const recipeEntries = matchIndices.map(idx => items[idx]);
          dashRenderBlocks.push({ type: 'recipe', recipe, entries: recipeEntries, isExploded: false, overrideServingIdx: null, firstIdx: Math.min(...matchIndices) });
        }
      }
    });
    dashRemaining.filter(r => !r.used).forEach(r => {
      dashRenderBlocks.push({ type: 'item', entry: r.item, firstIdx: r.idx });
    });
    dashRenderBlocks.sort((a,b) => a.firstIdx - b.firstIdx);

    dashRenderBlocks.forEach(block => {
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
        const { recipe, entries: recEntries, isExploded, overrideServingIdx } = block;
        const totalM = macroSum(recEntries);
        const servings = recipe.servings || 1;
        // Exploded: entries are already per-serving; merged: divide by recipe.servings.
        const effectiveServings = (isExploded || mergeServings) ? 1 : servings;
        const divisor = (isExploded || mergeServings) ? 1 : servings;
        const displayName = recipe.templateId
          ? ((allRecipes.find(r => r.id === recipe.templateId)?.name ?? '') + ' · ' + recipe.name)
          : recipe.name;
        const portionM = { kcal: totalM.kcal/divisor, p: totalM.p/divisor, c: totalM.c/divisor, f: totalM.f/divisor };

        for (let s = 0; s < effectiveServings; s++) {
          // For exploded entries the actual serving index is overrideServingIdx, not the loop var.
          const servingIdx = isExploded ? overrideServingIdx : s;
          const itemKey = mergeServings ? `${meal}::${recipe.name}::0` : `${meal}::${recipe.name}::${servingIdx}`;
          const rb = document.createElement('div');
          rb.className = 'recipe-row' + (currentCheckedMap[itemKey] ? ' checked' : '');
          rb.dataset.meal = meal;
          rb.dataset.entryIds = recEntries.map(x => x.id).join(',');
          rb.dataset.checkKeys = (mergeServings
            ? [`${meal}::${recipe.name}::0`]
            : (isExploded
                ? [`${meal}::${recipe.name}::${servingIdx}`]
                : Array.from({length: servings}, (_, i) => `${meal}::${recipe.name}::${i}`))).join('|');
          rb.dataset.dragKind = 'recipe';
          rb.dataset.recipeName = recipe.name;
          rb.dataset.serving = String(servingIdx);
          rb.dataset.servings = String(servings);
          rb.dataset.isExploded = String(isExploded);
          const portionLabel = (!mergeServings && servings > 1) ? ` <span class="recipe-portion-tag">${servingIdx+1}/${servings}</span>` : (mergeServings && servings > 1 ? ` <span class="recipe-portion-tag">${servings}×</span>` : '');

          const hdr = document.createElement('div');
          hdr.className = 'recipe-row-header';
          if (mergeServings) {
            hdr.innerHTML = `
              <div class="cb-box"><i class="fas fa-check"></i></div>
              <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
                <span class="recipe-row-name" style="font-size:.82rem">${displayName}</span>
                <span class="recipe-tag">Recipe</span>
                ${portionLabel}
              </div>`;
          } else {
            hdr.innerHTML = `
              <div class="cb-box"><i class="fas fa-check"></i></div>
              <div class="recipe-row-body">
                <div class="recipe-row-title">
                  <span class="recipe-row-name">${displayName}</span>
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
            ingRow.innerHTML = `<span class="ingredient-name">${ing.item_name}</span><div class="ing-pills"><div class="ip ip-kcal">${Math.round((ing.kcal||0)/divisor)}</div><div class="ip ip-p">${(parseFloat(ing.protein||0)/divisor).toFixed(1)}</div><div class="ip ip-c">${(parseFloat(ing.carbs||0)/divisor).toFixed(1)}</div><div class="ip ip-f">${(parseFloat(ing.fat||0)/divisor).toFixed(1)}</div></div>`;
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

  // Weekly Treat card — always rendered as a drop target at the bottom.
  // Items here are intentionally excluded from totals and checkables.
  renderWeeklyTreatCard(grouped[WEEKLY_TREAT_MEAL] || [], content);

  // Meal of Choice card — counts toward macros, added via + button.
  renderMealOfChoiceCard(grouped[MEAL_OF_CHOICE] || [], content);

  renderTargetBlock();
  updateChecked();
}

function renderWeeklyTreatCard(items, container) {
  const isEmpty = items.length === 0;
  const treatKcal = items.reduce((s, e) => s + (e.kcal||0), 0);
  const cap = settings.weeklyTreatMaxKcal || 0;
  const isOverBudget = cap > 0 && treatKcal > cap;

  const card = document.createElement('div');
  card.className = 'meal-card weekly-treat-card' + (isEmpty ? ' weekly-treat-empty' : '');
  card.dataset.meal = WEEKLY_TREAT_MEAL;

  let badge = '';
  if (!isEmpty) {
    if (isOverBudget) {
      const excess = Math.round(treatKcal - cap);
      badge = `<div class="weekly-treat-excluded-badge weekly-treat-over-budget">+${excess} kcal counted</div>`;
    } else {
      badge = `<div class="weekly-treat-excluded-badge">excluded</div>`;
    }
  }

  card.innerHTML = `<div class="meal-title weekly-treat-title">
    <span class="weekly-treat-icon">⭐</span>
    <div class="meal-name weekly-treat-name">Weekly Treat</div>
    ${badge}
  </div>`;

  const list = document.createElement('div');
  list.className = 'items-list';

  if (isEmpty) {
    const hint = document.createElement('div');
    hint.className = 'weekly-treat-hint';
    hint.innerHTML = `<i class="fas fa-arrow-down-to-line"></i> Drag your weekly treat here`;
    list.appendChild(hint);
  } else {
    items.forEach(e => {
      const m = { kcal: e.kcal||0, p: parseFloat(e.protein)||0, c: parseFloat(e.carbs)||0, f: parseFloat(e.fat)||0 };
      const row = document.createElement('div');
      row.className = 'food-item weekly-treat-item';
      row.dataset.meal = WEEKLY_TREAT_MEAL;
      row.dataset.entryIds = String(e.id);
      row.dataset.checkKeys = `${WEEKLY_TREAT_MEAL}::${e.item_name}`;
      row.dataset.dragKind = 'item';
      row.innerHTML = `<div class="weekly-treat-joker-icon"><i class="fas fa-star"></i></div><div class="food-item-body"><div class="food-name">${e.item_name}</div><div class="macro-pills weekly-treat-pills">${pillsHTML(m)}</div></div>`;
      list.appendChild(row);
    });
  }

  card.appendChild(list);
  container.appendChild(card);
}

/* ── Persist ── */
const pendingWrites = {};
function persistChecked(itemKey, checked) {
  currentCheckedMap[itemKey] = checked;
  clearTimeout(pendingWrites[itemKey]);
  pendingWrites[itemKey] = setTimeout(async () => {
    await db.from('fddb_checklist_status').upsert({ date: currentDate, item_key: itemKey, checked }, { onConflict: 'date,item_key' });
  }, 600);
}

function renderMealOfChoiceCard(items, container) {
  if (items.length === 0) return;

  const entry = items[0];
  const m = { kcal: entry.kcal||0, p: parseFloat(entry.protein)||0, c: parseFloat(entry.carbs)||0, f: parseFloat(entry.fat)||0 };
  const displayName = entry.item_name || 'Meal of Choice';

  const card = document.createElement('div');
  card.className = 'meal-card moc-card';

  card.innerHTML = `<div class="meal-title moc-title">
    <span class="moc-icon">🍽️</span>
    <div class="meal-name moc-name">Meal of Choice</div>
    <div class="moc-badge">${settings.mocKcal} kcal</div>
    <button class="moc-remove-btn" onclick="removeMealOfChoice('${entry.id}')"><i class="fas fa-trash-alt"></i></button>
  </div>`;

  const row = document.createElement('div');
  row.className = 'food-item checked';
  row.innerHTML = `<div class="cb-box"><i class="fas fa-check"></i></div><div class="food-item-body"><div class="food-name">${displayName}</div><div class="macro-pills">${pillsHTML(m)}</div></div>`;
  card.appendChild(row);
  checkables.push({ get checked() { return true; }, macros: m });

  container.appendChild(card);
}

function openMocNamePrompt() {
  const el = document.getElementById('mocNameOverlay');
  document.getElementById('mocNameInput').value = '';
  el.classList.add('open');
  setTimeout(() => document.getElementById('mocNameInput').focus(), 150);
}

async function confirmAddMealOfChoice() {
  const name = document.getElementById('mocNameInput').value.trim();
  document.getElementById('mocNameOverlay').classList.remove('open');
  await addMealOfChoice(name);
}

async function addMealOfChoice(name) {
  const { monday, sunday } = getWeekBounds(currentDate);
  const { data: weekMoC } = await db.from('fddb_daily_macros')
    .select('id, date').eq('meal', MEAL_OF_CHOICE).gte('date', monday).lte('date', sunday);

  if (weekMoC && weekMoC.length > 0 && weekMoC[0].date !== currentDate) {
    showToast('Meal of Choice already used this week', 'error'); return;
  }
  if (currentDayEntries.some(e => e.meal === WEEKLY_TREAT_MEAL)) {
    showToast('Not on the same day as Weekly Treat', 'error'); return;
  }

  const tgt = coachTargets[currentDayType] || {};
  const consumed = { kcal: 0, p: 0, c: 0, f: 0 };
  currentDayEntries.forEach(e => {
    if (e.meal === MEAL_OF_CHOICE) return;
    consumed.kcal += e.kcal || 0;
    consumed.p += parseFloat(e.protein) || 0;
    consumed.c += parseFloat(e.carbs) || 0;
    consumed.f += parseFloat(e.fat) || 0;
  });

  const mocKcal = settings.mocKcal || MOC_KCAL;
  if ((tgt.kcal || 0) - consumed.kcal < mocKcal - 100) {
    showToast(`Need ${mocKcal - 100} kcal free`, 'error'); return;
  }

  const remP = Math.max(0, (tgt.p || 0) - consumed.p);
  const remC = Math.max(0, (tgt.c || 0) - consumed.c);
  const remF = Math.max(0, (tgt.f || 0) - consumed.f);
  const remKcal = remP * 4 + remC * 4 + remF * 9;

  let finalP, finalC, finalF;
  if (remKcal > 0) {
    const k = mocKcal / remKcal;
    finalP = remP * k; finalC = remC * k; finalF = remF * k;
  } else {
    finalP = (mocKcal * 0.30) / 4;
    finalC = (mocKcal * 0.40) / 4;
    finalF = (mocKcal * 0.30) / 9;
  }

  const { error } = await db.from('fddb_daily_macros').insert({
    date: currentDate, meal: MEAL_OF_CHOICE, item_name: name || 'Meal of Choice',
    kcal: mocKcal,
    protein: parseFloat(finalP.toFixed(1)),
    carbs: parseFloat(finalC.toFixed(1)),
    fat: parseFloat(finalF.toFixed(1)),
  });

  if (error) { showToast('Error adding Meal of Choice', 'error'); return; }
  showToast('Meal of Choice added 🍽️');
  await loadDay();
}

async function removeMealOfChoice(id) {
  const { error } = await db.from('fddb_daily_macros').delete().eq('id', id);
  if (error) { showToast('Error removing Meal of Choice', 'error'); return; }
  showToast('Meal of Choice removed');
  await loadDay();
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
let creatorStep = 0, creatorMeal = null, creatorSelected = [], creatorIsTemplate = false;
function openCreator() {
  creatorStep = 0; creatorMeal = null; creatorSelected = []; creatorIsTemplate = false;
  document.getElementById('recipeNameInput').value = '';
  document.getElementById('creatorIsTemplateCheck')?.classList.remove('active');
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
  const { data: recipe, error: recErr } = await db.from('fddb_recipes').insert({ name, is_template: creatorIsTemplate }).select().single();
  if (recErr) { showToast('Error: ' + recErr.message, 'error'); document.getElementById('btnNext').disabled = false; document.getElementById('btnNext').textContent = 'Save'; return; }
  const itemRows = creatorSelected.map(item_name => ({ recipe_id: recipe.id, item_name: stripAmount(item_name) }));
  const { error: itemErr } = await db.from('fddb_recipe_items').insert(itemRows);
  if (itemErr) { showToast('Error: ' + itemErr.message, 'error'); return; }
  await loadRecipes();
  closeCreator();
  renderDashboard(currentDayEntries);
  showToast(`Recipe "${name}" saved`, 'success');
}

/* ── Template card ── */
function makeTemplateCard(template, variants, showCatTags) {
  const catNames = template.catIds.map(id => allCategories.find(c => c.id === id)?.name).filter(Boolean);
  const card = document.createElement('div');
  card.className = 'template-card card-collapsed';
  const baseItems = [...template.items].sort((a, b) => stripAmount(a).localeCompare(stripAmount(b)));
  const variantRows = variants.map(v => {
    const extra = v.items.filter(i => !template.items.includes(i));
    const missing = template.items.filter(i => !v.items.includes(i));
    const diffLabel = extra.length > 0 ? `+${extra.length}` : (missing.length > 0 ? `-${missing.length}` : '=');
    const safeVName = v.name.replace(/'/g, "\\'");
    const ingredientRows = extra.length
      ? extra.sort((a, b) => stripAmount(a).localeCompare(stripAmount(b))).map(n =>
          `<div class="manage-ingredient"><i class="fas fa-circle" style="font-size:.4rem;color:var(--accent);margin-right:7px;vertical-align:middle"></i>${n}</div>`
        ).join('')
      : `<div style="font-size:.8rem;color:var(--muted)">No extra ingredients</div>`;
    return `
      <div class="variant-row">
        <div class="variant-row-header">
          <div class="variant-row-main" onclick="this.closest('.variant-row').classList.toggle('open')">
            <span class="variant-name">${v.name}</span>
            <span class="variant-extra-badge">${diffLabel}</span>
          </div>
          <div class="variant-actions">
            <button class="btn-icon-sm btn-dupe" onclick="duplicateRecipe('${v.id}')"><i class="fas fa-copy"></i></button>
            <button class="btn-icon-sm btn-edit" onclick="openEditModal('${v.id}')"><i class="fas fa-pen"></i></button>
            <button class="btn-icon-sm btn-delete" onclick="deleteRecipe('${v.id}', '${safeVName}')"><i class="fas fa-trash"></i></button>
          </div>
          <i class="fas fa-chevron-down variant-chevron" onclick="this.closest('.variant-row').classList.toggle('open')"></i>
        </div>
        <div class="variant-ingredients">${ingredientRows}</div>
      </div>`;
  }).join('');
  const safeTName = template.name.replace(/'/g, "\\'");
  card.innerHTML = `
    <div class="template-header">
      <div style="flex:1;min-width:0" onclick="this.closest('.template-card').classList.toggle('card-collapsed')">
        <div class="template-title">
          <i class="fas fa-layer-group template-icon"></i>
          <span class="recipe-manage-name">${template.name}</span>
        </div>
        ${showCatTags && catNames.length ? `<div class="recipe-cat-tags">${catNames.map(n => `<span class="recipe-cat-tag">${n}</span>`).join('')}</div>` : ''}
      </div>
      <span class="template-base-count" onclick="this.closest('.template-card').classList.toggle('base-open')">${template.items.length} Base · ${variants.length} Var.</span>
      <div class="recipe-manage-actions">
        <button class="btn-icon-sm btn-edit" onclick="openEditModal('${template.id}')"><i class="fas fa-pen"></i></button>
        <button class="btn-icon-sm btn-delete" onclick="deleteRecipe('${template.id}', '${safeTName}')"><i class="fas fa-trash"></i></button>
      </div>
      <i class="fas fa-chevron-down template-chevron" onclick="this.closest('.template-card').classList.toggle('card-collapsed')"></i>
    </div>
    <div class="template-base-items">
      ${baseItems.map(n => `<div class="manage-ingredient"><i class="fas fa-circle" style="font-size:.4rem;color:var(--muted);margin-right:7px;vertical-align:middle"></i>${n}</div>`).join('')}
    </div>
    <div class="template-variants">
      ${variantRows}
      <button class="btn-add-variant" onclick="addVariant('${template.id}')"><i class="fas fa-plus"></i> Add variant</button>
    </div>`;
  return card;
}

async function addVariant(templateId) {
  const template = allRecipes.find(r => r.id === templateId);
  if (!template) return;
  const newName = 'New Variant';
  const { data: newRecipe, error } = await db.from('fddb_recipes').insert({ name: newName, template_id: templateId }).select().single();
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  if (template.items.length > 0) {
    await db.from('fddb_recipe_items').insert(template.items.map(item_name => ({ recipe_id: newRecipe.id, item_name })));
  }
  if (template.catIds?.length > 0) {
    await db.from('fddb_recipe_categories').insert(template.catIds.map(category_id => ({ recipe_id: newRecipe.id, category_id })));
  }
  await loadRecipes(); renderRecipeManage();
  showToast('Variant created', 'success');
  openEditModal(newRecipe.id);
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
      if (r.templateId) return false;
      if (activeFilterCat === '__none__') {
        if (r.catIds && r.catIds.length > 0) return false;
      } else if (activeFilterCat && !r.catIds.includes(activeFilterCat)) return false;
      if (!query) return true;
      const matchesSelf = r.name.toLowerCase().includes(query) || r.items.some(i => i.toLowerCase().includes(query));
      if (matchesSelf) return true;
      const variants = allRecipes.filter(v => v.templateId === r.id);
      return variants.some(v => v.name.toLowerCase().includes(query) || v.items.some(i => i.toLowerCase().includes(query)));
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

  const renderItem = (recipe, showCatTags) => {
    if (recipe.isTemplate) {
      const variants = allRecipes.filter(r => r.templateId === recipe.id);
      return makeTemplateCard(recipe, variants, showCatTags);
    }
    return makeCard(recipe, showCatTags);
  };

  if (activeFilterCat === null && !query) {
    const groups = allCategories
      .map(cat => ({ key: cat.id, label: cat.name, recipes: filtered.filter(r => r.catIds.includes(cat.id)) }))
      .filter(g => g.recipes.length > 0);
    const uncategorized = filtered.filter(r => !r.catIds || r.catIds.length === 0);
    if (uncategorized.length) groups.push({ key: '__none__', label: 'No category', recipes: uncategorized });

    _currentGroupKeys = groups.map(g => g.key);
    const allCollapsed = groups.every(g => !expandedSections.has(g.key));
    const ctrl = document.getElementById('recipeSectionControls');
    if (ctrl) {
      ctrl.innerHTML = `<button class="recipe-collapse-btn" onclick="toggleAllSections(${allCollapsed})"><i class="fas fa-angles-${allCollapsed ? 'down' : 'up'}"></i>${allCollapsed ? 'Expand all' : 'Collapse all'}</button>`;
    }

    groups.forEach(group => {
      const isCollapsed = !expandedSections.has(group.key);
      const header = document.createElement('div');
      header.className = 'recipe-section-header';
      header.innerHTML = `
        <span class="recipe-section-title">${group.label}</span>
        <span class="recipe-section-count">${group.recipes.length}</span>
        <i class="fas fa-chevron-down recipe-section-chevron${isCollapsed ? ' collapsed' : ''}"></i>`;
      header.onclick = () => toggleSection(group.key);
      el.appendChild(header);
      if (!isCollapsed) group.recipes.forEach(r => el.appendChild(renderItem(r, false)));
    });
  } else {
    const ctrl = document.getElementById('recipeSectionControls');
    if (ctrl) ctrl.innerHTML = '';
    filtered.forEach(recipe => el.appendChild(renderItem(recipe, true)));
  }
}
function toggleSection(key) {
  expandedSections.has(key) ? expandedSections.delete(key) : expandedSections.add(key);
  renderRecipeManage();
}
function toggleAllSections(expand) {
  if (expand) _currentGroupKeys.forEach(k => expandedSections.add(k));
  else _currentGroupKeys.forEach(k => expandedSections.delete(k));
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
let editTargetId = null, editName = '', editItems = [], editServings = 1, editCatIds = [], editAddTab = 'day', editTemplateId = null, editIsTemplate = false;
function openEditModal(id) {
  const recipe = allRecipes.find(r => r.id === id);
  if (!recipe) return;
  editTargetId = id; editName = recipe.name; editItems = [...recipe.items];
  editServings = recipe.servings || 1; editCatIds = [...(recipe.catIds || [])]; editAddTab = 'day';
  editTemplateId = recipe.templateId || null;
  editIsTemplate = recipe.isTemplate || false;
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
    <div class="edit-section">
      <div class="edit-section-title"><i class="fas fa-layer-group"></i> Template</div>
      <div class="cat-chip${editIsTemplate ? ' active' : ''}" style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px" onclick="editIsTemplate=!editIsTemplate;renderEditModal()"><i class="fas fa-layer-group"></i>Mark as template</div>
      ${editIsTemplate ? '' : (() => {
        const candidates = allRecipes
          .filter(r => r.isTemplate && r.id !== editTargetId)
          .sort((a, b) => a.name.localeCompare(b.name, 'de'));
        if (!candidates.length) return `<p style="font-size:.8rem;color:var(--muted);margin:0">No templates yet.</p>`;
        return `<select class="text-input" id="editTemplateSelect" onchange="editTemplateId = this.value || null" style="width:100%">
          <option value="">— No template (standalone) —</option>
          ${candidates.map(r => `<option value="${r.id}"${editTemplateId === r.id ? ' selected' : ''}>${r.name}</option>`).join('')}
        </select>`;
      })()}
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
  const { error: nameErr } = await db.from('fddb_recipes').update({ name, servings: editServings, is_template: editIsTemplate, template_id: editIsTemplate ? null : (editTemplateId || null) }).eq('id', editTargetId);
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
let statsLineChart = null, statsBarChart = null, statsWeightChart = null;

function setStatsPeriod(p) {
  statsPeriod = p;
  document.querySelectorAll('.seg-btn').forEach((b, i) => {
    b.classList.toggle('active', ['week','month','3months','custom'][i] === p);
  });
  document.getElementById('statsCustomRange').classList.toggle('show', p === 'custom');
  if (p !== 'custom') loadStats();
}

function getStatsDateRange() {
  const today = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if (statsPeriod === 'week') {
    const dow = today.getDay() || 7;
    const mon = new Date(today); mon.setDate(today.getDate() - dow + 1);
    return { from: fmt(mon), to: fmt(today) };
  }
  if (statsPeriod === 'month') return { from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), to: fmt(today) };
  if (statsPeriod === '3months') {
    const start = new Date(today); start.setMonth(today.getMonth() - 2); start.setDate(1);
    return { from: fmt(start), to: fmt(today) };
  }
  return { from: document.getElementById('statsFrom').value, to: document.getElementById('statsTo').value };
}

/* ══════════════════════════════════════
   Date-pill context menu (freeze / sick / finalize)
   ══════════════════════════════════════ */
let _dateMenuEl = null;
function closeDateMenu() {
  if (_dateMenuEl) { _dateMenuEl.remove(); _dateMenuEl = null; }
  document.removeEventListener('click', _dateMenuOutside, true);
  document.removeEventListener('touchstart', _dateMenuOutside, true);
  document.removeEventListener('keydown', _dateMenuKey, true);
}
function _dateMenuOutside(e) {
  if (_dateMenuEl && !_dateMenuEl.contains(e.target)) closeDateMenu();
}
function _dateMenuKey(e) { if (e.key === 'Escape') closeDateMenu(); }

async function openDateMenu(date, x, y) {
  closeDateMenu();
  const fin = finalizedMap.get(date);
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(date + 'T00:00:00');
  const isFuture = d > today;
  const isToday = date === todayStr;
  const freezesUsed = freezesInWindow(date) + (fin && fin.status === 'freeze' ? 1 : 0);
  const freezeWLabel = (settings.freezeWindow || 1) > 1 ? `${settings.freezeWindow} weeks` : 'week';

  // Compute adherence for current day to allow Finalize.
  // Always fetch day type — needed for Training/Rest toggle regardless of isFuture
  const dtRes = await db.from('fddb_day_type').select('type').eq('date', date).maybeSingle();
  const menuDayType = dtRes.data?.type || 'training';

  let canFinalize = false, adhForFinalize = null, totalsForFinalize = null;
  if (!isFuture) {
    const [macroRes, tgtRes] = await Promise.all([
      db.from('fddb_daily_macros').select('kcal, protein, carbs, fat').eq('date', date).neq('meal', WEEKLY_TREAT_MEAL),
      db.from('fddb_coach_targets').select('*').lte('valid_from', date).order('valid_from', { ascending: false }),
    ]);
    const rows = macroRes.data || [];
    if (rows.length) {
      const menuTotals = rows.reduce((s, r) => ({
        kcal: s.kcal + (r.kcal||0),
        p: s.p + (parseFloat(r.protein)||0),
        c: s.c + (parseFloat(r.carbs)||0),
        f: s.f + (parseFloat(r.fat)||0),
      }), { kcal:0, p:0, c:0, f:0 });
      const match = (tgtRes.data || []).find(t => t.type === menuDayType);
      if (match) {
        adhForFinalize = computeDayAdherence(menuTotals, { p: match.protein, c: match.carbs, f: match.fat });
        canFinalize = adhForFinalize != null;
        totalsForFinalize = menuTotals;
      }
    }
  }

  const menu = document.createElement('div');
  menu.className = 'date-menu';
  const dowStr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  const dateLabel = `${dowStr}, ${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
  const statusSub = fin
    ? `<span class="dmi-hint">· ${fin.status}${fin.adherence!=null?` · ${fin.adherence}%`:''}</span>`
    : '';

  const item = (cls, iconCls, icon, label, hint, disabled, onclick) => {
    const btn = document.createElement('button');
    btn.className = 'date-menu-item';
    if (disabled) btn.disabled = true;
    btn.innerHTML = `
      <div class="dmi-icon ${iconCls}">${icon}</div>
      <div class="dmi-label">${label}</div>
      ${hint ? `<div class="dmi-hint">${hint}</div>` : ''}
    `;
    if (!disabled) btn.onclick = () => { closeDateMenu(); onclick(); };
    return btn;
  };

  menu.innerHTML = `<div class="date-menu-header">${dateLabel} ${statusSub}</div>`;

  // Finalize now (only if we have data and day isn't in the future)
  menu.appendChild(item(
    'finalize', 'counted', '<i class="fas fa-check"></i>',
    'Finalize now',
    canFinalize ? `${adhForFinalize}%` : (isFuture ? 'future' : 'no data'),
    !canFinalize || isFuture,
    () => manualFinalizeDay(date, adhForFinalize, totalsForFinalize)
  ));

  // Freeze (2 per week, can be retroactive, NOT for future)
  menu.appendChild(item(
    'freeze', 'freeze', '<i class="fas fa-snowflake"></i>',
    'Freeze day',
    `${freezesUsed}/${settings.freezePerWeek} per ${freezeWLabel}`,
    isFuture || freezesInWindow(date) >= settings.freezePerWeek,
    () => setDayStatus(date, 'freeze')
  ));

  // Sick (only today)
  menu.appendChild(item(
    'sick', 'sick', '<i class="fas fa-thermometer-half"></i>',
    'Mark as sick',
    isToday ? '' : 'today only',
    !isToday,
    () => setDayStatus(date, 'sick')
  ));

  // Reset (only if something is set)
  if (fin) {
    const div = document.createElement('div');
    div.className = 'date-menu-divider';
    menu.appendChild(div);
    menu.appendChild(item(
      'reset', 'reset', '<i class="fas fa-rotate-left"></i>',
      'Reset status', '', false,
      () => setDayStatus(date, null)
    ));
  }

  // Training / Rest day type slider
  const divDt = document.createElement('div');
  divDt.className = 'date-menu-divider';
  menu.appendChild(divDt);
  const seg = document.createElement('div');
  seg.className = 'date-menu-seg';
  seg.innerHTML =
    `<button class="dts-btn${menuDayType === 'training' ? ' active' : ''}" data-dt="training">` +
      `<i class="fas fa-dumbbell"></i>` +
    `</button>` +
    `<button class="dts-btn${menuDayType === 'rest' ? ' active' : ''}" data-dt="rest">` +
      `<i class="fas fa-bed"></i>` +
    `</button>`;
  seg.querySelectorAll('.dts-btn').forEach(btn => {
    btn.onclick = () => {
      seg.querySelectorAll('.dts-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      closeDateMenu();
      setDayType(btn.dataset.dt, date);
    };
  });
  menu.appendChild(seg);

  document.body.appendChild(menu);
  // Position with viewport clamp.
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y + 6;
  if (left + rect.width + 8 > vw) left = vw - rect.width - 8;
  if (top + rect.height + 8 > vh)  top = y - rect.height - 6;
  left = Math.max(8, left);
  top = Math.max(8, top);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  _dateMenuEl = menu;
  // Ignore any synthesized click from the same tap that triggered the menu.
  const swallow = (e) => {
    if (_dateMenuEl && _dateMenuEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => {
    document.addEventListener('click', _dateMenuOutside, true);
    document.addEventListener('touchstart', _dateMenuOutside, true);
    document.addEventListener('keydown', _dateMenuKey, true);
  }, 350);
}

async function loadStats() {
  const { from, to } = getStatsDateRange();
  if (!from || !to || from > to) return;
  document.getElementById('statsLoading').style.display = 'flex';
  document.getElementById('statsContent').style.display = 'none';
  document.getElementById('statsEmpty').style.display = 'none';

  const [macroRes, dayTypeRes, targetsRes, finalizedRes, jokerRes, mocRes, weightRes] = await Promise.all([
    db.from('fddb_daily_macros').select('date, kcal, protein, carbs, fat').gte('date', from).lte('date', to).neq('meal', WEEKLY_TREAT_MEAL),
    db.from('fddb_day_type').select('date, type').gte('date', from).lte('date', to),
    db.from('fddb_coach_targets').select('*').lte('valid_from', to).order('valid_from', { ascending: false }),
    db.from('fddb_day_finalized').select('date, status').gte('date', from).lte('date', to),
    db.from('fddb_daily_macros').select('date').eq('meal', WEEKLY_TREAT_MEAL).gte('date', from).lte('date', to),
    db.from('fddb_daily_macros').select('date').eq('meal', MEAL_OF_CHOICE).gte('date', from).lte('date', to),
    db.from('weight_entries').select('date, weight').gte('date', from).lte('date', to).order('date', { ascending: true }),
  ]);

  document.getElementById('statsLoading').style.display = 'none';
  const macros = macroRes.data || [];
  const jokerDates = new Set((jokerRes.data || []).map(r => r.date));
  const mocDates = new Set((mocRes.data || []).map(r => r.date));
  const dayTypes = dayTypeRes.data || [];
  const allTgts = targetsRes.data || [];
  const weightByDate = Object.fromEntries((weightRes.data || []).map(r => [r.date, parseFloat(r.weight)]));
  if (!macros.length) { document.getElementById('statsEmpty').style.display = 'block'; return; }

  const byDate = {};
  macros.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { kcal:0, p:0, c:0, f:0 };
    byDate[r.date].kcal += r.kcal || 0;
    byDate[r.date].p += parseFloat(r.protein) || 0;
    byDate[r.date].c += parseFloat(r.carbs) || 0;
    byDate[r.date].f += parseFloat(r.fat) || 0;
  });
  const dayTypeMap = Object.fromEntries(dayTypes.map(d => [d.date, d.type]));
  const finalizedStatusMap = {};
  (finalizedRes.data || []).forEach(r => { finalizedStatusMap[r.date] = r.status; });
  function getTarget(date, type) {
    const match = allTgts.find(t => t.type === type && t.valid_from <= date);
    return match ? { kcal: match.kcal, p: match.protein, c: match.carbs, f: match.fat } : null;
  }

  const dates = Object.keys(byDate).sort();
  const dayData = dates.map(date => {
    const d = byDate[date];
    const type = dayTypeMap[date] || 'training';
    const tgt = getTarget(date, type);
    const status = finalizedStatusMap[date] || null;
    const isExcluded = status === 'sick' || status === 'freeze';
    if (!tgt || (tgt.p === 0 && tgt.c === 0 && tgt.f === 0)) return { date, adh: null, p: null, c: null, f: null, devP: null, devC: null, devF: null, devAvg: null, status };
    const rawP = tgt.p > 0 ? Math.round((d.p / tgt.p) * 100) : null;
    const rawC = tgt.c > 0 ? Math.round((d.c / tgt.c) * 100) : null;
    const rawF = tgt.f > 0 ? Math.round((d.f / tgt.f) * 100) : null;
    const pAdh = rawP !== null ? adherenceScore(rawP) : null;
    const cAdh = rawC !== null ? adherenceScore(rawC) : null;
    const fAdh = rawF !== null ? adherenceScore(rawF) : null;
    const valid = [pAdh, cAdh, fAdh].filter(v => v !== null);
    const adh = (valid.length && !isExcluded) ? Math.round(valid.reduce((a,b) => a+b, 0) / valid.length) : null;
    const devP = rawP !== null ? rawP - 100 : null;
    const devC = rawC !== null ? rawC - 100 : null;
    const devF = rawF !== null ? rawF - 100 : null;
    const devAvg = tgt.kcal > 0 ? Math.round((d.kcal / tgt.kcal) * 100) - 100 : null;
    return { date, adh, p: pAdh, c: cAdh, f: fAdh, devP, devC, devF, devAvg, status };
  });

  const withAdh = dayData.filter(d => d.adh !== null);
  const avgAdh = withAdh.length ? Math.round(withAdh.reduce((s,d) => s+d.adh, 0) / withAdh.length) : null;
  const avgDevP = withAdh.filter(d=>d.devP!==null).length ? Math.round(withAdh.filter(d=>d.devP!==null).reduce((s,d)=>s+d.devP,0)/withAdh.filter(d=>d.devP!==null).length) : null;
  const avgDevC = withAdh.filter(d=>d.devC!==null).length ? Math.round(withAdh.filter(d=>d.devC!==null).reduce((s,d)=>s+d.devC,0)/withAdh.filter(d=>d.devC!==null).length) : null;
  const avgDevF = withAdh.filter(d=>d.devF!==null).length ? Math.round(withAdh.filter(d=>d.devF!==null).reduce((s,d)=>s+d.devF,0)/withAdh.filter(d=>d.devF!==null).length) : null;
  const trainingDays = dates.filter(d => (dayTypeMap[d] || 'training') === 'training').length;
  const restDays = dates.filter(d => dayTypeMap[d] === 'rest').length;
  const excludedDays = dayData.filter(d => d.status === 'freeze' || d.status === 'sick').length;
  const hasJoker = dayData.some(d => jokerDates.has(d.date));
  const hasMoC = dayData.some(d => mocDates.has(d.date));
  const hasFreeze = dayData.some(d => d.status === 'freeze');
  const hasSick = dayData.some(d => d.status === 'sick');

  const adhColor = avgAdh !== null ? adherenceColor(avgAdh) : 'var(--muted)';
  document.getElementById('statsTrainingRest').innerHTML = `
    <div class="stats-summary-card">
      <div class="stats-summary-label">Training Days</div>
      <div class="stats-summary-val" style="color:var(--orange)">${trainingDays}</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-label">Rest Days</div>
      <div class="stats-summary-val" style="color:var(--blue)">${restDays}</div>
    </div>`;
  document.getElementById('statsOverallAdh').innerHTML = `
    <div class="stats-summary-val" style="color:${adhColor}">${avgAdh !== null ? avgAdh + '%' : '–'}</div>
    <div class="stats-summary-sub">${withAdh.length} of ${dates.length} days counted${excludedDays > 0 ? ` · ${excludedDays} excluded (sick/freeze)` : ''}</div>`;

  if (statsLineChart) { statsLineChart.destroy(); statsLineChart = null; }
  const lineCtx = document.getElementById('statsLineChart').getContext('2d');
  function devToColor(dev, alpha) {
    if (dev === null) return `rgba(90,90,90,${alpha})`;
    const score = adherenceScore(100 + dev);
    const base = adherenceColor(score);
    return base.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }
  const devValues = dayData.map(d => d.devAvg);
  const ptColors = dayData.map(d => {
    if (d.status === 'freeze') return 'rgba(96,165,250,1)';
    if (d.status === 'sick') return 'rgba(251,191,36,1)';
    if (jokerDates.has(d.date)) return 'rgba(245,158,11,1)';
    if (mocDates.has(d.date)) return 'rgba(167,139,250,1)';
    return devToColor(d.devAvg, 1);
  });
  const ptStyles = dayData.map(d => d.status === 'freeze' ? 'rectRot' : d.status === 'sick' ? 'triangle' : jokerDates.has(d.date) ? 'star' : mocDates.has(d.date) ? 'rectRot' : 'circle');
  const ptRadii = dayData.map(d => (d.status === 'freeze' || d.status === 'sick') ? 6 : (jokerDates.has(d.date) || mocDates.has(d.date)) ? 6 : (dayData.length > 30 ? 0 : 4));
  const ptBorderColors = dayData.map(d => jokerDates.has(d.date) ? 'rgba(245,158,11,1)' : mocDates.has(d.date) ? 'rgba(167,139,250,1)' : 'transparent');
  const ptBorderWidths = dayData.map(d => (jokerDates.has(d.date) || mocDates.has(d.date)) ? 2 : 0);
  const maxAbs = Math.max(...devValues.filter(v=>v!==null).map(Math.abs), 5);
  const yBound = Math.max(10, Math.ceil(maxAbs / 5) * 5);

  const weightValues = dayData.map(d => weightByDate[d.date] ?? null);
  const hasWeight = settings.showWeightChart && weightValues.some(v => v !== null);

  // Weight chart
  const weightChartCard = document.getElementById('weightChartCard');
  if (statsWeightChart) { statsWeightChart.destroy(); statsWeightChart = null; }
  if (weightChartCard) weightChartCard.style.display = hasWeight ? '' : 'none';
  if (hasWeight) {
    const weightVals = weightValues.filter(v => v !== null);
    const wMin = Math.floor(Math.min(...weightVals)) - 1;
    const wMax = Math.ceil(Math.max(...weightVals)) + 1;
    const wCtx = document.getElementById('statsWeightChart').getContext('2d');
    statsWeightChart = new Chart(wCtx, {
      type: 'line',
      data: {
        labels: dayData.map(d => d.date.slice(5)),
        datasets: [{ data: weightValues, borderColor: 'rgba(148,163,184,.9)', borderWidth: 2,
          pointRadius: dayData.length > 60 ? 0 : 3, pointBackgroundColor: 'rgba(148,163,184,.95)',
          tension: .35, fill: false, spanGaps: true }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.raw !== null ? ctx.raw + ' kg' : 'N/A' } } },
        scales: {
          x: { ticks: { color: '#6a6a72', font: { size: 10 }, maxTicksLimit: 10 }, grid: { color: '#1e1e1e' } },
          y: { min: wMin, max: wMax,
            ticks: { color: '#6a6a72', font: { size: 10 }, stepSize: 1, callback: v => v + ' kg' },
            grid: { color: '#1e1e1e' },
          },
        },
      },
    });
  }

  statsLineChart = new Chart(lineCtx, {
    type: 'line',
    data: {
      labels: dayData.map(d => d.date.slice(5)),
      datasets: [{
        label: 'Deviation', data: devValues, borderWidth: 2,
        pointRadius: ptRadii, pointStyle: ptStyles,
        pointBackgroundColor: ptColors, pointBorderColor: ptBorderColors, pointBorderWidth: ptBorderWidths,
        tension: .35, fill: 'origin',
        backgroundColor: 'rgba(90,90,90,.08)', spanGaps: true,
        segment: {
          borderColor: ctx => { const avg = (ctx.p0.parsed.y + ctx.p1.parsed.y) / 2; return devToColor(avg, 1); },
          backgroundColor: ctx => { const avg = (ctx.p0.parsed.y + ctx.p1.parsed.y) / 2; return devToColor(avg, 0.12); },
        },
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const d = dayData[ctx.dataIndex];
          const statusLabel = d && d.status === 'freeze' ? ' · Freeze ❄' : d && d.status === 'sick' ? ' · Sick 🤒' : d && jokerDates.has(d.date) ? ' · Joker ⭐' : d && mocDates.has(d.date) ? ' · Meal of Choice 🍽️' : '';
          return ctx.raw !== null ? 'Dev: ' + (ctx.raw > 0 ? '+' : '') + ctx.raw + '%' + statusLabel : 'N/A';
        }}}
      },
      scales: {
        x: { ticks: { color: '#6a6a72', font: { size: 10 }, maxTicksLimit: 10 }, grid: { color: '#1e1e1e' } },
        y: { min: -yBound, max: yBound,
          ticks: { color: '#6a6a72', font: { size: 10 }, callback: v => (v > 0 ? '+' : '') + v + '%' },
          grid: { color: ctx => ctx.tick.value === 0 ? 'rgba(255,255,255,.2)' : '#1e1e1e', lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1 }
        },
      },
    },
  });

  if (statsBarChart) { statsBarChart.destroy(); statsBarChart = null; }
  const barCtx = document.getElementById('statsBarChart').getContext('2d');
  const devData = [avgDevP, avgDevC, avgDevF];
  const devColors = devData.map(v => {
    if (v === null) return 'rgba(90,90,90,.5)';
    const score = adherenceScore(100 + v);
    return adherenceColor(score).replace('rgb(', 'rgba(').replace(')', ',.75)');
  });
  const maxBar = Math.max(...devData.filter(v=>v!==null).map(Math.abs), 5);
  const yBar = Math.max(10, Math.ceil(maxBar / 5) * 5);

  statsBarChart = new Chart(barCtx, {
    type: 'bar',
    data: { labels: ['Protein', 'Carbs', 'Fat'], datasets: [{ data: devData, backgroundColor: devColors, borderWidth: 0, borderRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.raw !== null ? (ctx.raw > 0 ? '+' : '') + ctx.raw + '%' : 'N/A' } } },
      scales: {
        x: { ticks: { color: '#6a6a72', font: { size: 11 } }, grid: { display: false } },
        y: { min: -yBar, max: yBar,
          ticks: { color: '#6a6a72', font: { size: 10 }, callback: v => (v > 0 ? '+' : '') + v + '%' },
          grid: { color: c => c.tick.value === 0 ? 'rgba(255,255,255,.15)' : '#1e1e1e' }
        },
      },
    },
  });

  // Line chart legend (dynamic)
  const lineLegendEl = document.getElementById('statsLineLegend');
  lineLegendEl.innerHTML = [
    hasJoker ? `<span style="color:var(--gold)">★ Joker</span>` : '',
    hasMoC ? `<span style="color:rgba(167,139,250,1)">◆ Meal of Choice</span>` : '',
    hasFreeze ? `<span style="color:rgba(96,165,250,.9)">◆ Freeze</span>` : '',
    hasSick ? `<span style="color:rgba(251,191,36,.9)">▲ Sick</span>` : '',
  ].filter(Boolean).join('');

  // Heatmap
  const hm = document.getElementById('statsHeatmap');
  hm.innerHTML = '';
  const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  function cellBg(a) {
    if (a === null) return '#1e1e1e';
    const t = a / 100;
    let r, g, b;
    if (t < 0.5) { const s = t/0.5; r = Math.round(248 + (250-248)*s); g = Math.round(113 + (204-113)*s); b = Math.round(113 + (21-113)*s); }
    else { const s = (t-0.5)/0.5; r = Math.round(250 + (74-250)*s); g = Math.round(204 + (222-204)*s); b = Math.round(21 + (128-21)*s); }
    return `rgba(${r},${g},${b},0.75)`;
  }

  if (statsPeriod === 'week') {
    const cwHeader = document.createElement('div');
    cwHeader.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:3px';
    dayData.forEach(d => {
      const dow = new Date(d.date).getDay();
      const label = DAY_LABELS[dow === 0 ? 6 : dow - 1];
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:.55rem;color:var(--muted);text-align:center;text-transform:uppercase;letter-spacing:.06em;font-weight:600';
      lbl.textContent = label;
      cwHeader.appendChild(lbl);
    });
    hm.appendChild(cwHeader);
    const cwGrid = document.createElement('div');
    cwGrid.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px';
    dayData.forEach(d => {
      const a = d.adh;
      const dtype = dayTypeMap[d.date];
      const status = d.status;
      const isJoker = jokerDates.has(d.date);
      const isMoC = mocDates.has(d.date);
      const typeIcon = dtype === 'training' ? `<i class="fas fa-dumbbell" style="font-size:.55rem;color:rgba(255,255,255,.5);margin-left:5px"></i>` : dtype === 'rest' ? `<i class="fas fa-bed" style="font-size:.55rem;color:rgba(255,255,255,.5);margin-left:5px"></i>` : '';
      const cell = document.createElement('div');
      let bg = cellBg(a);
      if (status === 'freeze') bg = 'rgba(96,165,250,0.2)';
      else if (status === 'sick') bg = 'rgba(251,191,36,0.2)';
      cell.style.cssText = `flex:1;position:relative;background:${bg};border-radius:8px;padding:12px 4px;text-align:center;display:flex;align-items:center;justify-content:center`;
      let mainContent;
      if (status === 'freeze') {
        mainContent = `<i class="fas fa-snowflake" style="font-size:1.05rem;color:rgba(96,165,250,.9)"></i>`;
      } else if (status === 'sick') {
        mainContent = `<i class="fas fa-thermometer-half" style="font-size:1.05rem;color:rgba(251,191,36,.9)"></i>`;
      } else {
        mainContent = `<div style="font-family:'Bebas Neue',sans-serif;font-size:1.15rem;color:${a!==null?'#fff':'#444'}">${a !== null ? a+'%' : '–'}</div>`;
      }
      const tipText = status === 'freeze' ? `${d.date}: Freeze` : status === 'sick' ? `${d.date}: Sick` : `${d.date}: ${a !== null ? a + '%' : 'N/A'}${isJoker ? ' · Joker ⭐' : isMoC ? ' · Meal of Choice 🍽️' : ''}`;
      cell.innerHTML = `${mainContent}${typeIcon}`;
      cell.setAttribute('data-tip', tipText);
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px';
      wrapper.appendChild(cell);
      const weekBar = document.createElement('div');
      weekBar.style.cssText = `height:3px;border-radius:99px;background:${isJoker ? 'var(--gold)' : isMoC ? 'var(--moc)' : 'transparent'};width:100%`;
      wrapper.appendChild(weekBar);
      cwGrid.appendChild(wrapper);
    });
    hm.appendChild(cwGrid);
  } else {
    const header = document.createElement('div');
    header.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:3px';
    DAY_LABELS.forEach(l => {
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:.55rem;color:var(--muted);text-align:center;text-transform:uppercase;letter-spacing:.06em;font-weight:600';
      lbl.textContent = l;
      header.appendChild(lbl);
    });
    hm.appendChild(header);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:2px';
    const firstDow = new Date(dayData[0].date).getDay();
    const offset = firstDow === 0 ? 6 : firstDow - 1;
    dayData.forEach((d, i) => {
      const a = d.adh;
      const dtype = dayTypeMap[d.date];
      const status = d.status;
      const isJoker = jokerDates.has(d.date);
      const isMoC = mocDates.has(d.date);
      const barColor = dtype === 'training' ? 'var(--orange)' : dtype === 'rest' ? 'var(--blue)' : null;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px;width:100%';
      if (i === 0 && offset > 0) wrapper.style.gridColumnStart = offset + 1 + '';
      const cell = document.createElement('div');
      let bg = cellBg(a);
      if (status === 'freeze') bg = 'rgba(96,165,250,0.25)';
      else if (status === 'sick') bg = 'rgba(251,191,36,0.25)';
      cell.style.cssText = `border-radius:4px;background:${bg};height:20px;width:100%;display:flex;align-items:center;justify-content:center;overflow:hidden`;
      const tipText = status === 'freeze' ? `${d.date}: Freeze` : status === 'sick' ? `${d.date}: Sick` : `${d.date}: ${a !== null ? a + '%' : 'N/A'}${isJoker ? ' · Joker ⭐' : isMoC ? ' · Meal of Choice 🍽️' : ''}`;
      cell.setAttribute('data-tip', tipText);
      if (status === 'freeze') {
        cell.innerHTML = `<span style="display:inline-flex;background:rgba(96,165,250,.45);border-radius:3px;padding:2px 3px;line-height:1"><i class="fas fa-snowflake" style="font-size:.5rem;color:#fff"></i></span>`;
      } else if (status === 'sick') {
        cell.innerHTML = `<span style="display:inline-flex;background:rgba(251,191,36,.45);border-radius:3px;padding:2px 3px;line-height:1"><i class="fas fa-thermometer-half" style="font-size:.5rem;color:#fff"></i></span>`;
      } else if (isJoker) {
        cell.innerHTML = `<span style="display:inline-flex;background:rgba(245,158,11,.55);border-radius:3px;padding:2px 3px;line-height:1"><i class="fas fa-star" style="font-size:.5rem;color:#fff"></i></span>`;
      } else if (isMoC) {
        cell.innerHTML = `<span style="display:inline-flex;background:rgba(167,139,250,.55);border-radius:3px;padding:2px 3px;line-height:1"><i class="fas fa-utensils" style="font-size:.5rem;color:#fff"></i></span>`;
      }
      cell.className = 'heatmap-cell';
      wrapper.appendChild(cell);
      if (barColor) {
        const bar = document.createElement('div');
        bar.style.cssText = `height:3px;border-radius:99px;background:${barColor};width:100%`;
        wrapper.appendChild(bar);
      }
      grid.appendChild(wrapper);
    });
    hm.appendChild(grid);
  }

  const hmLegend = document.createElement('div');
  hmLegend.className = 'chart-legend';
  hmLegend.style.marginTop = '10px';
  const jokerHmItem = hasJoker ? (statsPeriod === 'week'
    ? `<span><span style="display:inline-block;width:14px;height:3px;border-radius:99px;background:var(--gold);vertical-align:middle"></span> Joker</span>`
    : `<span><i class="fas fa-star" style="color:var(--gold);font-size:.55rem"></i> Joker</span>`) : '';
  const mocHmItem = hasMoC ? (statsPeriod === 'week'
    ? `<span><span style="display:inline-block;width:14px;height:3px;border-radius:99px;background:var(--moc);vertical-align:middle"></span> Meal of Choice</span>`
    : `<span><i class="fas fa-utensils" style="color:var(--moc);font-size:.55rem"></i> Meal of Choice</span>`) : '';
  hmLegend.innerHTML = [
    jokerHmItem,
    mocHmItem,
    hasFreeze ? `<span><i class="fas fa-snowflake" style="color:rgba(96,165,250,.9);font-size:.55rem"></i> Freeze</span>` : '',
    hasSick ? `<span><i class="fas fa-thermometer-half" style="color:rgba(251,191,36,.9);font-size:.55rem"></i> Sick</span>` : '',
  ].filter(Boolean).join('');
  if (hmLegend.innerHTML) hm.appendChild(hmLegend);

  document.getElementById('statsContent').style.display = 'flex';
  renderStreak();
  const hmTitle = document.querySelector('#statsHeatmap').previousElementSibling;
  if (avgAdh !== null) {
    hmTitle.innerHTML = `<i class="fas fa-th"></i> Adherence Heatmap <span style="color:${adherenceColor(avgAdh)};margin-left:6px">— Ø ${avgAdh}%</span>`;
  } else {
    hmTitle.innerHTML = '<i class="fas fa-th"></i> Adherence Heatmap';
  }
}

/* ── Toast ── */
let toastTimer;
function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' '+type : '');
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
    showToast('Screenshot lib still loading…', 'error');
    return;
  }
  const activeView = document.querySelector('.view.active');
  if (!activeView) { showToast('No active view', 'error'); return; }

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
    <div style="font-size:.9rem;color:#fff">Creating screenshot…</div>
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
  //    On desktop Chart.js charts render very wide (e.g. 900×150px).
  //    Resize each Chart.js instance to CAPTURE_WIDTH before snapshotting
  //    so the image already has the right proportions and needs no
  //    distorting transforms in the clone.
  const CAPTURE_CHART_WIDTH = 460 - 60; // stage width minus padding
  const liveCanvases = activeView.querySelectorAll('canvas');
  const chartResizeList = []; // track which charts we resized for restore
  liveCanvases.forEach(c => {
    if (typeof Chart !== 'undefined') {
      const chart = Chart.getChart(c);
      if (chart) {
        chartResizeList.push({ chart, origW: c.offsetWidth, origH: c.offsetHeight });
        chart.resize(CAPTURE_CHART_WIDTH, c.offsetHeight);
      }
    }
  });
  // Wait two frames for Chart.js to finish re-rendering at the new size.
  if (chartResizeList.length) {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

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
  clone.querySelectorAll('.header-actions, .date-picker-btn, .today-sub-nav').forEach(el => el.remove());

  // In timeline mode the hero card is hidden via .tl-mode CSS, but that class
  // was stripped from the clone root — remove the card explicitly.
  if (timelineMode) clone.querySelector('#heroCard')?.remove();
  // Remove live UI indicators from the capture.
  clone.querySelector('.tl-now-line')?.remove();
  clone.querySelector('.tl-meal-rail')?.remove();
  clone.querySelector('.timeline-view')?.classList.remove('tl-has-rail');

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
      gap: 0 !important;
    }
    /* Kill the radial glow pseudo-element on the hero card */
    #__screenshotStage .hero-card::before {
      display: none !important;
    }
    /* Without ::before the gold bg tint bleeds strongly in canvas; reset
       to standard surface background, keep only the border accent */
    #__screenshotStage .hero-card.hero-goal-perfect {
      background: linear-gradient(145deg, var(--surface) 0%, var(--bg-elev) 100%) !important;
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
    /* Chart images fill container width without overflowing */
    #__screenshotStage img {
      max-width: 100% !important;
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
  //    Charts were already resized to CAPTURE_CHART_WIDTH before
  //    snapshotting, so snap.w ≈ container width and no distortion occurs.
  clone.querySelectorAll('canvas').forEach(c => {
    const key = c.getAttribute('data-cx-key');
    const snap = key && canvasSnapshots.get(key);
    if (!snap) return;
    const img = document.createElement('img');
    img.src = snap.url;
    img.style.cssText = `display:block;width:${snap.w}px;height:${snap.h}px;max-width:100%`;
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
      if (!blob) { showToast('Screenshot failed', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Screenshot saved: ' + filename, 'success');
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
    // Restore Chart.js instances to their original desktop size
    chartResizeList.forEach(({ chart, origW, origH }) => chart.resize(origW, origH));
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
  let lockedScrollMax = 0;
  let scrollRafId = null;

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
    // Capture max scroll BEFORE position:fixed collapses scrollHeight to vh.
    lockedScrollMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
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

  function updateSameMealDropTarget(x, y, card) {
    const rows = [...card.querySelectorAll('[data-drag-kind]')].filter(r => r !== state.src);
    let insertBefore = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { insertBefore = row; break; }
    }
    if (insertBefore === state.dropInsertBefore && state.dropLine && state.dropLine.parentElement) return;
    state.dropInsertBefore = insertBefore;
    if (!state.dropLine) {
      state.dropLine = document.createElement('div');
      state.dropLine.className = 'dnd-drop-line';
    }
    const list = card.querySelector('.items-list');
    if (!list) return;
    if (insertBefore) list.insertBefore(state.dropLine, insertBefore);
    else list.appendChild(state.dropLine);
  }

  function cancelDrag(restore = true) {
    if (!state) return;
    const wasStarted = state.started;
    if (scrollRafId) { cancelAnimationFrame(scrollRafId); scrollRafId = null; }
    hideTreatPill();
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    clearTimeout(state.pressTimer);
    clearTimeout(state.contextTimer);
    if (state.ghost) state.ghost.remove();
    if (state.dropLine) state.dropLine.remove();
    if (state.src && restore) state.src.classList.remove('dnd-source');
    document.querySelectorAll('.meal-card.dnd-hover').forEach(c => c.classList.remove('dnd-hover'));
    document.querySelectorAll('.tl-row.tl-drop-target').forEach(r => r.classList.remove('tl-drop-target'));
    document.querySelector('.timeline-view')?.classList.remove('tl-drag-active');
    refreshMealRail(false);
    state = null;
    document.body.classList.remove('is-dragging');
    if (wasStarted) unlockBodyScroll();
  }

  // ── rAF smooth edge-scroll ──────────────────────────────
  // Body stays position:fixed during drag (Safari-safe), so we
  // simulate scroll by adjusting lockedScrollY + body.style.top.
  // Speed scales with distance into the edge zone (2–22 px/frame).
  // ── rAF smooth edge-scroll ──────────────────────────────
  // Body stays position:fixed during drag (Safari-safe), so we
  // simulate scroll by adjusting lockedScrollY + body.style.top.
  // Speed scales with distance into the edge zone (2–22 px/frame).
  function tickScroll() {
    if (!state || !state.started) { scrollRafId = null; return; }
    const y   = state.lastClientY || 0;
    const x   = state.lastClientX || 0;
    const vh  = window.innerHeight;
    const EDGE = 90;
    let scrolled = false;
    if (y < EDGE && lockedScrollY > 0) {
      const t = 1 - y / EDGE;
      lockedScrollY = Math.max(0, lockedScrollY - Math.round(2 + t * 20));
      document.body.style.top = `-${lockedScrollY}px`;
      scrolled = true;
    } else if (y > vh - EDGE && lockedScrollY < lockedScrollMax) {
      const t = (y - (vh - EDGE)) / EDGE;
      lockedScrollY = Math.min(lockedScrollMax, lockedScrollY + Math.round(2 + t * 20));
      document.body.style.top = `-${lockedScrollY}px`;
      scrolled = true;
    }
    if (scrolled) updateDropTarget(x, y);
    scrollRafId = requestAnimationFrame(tickScroll);
  }

  // ── Timeline drop-target evaluation ──
  function updateTlDropTarget(x, y) {
    const rows = document.querySelectorAll('.tl-row');
    let found = null;
    rows.forEach(r => {
      r.classList.remove('tl-drop-target');
      const b = r.getBoundingClientRect();
      if (y >= b.top && y < b.bottom) found = r;
    });
    if (found) { found.classList.add('tl-drop-target'); state.dropTlRow = found; }
    else state.dropTlRow = null;
  }

  // ── Drop-target evaluation (shared by onMove + tickScroll) ──
  function updateDropTarget(x, y) {
    if (!state || !state.started) return;
    if (timelineMode) { updateTlDropTarget(x, y); return; }
    const card = findMealCardAtPoint(x, y);
    if (card && card.dataset.meal === state.src.dataset.meal) {
      document.querySelectorAll('.meal-card.dnd-hover').forEach(c => c.classList.remove('dnd-hover'));
      state.dropCard = card;
      updateSameMealDropTarget(x, y, card);
    } else {
      if (state.dropLine) { state.dropLine.remove(); state.dropLine = null; state.dropInsertBefore = undefined; }
      if (card !== state.dropCard) {
        document.querySelectorAll('.meal-card.dnd-hover').forEach(c => c.classList.remove('dnd-hover'));
        state.dropCard = card;
        if (card) card.classList.add('dnd-hover');
      }
    }
  }

  // ── Floating Weekly Treat pill ───────────────────────────
  // Fixed above the tab bar — always reachable without scrolling.
  // Hidden when dragging from weekly treat itself (no-op drop).
  function showTreatPill() {
    if (document.getElementById('dndTreatPill')) return;
    if (state && state.src && state.src.dataset.meal === WEEKLY_TREAT_MEAL) return;
    const pill = document.createElement('div');
    pill.id = 'dndTreatPill';
    pill.className = 'meal-card weekly-treat-card dnd-treat-pill';
    pill.dataset.meal = WEEKLY_TREAT_MEAL;
    pill.innerHTML = `<div class="meal-title weekly-treat-title" style="border-bottom:none;padding:10px 14px">
      <span class="weekly-treat-icon">⭐</span>
      <div class="meal-name weekly-treat-name">Weekly Treat</div>
      <div class="dnd-treat-pill-hint">drop here</div>
    </div>`;
    document.body.appendChild(pill);
  }
  function hideTreatPill() {
    const pill = document.getElementById('dndTreatPill');
    if (pill) pill.remove();
  }

  function beginDrag(src, clientX, clientY) {
    // For timeline: pre-measure the expanded scrollHeight so lockBodyScroll
    // captures the full draggable range. Add/remove tl-drag-active synchronously
    // (forced reflow, no paint, no scroll API) so no pointercancel fires.
    // Then lock the body, override lockedScrollMax, and THEN expand rows –
    // by which point body is position:fixed so rows expanding doesn't scroll.
    // Use rect captured at onDown (state.downRect) so the ghost starts at the
    // exact touch/click point before any DOM changes shift the chip.
    let expandedMax = null;
    if (timelineMode) {
      const tlView = document.querySelector('.timeline-view');
      if (tlView) {
        tlView.classList.add('tl-drag-active');
        expandedMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        tlView.classList.remove('tl-drag-active');
      }
    }
    lockBodyScroll();
    if (expandedMax !== null) lockedScrollMax = expandedMax;

    const rect = (state && state.downRect) || src.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.add('dnd-ghost');
    // Cancel any CSS animation inherited from the source element (e.g. slideUp
    // on .tl-chip) – a running animation overrides inline style.transform and
    // would prevent moveGhost from actually moving the ghost.
    ghost.style.animation = 'none';
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
    state.lastClientX = clientX;
    state.lastClientY = clientY;
    state.started = true;
    document.body.classList.add('is-dragging');

    scrollRafId = requestAnimationFrame(tickScroll);
    if (!timelineMode) showTreatPill();

    // Expand all rows after body is locked so row expansion can't scroll the
    // viewport or change the ghost's initial coordinates.
    if (timelineMode) {
      document.querySelector('.timeline-view')?.classList.add('tl-drag-active');
      refreshMealRail(true);
    }

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
    // Dashboard is read-only when timeline is the primary view
    if (settings.timelinePrimary && !timelineMode) return;
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
      dropLine: null,
      dropInsertBefore: undefined,
      dropTlRow: null,
      downRect: src.getBoundingClientRect(),
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
        if (dist > 28) {
          clearTimeout(state.pressTimer);
          cancelDrag(true);
          return;
        }
      }
    }
    if (!state || !state.started) return;
    ev.preventDefault();

    state.lastClientX = ev.clientX;
    state.lastClientY = ev.clientY;

    moveGhost(ev.clientX, ev.clientY);
    updateDropTarget(ev.clientX, ev.clientY);
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

    if (timelineMode && state && state.dropTlRow) {
      const hour = state.dropTlRow.dataset.hour === 'null' ? null : parseInt(state.dropTlRow.dataset.hour, 10);
      const ids = src.dataset.entryIds.split(',').map(s => s.trim()).filter(Boolean);
      const oldKeys = src.dataset.checkKeys.split('|').filter(Boolean);
      const kind = src.dataset.dragKind;
      const recipeName = src.dataset.recipeName || '';
      const fromMeal = src.dataset.meal;
      const serving = parseInt(src.dataset.serving ?? '0', 10);
      const servings = parseInt(src.dataset.servings ?? '1', 10);
      const isExploded = src.dataset.isExploded === 'true';

      ghost.style.transition = 'opacity .15s ease';
      ghost.style.opacity = '0';
      const swallow = e => { e.stopPropagation(); e.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 80);
      cancelDrag(false);

      const newMeal = getMealForTime(hour);
      if (newMeal && newMeal !== fromMeal &&
          fromMeal !== WEEKLY_TREAT_MEAL && fromMeal !== MEAL_OF_CHOICE) {
        if (kind === 'recipe' && servings > 1) {
          // Multi-serving recipe: move only this one serving
          await moveSingleServing({ recipeName, serving, servings, ids, fromMeal, toMeal: newMeal, isExploded });
          // Update time key to reflect new meal
          const newKey = `${newMeal}::${recipeName}::${serving}`;
          saveItemTime(newKey, hour);
        } else {
          // Single item or single-serving recipe: move everything
          await moveEntries({ ids, fromMeal, toMeal: newMeal, kind, oldKeys, recipeName });
          if (hour !== null) {
            oldKeys.forEach(k => {
              const parts = k.split('::');
              parts[0] = newMeal;
              saveItemTime(parts.join('::'), hour);
            });
          }
        }
      } else {
        // Same meal or no time-range mapping: just update the time slot
        oldKeys.forEach(k => saveItemTime(k, hour));
      }
      renderTimelineDashboard(currentDayEntries);
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

      const swallow = e => { e.stopPropagation(); e.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 80);

      cancelDrag(false);
      await moveEntries({ ids, fromMeal: src.dataset.meal, toMeal: newMeal, kind, oldKeys, recipeName });
    } else if (dropCard && dropCard.dataset.meal === src.dataset.meal) {
      const capturedInsertBefore = state.dropInsertBefore;
      const capturedCard = dropCard;
      const meal = dropCard.dataset.meal;

      ghost.style.transition = 'opacity .15s ease';
      ghost.style.opacity = '0';

      const swallow = e => { e.stopPropagation(); e.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 80);

      setTimeout(() => {
        cancelDrag(true);
        reorderEntries({ srcEl: src, insertBefore: capturedInsertBefore, mealCard: capturedCard, meal });
      }, 150);
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

  function getWeekBounds(dateStr) {
    const d = new Date(dateStr);
    const dow = d.getDay(); // 0=Sun … 6=Sat
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d); mon.setDate(d.getDate() + diffToMon);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const fmt = x => x.toISOString().split('T')[0];
    return { monday: fmt(mon), sunday: fmt(sun) };
  }

  async function moveEntries({ ids, fromMeal, toMeal, kind, oldKeys, recipeName }) {
    if (!ids.length || fromMeal === toMeal) return;

    if (toMeal === WEEKLY_TREAT_MEAL) {
      const { monday, sunday } = getWeekBounds(currentDate);
      const { data: weekTreats } = await db
        .from('fddb_daily_macros')
        .select('id, date')
        .eq('meal', WEEKLY_TREAT_MEAL)
        .gte('date', monday)
        .lte('date', sunday);
      const idSet = new Set(ids);
      const existing = (weekTreats || []).filter(e => !idSet.has(String(e.id)));
      if (existing.length > 0) {
        showToast('Weekly joker already used ⭐', 'error');
        return;
      }
    }

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

      showMoveToast(kind === 'recipe' ? recipeName : 'Item', toMeal);
    } catch (err) {
      console.error('Move failed:', err);
      alert('Verschieben fehlgeschlagen. Lade neu...');
      loadDay();
    }
  }

  // Moves exactly one serving of a multi-serving recipe to a different meal.
  // If the recipe entries are still "merged" (serving_index=null), they are
  // first exploded into per-serving rows in the DB before the move.
  async function moveSingleServing({ recipeName, serving, servings, ids, fromMeal, toMeal, isExploded }) {
    try {
      const idSet = new Set(ids);
      const allEntries = currentDayEntries.filter(e => idSet.has(String(e.id)));

      if (isExploded) {
        // Entries already have serving_index; just move this serving's rows.
        const servingEntries = allEntries.filter(e => e.serving_index === serving);
        if (!servingEntries.length) return;
        const servingIds = servingEntries.map(e => String(e.id));
        // Optimistic local update
        servingEntries.forEach(e => { e.meal = toMeal; });
        // Migrate check keys
        const oldKey = `${fromMeal}::${recipeName}::${serving}`;
        const newKey = `${toMeal}::${recipeName}::${serving}`;
        if (currentCheckedMap[oldKey] !== undefined) {
          const v = currentCheckedMap[oldKey];
          delete currentCheckedMap[oldKey];
          if (v) currentCheckedMap[newKey] = v;
          await db.from('fddb_checklist_status').delete().eq('date', currentDate).eq('item_key', oldKey);
          if (v) await db.from('fddb_checklist_status').upsert({ date: currentDate, item_key: newKey, checked: true }, { onConflict: 'date,item_key' });
        }
        const { error } = await db.from('fddb_daily_macros').update({ meal: toMeal }).in('id', servingIds);
        if (error) throw error;
      } else {
        // Entries are merged: explode into N per-serving rows, then move target serving.
        const newRows = [];
        for (let s = 0; s < servings; s++) {
          for (const entry of allEntries) {
            newRows.push({
              date: currentDate,
              meal: s === serving ? toMeal : fromMeal,
              item_name: entry.item_name,
              kcal: Math.round((entry.kcal || 0) / servings),
              protein: ((parseFloat(entry.protein) || 0) / servings).toFixed(1),
              carbs: ((parseFloat(entry.carbs) || 0) / servings).toFixed(1),
              fat: ((parseFloat(entry.fat) || 0) / servings).toFixed(1),
              serving_index: s,
              sort_order: entry.sort_order,
            });
          }
        }
        // Remove old merged entries from local state
        currentDayEntries = currentDayEntries.filter(e => !idSet.has(String(e.id)));
        // DB: delete old, insert exploded rows
        await db.from('fddb_daily_macros').delete().in('id', ids);
        const { data: inserted, error } = await db.from('fddb_daily_macros').insert(newRows).select();
        if (error) throw error;
        if (inserted) currentDayEntries.push(...inserted);
        // Migrate check key for the moved serving
        const oldKey = `${fromMeal}::${recipeName}::${serving}`;
        const newKey = `${toMeal}::${recipeName}::${serving}`;
        if (currentCheckedMap[oldKey] !== undefined) {
          const v = currentCheckedMap[oldKey];
          delete currentCheckedMap[oldKey];
          if (v) currentCheckedMap[newKey] = v;
          await db.from('fddb_checklist_status').delete().eq('date', currentDate).eq('item_key', oldKey);
          if (v) await db.from('fddb_checklist_status').upsert({ date: currentDate, item_key: newKey, checked: true }, { onConflict: 'date,item_key' });
        }
      }
      showMoveToast(recipeName, toMeal);
    } catch (err) {
      console.error('moveSingleServing failed:', err);
      alert('Verschieben fehlgeschlagen. Lade neu...');
      loadDay();
    }
  }

  async function reorderEntries({ srcEl, insertBefore, mealCard, meal }) {
    const allRows = [...mealCard.querySelectorAll('[data-drag-kind]')];
    const otherRows = allRows.filter(r => r !== srcEl);
    let insertIdx;
    if (insertBefore) {
      const idx = otherRows.indexOf(insertBefore);
      insertIdx = idx >= 0 ? idx : otherRows.length;
    } else {
      insertIdx = otherRows.length;
    }
    const newOrder = [...otherRows.slice(0, insertIdx), srcEl, ...otherRows.slice(insertIdx)];

    newOrder.forEach((row, sortOrder) => {
      row.dataset.entryIds.split(',').map(s => s.trim()).filter(Boolean).forEach(id => {
        const entry = currentDayEntries.find(e => String(e.id) === id);
        if (entry) entry.sort_order = sortOrder;
      });
    });

    renderDashboard(currentDayEntries);

    try {
      const updates = newOrder.flatMap((row, sortOrder) =>
        row.dataset.entryIds.split(',').map(s => s.trim()).filter(Boolean).map(id =>
          db.from('fddb_daily_macros').update({ sort_order: sortOrder }).eq('id', id)
        )
      );
      const results = await Promise.all(updates);
      const failed = results.find(r => r.error);
      if (failed) throw failed.error;
    } catch (err) {
      console.error('Reorder failed:', err);
      alert('Umsortieren fehlgeschlagen. Lade neu...');
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

  function showTlContextMenu(chipEl) {
    const isTreat = chipEl.dataset.meal === WEEKLY_TREAT_MEAL;
    const name = chipEl.querySelector('.tl-chip-name')?.textContent || 'Item';

    const overlay = document.createElement('div');
    overlay.className = 'tl-ctx-overlay';

    const sheet = document.createElement('div');
    sheet.className = 'tl-ctx-sheet';

    const close = () => {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 220);
    };

    const doMove = async (toMeal) => {
      close();
      const ids = chipEl.dataset.entryIds.split(',').map(s => s.trim()).filter(Boolean);
      const fromMeal = chipEl.dataset.meal;
      const kind = chipEl.dataset.dragKind;
      const oldKeys = chipEl.dataset.checkKeys.split('|').filter(Boolean);
      const recipeName = chipEl.dataset.recipeName || '';
      await moveEntries({ ids, fromMeal, toMeal, kind, oldKeys, recipeName });
    };

    if (!isTreat) {
      sheet.innerHTML = `
        <div class="tl-ctx-title">${name}</div>
        <button class="tl-ctx-action" id="tlCtxTreat"><i class="fas fa-star"></i> Mark as Weekly Treat</button>
        <button class="tl-ctx-cancel">Cancel</button>`;
      overlay.appendChild(sheet);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      sheet.querySelector('.tl-ctx-cancel').addEventListener('click', close);
      sheet.querySelector('#tlCtxTreat').addEventListener('click', () => doMove(WEEKLY_TREAT_MEAL));
    } else {
      // Build meal options from current day entries (excluding treat itself)
      const seenLabels = new Set();
      const mealOptions = ORDER
        .filter(m => {
          const label = LABELS[m] || m;
          if (seenLabels.has(label)) return false;
          seenLabels.add(label);
          return true;
        })
        .map(m => `<button class="tl-ctx-meal-btn" data-meal="${m}">${LABELS[m] || m}</button>`)
        .join('');
      sheet.innerHTML = `
        <div class="tl-ctx-title">${name}</div>
        <div class="tl-ctx-info"><i class="fas fa-star"></i> Weekly Treat — move back to:</div>
        <div class="tl-ctx-meal-grid">${mealOptions}</div>
        <button class="tl-ctx-cancel">Cancel</button>`;
      overlay.appendChild(sheet);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      sheet.querySelector('.tl-ctx-cancel').addEventListener('click', close);
      sheet.querySelectorAll('.tl-ctx-meal-btn').forEach(btn => {
        btn.addEventListener('click', () => doMove(btn.dataset.meal));
      });
    }
  }

  document.addEventListener('pointerdown', onDown);
  window.showTlContextMenu = showTlContextMenu;
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

