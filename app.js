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
let currentDayEntries = [];
let currentCheckedMap = {};
let currentDate = '';
let coachTargets = { training: {kcal:0,p:0,c:0,f:0}, rest: {kcal:0,p:0,c:0,f:0} };
let currentDayType = 'training';
let mergeServings = false;
let waterData = { drunk: null, goal: null };

// ── Init ──
const todayStr = new Date().toISOString().split('T')[0];
document.getElementById('dateInput').value = todayStr;
currentDate = todayStr;
renderDateStrip(todayStr);
document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
loadRecipes().then(() => loadDay());

/* ── Date Strip ── */
function renderDateStrip(selected) {
  const strip = document.getElementById('dateStrip');
  strip.innerHTML = '';
  const today = new Date();
  const days = [];
  for (let i = -6; i <= 2; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  days.forEach(d => {
    const iso = d.toISOString().split('T')[0];
    const pill = document.createElement('button');
    pill.className = 'date-pill';
    if (iso === todayStr) pill.classList.add('today');
    if (iso === selected) pill.classList.add('active');
    pill.innerHTML = `<div class="dp-dow">${DOW[d.getDay()]}</div><div class="dp-num">${d.getDate()}</div><div class="dp-mo">${MO[d.getMonth()]}</div>`;
    pill.onclick = () => {
      document.getElementById('dateInput').value = iso;
      renderDateStrip(iso);
      loadDay();
    };
    strip.appendChild(pill);
  });
  // scroll selected pill into center
  setTimeout(() => {
    const active = strip.querySelector('.active');
    if (active) {
      const off = active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2;
      strip.scrollTo({ left: off, behavior: 'smooth' });
    }
  }, 50);
}

function onDateChange() {
  const v = document.getElementById('dateInput').value;
  if (!v) return;
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
    db.from('fddb_day_type').upsert({ date: dateVal, type: 'training' }, { onConflict: 'date' });
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
    const off = circ * (1 - overallAdh / 100);
    ringFg.style.strokeDashoffset = off;
    ringFg.style.stroke = adherenceColor(overallAdh);
    ringVal.textContent = overallAdh + '%';
    ringVal.style.color = adherenceColor(overallAdh);
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

  const sorted = Object.keys(grouped).sort((a,b) => (ORDER.indexOf(a)<0?99:ORDER.indexOf(a))-(ORDER.indexOf(b)<0?99:ORDER.indexOf(b)));

  sorted.forEach((meal, mi) => {
    const items = grouped[meal];
    const mealKcal = items.reduce((s,i) => s+(i.kcal||0), 0);
    const card = document.createElement('div');
    card.className = 'meal-card';
    card.style.animationDelay = `${mi*0.05}s`;

    if (mergeServings) {
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
      `<div class="cat-chip${activeFilterCat===null?' active':''}" onclick="setFilterCat(null)">All</div>`,
      ...allCategories.map(c => `<div class="cat-chip${activeFilterCat===c.id?' active':''}" onclick="setFilterCat('${c.id}')">${c.name}</div>`),
      `<div class="cat-chip" style="background:rgba(94,166,255,.08);border-color:rgba(94,166,255,.3);color:var(--blue);font-size:.72rem" onclick="manageCategoriesPrompt()"><i class="fas fa-tags"></i> + Category</div>`
    ].join('');
  }
  const filtered = [...allRecipes].sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .filter(r => {
      if (activeFilterCat && !r.catIds.includes(activeFilterCat)) return false;
      if (!query) return true;
      return r.name.toLowerCase().includes(query) || r.items.some(i => i.toLowerCase().includes(query));
    });
  if (!allRecipes.length) { el.innerHTML = '<div class="empty-recipes"><i class="fas fa-book-open"></i>No recipes created yet</div>'; return; }
  if (!filtered.length) { el.innerHTML = '<div class="empty-recipes"><i class="fas fa-search"></i>No recipes found</div>'; return; }
  el.innerHTML = '';
  filtered.forEach(recipe => {
    const catNames = recipe.catIds.map(id => allCategories.find(c => c.id === id)?.name).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'recipe-manage-card';
    card.innerHTML = `
      <div class="recipe-manage-header" onclick="this.closest('.recipe-manage-card').classList.toggle('open')">
        <div style="flex:1;min-width:0">
          <div class="recipe-manage-name">${recipe.name}</div>
          ${catNames.length ? `<div class="recipe-cat-tags">${catNames.map(n=>`<span class="recipe-cat-tag">${n}</span>`).join('')}</div>` : ''}
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
    el.appendChild(card);
  });
}
function setFilterCat(id) { activeFilterCat = id; renderRecipeManage(); }
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
      { id:'t_kcal', label:'Calories (kcal)', val: t.kcal, color:'var(--orange)' },
      { id:'t_p', label:'Protein (g)', val: t.p, color:'var(--blue)' },
      { id:'t_c', label:'Carbs (g)', val: t.c, color:'var(--yellow)' },
      { id:'t_f', label:'Fat (g)', val: t.f, color:'var(--red)' },
    ].map(f => `
      <div class="edit-section" style="margin-bottom:12px">
        <div class="edit-section-title" style="color:${f.color}"><i class="fas fa-circle" style="font-size:.4rem"></i> ${f.label}</div>
        <input class="text-input" id="${f.id}" type="number" min="0" value="${f.val}" style="margin-bottom:0">
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
  const fmt = d => d.toISOString().split('T')[0];
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

async function loadStats() {
  const { from, to } = getStatsDateRange();
  if (!from || !to || from > to) return;
  document.getElementById('statsLoading').style.display = 'flex';
  document.getElementById('statsContent').style.display = 'none';
  document.getElementById('statsEmpty').style.display = 'none';

  const [macroRes, dayTypeRes, targetsRes] = await Promise.all([
    db.from('fddb_daily_macros').select('date, kcal, protein, carbs, fat').gte('date', from).lte('date', to),
    db.from('fddb_day_type').select('date, type').gte('date', from).lte('date', to),
    db.from('fddb_coach_targets').select('*').lte('valid_from', to).order('valid_from', { ascending: false }),
  ]);

  document.getElementById('statsLoading').style.display = 'none';
  const macros = macroRes.data || [];
  const dayTypes = dayTypeRes.data || [];
  const allTgts = targetsRes.data || [];
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
  function getTarget(date, type) {
    const match = allTgts.find(t => t.type === type && t.valid_from <= date);
    return match ? { kcal: match.kcal, p: match.protein, c: match.carbs, f: match.fat } : null;
  }

  const dates = Object.keys(byDate).sort();
  const dayData = dates.map(date => {
    const d = byDate[date];
    const type = dayTypeMap[date] || 'training';
    const tgt = getTarget(date, type);
    if (!tgt || (tgt.p === 0 && tgt.c === 0 && tgt.f === 0)) return { date, adh: null, p: null, c: null, f: null, devP: null, devC: null, devF: null };
    const rawP = tgt.p > 0 ? Math.round((d.p / tgt.p) * 100) : null;
    const rawC = tgt.c > 0 ? Math.round((d.c / tgt.c) * 100) : null;
    const rawF = tgt.f > 0 ? Math.round((d.f / tgt.f) * 100) : null;
    const pAdh = rawP !== null ? adherenceScore(rawP) : null;
    const cAdh = rawC !== null ? adherenceScore(rawC) : null;
    const fAdh = rawF !== null ? adherenceScore(rawF) : null;
    const valid = [pAdh, cAdh, fAdh].filter(v => v !== null);
    const adh = valid.length ? Math.round(valid.reduce((a,b) => a+b, 0) / valid.length) : null;
    const devP = rawP !== null ? rawP - 100 : null;
    const devC = rawC !== null ? rawC - 100 : null;
    const devF = rawF !== null ? rawF - 100 : null;
    const devAvg = tgt.kcal > 0 ? Math.round((d.kcal / tgt.kcal) * 100) - 100 : null;
    return { date, adh, p: pAdh, c: cAdh, f: fAdh, devP, devC, devF, devAvg };
  });

  const withAdh = dayData.filter(d => d.adh !== null);
  const avgAdh = withAdh.length ? Math.round(withAdh.reduce((s,d) => s+d.adh, 0) / withAdh.length) : null;
  const avgDevP = withAdh.filter(d=>d.devP!==null).length ? Math.round(withAdh.filter(d=>d.devP!==null).reduce((s,d)=>s+d.devP,0)/withAdh.filter(d=>d.devP!==null).length) : null;
  const avgDevC = withAdh.filter(d=>d.devC!==null).length ? Math.round(withAdh.filter(d=>d.devC!==null).reduce((s,d)=>s+d.devC,0)/withAdh.filter(d=>d.devC!==null).length) : null;
  const avgDevF = withAdh.filter(d=>d.devF!==null).length ? Math.round(withAdh.filter(d=>d.devF!==null).reduce((s,d)=>s+d.devF,0)/withAdh.filter(d=>d.devF!==null).length) : null;
  const trainingDays = dates.filter(d => (dayTypeMap[d] || 'training') === 'training').length;
  const restDays = dates.filter(d => dayTypeMap[d] === 'rest').length;

  const adhColor = avgAdh !== null ? adherenceColor(avgAdh) : 'var(--muted)';
  document.getElementById('statsSummary').innerHTML = `
    <div class="stats-summary-card" style="grid-column:1/-1">
      <div class="stats-summary-label">Ø Overall Adherence</div>
      <div class="stats-summary-val" style="color:${adhColor}">${avgAdh !== null ? avgAdh + '%' : '–'}</div>
      <div class="stats-summary-sub">${withAdh.length} of ${dates.length} days with target data</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-label">Training Days</div>
      <div class="stats-summary-val" style="color:var(--orange)">${trainingDays}</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-label">Rest Days</div>
      <div class="stats-summary-val" style="color:var(--blue)">${restDays}</div>
    </div>`;

  if (statsLineChart) { statsLineChart.destroy(); statsLineChart = null; }
  const lineCtx = document.getElementById('statsLineChart').getContext('2d');
  function devToColor(dev, alpha) {
    if (dev === null) return `rgba(90,90,90,${alpha})`;
    const score = adherenceScore(100 + dev);
    const base = adherenceColor(score);
    return base.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }
  const devValues = dayData.map(d => d.devAvg);
  const ptColors = dayData.map(d => devToColor(d.devAvg, 1));
  const maxAbs = Math.max(...devValues.filter(v=>v!==null).map(Math.abs), 5);
  const yBound = Math.max(10, Math.ceil(maxAbs / 5) * 5);

  statsLineChart = new Chart(lineCtx, {
    type: 'line',
    data: {
      labels: dayData.map(d => d.date.slice(5)),
      datasets: [{
        label: 'Deviation', data: devValues, borderWidth: 2,
        pointRadius: dayData.length > 30 ? 0 : 4,
        pointBackgroundColor: ptColors, pointBorderColor: 'transparent',
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
        tooltip: { callbacks: { label: ctx => ctx.raw !== null ? 'Dev: ' + (ctx.raw > 0 ? '+' : '') + ctx.raw + '%' : 'N/A' } }
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
      const typeIcon = dtype === 'training' ? `<i class="fas fa-dumbbell" style="font-size:.55rem;color:rgba(255,255,255,.5);margin-left:5px"></i>` : dtype === 'rest' ? `<i class="fas fa-bed" style="font-size:.55rem;color:rgba(255,255,255,.5);margin-left:5px"></i>` : '';
      const cell = document.createElement('div');
      cell.style.cssText = `background:${cellBg(a)};border-radius:8px;padding:12px 4px;text-align:center;display:flex;align-items:center;justify-content:center`;
      cell.innerHTML = `<div style="font-family:'Bebas Neue',sans-serif;font-size:1.15rem;color:${a!==null?'#fff':'#444'}">${a !== null ? a+'%' : '–'}</div>${typeIcon}`;
      cell.setAttribute('data-tip', `${d.date}: ${a !== null ? a + '%' : 'N/A'}`);
      cwGrid.appendChild(cell);
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
      const barColor = dtype === 'training' ? 'var(--orange)' : dtype === 'rest' ? 'var(--blue)' : null;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px;width:100%';
      if (i === 0 && offset > 0) wrapper.style.gridColumnStart = offset + 1 + '';
      const cell = document.createElement('div');
      cell.style.cssText = `border-radius:4px;background:${cellBg(a)};aspect-ratio:1;width:100%`;
      cell.setAttribute('data-tip', `${d.date}: ${a !== null ? a + '%' : 'N/A'}`);
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

  document.getElementById('statsContent').style.display = 'block';
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
