// Business logic: pure, testable functions. No DOM, no storage.
// All dates are ISO "YYYY-MM-DD" strings (local calendar days).

export const SLOTS = ['lunch', 'snack', 'dinner'];
export const SLOT_LABEL = { lunch: 'Lunch', snack: 'Afternoon snack', dinner: 'Dinner' };
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_LABEL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
export const DAY_PL = { mon: 'Poniedziałek', tue: 'Wtorek', wed: 'Środa', thu: 'Czwartek', fri: 'Piątek', sat: 'Sobota', sun: 'Niedziela' };

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return toISO(d); };
export const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000); // b - a
export const mondayOf = s => { const d = parseISO(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return toISO(d); };
export const dayKeyOf = s => DAYS[(parseISO(s).getDay() + 6) % 7];
export const todayISO = () => toISO(new Date());
export const fmtDate = s => { if (!s) return ''; const d = parseISO(s); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

/* ---------- ingredient index & name normalisation ---------- */
export const normalizeName = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const EXTRA_ALIASES = {
  zucchini: ['courgette'], rocket: ['arugula'], 'chicken-breast': ['chicken', 'kurczak'], 'turkey-breast': ['turkey', 'indyk'],
  eggs: ['egg', 'jajka', 'jajko', 'jaja'], potatoes: ['potato', 'ziemniak'], carrot: ['carrots', 'marchewka'], tomato: ['tomatoes', 'pomidory'],
  banana: ['bananas', 'banany'], blueberries: ['blueberry', 'borowki'], 'spelt-sourdough': ['bread', 'spelt bread', 'chleb'], 'white-rice': ['rice', 'ryz'],
  oats: ['oat flakes', 'porridge oats', 'platki owsiane'], 'lf-yogurt': ['yoghurt lactose free', 'lactose free yogurt'], cucumber: ['cucumbers'],
  'olive-oil': ['olive oil', 'oliwa'], salmon: ['losos'], cod: ['dorsz'], millet: ['kasza jaglana', 'millet groats'], 'peanut-butter': ['pb'],
};

export function makeIndex(data) {
  const byId = {}; const alias = {};
  for (const ing of data.ingredients) {
    byId[ing.id] = ing;
    const names = [ing.en, ing.id.replace(/-/g, ' '), ...(ing.pl || []), ...(EXTRA_ALIASES[ing.id] || [])];
    for (const n of names) { const k = normalizeName(n); if (k && !alias[k]) alias[k] = ing.id; }
  }
  const mealById = {}; for (const m of data.meals) mealById[m.id] = m;
  const stepById = {}; for (const s of data.protocol.steps) stepById[s.id] = s;
  return { byId, alias, mealById, stepById };
}

export function resolveIngredient(index, text) {
  const k = normalizeName(text);
  if (!k) return null;
  if (index.alias[k]) return index.alias[k];
  const sing = k.replace(/(es|s)$/, '');
  if (index.alias[sing]) return index.alias[sing];
  // best partial match: alias that starts with / contains the query (shortest wins)
  let best = null;
  for (const a in index.alias) {
    if (a.startsWith(k) || (k.length > 3 && a.includes(k))) { if (!best || a.length < best.length) best = a; }
  }
  return best ? index.alias[best] : null;
}

// "chicken breast 400g, carrots 300 g, eggs 6" -> [{text, id, qty, unit}]
export function parseQuickAdd(index, text) {
  return text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(raw => {
    const m = raw.match(/^(.*?)(?:\s+(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|pcs|szt|x)?)?$/i);
    let name = (m && m[1]) || raw; let qty = m && m[2] ? parseFloat(m[2].replace(',', '.')) : null; let unit = (m && m[3] || '').toLowerCase();
    if (unit === 'kg') { qty *= 1000; unit = 'g'; } else if (unit === 'l') { qty *= 1000; unit = 'ml'; } else if (unit === 'szt' || unit === 'x') unit = 'pcs';
    if (qty != null && !unit) unit = 'pcs';
    return { text: raw, name: name.trim(), id: resolveIngredient(index, name), qty, unit: unit || 'g' };
  });
}

/* ---------- dietary compatibility (gluten-, dairy-, soy-free) ---------- */
const DIET_REASON = { G: 'gluten', D: 'dairy', S: 'soy' };
export function dietAssess(meal, index, settings) {
  const conflicts = []; const checks = [];
  const s = settings || { glutenFree: true, dairyFree: true, soyFree: true };
  for (const ri of meal.ingredients) {
    const ing = index.byId[ri.id]; if (!ing) continue; const f = ing.diet || '';
    if (s.glutenFree && f.includes('G')) conflicts.push({ id: ing.id, en: ing.en, reason: 'gluten' });
    if (ing.unknown) checks.push({ id: ing.id, en: ing.en, reason: 'unknown ingredient' });
    else if (s.glutenFree && f.includes('g')) checks.push({ id: ing.id, en: ing.en, reason: 'gluten-free label' });
    if (s.dairyFree && f.includes('D')) conflicts.push({ id: ing.id, en: ing.en, reason: 'dairy' });
    else if (s.dairyFree && f.includes('d')) checks.push({ id: ing.id, en: ing.en, reason: 'dairy-free label' });
    if (s.soyFree && f.includes('S')) conflicts.push({ id: ing.id, en: ing.en, reason: 'soy' });
    else if (s.soyFree && f.includes('s')) checks.push({ id: ing.id, en: ing.en, reason: 'soy-free label' });
  }
  const reasons = [...new Set(conflicts.map(c => c.reason))];
  const status = conflicts.length ? 'conflict' : checks.length ? 'check' : 'ok';
  const label = status === 'ok' ? 'Fits your diet' : status === 'check' ? 'Check labels' : 'Contains ' + reasons.join(', ');
  return { status, label, conflicts, checks, reasons };
}

/* ---------- FODMAP ---------- */
export const categoryGroup = (data, cat) => data.protocol.categories[cat] && data.protocol.categories[cat].group;

export function fodmapExposures(meal, index) {
  const out = [];
  for (const ri of meal.ingredients) {
    const ing = index.byId[ri.id]; if (!ing) continue;
    if (ing.groups) {
      if (ing.id === 'banana' && ri.variant === 'green') continue; // green banana per Plan 3
      for (const g of ing.groups) out.push({ id: ing.id, en: ing.en, group: g, certainty: ing.certainty || 'listed', note: ing.fodmapNote });
    } else if (ing.labelCheck) out.push({ id: ing.id, en: ing.en, group: null, certainty: 'label', note: ing.fodmapNote || 'Composition not stated in your documents — check the label.' });
  }
  return out;
}

const RANK = { ok: 0, review: 1, incidental: 2, conflict: 3 };
// ctx: { activeStep, testedIds:Set|array, data }
export function fodmapAssess(meal, index, data, ctx = {}) {
  const tested = new Set(ctx.testedIds || []);
  const notes = []; let status = 'ok';
  const bump = (s, n) => { if (RANK[s] > RANK[status]) status = s; notes.push({ level: s, text: n }); };
  const active = ctx.activeStep || null;
  const activeGroup = active ? categoryGroup(data, active.category) : null;
  for (const e of fodmapExposures(meal, index)) {
    if (e.certainty === 'label') { bump('review', `${e.en}: ${e.note}`); continue; }
    if (tested.has(e.id) && !(active && active.ingredientIds.includes(e.id))) { bump('conflict', `${e.en} was tested earlier. Per your plan, tested foods stay out until reintroduction ends.`); continue; }
    const firm = e.certainty === 'listed';
    if (active && e.group === activeGroup) {
      if (active.ingredientIds.includes(e.id)) bump('incidental', `${e.en} is this week\u2019s challenge food. Here it is an incidental exposure, not the prescribed dose.`);
      else bump(firm ? 'incidental' : 'review', `${e.en} is in the ${e.group} group being tested this week — extra, non-prescribed exposure.${e.note ? ' ' + e.note : ''}`);
    } else if (active) {
      bump(firm ? 'conflict' : 'review', `${e.en} is listed under ${e.group}, a different group from this week\u2019s ${data.protocol.categories[active.category].label} challenge.${e.note ? ' ' + e.note : ''}`);
    } else {
      bump(firm ? 'conflict' : 'review', `${e.en} is listed as a ${e.group} challenge food — keep it out of the elimination diet.${e.note ? ' ' + e.note : ''}`);
    }
  }
  // Dietitian's recommendations table: not-recommended foods, portion limits, stacking of moderate foods.
  const servings = meal.servings || 1; let moderate = [];
  for (const ri of meal.ingredients) {
    const ing = index.byId[ri.id]; if (!ing) continue;
    if (ing.unknown) bump('review', `${ing.en} isn’t in your documents’ ingredient list — diet and FODMAP status unknown.`);
    if (ing.table === 'avoid' && !ing.groups) bump(ing.inPlans ? 'review' : 'conflict', ing.tableNote || `${ing.en} is in the not-recommended column of your recommendations.`);
    if (ing.table === 'conflict' && !ing.groups) bump('review', ing.tableNote);
    if (ing.tableLabel) bump('review', ing.tableNote);
    if (ing.table === 'mod') moderate.push(ing.en);
    if (ing.portion) {
      const per = Math.round(ri.g / servings);
      if (per >= ing.portion.high) { bump('review', `${per} g ${ing.en.toLowerCase()} per portion — your recommendations class ${ing.portion.high} g as high-FODMAP (${ing.portion.low} g is low).`); moderate.push(ing.en); }
      else if (per > ing.portion.low) { bump('review', `${per} g ${ing.en.toLowerCase()} per portion — above the ${ing.portion.low} g low-FODMAP portion in your recommendations.`); moderate.push(ing.en); }
    }
  }
  moderate = [...new Set(moderate)];
  if (moderate.length >= 2) bump('review', `Several moderate-FODMAP foods in one meal (${moderate.join(', ').toLowerCase()}). Your recommendations advise against stacking them.`);
  const label = { ok: 'Low-FODMAP per your plan', review: 'FODMAP review', incidental: 'Challenge exposure', conflict: 'FODMAP conflict' }[status];
  return { status, label, notes, moderate };
}

export function plantVariety(week, index) {
  const ids = new Set();
  for (const e of weekEntries(week)) { const m = index.mealById[e.mealId]; if (!m) continue; for (const i of m.ingredients) { const c = (index.byId[i.id] || {}).cat; if (['produce', 'grains', 'nuts', 'bread'].includes(c)) ids.add(i.id); } }
  return ids.size;
}

// Psyllium schedule from the recommendations document.
export function psylliumDose(start, today) {
  if (!start) return null; const day = diffDays(start, today) + 1;
  if (day < 1) return { day, text: 'Not started yet' };
  if (day <= 5) return { day, text: '3 g once a day' };
  if (day <= 10) return { day, text: '4–5 g once a day, if 3 g was well tolerated' };
  return { day, text: 'If still needed, gradually up to about 5 g twice a day' };
}

/* ---------- pantry availability ---------- */
export function pantryMap(pantry) { const m = {}; for (const p of pantry) m[p.id] = p; return m; }
export const isExpiringSoon = (p, today, days = 3) => p && p.expires && diffDays(today, p.expires) <= days;

export function availability(meal, pantry, scale = 1) {
  const pm = Array.isArray(pantry) ? pantryMap(pantry) : pantry;
  const items = []; let missing = 0;
  for (const ri of meal.ingredients) {
    if (ri.id === 'water') continue;
    const need = Math.round(ri.g * scale * 10) / 10;
    const p = pm[ri.id];
    let status;
    if (!p) status = 'missing';
    else if (p.qty == null) status = 'have';
    else if (p.unit === 'pcs') status = 'have-uncounted';
    else status = p.qty >= need ? 'have' : 'short';
    if ((status === 'missing' || status === 'short') && !ri.optional) missing++;
    items.push({ id: ri.id, orig: ri.orig, need, status, haveQty: p ? p.qty : null, unit: p ? p.unit : 'g', optional: !!ri.optional });
  }
  const required = items.filter(i => !i.optional);
  const haveCount = required.filter(i => i.status !== 'missing' && i.status !== 'short').length;
  return { items, missingCount: missing, haveCount, total: required.length, canMake: missing === 0, coverage: required.length ? haveCount / required.length : 0 };
}

/* ---------- discovery ranking ---------- */
export function cookingTimeHints(meal) {
  const out = []; const re = /(\d+(?:[–-]\d+)?)\s*(minut|min|godzin)/gi; let m;
  while ((m = re.exec(meal.instructions))) out.push(m[1] + (m[2].startsWith('godz') ? ' h' : ' min'));
  return out;
}

// opts: { pantry, today, settings, fodmapCtx, mode:'now'|'almost'|'all', slot, maxTime, minProtein, q, dietOnly, prepTimes }
export function rankMeals(data, index, opts) {
  const pm = pantryMap(opts.pantry || []); const today = opts.today || todayISO();
  const q = normalizeName(opts.q || '');
  const res = [];
  for (const meal of data.meals) {
    if (opts.slot && opts.slot !== 'all' && meal.slot !== opts.slot) continue;
    if (q) {
      const hay = normalizeName([meal.nameEn, meal.namePl, ...meal.ingredients.map(i => (index.byId[i.id] || {}).en + ' ' + i.orig)].join(' '));
      if (!hay.includes(q)) continue;
    }
    const prep = (opts.prepTimes || {})[meal.id];
    if (opts.maxTime && (prep == null || prep > opts.maxTime)) continue;
    if (opts.minProtein && meal.nutrition.protein < opts.minProtein) continue;
    const avail = availability(meal, pm, 1 / (meal.servings || 1));
    if (opts.mode === 'now' && !avail.canMake) continue;
    if (opts.mode === 'almost' && (avail.canMake || avail.missingCount > 2)) continue;
    const diet = dietAssess(meal, index, opts.settings);
    if (opts.dietOnly && diet.status === 'conflict') continue;
    const fod = fodmapAssess(meal, index, data, opts.fodmapCtx || {});
    const reasons = []; let score = 0;
    if (avail.canMake) { score += 1000; reasons.push('You have every required ingredient'); }
    else reasons.push(`Missing ${avail.missingCount} of ${avail.total}`);
    const expiring = avail.items.filter(i => i.status !== 'missing' && isExpiringSoon(pm[i.id], today)).map(i => ({ id: i.id, days: diffDays(today, pm[i.id].expires) }));
    if (expiring.length) {
      score += expiring.reduce((s, e) => s + Math.max(10, 60 - e.days * 15), 0);
      reasons.push('Uses ' + expiring.map(e => `${(index.byId[e.id] || {}).en.toLowerCase()} (${e.days <= 0 ? 'expires today' : e.days === 1 ? '1 day left' : e.days + ' days left'})`).join(', '));
    }
    score += Math.round(avail.coverage * 100);
    if (!avail.canMake && avail.coverage >= 0.7) reasons.push(`Uses ${avail.haveCount} ingredients you have`);
    if (fod.status === 'ok') { score += 30; reasons.push(opts.fodmapCtx && opts.fodmapCtx.activeStep ? 'Fits this challenge week' : 'Fits your current phase'); }
    if (fod.status === 'conflict') score -= 500;
    res.push({ meal, avail, diet, fod, reasons, score, expiring });
  }
  res.sort((a, b) => b.score - a.score || b.meal.nutrition.protein - a.meal.nutrition.protein);
  return res;
}

/* ---------- planner ---------- */
export const emptyWeek = () => Object.fromEntries(DAYS.map(d => [d, { lunch: null, snack: null, dinner: null }]));
export function weekEntries(week) { const out = []; for (const d of DAYS) for (const s of SLOTS) if (week[d] && week[d][s]) out.push({ day: d, slot: s, ...week[d][s] }); return out; }

// Returns { week, overwrites:[{day,slot}] }. With confirm=false and overwrites, week is unchanged.
export function applyTemplate(week, data, planId, { confirm = false } = {}) {
  const next = JSON.parse(JSON.stringify(week)); const overwrites = [];
  for (const m of data.meals.filter(m => m.plan === planId)) {
    const cur = next[m.day][m.slot];
    if (cur && cur.mealId !== m.id) overwrites.push({ day: m.day, slot: m.slot });
    next[m.day][m.slot] = { mealId: m.id, servings: 1 };
  }
  if (overwrites.length && !confirm) return { week, overwrites, applied: false };
  return { week: next, overwrites, applied: true };
}
export function assignSlot(week, day, slot, mealId, { confirm = false } = {}) {
  const cur = week[day][slot];
  if (cur && cur.mealId !== mealId && !confirm) return { week, overwrite: true, applied: false };
  const next = JSON.parse(JSON.stringify(week)); next[day][slot] = mealId ? { mealId, servings: (cur && cur.servings) || 1 } : null;
  return { week: next, applied: true };
}
export function moveSlot(week, from, to, { confirm = false } = {}) {
  const src = week[from.day][from.slot]; if (!src) return { week, applied: false };
  const dst = week[to.day][to.slot];
  if (dst && !confirm) return { week, overwrite: true, applied: false };
  const next = JSON.parse(JSON.stringify(week)); next[to.day][to.slot] = src; next[from.day][from.slot] = null;
  return { week: next, applied: true };
}
export function duplicateSlot(week, from, toDays, { confirm = false } = {}) {
  const src = week[from.day][from.slot]; if (!src) return { week, applied: false };
  const overwrites = toDays.filter(d => week[d][from.slot] && week[d][from.slot].mealId !== src.mealId);
  if (overwrites.length && !confirm) return { week, overwrites, applied: false };
  const next = JSON.parse(JSON.stringify(week)); for (const d of toDays) next[d][from.slot] = { ...src };
  return { week: next, applied: true, overwrites };
}

/* ---------- shopping list ---------- */
export function buildShopping(week, index, pantry, today) {
  const pm = pantryMap(pantry); const agg = {};
  for (const e of weekEntries(week)) {
    const meal = index.mealById[e.mealId]; if (!meal) continue;
    const scale = (e.servings || 1) / (meal.servings || 1);
    for (const ri of meal.ingredients) {
      if (ri.id === 'water') continue;
      const a = agg[ri.id] || (agg[ri.id] = { id: ri.id, need: 0, meals: [] });
      a.need += ri.g * scale; if (!a.meals.includes(meal.nameEn)) a.meals.push(meal.nameEn);
    }
  }
  const toBuy = []; const covered = [];
  for (const id in agg) {
    const a = agg[id]; a.need = Math.round(a.need); const p = pm[id];
    let have = 0, comparable = true;
    if (p) { if (p.qty == null) have = Infinity; else if (p.unit === 'pcs') comparable = false; else have = p.qty; }
    const row = { ...a, en: (index.byId[id] || {}).en || id, cat: (index.byId[id] || {}).cat || 'other', have, comparable, expiringSoon: isExpiringSoon(p, today) };
    if (!comparable) { row.buy = null; row.note = 'Pantry counted in pieces — check manually'; toBuy.push(row); }
    else if (have >= a.need) covered.push(row);
    else { row.buy = Math.ceil(a.need - have); toBuy.push(row); }
  }
  toBuy.sort((a, b) => a.cat.localeCompare(b.cat) || a.en.localeCompare(b.en));
  return { toBuy, covered };
}
export function unusedPantry(week, index, pantry) {
  const used = new Set(); for (const e of weekEntries(week)) { const m = index.mealById[e.mealId]; if (m) m.ingredients.forEach(i => used.add(i.id)); }
  return pantry.filter(p => !p.staple && !used.has(p.id));
}

/* ---------- FODMAP reintroduction state machine ----------
 progress = { phase, confirmed:{stepId:true}, doseChoice:{stepId:'table'|'recipe'}, steps:{ [id]: StepState } }
 StepState = { status:'pending'|'scheduled'|'washout'|'stopped'|'done'|'skipped', weekStart, days:{1:{date,level}}, outcome, reviewedAt, skipReason, settled, history:[] }
*/
export function initProgress(data) {
  const steps = {}; for (const s of data.protocol.steps) steps[s.id] = { status: 'pending', days: {}, history: [] };
  return { phase: 'elimination', confirmed: {}, doseChoice: {}, steps };
}
const CLOSED = ['done', 'skipped'];
export const stepWindow = st => st && st.weekStart ? { start: st.weekStart, end: addDays(st.weekStart, 6) } : null;
const overlaps = (a, b) => !(diffDays(a.end, b.start) > 0 || diffDays(b.end, a.start) > 0);

export function getDose(data, stepId, day, progress) {
  const step = data.protocol.steps.find(s => s.id === stepId); if (!step) return null;
  if (day === 4) return { text: step.day4, amount: null, unit: null, optional: true };
  if (day < 1 || day > 3) return null;
  if (step.doseConflict && progress && progress.doseChoice[stepId] === 'recipe') return { text: step.altDoses[day - 1].text, amount: null, unit: null, source: 'recipe' };
  const d = step.doses[day - 1]; return { ...d, source: 'table' };
}

export function currentStep(data, progress) {
  for (const s of data.protocol.steps) { const st = progress.steps[s.id]; if (!CLOSED.includes(st.status)) return { step: s, state: st }; }
  return null;
}
export function activeChallengeOn(data, progress, date) {
  for (const s of data.protocol.steps) {
    const st = progress.steps[s.id]; const w = stepWindow(st);
    if (w && ['scheduled', 'washout', 'stopped'].includes(st.status) && diffDays(w.start, date) >= 0 && diffDays(date, w.end) >= 0) return { step: s, state: st };
  }
  return null;
}
export function testedIngredientIds(data, progress, exceptStepId) {
  const ids = [];
  for (const s of data.protocol.steps) { const st = progress.steps[s.id]; if (s.id !== exceptStepId && (st.status === 'done' || Object.keys(st.days).length)) ids.push(...s.ingredientIds); }
  return ids;
}
const lastDay = st => { const ks = Object.keys(st.days).map(Number).sort((a, b) => b - a); return ks.length ? { n: ks[0], ...st.days[ks[0]] } : null; };

export function washoutStatus(st, today) {
  const ld = lastDay(st); if (!ld) return null;
  const levels = Object.values(st.days).map(d => d.level);
  const minDays = levels.includes('severe') ? 2 : levels.includes('acceptable') ? 3 : 2;
  const end = addDays(ld.date, minDays);
  const left = diffDays(today, end) + 1;
  const needsSettled = st.status === 'stopped';
  return { start: addDays(ld.date, 1), end, minDays, daysLeft: Math.max(0, left), complete: left <= 0 && (!needsSettled || !!st.settled), needsSettled };
}

export function scheduleStep(data, progress, stepId, weekStart, today) {
  const step = data.protocol.steps.find(s => s.id === stepId);
  if (!step) return { ok: false, reason: 'Unknown challenge.' };
  const st = progress.steps[stepId];
  if (st.status !== 'pending') return { ok: false, reason: `${step.product} is already ${st.status}.` };
  if (step.needsConfirm && !progress.confirmed[stepId]) return { ok: false, reason: `Confirm or skip ${step.product} first. ${step.needsConfirm}` };
  if (step.doseConflict && !progress.doseChoice[stepId]) return { ok: false, reason: `Choose which dose source to follow for ${step.product}. ${step.doseConflict}` };
  const isFirst = data.protocol.steps.every(s => s.id === stepId || progress.steps[s.id].status === 'pending' || progress.steps[s.id].status === 'skipped') && progress.phase === 'elimination';
  if (isFirst) {
    if (!progress.eliminationStart) return { ok: false, reason: 'Enter when your elimination phase started. Your recommendations ask for at least 14 days of symptom monitoring first.' };
    const days = diffDays(progress.eliminationStart, weekStart);
    if (days < 14) return { ok: false, reason: `Your recommendations ask for at least 14 days of elimination with symptom monitoring. The earliest start is ${fmtDate(addDays(progress.eliminationStart, 14))}.` };
    if (!progress.reliefConfirmed) return { ok: false, reason: 'Confirm that your symptoms have eased satisfactorily on the elimination diet. Your recommendations say to move on only then.' };
  }
  const cur = currentStep(data, progress);
  if (!cur || cur.step.id !== stepId) {
    const prev = cur ? cur.step : null;
    return { ok: false, reason: prev ? `${prev.product} (${data.protocol.categories[prev.category].label}) must be completed and reviewed first. The order follows your plan.` : 'All challenges are closed.' };
  }
  const win = { start: weekStart, end: addDays(weekStart, 6) };
  for (const s of data.protocol.steps) {
    if (s.id === stepId) continue; const o = progress.steps[s.id]; const w = stepWindow(o);
    if (w && o.status !== 'skipped' && overlaps(win, w)) {
      const sameGroup = categoryGroup(data, s.category) === categoryGroup(data, step.category);
      return { ok: false, reason: `The week of ${fmtDate(win.start)} overlaps the ${data.protocol.categories[s.category].label} challenge (${s.product}, ${fmtDate(w.start)}–${fmtDate(w.end)}). ${sameGroup ? 'Only one challenge food per week.' : 'Only one FODMAP group can be challenged per week.'}` };
    }
    if (o.status !== 'skipped' && Object.keys(o.days).length) {
      const wo = washoutStatus(o, today || weekStart);
      if (wo && diffDays(wo.end, weekStart) <= 0) return { ok: false, reason: `The washout after ${s.product} runs until ${fmtDate(wo.end)}. The next challenge can start on ${fmtDate(addDays(wo.end, 1))} at the earliest.` };
    }
  }
  const next = JSON.parse(JSON.stringify(progress));
  next.steps[stepId] = { ...st, status: 'scheduled', weekStart, days: {} };
  next.phase = 'reintroduction';
  return { ok: true, progress: next };
}

// level: 'none' | 'acceptable' | 'severe'
export function logChallengeDay(data, progress, stepId, day, date, level) {
  const step = data.protocol.steps.find(s => s.id === stepId); const st = progress.steps[stepId];
  if (!step || !st) return { ok: false, reason: 'Unknown challenge.' };
  if (st.status !== 'scheduled') return { ok: false, reason: st.status === 'stopped' ? 'Testing was stopped after strong symptoms. Review the outcome before continuing.' : `This challenge is ${st.status}; challenge days can’t be logged.` };
  const w = stepWindow(st);
  if (diffDays(w.start, date) < 0 || diffDays(date, w.end) < 0) return { ok: false, reason: `Challenge days must stay within the assigned week (${fmtDate(w.start)}–${fmtDate(w.end)}).` };
  const ld = lastDay(st); const expected = ld ? ld.n + 1 : 1;
  if (day !== expected) return { ok: false, reason: `Log day ${expected} next.` };
  if (day > 4) return { ok: false, reason: 'Your plan has at most 4 challenge days.' };
  if (ld && diffDays(ld.date, date) !== 1) return { ok: false, reason: `Challenge days run on consecutive days ("3/4 days in a row"). Day ${day} should be ${fmtDate(addDays(ld.date, 1))}.` };
  if (day === 1 && diffDays(date, w.end) < 2) return { ok: false, reason: 'Day 1 is too late in the week to fit three challenge days.' };
  const next = JSON.parse(JSON.stringify(progress)); const ns = next.steps[stepId];
  ns.days[day] = { date, level, dose: getDose(data, stepId, day, progress).text };
  let guidance;
  if (level === 'severe') { ns.status = 'stopped'; guidance = 'Stop testing. Follow the elimination diet for 2 days. When symptoms settle, review: repeat with a smaller portion or with a day’s gap, or exclude and retest later.'; }
  else if (day >= 3) { ns.status = day === 4 ? 'washout' : 'scheduled'; guidance = day === 3 ? 'Day 3 done. Log an optional day 4 only if your usual portion is larger than day 3 — otherwise end the challenge days and start the washout.' : 'Challenge days complete. Washout: back to the full elimination diet.'; }
  else if (level === 'acceptable') guidance = 'Don’t increase the portion. Your plan says to test a different food from the same group the next day — check with your dietitian which one.';
  else guidance = `Increase to the day ${day + 1} portion: ${getDose(data, stepId, day + 1, progress).text}.`;
  if (level === 'acceptable') ns.hold = true;
  return { ok: true, progress: next, guidance };
}
export function endChallengeDays(data, progress, stepId) {
  const st = progress.steps[stepId]; const ld = lastDay(st);
  if (st.status !== 'scheduled' || !ld || ld.n < 3) return { ok: false, reason: 'Finish day 3 first.' };
  const next = JSON.parse(JSON.stringify(progress)); next.steps[stepId].status = 'washout'; return { ok: true, progress: next };
}
export function markSettled(progress, stepId) { const next = JSON.parse(JSON.stringify(progress)); next.steps[stepId].settled = true; return next; }

// outcome: 'tolerated' | 'limit' | 'not-tolerated' | 'repeat' | 'incomplete'
export function reviewStep(data, progress, stepId, outcome, today, note) {
  const step = data.protocol.steps.find(s => s.id === stepId); const st = progress.steps[stepId];
  if (!['washout', 'stopped', 'scheduled'].includes(st.status)) return { ok: false, reason: 'Nothing to review yet.' };
  if (st.status === 'scheduled' && outcome !== 'incomplete') return { ok: false, reason: 'Finish the challenge days or mark the test incomplete.' };
  if (st.status !== 'scheduled') {
    const wo = washoutStatus(st, today);
    if (wo && !wo.complete) return { ok: false, reason: wo.needsSettled && wo.daysLeft === 0 ? 'Confirm your symptoms have settled before reviewing.' : `Washout isn’t finished — ${wo.daysLeft} day${wo.daysLeft === 1 ? '' : 's'} left (until ${fmtDate(wo.end)}).` };
  }
  if (st.status === 'stopped' && (outcome === 'tolerated' || outcome === 'limit')) return { ok: false, reason: 'After strong symptoms your plan says to repeat with a smaller portion or a day’s gap, or exclude and retest later.' };
  const next = JSON.parse(JSON.stringify(progress)); const ns = next.steps[stepId];
  ns.history.push({ weekStart: st.weekStart, days: st.days, outcome, note: note || '', at: today });
  if (outcome === 'repeat' || outcome === 'incomplete') { Object.assign(ns, { status: 'pending', weekStart: null, days: {}, settled: false, hold: false }); return { ok: true, progress: next, advanced: false }; }
  Object.assign(ns, { status: 'done', outcome, reviewedAt: today, note: note || '' });
  if (outcome === 'not-tolerated') ns.retestAfter = addDays(today, 90);
  if (!currentStep(data, next)) next.phase = 'complete';
  return { ok: true, progress: next, advanced: true };
}
export function skipStep(data, progress, stepId, reason) {
  const st = progress.steps[stepId];
  if (!reason || reason.trim().length < 3) return { ok: false, reason: 'Add a short reason for skipping (e.g. agreed with dietitian).' };
  if (st.status !== 'pending') return { ok: false, reason: 'Only challenges that haven’t started can be skipped.' };
  const next = JSON.parse(JSON.stringify(progress)); Object.assign(next.steps[stepId], { status: 'skipped', skipReason: reason.trim() });
  if (!currentStep(data, next)) next.phase = 'complete';
  return { ok: true, progress: next };
}
// Back-fill a challenge that already happened. days: [{day, date, level, amount}] in order.
export function recordPastChallenge(data, progress, stepId, rec, today) {
  const step = data.protocol.steps.find(s => s.id === stepId); const st = progress.steps[stepId];
  if (!step || !st) return { ok: false, reason: 'Unknown challenge.' };
  if (st.status !== 'pending') return { ok: false, reason: `${step.product} already has a ${STATUS_LABEL_E[st.status] || st.status} record.` };
  const { weekStart, outcome } = rec; const days = (rec.days || []).filter(d => d && d.level);
  if (!weekStart) return { ok: false, reason: 'Enter the date the challenge week started.' };
  if (!days.length) return { ok: false, reason: 'Record at least day 1.' };
  const end = addDays(weekStart, 6);
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.day !== i + 1) return { ok: false, reason: `Days must be recorded in order — day ${i + 1} is missing.` };
    if (!d.date) return { ok: false, reason: `Enter the date for day ${d.day}.` };
    if (diffDays(today, d.date) > 0) return { ok: false, reason: `Day ${d.day} is in the future. Use “Schedule week” for upcoming challenges.` };
    if (diffDays(weekStart, d.date) < 0 || diffDays(d.date, end) < 0) return { ok: false, reason: `Day ${d.day} (${fmtDate(d.date)}) is outside the challenge week ${fmtDate(weekStart)}–${fmtDate(end)}.` };
    if (i > 0 && diffDays(days[i - 1].date, d.date) !== 1) return { ok: false, reason: `Challenge days run on consecutive days — day ${d.day} should be ${fmtDate(addDays(days[i - 1].date, 1))}.` };
  }
  const severe = days.some(d => d.level === 'severe');
  if (!['tolerated', 'limit', 'not-tolerated', 'incomplete'].includes(outcome)) return { ok: false, reason: 'Choose the outcome you and your dietitian agreed on.' };
  if (severe && outcome === 'tolerated') return { ok: false, reason: 'You recorded strong symptoms on at least one day. Choose “tolerated up to a portion”, not tolerated, or incomplete.' };
  if ((outcome === 'tolerated' || outcome === 'limit') && days.length < 3) return { ok: false, reason: 'A tolerated result needs all three challenge days. Use incomplete if you stopped early.' };
  const win = { start: weekStart, end };
  for (const s of data.protocol.steps) {
    if (s.id === stepId) continue; const o = progress.steps[s.id]; const w = stepWindow(o);
    if (w && o.status !== 'skipped' && overlaps(win, w)) return { ok: false, reason: `That week overlaps the ${data.protocol.categories[s.category].label} challenge (${s.product}, ${fmtDate(w.start)}–${fmtDate(w.end)}). Only one FODMAP group per week.` };
  }
  const next = JSON.parse(JSON.stringify(progress)); const ns = next.steps[stepId];
  const dayMap = {}; for (const d of days) dayMap[d.day] = { date: d.date, level: d.level, dose: (d.amount && d.amount.trim()) || (getDose(data, stepId, d.day, progress) || {}).text };
  const last = days[days.length - 1].date;
  if (outcome === 'incomplete') {
    ns.history.push({ weekStart, days: dayMap, outcome, note: rec.note || '', at: today, recordedPast: true });
    return { ok: true, progress: next, note: 'Saved as an incomplete attempt. The challenge stays open to run again.' };
  }
  Object.assign(ns, { status: 'done', weekStart, days: dayMap, outcome, note: rec.note || '', reviewedAt: today, recordedPast: true, settled: true });
  if (outcome === 'not-tolerated') ns.retestAfter = addDays(last, 90);
  if (next.phase === 'elimination') next.phase = 'reintroduction';
  if (!currentStep(data, next)) next.phase = 'complete';
  return { ok: true, progress: next };
}
export function undoPastRecord(progress, stepId) {
  const st = progress.steps[stepId]; if (!st || !st.recordedPast) return { ok: false, reason: 'Only back-filled records can be removed.' };
  const next = JSON.parse(JSON.stringify(progress));
  next.steps[stepId] = { status: 'pending', days: {}, history: st.history || [] };
  return { ok: true, progress: next };
}
// Any challenge (running or finished) whose week contains the date — used to link diary entries.
export function challengeForDate(data, progress, date) {
  for (const s of data.protocol.steps) {
    const st = progress.steps[s.id]; const w = stepWindow(st);
    if (w && st.status !== 'skipped' && diffDays(w.start, date) >= 0 && diffDays(date, w.end) >= 0) return { step: s, state: st };
  }
  return null;
}
const STATUS_LABEL_E = { scheduled: 'scheduled', washout: 'washout', stopped: 'stopped', done: 'finished', skipped: 'skipped' };

