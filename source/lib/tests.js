// Automated checks for the safety rules. runTests(E, DATA) -> [{name, pass, detail}]
export function runTests(E, DATA) {
  const idx = E.makeIndex(DATA); const out = [];
  const t = (name, fn) => { try { const r = fn(); out.push({ name, pass: r === true, detail: r === true ? '' : String(r) }); } catch (e) { out.push({ name, pass: false, detail: e.message }); } };
  const W = '2026-11-02'; // a Monday
  const base = () => ({ ...E.initProgress(DATA), eliminationStart: E.addDays(W, -21), reliefConfirmed: true });
  const meal = ids => ({ id: 'x', nameEn: 'test', slot: 'lunch', servings: 1, nutrition: { protein: 0 }, instructions: '', ingredients: ids.map(id => ({ id, orig: id, g: 100 })) });
  // helper: run s1 fully and review
  const finishS1 = () => {
    let p = E.scheduleStep(DATA, base(), 's1', W, W).progress;
    p = E.logChallengeDay(DATA, p, 's1', 1, W, 'none').progress;
    p = E.logChallengeDay(DATA, p, 's1', 2, E.addDays(W, 1), 'none').progress;
    p = E.logChallengeDay(DATA, p, 's1', 3, E.addDays(W, 2), 'none').progress;
    p = E.endChallengeDays(DATA, p, 's1').progress; return p;
  };

  t('Two different FODMAP groups cannot be scheduled in the same week', () => {
    let p = E.scheduleStep(DATA, base(), 's1', W, W).progress;
    // force-attempt the lactose step in the same week (bypassing order by marking s1 closed would hide overlap) — simulate a store with s1 scheduled
    p.steps.s2 = { ...p.steps.s2 }; const r = E.scheduleStep(DATA, { ...p, steps: { ...p.steps, s1: { ...p.steps.s1, status: 'done' } } }, 's2', E.addDays(W, 3), W);
    return r.ok === false && /one FODMAP group/i.test(r.reason) ? true : 'expected block, got ' + JSON.stringify(r.reason);
  });
  t('Every week holds at most one challenge, even within the same group', () => {
    let p = finishS1(); p = E.reviewStep(DATA, p, 's1', 'tolerated', E.addDays(W, 6)).progress;
    p = E.scheduleStep(DATA, p, 's2', E.addDays(W, 7), E.addDays(W, 7)).progress;
    p = { ...p, steps: { ...p.steps, s2: { ...p.steps.s2, status: 'done' } }, confirmed: { s3: true } };
    const r = E.scheduleStep(DATA, p, 's3', E.addDays(W, 9), W);
    return r.ok === false ? true : 'expected block';
  });
  t('Challenge days must stay inside the assigned week', () => {
    const p = E.scheduleStep(DATA, base(), 's1', W, W).progress;
    const r = E.logChallengeDay(DATA, p, 's1', 1, E.addDays(W, 7), 'none'); return r.ok === false ? true : 'allowed day outside week';
  });
  t('Challenge days must be consecutive', () => {
    let p = E.scheduleStep(DATA, base(), 's1', W, W).progress; p = E.logChallengeDay(DATA, p, 's1', 1, W, 'none').progress;
    const r = E.logChallengeDay(DATA, p, 's1', 2, E.addDays(W, 2), 'none'); return r.ok === false ? true : 'allowed gap';
  });
  t('Order is enforced: GOS cannot start before fructose is reviewed', () => {
    const r = E.scheduleStep(DATA, base(), 's10', W, W); return r.ok === false ? true : 'allowed out of order';
  });
  t('Next challenge blocked while washout is incomplete', () => {
    const p = finishS1(); const r = E.reviewStep(DATA, p, 's1', 'tolerated', E.addDays(W, 3)); return r.ok === false && /Washout/i.test(r.reason) ? true : JSON.stringify(r);
  });
  t('Washout lasts 3 days after acceptable symptoms', () => {
    let p = E.scheduleStep(DATA, base(), 's1', W, W).progress;
    p = E.logChallengeDay(DATA, p, 's1', 1, W, 'acceptable').progress; p = E.logChallengeDay(DATA, p, 's1', 2, E.addDays(W, 1), 'none').progress; p = E.logChallengeDay(DATA, p, 's1', 3, E.addDays(W, 2), 'none').progress;
    const wo = E.washoutStatus(p.steps.s1, E.addDays(W, 3)); return wo.minDays === 3 ? true : 'minDays ' + wo.minDays;
  });
  t('Strong reaction stops the test and never auto-advances', () => {
    let p = E.scheduleStep(DATA, base(), 's1', W, W).progress;
    const r1 = E.logChallengeDay(DATA, p, 's1', 1, W, 'severe'); p = r1.progress;
    if (p.steps.s1.status !== 'stopped') return 'not stopped';
    if (E.logChallengeDay(DATA, p, 's1', 2, E.addDays(W, 1), 'none').ok) return 'allowed day 2 after stop';
    if (E.reviewStep(DATA, p, 's1', 'repeat', E.addDays(W, 4)).ok) return 'review allowed before symptoms settled';
    p = E.markSettled(p, 's1');
    if (E.reviewStep(DATA, p, 's1', 'tolerated', E.addDays(W, 4)).ok) return 'tolerated accepted after severe';
    const r = E.reviewStep(DATA, p, 's1', 'repeat', E.addDays(W, 4));
    if (!r.ok || r.advanced) return 'repeat advanced';
    return E.currentStep(DATA, r.progress).step.id === 's1' ? true : 'moved on';
  });
  t('Second foods need confirmation before scheduling', () => {
    let p = base(); p.steps.s1.status = 'done'; p.steps.s2.status = 'done';
    const r = E.scheduleStep(DATA, p, 's3', W, W); return r.ok === false && /Confirm/i.test(r.reason) ? true : 'not blocked';
  });
  t('Wheat bread week needs a dose-source choice (conflicting documents)', () => {
    let p = base(); for (const k of ['s1', 's2', 's3', 's4', 's5', 's6']) p.steps[k].status = 'done';
    const r = E.scheduleStep(DATA, p, 's7', W, W); return r.ok === false && /dose source/i.test(r.reason) ? true : 'not blocked';
  });
  t('Doses come only from the protocol', () => {
    const d1 = E.getDose(DATA, 's1', 1), d3 = E.getDose(DATA, 's8', 3), d5 = E.getDose(DATA, 's1', 5), d4 = E.getDose(DATA, 's1', 4);
    return d1.amount === 40 && d3.amount === 8 && d5 === null && d4.amount === null ? true : JSON.stringify({ d1, d3, d5, d4 });
  });
  t('Incidental exposure to the active challenge food is flagged', () => {
    const f = E.fodmapAssess(meal(['chicken-breast', 'mango']), idx, DATA, { activeStep: DATA.protocol.steps[0] });
    return f.status === 'incidental' ? true : f.status;
  });
  t('A different group during a challenge week is blocked', () => {
    let p = E.scheduleStep(DATA, base(), 's1', W, W).progress;
    const v = E.validateMealOnDate(DATA, idx, p, meal(['chicken-breast', 'onion']), E.addDays(W, 1));
    return v.ok === false && v.blocked ? true : JSON.stringify(v.fod);
  });
  t('Tomato (conflicting sources) is marked for review, not silently allowed', () => {
    const f = E.fodmapAssess(meal(['tomato']), idx, DATA, {}); return f.status === 'review' ? true : f.status;
  });
  t('Green banana (Plan 3) is not flagged; unspecified banana is', () => {
    const g = { ...meal([]), ingredients: [{ id: 'banana', g: 120, variant: 'green' }] };
    return E.fodmapAssess(g, idx, DATA).status === 'ok' && E.fodmapAssess(meal(['banana']), idx, DATA).status === 'review' ? true : 'mismatch';
  });
  t('A tested food stays flagged while later challenges run', () => {
    let p = finishS1(); p = E.reviewStep(DATA, p, 's1', 'tolerated', E.addDays(W, 6)).progress;
    const f = E.fodmapAssess(meal(['mango']), idx, DATA, { testedIds: E.testedIngredientIds(DATA, p) }); return f.status === 'conflict' ? true : f.status;
  });
  t('"Can make now" is false when one required ingredient is missing', () => {
    const m = DATA.meals.find(x => x.id === 'p3-wed-lunch');
    const pantry = m.ingredients.slice(1).map(i => ({ id: i.id, qty: null, unit: 'g' }));
    const a = E.availability(m, pantry); const full = E.availability(m, [...pantry, { id: m.ingredients[0].id, qty: 9999, unit: 'g' }]);
    return !a.canMake && a.missingCount === 1 && full.canMake ? true : JSON.stringify({ a: a.missingCount, full: full.canMake });
  });
  t('Insufficient quantity counts as missing', () => {
    const m = DATA.meals.find(x => x.id === 'p3-wed-lunch'); const pantry = m.ingredients.map(i => ({ id: i.id, qty: i.g / 2, unit: 'g' }));
    return E.availability(m, pantry).canMake === false ? true : 'treated as available';
  });
  t('Shopping list aggregates grams and subtracts pantry', () => {
    let w = E.emptyWeek(); w.mon.lunch = { mealId: 'p3-wed-lunch', servings: 1 }; w.tue.lunch = { mealId: 'p3-wed-lunch', servings: 1 };
    const s = E.buildShopping(w, idx, [{ id: 'cod', qty: 150, unit: 'g' }], W); const cod = s.toBuy.find(r => r.id === 'cod');
    return cod && cod.need === 400 && cod.buy === 250 ? true : JSON.stringify(cod);
  });
  t('Templates never overwrite planned meals without confirmation', () => {
    let w = E.emptyWeek(); w.mon.lunch = { mealId: 'p1-tue-lunch', servings: 1 };
    const r = E.applyTemplate(w, DATA, 'p2'); return r.applied === false && r.overwrites.length === 1 && w.mon.lunch.mealId === 'p1-tue-lunch' ? true : 'overwrote';
  });
  t('Original plans stay unchanged after editing a week', () => {
    const before = JSON.stringify(DATA.meals.filter(m => m.plan === 'p1'));
    let w = E.applyTemplate(E.emptyWeek(), DATA, 'p1').week; w = E.assignSlot(w, 'mon', 'lunch', 'p2-mon-lunch', { confirm: true }).week;
    return JSON.stringify(DATA.meals.filter(m => m.plan === 'p1')) === before ? true : 'mutated';
  });
  t('Every protocol challenge from the document is represented', () => {
    const want = { s1: [40, 60, 120], s2: [40, 75, 150], s3: [62.5, 125, 250], s4: [20, 60, 100], s5: [50, 75, 100], s6: [25, 50, 75], s7: [25, 37, 50], s8: [2, 4, 8], s9: [25, 50, 75], s10: [20, 50, 75] };
    for (const s of DATA.protocol.steps) if (JSON.stringify(s.doses.map(d => d.amount)) !== JSON.stringify(want[s.id])) return s.id + ' doses differ';
    const cats = new Set(DATA.protocol.steps.map(s => s.category)); return cats.size === 7 ? true : 'categories ' + cats.size;
  });
  t('First challenge needs 14 days of elimination and confirmed relief', () => {
    const p0 = E.initProgress(DATA);
    if (E.scheduleStep(DATA, p0, 's1', W, W).ok) return 'allowed without elimination start';
    if (E.scheduleStep(DATA, { ...p0, eliminationStart: E.addDays(W, -10), reliefConfirmed: true }, 's1', W, W).ok) return 'allowed after 10 days';
    if (E.scheduleStep(DATA, { ...p0, eliminationStart: E.addDays(W, -14) }, 's1', W, W).ok) return 'allowed without relief';
    return E.scheduleStep(DATA, { ...p0, eliminationStart: E.addDays(W, -14), reliefConfirmed: true }, 's1', W, W).ok ? true : 'blocked valid start';
  });
  t('Blueberry portions above 40 g are flagged (recommendations)', () => {
    const lo = { ...meal([]), ingredients: [{ id: 'blueberries', g: 40 }] }, hi = { ...meal([]), ingredients: [{ id: 'blueberries', g: 125 }] };
    return E.fodmapAssess(lo, idx, DATA).status === 'ok' && E.fodmapAssess(hi, idx, DATA).status === 'review' ? true : 'mismatch';
  });
  t('Stacking two moderate foods in one meal is flagged', () => {
    const one = E.fodmapAssess(meal(['avocado', 'chicken-breast']), idx, DATA), two = E.fodmapAssess(meal(['avocado', 'zucchini']), idx, DATA);
    return one.status === 'ok' && two.status === 'review' ? true : one.status + '/' + two.status;
  });
  t('Not-recommended food outside your plans is a conflict; inside a plan it is review', () => {
    const a = E.fodmapAssess(meal(['sour-cherries']), idx, DATA).status, b = E.fodmapAssess(meal(['black-olives']), idx, DATA).status;
    return a === 'conflict' && b === 'review' ? true : a + '/' + b;
  });
  t('Past challenges can be back-filled and respect the weekly rules', () => {
    const today = E.addDays(W, 30); const p0 = E.initProgress(DATA);
    const days = [0, 1, 2].map(i => ({ day: i + 1, date: E.addDays(W, i), level: 'none' }));
    const r = E.recordPastChallenge(DATA, p0, 's2', { weekStart: W, days, outcome: 'tolerated' }, today);
    if (!r.ok || r.progress.steps.s2.status !== 'done') return 'not saved: ' + r.reason;
    const clash = E.recordPastChallenge(DATA, r.progress, 's1', { weekStart: E.addDays(W, 3), days: [{ day: 1, date: E.addDays(W, 3), level: 'none' }], outcome: 'incomplete' }, today);
    if (clash.ok) return 'allowed overlapping week';
    const fut = E.recordPastChallenge(DATA, p0, 's1', { weekStart: E.addDays(today, 1), days: [{ day: 1, date: E.addDays(today, 1), level: 'none' }], outcome: 'incomplete' }, today);
    if (fut.ok) return 'allowed future date';
    const sev = E.recordPastChallenge(DATA, p0, 's1', { weekStart: W, days: [{ day: 1, date: W, level: 'severe' }], outcome: 'tolerated' }, today);
    if (sev.ok) return 'tolerated after severe';
    return E.challengeForDate(DATA, r.progress, E.addDays(W, 1)).step.id === 's2' ? true : 'diary not linked';
  });
  return out;
}
