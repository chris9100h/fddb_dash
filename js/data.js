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
  haptic('tap');
  const fin = finalizedMap.get(date);
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(date + 'T00:00:00');
  const isFuture = d > today;
  const isToday = date === todayStr;
  const freezesUsed = freezesThisWeek(date) + (fin && fin.status === 'freeze' ? 1 : 0);

  // Compute adherence for current day to allow Finalize.
  let canFinalize = false, adhForFinalize = null;
  if (!isFuture) {
    const [macroRes, dtRes, tgtRes] = await Promise.all([
      db.from('fddb_daily_macros').select('protein, carbs, fat').eq('date', date),
      db.from('fddb_day_type').select('type').eq('date', date).maybeSingle(),
      db.from('fddb_coach_targets').select('*').lte('valid_from', date).order('valid_from', { ascending: false }),
    ]);
    const rows = macroRes.data || [];
    if (rows.length) {
      const totals = rows.reduce((s, r) => ({
        p: s.p + (parseFloat(r.protein)||0),
        c: s.c + (parseFloat(r.carbs)||0),
        f: s.f + (parseFloat(r.fat)||0),
      }), { p:0, c:0, f:0 });
      const type = (dtRes.data && dtRes.data.type) || 'training';
      const match = (tgtRes.data || []).find(t => t.type === type);
      if (match) {
        adhForFinalize = computeDayAdherence(totals, { p: match.protein, c: match.carbs, f: match.fat });
        canFinalize = adhForFinalize != null;
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
    () => manualFinalizeDay(date, adhForFinalize)
  ));

  // Freeze (2 per week, can be retroactive, NOT for future)
  menu.appendChild(item(
    'freeze', 'freeze', '<i class="fas fa-snowflake"></i>',
    'Freeze day',
    `${freezesUsed}/2 this week`,
    isFuture || freezesThisWeek(date) >= 2,
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

  const [macroRes, dayTypeRes, targetsRes, finalizedRes] = await Promise.all([
    db.from('fddb_daily_macros').select('date, kcal, protein, carbs, fat').gte('date', from).lte('date', to),
    db.from('fddb_day_type').select('date, type').gte('date', from).lte('date', to),
    db.from('fddb_coach_targets').select('*').lte('valid_from', to).order('valid_from', { ascending: false }),
    db.from('fddb_day_finalized').select('date, status').gte('date', from).lte('date', to),
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

  const adhColor = avgAdh !== null ? adherenceColor(avgAdh) : 'var(--muted)';
  document.getElementById('statsSummary').innerHTML = `
    <div class="stats-summary-card" style="grid-column:1/-1">
      <div class="stats-summary-label">Ø Overall Adherence</div>
      <div class="stats-summary-val" style="color:${adhColor}">${avgAdh !== null ? avgAdh + '%' : '–'}</div>
      <div class="stats-summary-sub">${withAdh.length} of ${dates.length} days counted${excludedDays > 0 ? ` · ${excludedDays} excluded (sick/freeze)` : ''}</div>
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
  const ptColors = dayData.map(d => {
    if (d.status === 'freeze') return 'rgba(96,165,250,1)';
    if (d.status === 'sick') return 'rgba(251,191,36,1)';
    return devToColor(d.devAvg, 1);
  });
  const ptStyles = dayData.map(d => d.status === 'freeze' ? 'rectRot' : d.status === 'sick' ? 'triangle' : 'circle');
  const ptRadii = dayData.map(d => (d.status === 'freeze' || d.status === 'sick') ? 6 : (dayData.length > 30 ? 0 : 4));
  const maxAbs = Math.max(...devValues.filter(v=>v!==null).map(Math.abs), 5);
  const yBound = Math.max(10, Math.ceil(maxAbs / 5) * 5);

  statsLineChart = new Chart(lineCtx, {
    type: 'line',
    data: {
      labels: dayData.map(d => d.date.slice(5)),
      datasets: [{
        label: 'Deviation', data: devValues, borderWidth: 2,
        pointRadius: ptRadii, pointStyle: ptStyles,
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
        tooltip: { callbacks: { label: ctx => {
          const d = dayData[ctx.dataIndex];
          const statusLabel = d && d.status === 'freeze' ? ' · Freeze ❄' : d && d.status === 'sick' ? ' · Sick 🤒' : '';
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
      const typeIcon = dtype === 'training' ? `<i class="fas fa-dumbbell" style="font-size:.55rem;color:rgba(255,255,255,.5);margin-left:5px"></i>` : dtype === 'rest' ? `<i class="fas fa-bed" style="font-size:.55rem;color:rgba(255,255,255,.5);margin-left:5px"></i>` : '';
      const cell = document.createElement('div');
      let bg = cellBg(a);
      if (status === 'freeze') bg = 'rgba(96,165,250,0.2)';
      else if (status === 'sick') bg = 'rgba(251,191,36,0.2)';
      cell.style.cssText = `background:${bg};border-radius:8px;padding:12px 4px;text-align:center;display:flex;align-items:center;justify-content:center`;
      let mainContent;
      if (status === 'freeze') {
        mainContent = `<i class="fas fa-snowflake" style="font-size:1.05rem;color:rgba(96,165,250,.9)"></i>`;
      } else if (status === 'sick') {
        mainContent = `<i class="fas fa-thermometer-half" style="font-size:1.05rem;color:rgba(251,191,36,.9)"></i>`;
      } else {
        mainContent = `<div style="font-family:'Bebas Neue',sans-serif;font-size:1.15rem;color:${a!==null?'#fff':'#444'}">${a !== null ? a+'%' : '–'}</div>`;
      }
      const tipText = status === 'freeze' ? `${d.date}: Freeze` : status === 'sick' ? `${d.date}: Sick` : `${d.date}: ${a !== null ? a + '%' : 'N/A'}`;
      cell.innerHTML = `${mainContent}${typeIcon}`;
      cell.setAttribute('data-tip', tipText);
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
      const status = d.status;
      const barColor = dtype === 'training' ? 'var(--orange)' : dtype === 'rest' ? 'var(--blue)' : null;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px;width:100%';
      if (i === 0 && offset > 0) wrapper.style.gridColumnStart = offset + 1 + '';
      const cell = document.createElement('div');
      let bg = cellBg(a);
      if (status === 'freeze') bg = 'rgba(96,165,250,0.25)';
      else if (status === 'sick') bg = 'rgba(251,191,36,0.25)';
      cell.style.cssText = `border-radius:4px;background:${bg};height:20px;width:100%;display:flex;align-items:center;justify-content:center;overflow:hidden`;
      const tipText = status === 'freeze' ? `${d.date}: Freeze` : status === 'sick' ? `${d.date}: Sick` : `${d.date}: ${a !== null ? a + '%' : 'N/A'}`;
      cell.setAttribute('data-tip', tipText);
      if (status === 'freeze') {
        cell.innerHTML = `<i class="fas fa-snowflake" style="font-size:.5rem;color:rgba(96,165,250,.9)"></i>`;
      } else if (status === 'sick') {
        cell.innerHTML = `<i class="fas fa-thermometer-half" style="font-size:.5rem;color:rgba(251,191,36,.9)"></i>`;
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
