// Parse a dietitian meal-plan PDF (same layout as the uploaded "Indywidualny program odżywiania" files).
// Pure functions: text in, structured meals out. PDF text extraction lives in readPdfText().
// Engine helpers are injected (no relative imports, so the file also works when bundled).
let normalizeName = s => s, resolveIngredient = () => null;
export function useEngine(E) { normalizeName = E.normalizeName; resolveIngredient = E.resolveIngredient; }

const DAY_KEYS = { poniedzialek: 'mon', wtorek: 'tue', sroda: 'wed', czwartek: 'thu', piatek: 'fri', sobota: 'sat', niedziela: 'sun' };
const HEADER = /^(PROPOZYCJA|OBIAD|PODWIECZOREK|KOLACJA|ŚNIADANIE|SNIADANIE|II ŚNIADANIE|DRUGIE ŚNIADANIE|PRZEKĄSKA|PRZEKASKA|LUNCH)\s+(\d{1,2}:\d\d)\s+E:\s*([\d ]+)kcal\s+B:\s*([\d,]+)g\s+T:\s*([\d,]+)g\s+W:\s*([\d,]+)g\s+F:\s*([\d,]+)g/i;
const num = s => parseFloat(String(s).replace(/ /g, '').replace(',', '.'));
const ENDS_G = /(\d[\d ]*(?:,\d+)?)\s*g\s*$/;
const HAS_X = /(^|\s)(\d+(?:,\d+)?) x(\s|$)/;
const slug = s => normalizeName(s).replace(/ /g, '-').slice(0, 40);

export async function readPdfText(file, urls) {
  const { PDFParse } = await import(urls.lib);
  PDFParse.setWorker(urls.worker);
  const parser = new PDFParse({ data: new Uint8Array(await file.arrayBuffer()) });
  const r = await parser.getText();
  return r.text;
}

function slotOf(label, time) {
  const h = parseInt(time, 10);
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 15 && h < 19) return 'snack';
  if (h >= 19) return 'dinner';
  return /KOLACJA/i.test(label) ? 'dinner' : /PODWIECZOREK|PRZEK/i.test(label) ? 'snack' : null;
}

function parseIngredientLines(lines, index) {
  // An ingredient ends on a line ending in "N g". Wrapped names/units span the lines in between.
  const groups = []; let buf = []; let firstStart = null;
  for (let i = 0; i < lines.length; i++) {
    buf.push(i);
    if (ENDS_G.test(lines[i]) && HAS_X.test(buf.map(k => lines[k]).join(' '))) { groups.push(buf); buf = []; }
  }
  if (!groups.length) return { items: [], bodyEnd: lines.length };
  // First group also holds the method text: trim it back to where the ingredient starts.
  const extra = [];
  const trim = (g0, isFirst) => { let k = g0.findIndex(x => HAS_X.test(lines[x]));
  const before = l => l.replace(/\t/g, ' ').split(/(?:^|\s)\d+(?:,\d+)? x(?:\s|$)/)[0].trim();
  let start = k;
  const cont = l => /^[a-ząćęłńóśźż(]/.test(l.trim()) || before(l) === '';
  while (start > 0 && !/[.\]!:;)]$/.test(lines[g0[start - 1]].trim()) && (cont(lines[g0[start]]) || (index && index.alias[normalizeName(lines[g0[start - 1]] + ' ' + before(lines[g0[start]]))]))) start--;
  if (isFirst) firstStart = g0[start]; else extra.push(...g0.slice(0, start).map(x => lines[x])); return g0.slice(start); };
  for (let gi = 0; gi < groups.length; gi++) groups[gi] = trim(groups[gi], gi === 0);
  const items = [];
  for (const grp of groups) {
    const txt = grp.map(x => lines[x]).join(' ').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    const m = txt.match(/^(.+?)\s+(\d+(?:,\d+)?) x (.+?)\s*(\d[\d ]*(?:,\d+)?)\s*g$/);
    if (m) items.push({ orig: m[1].trim(), count: num(m[2]), unit: m[3].trim().replace(/,$/, ''), g: num(m[4]) });
  }
  return { items, bodyEnd: firstStart, extra };
}

