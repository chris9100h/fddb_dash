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

const ORDER = ['frühstück','zwischenmahlzeit 1','mittagessen','zwischenmahlzeit 2','abendbrot','abendessen'];
const LABELS = { 'frühstück':'Breakfast','zwischenmahlzeit 1':'Snack 1','mittagessen':'Lunch','zwischenmahlzeit 2':'Snack 2','abendbrot':'Dinner','abendessen':'Dinner' };

let checkables = [];
let totals = { kcal:0, p:0, c:0, f:0 };
let allRecipes = [];
let allCategories = [];
let allUnits = [];
let activeFilterCat = null;
let collapsedSections = new Set();
let _currentGroupKeys = [];
let currentDayEntries = [];
let currentCheckedMap = {};
let currentDate = '';
let coachTargets = { training: {kcal:0,p:0,c:0,f:0}, rest: {kcal:0,p:0,c:0,f:0} };
let currentDayType = 'training';
let mergeServings = false;
let waterData = { drunk: null, goal: null };

// ── Init ──
// Hoisted cache for finalized-day rows (used by renderDateStrip on first paint).
// Use var so it's hoisted and safe to reference from function bodies before init.
var finalizedMap = new Map();
const todayStr = new Date().toISOString().split('T')[0];
document.getElementById('dateInput').value = todayStr;
currentDate = todayStr;
renderDateStrip(todayStr);
// Load finalized status map so date-pill icons can render.
if (typeof loadFinalizedMap === 'function') {
  loadFinalizedMap().then(() => renderDateStrip(currentDate));
}
document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));

/* ══════════════════════════════════════
   SETTINGS (Supabase-backed, localStorage cache)
   ══════════════════════════════════════ */
const SETTINGS_CACHE_KEY = 'fddb.settings.cache.v1';
const SETTINGS_DEFAULTS = {
  adherenceGoal: 80,        // % — threshold for a day to count
  adherenceCutoff: '22:00', // HH:MM — auto-finalize time
  haptics: true,            // vibration feedback on/off
  sickModeActive: false,    // when true, every day (incl. today) is auto-marked 'sick'
  sickSince: null,          // YYYY-MM-DD — date sick mode started
};
let settings = { ...SETTINGS_DEFAULTS };

// Hydrate from cache immediately so UI doesn't flash defaults.
try {
  const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
  if (raw) settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
} catch (e) { /* ignore */ }

function cacheSettings() {
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings)); } catch (e) {}
}

// Map camelCase setting key ⇆ Supabase row key.
// Using snake_case in DB matches the convention of other fddb_ tables.
const SETTING_DB_KEYS = {
  adherenceGoal:    'adherence_goal',
  adherenceCutoff:  'adherence_cutoff',
  haptics:          'haptics',
  sickModeActive:   'sick_mode_active',
  sickSince:        'sick_since',
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

function applySettingsToUI() {
  const goalEl = document.getElementById('setAdherenceGoal');
  const cutoffEl = document.getElementById('setAdherenceCutoff');
  const hapticsEl = document.getElementById('setHaptics');
  const sickEl = document.getElementById('setSickMode');
  const sickSubEl = document.getElementById('sickModeSub');
  if (!goalEl) return;
  goalEl.value = settings.adherenceGoal;
  cutoffEl.value = settings.adherenceCutoff;
  hapticsEl.checked = !!settings.haptics;
  if (sickEl) sickEl.checked = !!settings.sickModeActive;
  if (sickSubEl) {
    sickSubEl.textContent = settings.sickModeActive
      ? `Active since ${settings.sickSince || '—'} · all days marked sick`
      : 'Off';
  }
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
  const hapticsEl = document.getElementById('setHaptics');
  if (!goalEl) return;

  applySettingsToUI();

  goalEl.addEventListener('change', () => {
    let v = parseInt(goalEl.value, 10);
    if (!Number.isFinite(v)) v = SETTINGS_DEFAULTS.adherenceGoal;
    v = Math.max(50, Math.min(100, v));
    goalEl.value = v;
    settings.adherenceGoal = v;
    cacheSettings();
    writeSettingToDb('adherenceGoal', v);
  });
  cutoffEl.addEventListener('change', () => {
    const v = cutoffEl.value || SETTINGS_DEFAULTS.adherenceCutoff;
    settings.adherenceCutoff = v;
    cacheSettings();
    writeSettingToDb('adherenceCutoff', v);
  });
  hapticsEl.addEventListener('change', () => {
    settings.haptics = hapticsEl.checked;
    cacheSettings();
    writeSettingToDb('haptics', settings.haptics);
    if (settings.haptics) haptic('check');
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

  // Background refresh from server — overrides cache if newer values exist.
  loadSettingsFromDb();
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ══════════════════════════════════════
   HAPTICS
   Central helper — all vibration goes
   through haptic(type). Respects user
   setting + browser support.
   ══════════════════════════════════════ */
const HAPTIC_PATTERNS = {
  check:       { v: 10,                           p: 1, d: 0   },
  uncheck:     { v: 5,                            p: 1, d: 0   },
  tap:         { v: null,                         p: 1, d: 0   },
  goalReached: { v: [20, 50, 20, 50, 80],         p: 3, d: 80  },
  streakUp:    { v: [10, 40, 10, 40, 10, 40, 100],p: 4, d: 70  },
  error:       { v: [100, 50, 100],               p: 3, d: 100 },
};

/* Safari iOS 18+: toggling a [switch] checkbox triggers native haptic */
let _hapticSwitch = null;
function _safariPulse(n, delay) {
  if (!_hapticSwitch) {
    _hapticSwitch = document.createElement('input');
    _hapticSwitch.type = 'checkbox';
    _hapticSwitch.setAttribute('switch', '');
    _hapticSwitch.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:0;height:0';
    document.body.appendChild(_hapticSwitch);
  }
  if (n === 1) { _hapticSwitch.checked = !_hapticSwitch.checked; return; }
  for (let i = 0; i < n; i++) {
    setTimeout(() => { _hapticSwitch.checked = !_hapticSwitch.checked; }, i * delay);
  }
}

function haptic(type) {
  if (!settings.haptics) return;
  const h = HAPTIC_PATTERNS[type];
  if (!h) return;
  try {
    _safariPulse(h.p, h.d);
    if (navigator.vibrate && h.v != null) navigator.vibrate(h.v);
  } catch (e) { /* ignore */ }
}

// Initialise settings UI on next tick (after DOM is settled).
setTimeout(initSettingsUI, 0);

/* ── Date Strip ── */
// Window-offset: 0 means today is the rightmost pill, 4 means 4 days back, etc.
var dateStripOffset = 0;