export function earliestStart(data, progress, today) {
  let earliest = today;
  for (const s of data.protocol.steps) { const o = progress.steps[s.id]; if (o.status !== 'skipped' && Object.keys(o.days).length) { const wo = washoutStatus(o, today); if (wo) { const d = addDays(wo.end, 1); if (diffDays(earliest, d) > 0) earliest = d; } } }
  return earliest;
}

// Validate placing a meal on a date in the planner (hard rules 6/7).
export function validateMealOnDate(data, index, progress, meal, date) {
  const act = activeChallengeOn(data, progress, date);
  const fod = fodmapAssess(meal, index, data, { activeStep: act && act.step, testedIds: testedIngredientIds(data, progress, act && act.step.id) });
  if (fod.status === 'conflict') return { ok: false, blocked: true, fod, reason: fod.notes.filter(n => n.level === 'conflict').map(n => n.text).join(' ') };
  return { ok: true, fod, warn: fod.status !== 'ok' };
}

/* ---------- symptoms ---------- */
export function symptomSummary(data, progress, logs) {
  const by = {};
  for (const l of logs) {
    const key = l.stepId || 'none';
    (by[key] = by[key] || []).push(l);
  }
  return Object.entries(by).map(([k, arr]) => {
    const step = data.protocol.steps.find(s => s.id === k);
    const avg = f => { const v = arr.map(a => a[f]).filter(x => x != null && x !== ''); return v.length ? Math.round(v.reduce((s, x) => s + Number(x), 0) / v.length * 10) / 10 : null; };
    return { key: k, label: step ? `${data.protocol.categories[step.category].label} · ${step.product}` : 'Not linked to a challenge', count: arr.length, bloating: avg('bloating'), gas: avg('gas'), pain: avg('pain') };
  });
}