export function parsePlanText(text, index, planId) {
  const clean = text.replace(/-- \d+ of \d+ --/g, '\n').replace(/\u00a0/g, ' ').replace(/\r/g, '');
  const lines = clean.split('\n').map(l => l.replace(/[ \t]+$/g, '')).filter(l => l.trim() !== '');
  const warnings = []; const meals = []; const newIngs = {};
  let day = null; let dayIndex = -1; let cur = null; const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^ROZPISKA DNI/i.test(l)) { const nx = normalizeName(lines[i + 1] || ''); const dn = nx.match(/^dzien (\d+)/); const d = dn ? ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][(+dn[1] - 1) % 7] : DAY_KEYS[nx.split(' ')[0]]; if (d) { day = d; dayIndex++; } if (cur) { blocks.push(cur); cur = null; } i++; continue; }
    const h = l.replace(/\t/g, ' ').match(HEADER);
    if (h) { if (cur) blocks.push(cur); cur = { day, dayIndex, h, lines: [] }; continue; }
    if (cur) cur.lines.push(lines[i]);
  }
  if (cur) blocks.push(cur);
  if (!blocks.length) return { meals: [], newIngredients: [], warnings: ['No meals found. This reader expects the same layout as your dietitian’s plans (day pages with “OBIAD 12:00 E: … kcal” or “PROPOZYCJA 08:00 E: … kcal” headers).'] };

  const seen = {}; const perDay = {}; blocks.forEach(b => { perDay[b.dayIndex] = (perDay[b.dayIndex] || 0) + 1; }); const rank = {};
  // "PROPOZYCJA" plans list numbered suggestions: map by order (4 a day: lunch, snack, snack, dinner).
  for (const b of blocks) if (/PROPOZYCJA/i.test(b.h[1])) { const r = rank[b.dayIndex] = (rank[b.dayIndex] || 0) + 1; const n = perDay[b.dayIndex]; b.slot = r === 1 ? 'lunch' : r === n && n > 2 ? 'dinner' : 'snack'; }
  for (const b of blocks) {
    const ls = b.lines.filter(l => !/^E:\s*[\d ]+kcal/.test(l.trim()) && !/^\d+\.$/.test(l.trim()));
    const { items, bodyEnd, extra } = parseIngredientLines(ls, index);
    const body = ls.slice(0, bodyEnd);
    let name = (body[0] || '').trim(); let k = 1;
    while (k < body.length && k < 3 && /^[a-ząćęłńóśźż]/.test(body[k].trim()) && !/[.!]$/.test(name)) { name += ' ' + body[k].trim(); k++; }
    let note;
    if (/^\(/.test(name) || /^(Zjedz|Ilość porcji|Uwaga)/i.test(name)) { note = name; name = (body[k] || '').trim(); k++; }
    name = name.replace(/^\/\d+\s+/, '').replace(/\s+\d{1,2}\/\d{1,2}$/, '');
    const instructions = body.slice(k).concat(extra).join(' ').replace(/\s+/g, ' ').replace(/(^|\s)\d+\.(?=\s)/g, ' ').replace(/\s+/g, ' ').trim();
    const slot = b.slot || slotOf(b.h[1], b.h[2]);
    const dkey = b.day || 'mon';
    if (!b.day) warnings.push(`“${name}” has no day heading — placed on Monday.`);
    if (!slot) { warnings.push(`“${name}” at ${b.h[2]} doesn’t match lunch, afternoon snack or dinner — skipped.`); continue; }
    const ings = items.map(it => {
      let id = resolveIngredient(index, it.orig);
      if (!id || normalizeName(index.byId[id] ? index.byId[id].pl.concat(index.byId[id].en).join('|') : '').indexOf(normalizeName(it.orig).split(' ')[0]) < 0) {
        const exact = index.alias[normalizeName(it.orig)];
        id = exact || null;
      }
      if (!id) { id = 'x-' + slug(it.orig); newIngs[id] = newIngs[id] || { id, en: it.orig, pl: [it.orig], cat: 'other', diet: '', unknown: true, imported: true }; }
      return { id, orig: it.orig, count: it.count, unit: it.unit, g: it.g };
    });
    let id = `${planId}-${dkey}-${slot}`; seen[id] = (seen[id] || 0) + 1; if (seen[id] > 1) id += '-' + seen[id];
    const issues = ['Imported automatically from your PDF. Check the name, ingredients and method against the document.'];
    if (!items.length) issues.push('No ingredients could be read from this meal.');
    const unknown = ings.filter(x => newIngs[x.id]).map(x => x.orig);
    if (unknown.length) issues.push(`Not in your existing ingredient list, so diet and FODMAP status are unknown: ${unknown.join(', ')}.`);
    meals.push({ id, plan: planId, day: dkey, dayIndex: Math.max(0, b.dayIndex), slot, origLabel: b.h[1].toUpperCase(), time: b.h[2], namePl: name || 'Untitled meal', nameEn: name || 'Untitled meal', note,
      nutrition: { kcal: num(b.h[3]), protein: num(b.h[4]), fat: num(b.h[5]), carbs: num(b.h[6]), fibre: num(b.h[7]) },
      ingredients: ings, instructions, servings: 1, servingsNote: 'Not stated in source — assumed 1 portion.', issues, imported: true });
  }
  return { meals, newIngredients: Object.values(newIngs), warnings };
}

// Free-text recipe ("Write a recipe" on Discover). First line = name, short lines = ingredients,
// sentences = method. Optional "Składniki:" / "Ingredients:" and "Przygotowanie:" / "Method:" headings.
const TO_G = { g: 1, gram: 1, gramy: 1, gramow: 1, dag: 10, kg: 1000, ml: 1, l: 1000 };
const QTY = '(\\d+(?:[.,]\\d+)?|\\d+\\/\\d+|½|¼|¾|pół|pol)';
const UNIT = '(kg|dag|gramy|gramów|gramow|gram|g|ml|l|łyżk\\S*|lyzk\\S*|łyżeczk\\S*|lyzeczk\\S*|szczypt\\S*|szklank\\S*|garś\\S*|garsc\\S*|plaster\\S*|plastr\\S*|ząb\\S*|zab\\S*|ząbk\\S*|opakowan\\S*|puszk\\S*|tbsp|tsp|cups?|pinch|handful|slices?|cloves?|pcs|szt\\.?|x)';
const LEAD = new RegExp(`^${QTY}\\s*${UNIT}?\\.?\\s+(.+)$`, 'i');
const TRAIL = new RegExp(`^(.+?)\\s*[-–:,]?\\s+${QTY}\\s*${UNIT}?\\.?$`, 'i');
const ING_HEAD = /^(składniki|skladniki|ingredients)\s*:?\s*$/i;
const METHOD_HEAD = /^(przygotowanie|sposób przygotowania|sposob przygotowania|wykonanie|method|instructions|directions|preparation)\s*:?\s*/i;
const qtyNum = s => { s = s.toLowerCase(); if (s === '½' || s === 'pół' || s === 'pol') return 0.5; if (s === '¼') return 0.25; if (s === '¾') return 0.75; if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return b ? a / b : a; } return num(s); };
const looksLikeSentence = l => /[.!?]$/.test(l) || l.split(/\s+/).length > 8;

export function parseIngredientLine(line) {
  const orig = line.replace(/^[-•*–]\s*/, '').replace(/\s+/g, ' ').trim();
  let m = orig.match(LEAD); let q, unit, name;
  if (m) { q = m[1]; unit = m[2]; name = m[3]; } else if ((m = orig.match(TRAIL))) { name = m[1]; q = m[2]; unit = m[3]; } else name = orig;
  const count = q != null ? qtyNum(q) : null;
  const u = unit ? unit.toLowerCase().replace(/\.$/, '') : '';
  const per = TO_G[normalizeName(u)];
  const g = count != null && per ? Math.round(count * per * 10) / 10 : 0;
  return { orig, name: name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(), count, unit: per ? 'g' : (u || (count != null ? 'pcs' : '')), g };
}

export function parseRecipeText(text, index) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const name = (lines[0] || '').replace(/^#+\s*/, '').trim();
  const ingLines = []; const method = []; let mode = 'auto';
  for (const l of lines.slice(1)) {
    if (ING_HEAD.test(l)) { mode = 'ing'; continue; }
    const mh = l.match(METHOD_HEAD);
    if (mh && (mh[0].trim().endsWith(':') || mh[0].length === l.length)) { mode = 'method'; const rest = l.slice(mh[0].length).trim(); if (rest) method.push(rest); continue; }
    if (mode === 'method' || (mode === 'auto' && looksLikeSentence(l))) { mode = 'method'; method.push(l.replace(/^\d+[.)]\s*/, '')); continue; }
    ingLines.push(l);
  }
  const newIngs = {};
  const ingredients = ingLines.map(parseIngredientLine).filter(x => x.name).map(it => {
    let id = resolveIngredient(index, it.name);
    const first = normalizeName(it.name).split(' ')[0];
    if (id && index.byId[id] && normalizeName(index.byId[id].pl.concat(index.byId[id].en).join('|')).indexOf(first) < 0) id = index.alias[normalizeName(it.name)] || null;
    if (!id) { id = 'x-' + slug(it.name); newIngs[id] = newIngs[id] || { id, en: it.name, pl: [it.name], cat: 'other', diet: '', unknown: true, imported: true }; }
    return { id, orig: it.orig, count: it.count, unit: it.unit, g: it.g };
  });
  return { name, ingredients, instructions: method.map(x => /[.!?:;]$/.test(x) ? x : x + '.').join(' ').replace(/\s+/g, ' ').trim(), newIngredients: Object.values(newIngs) };
}
