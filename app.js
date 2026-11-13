/* Let's Cooking — a tiny static recipe app.
   Recipes come from TheMealDB's free API. Everything you save, cook and rate
   lives in this browser's localStorage and drives the suggestions. */
(() => {
  'use strict';

  const API = 'https://www.themealdb.com/api/json/v1/1/';
  const STORE_KEY = 'letscooking.v1';

  const CATEGORIES = ['Beef', 'Breakfast', 'Chicken', 'Dessert', 'Goat', 'Lamb', 'Miscellaneous',
    'Pasta', 'Pork', 'Seafood', 'Side', 'Starter', 'Vegan', 'Vegetarian'];
  // Fallback cuisine list; the live list (with country names) is loaded from the API on first use.
  const AREAS = ['American', 'British', 'Canadian', 'Chinese', 'Croatian', 'Dutch', 'Egyptian',
    'Filipino', 'French', 'Greek', 'Indian', 'Irish', 'Italian', 'Jamaican', 'Japanese', 'Kenyan',
    'Malaysian', 'Mexican', 'Moroccan', 'Polish', 'Portuguese', 'Russian', 'Spanish', 'Thai',
    'Tunisian', 'Turkish', 'Ukrainian', 'Vietnamese'];
  // Words that say nothing about a craving, and pantry staples that say nothing about taste.
  const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'some', 'something', 'of', 'in',
    'on', 'for', 'i', 'want', 'like', 'food', 'dish', 'meal', 'recipe', 'recipes', 'to', 'my']);
  const STAPLES = new Set(['salt', 'water', 'pepper', 'black pepper', 'oil', 'olive oil',
    'vegetable oil', 'sunflower oil', 'sugar', 'butter', 'flour', 'plain flour', 'garlic',
    'garlic clove', 'garlic cloves', 'onion', 'onions', 'egg', 'eggs', 'milk', 'sea salt']);
  const EXAMPLES = ['chicken curry', 'pasta, garlic', 'something Mexican', 'salmon', 'chocolate dessert', 'vegetarian'];

  // ---------- Storage ----------

  const emptyStore = () => ({ saved: {}, cooked: [], searches: [] });

  function loadStore() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY));
      if (data && typeof data === 'object') return { ...emptyStore(), ...data };
    } catch { /* fall through to a fresh store */ }
    return emptyStore();
  }

  let store = loadStore();
  let recsCache = null; // recommendations are rebuilt whenever the store changes

  function saveStore() {
    recsCache = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      alert('Could not save — your browser storage is full or blocked.');
    }
  }

  // ---------- TheMealDB ----------

  const mealCache = new Map();

  // The API lists cuisines as {demonym, country} ("Indian" / "India"). Recipes and filters
  // are only reliable with the country name, so we show the demonym and query the country.
  let areas = AREAS.map((area) => ({ area, country: '' }));
  let areasReady = null;
  function loadAreas() {
    areasReady ||= fetch(API + 'list.php?a=list')
      .then((res) => res.json())
      .then((data) => {
        const list = (data.meals || []).filter((x) => x.strArea && x.strCountry)
          .map((x) => ({ area: x.strArea, country: x.strCountry }));
        if (list.length) areas = list;
      })
      .catch(() => { areasReady = null; }); // keep the fallback list, retry next time
    return areasReady;
  }
  const findArea = (text) => {
    const t = String(text).toLowerCase();
    return areas.find((x) => x.area.toLowerCase() === t || x.country.toLowerCase() === t);
  };
  const areaName = (text) => findArea(text)?.area || text || '';
  const areaQuery = (name) => encodeURIComponent(findArea(name)?.country || name);

  async function api(path) {
    await loadAreas();
    const res = await fetch(API + path);
    if (!res.ok) throw new Error('Recipe service returned ' + res.status);
    const data = await res.json();
    return Array.isArray(data.meals) ? data.meals.map(normalize) : [];
  }

  const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

  function normalize(m) {
    const ingredients = [];
    for (let i = 1; i <= 20; i++) {
      const name = (m['strIngredient' + i] || '').trim();
      if (name) ingredients.push({ name, measure: (m['strMeasure' + i] || '').trim() });
    }
    const meal = {
      id: String(m.idMeal),
      name: m.strMeal || 'Untitled recipe',
      thumb: httpUrl(m.strMealThumb),
      category: m.strCategory || '',
      area: areaName(m.strArea),
      ingredients,
      instructions: m.strInstructions || '',
      source: httpUrl(m.strSource),
      youtube: httpUrl(m.strYoutube),
      full: typeof m.strInstructions === 'string',
    };
    if (meal.full) mealCache.set(meal.id, meal);
    return meal;
  }

  async function getMeal(id) {
    if (mealCache.has(id)) return mealCache.get(id);
    try {
      const [meal] = await api('lookup.php?i=' + encodeURIComponent(id));
      if (meal) return meal;
    } catch (err) {
      // Offline or service down: fall back to our own copy if we kept one.
      const kept = store.saved[id] || store.cooked.find((c) => c.id === id)?.meal;
      if (kept) return kept;
      throw err;
    }
    return store.saved[id] || null;
  }

  // ---------- Taste profile (the "learning") ----------

  const ingKey = (name) => name.toLowerCase().trim();

  function buildProfile() {
    const w = new Map();
    const add = (key, amount) => w.set(key, (w.get(key) || 0) + amount);
    const addMeal = (meal, amount) => {
      if (meal.category) add('c:' + meal.category, amount);
      if (meal.area && meal.area !== 'Unknown') add('a:' + meal.area, amount);
      for (const ing of meal.ingredients || []) {
        const k = ingKey(ing.name);
        if (!STAPLES.has(k)) add('i:' + k, amount * 0.4);
      }
    };

    // Reviews are the strongest signal: 5★ pulls toward, 1★ pushes away.
    for (const c of store.cooked) {
      let amount = c.rating - 3;
      if (c.again === true) amount += 1;
      if (c.again === false) amount -= 1;
      addMeal(c.meal, amount);
    }
    for (const meal of Object.values(store.saved)) addMeal(meal, 1);
    // Cravings you type are a light nudge.
    for (const s of store.searches.slice(-40)) {
      for (const t of parseTerms(s.q)) {
        if (t.category) add('c:' + t.category, 0.3);
        else if (t.area) add('a:' + t.area, 0.3);
        else add('i:' + t.text, 0.3);
      }
    }
    return w;
  }

  function affinity(meal, profile) {
    let score = (profile.get('c:' + meal.category) || 0) + (profile.get('a:' + meal.area) || 0);
    for (const ing of meal.ingredients || []) score += profile.get('i:' + ingKey(ing.name)) || 0;
    return score;
  }

  function topKeys(profile, prefix, n) {
    return [...profile.entries()]
      .filter(([k, v]) => k.startsWith(prefix) && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ name: k.slice(prefix.length), weight: v }));
  }

  // How many ingredients feels comfortable, judged from "too easy / just right / too hard" feedback.
  function comfortSize() {
    const rated = store.cooked.filter((c) => c.difficulty && c.meal.ingredients?.length);
    if (rated.length < 2) return null;
    const sizes = rated.map((c) => {
      const n = c.meal.ingredients.length;
      return c.difficulty === 'easy' ? n + 3 : c.difficulty === 'hard' ? n - 3 : n;
    });
    return Math.max(3, Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length));
  }

  const cookedIds = () => new Set(store.cooked.map((c) => c.id));
  const lastReview = (id) => store.cooked.filter((c) => c.id === id).at(-1);

  // ---------- Search ----------

  const matchName = (list, text) => {
    const t = text.toLowerCase().replace(/s$/, '');
    return list.find((x) => x.toLowerCase() === text.toLowerCase() || x.toLowerCase() === t) || '';
  };

  function parseTerms(query) {
    const phrases = query.toLowerCase().split(/[,;+&]|\band\b|\bwith\b|\bor\b/)
      .map((p) => p.split(/\s+/).filter((word) => word && !STOPWORDS.has(word)).join(' '))
      .filter(Boolean);
    const texts = new Set(phrases);
    // "spicy chicken curry" should also try each word on its own.
    for (const p of phrases) if (p.includes(' ')) p.split(' ').forEach((word) => texts.add(word));
    return [...texts].slice(0, 6).map((text) => ({
      text,
      category: matchName(CATEGORIES, text),
      area: findArea(text)?.area || findArea(text.replace(/s$/, ''))?.area || '',
    }));
  }

  async function searchMeals(query) {
    await loadAreas(); // cuisine names must be known before the craving is parsed
    const terms = parseTerms(query);
    if (!terms.length) return [];
    const jobs = [];
    for (const t of terms) {
      jobs.push({ t, path: 'search.php?s=' + encodeURIComponent(t.text) });
      jobs.push({ t, path: 'filter.php?i=' + encodeURIComponent(t.text.replace(/ /g, '_')) });
      if (t.category) jobs.push({ t, path: 'filter.php?c=' + encodeURIComponent(t.category) });
      if (t.area) jobs.push({ t, path: 'filter.php?a=' + areaQuery(t.area) });
    }
    const results = await Promise.allSettled(jobs.map((j) => api(j.path)));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;

    const found = new Map();
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      for (const meal of r.value) {
        const entry = found.get(meal.id) || { meal, terms: new Set() };
        if (meal.full) entry.meal = meal;
        entry.terms.add(jobs[i].t.text);
        found.set(meal.id, entry);
      }
    });

    const profile = buildProfile();
    return [...found.values()]
      .map((e) => ({ meal: e.meal, score: e.terms.size * 100 + Math.max(-20, Math.min(20, affinity(e.meal, profile))) }))
      .sort((a, b) => b.score - a.score || a.meal.name.localeCompare(b.meal.name))
      .slice(0, 48)
      .map((e) => e.meal);
  }

  // ---------- Recommendations ----------

  async function buildRecommendations() {
    await loadAreas();
    const profile = buildProfile();
    const cooked = cookedIds();
    const sources = [
      ...topKeys(profile, 'a:', 2).map((k) => ({ ...k, path: 'filter.php?a=' + areaQuery(k.name), why: `You like ${k.name} food` })),
      ...topKeys(profile, 'c:', 2).map((k) => ({ ...k, path: 'filter.php?c=' + encodeURIComponent(k.name), why: `You like ${k.name.toLowerCase()} dishes` })),
      ...topKeys(profile, 'i:', 3).map((k) => ({ ...k, path: 'filter.php?i=' + encodeURIComponent(k.name.replace(/ /g, '_')), why: `Uses ${k.name}` })),
    ];

    const lists = await Promise.allSettled(sources.map((s) => api(s.path)));
    const pool = new Map();
    lists.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      for (const meal of r.value) {
        if (cooked.has(meal.id)) continue;
        const entry = pool.get(meal.id) || { meal, score: Math.random(), why: sources[i].why };
        entry.score += sources[i].weight;
        pool.set(meal.id, entry);
      }
    });

    // Fetch full details for the best candidates so they can be judged properly.
    const shortlist = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, 12);
    const comfort = comfortSize();
    const detailed = await Promise.allSettled(shortlist.map((e) => getMeal(e.meal.id)));
    const picks = [];
    detailed.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value) return;
      const meal = r.value;
      let score = affinity(meal, profile);
      if (comfort) score -= Math.max(0, Math.abs(meal.ingredients.length - comfort) - 3) * 0.5;
      picks.push({ meal, score, why: shortlist[i].why });
    });
    picks.sort((a, b) => b.score - a.score);

    const fresh = (await Promise.allSettled([0, 1, 2, 3].map(() => api('random.php'))))
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .filter((m, i, all) => !cooked.has(m.id) && all.findIndex((x) => x.id === m.id) === i);

    if (!picks.length && !fresh.length && lists.concat(detailed).some((r) => r.status === 'rejected')) {
      throw new Error('Could not reach the recipe service.');
    }

    const again = new Map();
    for (const c of store.cooked) again.set(c.id, c); // latest review per recipe wins
    const makeAgain = [...again.values()]
      .filter((c) => c.rating >= 4 && c.again !== false)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 4);

    return { picks: picks.slice(0, 8), fresh, makeAgain, learned: sources.length > 0 };
  }

  // ---------- DOM helpers ----------

  // h('a', {class: 'x', onclick: fn}, 'text', childNode) — text always goes in as text, never HTML.
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  }

  const app = document.getElementById('app');
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const niceDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const DIFFICULTY = { easy: 'Too easy', right: 'Just right', hard: 'Too hard' };

  function card(meal, why) {
    const review = lastReview(meal.id);
    const sub = [meal.category, meal.area].filter((x) => x && x !== 'Unknown').join(' · ');
    return h('a', { class: 'card', href: '#recipe/' + meal.id },
      meal.thumb && h('img', { src: meal.thumb, alt: '', loading: 'lazy' }),
      h('div', { class: 'body' },
        h('span', { class: 'name' }, meal.name),
        sub && h('span', { class: 'muted small' }, sub),
        review && h('span', { class: 'stars small', title: 'Your rating' }, stars(review.rating)),
        why && h('span', { class: 'why' }, why)));
  }

  const grid = (items) => h('div', { class: 'grid' }, items);
  const loading = (text) => h('p', { class: 'muted', role: 'status' }, text || 'Loading…');
  const errorBox = (err, retry) => h('div', { class: 'notice error' },
    h('p', {}, 'Couldn’t reach the recipe service. Check your connection and try again.'),
    h('p', { class: 'muted small' }, String(err?.message || err)),
    retry && h('button', { class: 'btn', onclick: retry }, 'Try again'));

  // ---------- Views ----------

  let renderToken = 0;
  const search = { query: '', results: null, error: null, busy: false };

  function viewCravings() {
    const input = h('input', {
      type: 'search', name: 'q', value: search.query, autocomplete: 'off',
      placeholder: 'e.g. chicken curry, or "pasta, mushrooms"', 'aria-label': 'What are you craving?',
    });
    const out = h('div', {});

    const run = async (query) => {
      query = query.trim();
      if (!query) return;
      input.value = query;
      Object.assign(search, { query, results: null, error: null, busy: true });
      paint();
      const token = renderToken;
      try {
        search.results = await searchMeals(query);
        if (store.searches.at(-1)?.q !== query) {
          store.searches.push({ q: query, date: new Date().toISOString() });
          store.searches = store.searches.slice(-100);
          saveStore();
        }
      } catch (err) {
        search.error = err;
      }
      search.busy = false;
      if (token === renderToken) paint();
    };

    const paint = () => {
      out.replaceChildren();
      if (search.busy) out.append(loading('Finding recipes…'));
      else if (search.error) out.append(errorBox(search.error, () => run(search.query)));
      else if (search.results && !search.results.length) {
        out.append(h('div', { class: 'notice' },
          h('p', {}, `Nothing found for “${search.query}”.`),
          h('p', { class: 'muted small' }, 'Try a single ingredient (chicken, rice), a dish name (lasagne), or a cuisine (Thai).')));
      } else if (search.results) {
        out.append(h('p', { class: 'muted small' }, `${search.results.length} recipes for “${search.query}” — best matches first.`),
          grid(search.results.map((m) => card(m))));
      } else {
        out.append(h('div', { class: 'row' },
          h('span', { class: 'muted small' }, 'Try:'),
          EXAMPLES.map((ex) => h('button', { class: 'chip', type: 'button', onclick: () => run(ex) }, ex))));
        if (!store.cooked.length && !Object.keys(store.saved).length) {
          out.append(h('div', { class: 'notice' },
            h('strong', {}, 'New here? '),
            'Type what you feel like eating, pick a recipe, cook it, then rate it. The more you rate, the better the ',
            h('a', { href: '#foryou' }, 'For You'), ' ideas get. ',
            h('a', { href: '#help' }, 'Full guide →')));
        }
      }
    };

    app.append(
      h('h1', {}, 'What are you craving?'),
      h('p', { class: 'muted' }, 'Type a dish, ingredients you have, or a cuisine. Separate several with commas.'),
      h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); run(input.value); } },
        input, h('button', { class: 'btn primary', type: 'submit' }, 'Find recipes')),
      out);
    paint();
  }

  async function viewForYou() {
    const token = renderToken;
    const out = h('div', {}, loading('Thinking about what you’d like…'));
    app.append(
      h('h1', {}, 'For You'),
      h('p', { class: 'muted' }, 'Ideas based on what you’ve searched, saved and rated.'),
      out);

    let recs;
    try {
      recs = recsCache || (recsCache = await buildRecommendations());
    } catch (err) {
      if (token === renderToken) out.replaceChildren(errorBox(err, route));
      return;
    }
    if (token !== renderToken) return;

    out.replaceChildren();
    if (!recs.learned) {
      out.append(h('div', { class: 'notice' },
        'I don’t know your tastes yet. Search for a craving, save recipes you like, and rate what you cook — this page fills in as you go. Here are some random ideas to start.'));
    }
    if (recs.picks.length) out.append(h('h2', {}, 'Picked for you'), grid(recs.picks.map((p) => card(p.meal, p.why))));
    if (recs.makeAgain.length) out.append(h('h2', {}, 'Worth making again'), grid(recs.makeAgain.map((c) => card(c.meal))));
    if (recs.fresh.length) out.append(h('h2', {}, recs.learned ? 'Something different' : 'Random ideas'), grid(recs.fresh.map((m) => card(m))));
    out.append(h('p', { style: 'margin-top:1.5rem' },
      h('button', { class: 'btn', onclick: () => { recsCache = null; route(); } }, '↻ New ideas')));
  }

  function viewCookbook() {
    const saved = Object.values(store.saved);
    const cooked = [...store.cooked].reverse();
    app.append(h('h1', {}, 'Cookbook'), h('p', { class: 'muted' }, 'Your saved recipes, cooking history, and what the site has learned.'));

    // Profile
    if (store.cooked.length) {
      const profile = buildProfile();
      const avg = store.cooked.reduce((a, c) => a + c.rating, 0) / store.cooked.length;
      const likes = [...topKeys(profile, 'a:', 2), ...topKeys(profile, 'c:', 2)].map((k) => k.name);
      const ingredients = topKeys(profile, 'i:', 5).map((k) => k.name);
      const diff = { easy: 0, right: 0, hard: 0 };
      store.cooked.forEach((c) => { if (c.difficulty) diff[c.difficulty]++; });
      let tip = 'Rate how hard each recipe felt and I’ll match suggestions to your level.';
      const judged = diff.easy + diff.right + diff.hard;
      if (judged >= 2) {
        if (diff.hard > diff.easy && diff.hard >= judged / 3) tip = 'Several recipes felt too hard, so I’m leaning toward simpler ones with fewer ingredients.';
        else if (diff.easy > diff.hard && diff.easy >= judged / 3) tip = 'You’re finding things easy — I’m suggesting more involved recipes to stretch you.';
        else tip = 'Difficulty has felt about right, so I’m keeping suggestions at this level.';
      }
      const comfort = comfortSize();
      app.append(h('div', { class: 'panel' },
        h('h2', {}, 'Your cooking profile'),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', {}, String(store.cooked.length)), 'meals cooked'),
          h('div', { class: 'stat' }, h('b', {}, avg.toFixed(1) + ' ★'), 'average rating'),
          comfort && h('div', { class: 'stat' }, h('b', {}, '~' + comfort), 'ingredients feels right')),
        likes.length ? h('p', {}, h('strong', {}, 'You tend to like: '), likes.join(', ')) : null,
        ingredients.length ? h('p', {}, h('strong', {}, 'Ingredients that work for you: '), ingredients.join(', ')) : null,
        h('p', { class: 'muted' }, tip)));
    }

    app.append(h('h2', {}, `Saved (${saved.length})`));
    app.append(saved.length ? grid(saved.map((m) => card(m)))
      : h('p', { class: 'muted' }, 'Nothing saved yet. Open a recipe and press “Save”.'));

    app.append(h('h2', {}, `Cooked (${cooked.length})`));
    if (!cooked.length) app.append(h('p', { class: 'muted' }, 'After you cook something, open the recipe and leave a rating — it shows up here.'));
    else {
      app.append(h('div', { class: 'panel' }, cooked.map((c) => h('div', { class: 'review' },
        h('div', { class: 'row' },
          h('a', { href: '#recipe/' + c.id }, h('strong', {}, c.meal.name)),
          h('span', { class: 'stars' }, stars(c.rating)),
          h('span', { class: 'muted small' }, [niceDate(c.date), DIFFICULTY[c.difficulty]].filter(Boolean).join(' · '))),
        c.notes && h('p', { class: 'small' }, c.notes)))));
    }

    // Backup
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importData });
    app.append(h('h2', {}, 'Backup'),
      h('p', { class: 'muted small' }, 'Your data only lives in this browser. Export a backup to keep it safe or move it to another device.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: exportData }, 'Export my data'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import a backup'),
        h('button', { class: 'btn danger', onclick: resetData }, 'Erase everything'),
        fileInput));
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `letscooking-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const okMeal = (m) => m && typeof m.id === 'string' && typeof m.name === 'string';
      if (!data || typeof data.saved !== 'object' || !Array.isArray(data.cooked)
        || !Object.values(data.saved).every(okMeal)
        || !data.cooked.every((c) => okMeal(c.meal) && typeof c.id === 'string' && c.rating >= 1 && c.rating <= 5 && typeof c.date === 'string')) {
        throw new Error('bad shape');
      }
      if (!confirm('Replace everything in this browser with the backup?')) return;
      // Re-check links, since a backup file can come from anywhere.
      const clean = (m) => ({ ...m, thumb: httpUrl(m.thumb), source: httpUrl(m.source), youtube: httpUrl(m.youtube), ingredients: Array.isArray(m.ingredients) ? m.ingredients : [] });
      store = {
        saved: Object.fromEntries(Object.values(data.saved).map((m) => [m.id, clean(m)])),
        cooked: data.cooked.map((c) => ({ ...c, meal: clean(c.meal) })),
        searches: Array.isArray(data.searches) ? data.searches.filter((s) => s && typeof s.q === 'string') : [],
      };
      saveStore();
      route();
    } catch {
      alert('That file doesn’t look like a Let’s Cooking backup.');
    }
  }

  function resetData() {
    if (!confirm('Erase all saved recipes, ratings and history from this browser? This can’t be undone.')) return;
    store = emptyStore();
    saveStore();
    route();
  }

  function splitSteps(text) {
    const lines = text.split(/\r?\n+/).map((s) => s.trim())
      .filter((s) => s && !/^(step\s*)?\d+[.):]?$/i.test(s))
      .map((s) => s.replace(/^(step\s*)?\d+[.):]\s+/i, ''));
    // Some recipes arrive as one big paragraph — break those into sentences.
    if (lines.length <= 2 && text.length > 400) {
      return lines.flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z])/)).filter(Boolean);
    }
    return lines.length ? lines : [text];
  }

  async function viewRecipe(id) {
    const token = renderToken;
    app.append(loading('Loading recipe…'));
    let meal;
    try {
      meal = await getMeal(id);
    } catch (err) {
      if (token === renderToken) app.replaceChildren(errorBox(err, route));
      return;
    }
    if (token !== renderToken) return;
    app.replaceChildren();
    if (!meal) {
      app.append(h('div', { class: 'notice' }, 'That recipe couldn’t be found. ', h('a', { href: '#cravings' }, 'Back to search')));
      return;
    }

    const saveBtn = h('button', { class: 'btn', onclick: () => {
      if (store.saved[meal.id]) delete store.saved[meal.id]; else store.saved[meal.id] = meal;
      saveStore();
      paintSave();
    } });
    const paintSave = () => {
      const on = Boolean(store.saved[meal.id]);
      saveBtn.textContent = on ? '♥ Saved' : '♡ Save';
      saveBtn.classList.toggle('on', on);
      saveBtn.setAttribute('aria-pressed', String(on));
    };
    paintSave();

    const sub = [meal.category, meal.area].filter((x) => x && x !== 'Unknown').join(' · ');
    const history = h('div', {});
    const paintHistory = () => {
      const mine = store.cooked.filter((c) => c.id === meal.id).reverse();
      history.replaceChildren();
      if (!mine.length) return;
      history.append(h('div', { class: 'panel' },
        h('h2', {}, 'Your notes from last time'),
        mine.map((c) => h('div', { class: 'review' },
          h('div', { class: 'row' },
            h('span', { class: 'stars' }, stars(c.rating)),
            h('span', { class: 'muted small' }, [niceDate(c.date), DIFFICULTY[c.difficulty],
              c.again === true ? 'would make again' : c.again === false ? 'wouldn’t make again' : ''].filter(Boolean).join(' · ')),
            h('button', { class: 'chip', type: 'button', onclick: () => {
              if (!confirm('Delete this review?')) return;
              store.cooked = store.cooked.filter((x) => x !== c);
              saveStore();
              paintHistory();
            } }, 'Delete')),
          c.notes && h('p', {}, c.notes)))));
    };
    paintHistory();

    app.append(
      h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); history_back(); } }, '← Back')),
      h('div', { class: 'recipe-head' },
        meal.thumb ? h('img', { src: meal.thumb, alt: meal.name }) : h('div', {}),
        h('div', {},
          h('h1', {}, meal.name),
          sub && h('p', { class: 'muted' }, sub),
          h('p', { class: 'muted small' }, `${meal.ingredients.length} ingredients`),
          h('div', { class: 'row', style: 'margin-top:1rem' },
            saveBtn,
            h('a', { class: 'btn primary', href: '#review', onclick: (e) => {
              e.preventDefault();
              document.getElementById('review').scrollIntoView({ behavior: 'smooth' });
            } }, 'I cooked this — rate it'),
            meal.youtube && h('a', { class: 'btn', href: meal.youtube, target: '_blank', rel: 'noopener noreferrer' }, 'Video'),
            meal.source && h('a', { class: 'btn', href: meal.source, target: '_blank', rel: 'noopener noreferrer' }, 'Original recipe')))),
      history,
      h('h2', {}, 'Ingredients'),
      h('p', { class: 'muted small' }, 'Tick things off as you gather them.'),
      h('ul', { class: 'ingredients' }, meal.ingredients.map((ing) => h('li', {},
        h('label', {}, h('input', { type: 'checkbox' }), h('span', {}, [ing.measure, ing.name].filter(Boolean).join(' ')))))),
      h('h2', {}, 'Method'),
      h('ol', { class: 'steps' }, splitSteps(meal.instructions).map((s) => h('li', {}, s))),
      reviewForm(meal, paintHistory));
  }

  function history_back() {
    if (window.history.length > 1) window.history.back();
    else location.hash = '#cravings';
  }

  function reviewForm(meal, onSaved) {
    const state = { rating: 0, difficulty: '', again: null };
    const starBtns = [1, 2, 3, 4, 5].map((n) => h('button', {
      type: 'button', 'aria-label': `${n} star${n > 1 ? 's' : ''}`,
      onclick: () => { state.rating = n; paint(); },
    }, '★'));
    const choice = (key, value, label) => h('button', {
      type: 'button', class: 'btn', 'data-key': key,
      onclick: (e) => { state[key] = state[key] === value ? (key === 'again' ? null : '') : value; paint(); e.currentTarget.blur(); },
    }, label);
    const diffBtns = [choice('difficulty', 'easy', 'Too easy'), choice('difficulty', 'right', 'Just right'), choice('difficulty', 'hard', 'Too hard')];
    const diffValues = ['easy', 'right', 'hard'];
    const againBtns = [choice('again', true, 'Yes'), choice('again', false, 'No')];
    const notes = h('textarea', { placeholder: 'What worked? What would you change next time? (less salt, cook 5 min longer…)', 'aria-label': 'Notes' });
    const msg = h('span', { class: 'muted small', role: 'status' });

    const paint = () => {
      starBtns.forEach((b, i) => { b.classList.toggle('lit', i < state.rating); b.setAttribute('aria-pressed', String(i + 1 === state.rating)); });
      diffBtns.forEach((b, i) => { const on = state.difficulty === diffValues[i]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      againBtns.forEach((b, i) => { const on = state.again === (i === 0); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    };
    paint();

    return h('form', { class: 'panel', id: 'review', onsubmit: (e) => {
      e.preventDefault();
      if (!state.rating) { msg.textContent = 'Pick a star rating first.'; return; }
      store.cooked.push({
        id: meal.id, meal, rating: state.rating, difficulty: state.difficulty || null,
        again: state.again, notes: notes.value.trim(), date: new Date().toISOString(),
      });
      saveStore();
      Object.assign(state, { rating: 0, difficulty: '', again: null });
      notes.value = '';
      paint();
      msg.textContent = 'Saved! Your suggestions just got a little smarter.';
      onSaved();
    } },
      h('h2', {}, 'Cooked it? Leave a review'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'How was it?'), h('div', { class: 'star-input' }, starBtns)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'How hard was it to cook?'), h('div', { class: 'row' }, diffBtns)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Would you make it again?'), h('div', { class: 'row' }, againBtns)),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Notes for next time'), notes),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save review'), msg));
  }

  function viewHelp() {
    app.append(h('div', { class: 'help' },
      h('h1', {}, 'How it works'),
      h('p', { class: 'muted' }, 'Four steps. No account, no setup.'),
      h('ol', {},
        h('li', {}, h('strong', {}, 'Type a craving. '), 'On ', h('a', { href: '#cravings' }, 'Cravings'),
          ', enter a dish (“lasagne”), ingredients you have (“chicken, rice”), or a cuisine (“Thai”). Use commas for several things — recipes matching more of them come first.'),
        h('li', {}, h('strong', {}, 'Pick a recipe. '), 'Tap a card to see ingredients and steps. Tick ingredients off as you gather them. Press ',
          h('strong', {}, '♡ Save'), ' to keep it in your ', h('a', { href: '#cookbook' }, 'Cookbook'), '.'),
        h('li', {}, h('strong', {}, 'Cook, then rate. '), 'At the bottom of every recipe: give it stars, say how hard it felt, whether you’d make it again, and jot notes for next time. Your notes appear at the top of the recipe whenever you come back to it.'),
        h('li', {}, h('strong', {}, 'Get better ideas. '), 'Open ', h('a', { href: '#foryou' }, 'For You'),
          ' for suggestions based on everything above. Press “New ideas” any time for a fresh batch.')),

      h('h2', {}, 'How the site learns'),
      h('ul', {},
        h('li', {}, h('strong', {}, 'Ratings matter most. '), '4–5 stars means more of that cuisine, type of dish and those ingredients; 1–2 stars means less. “Would make again” strengthens it either way.'),
        h('li', {}, h('strong', {}, 'Saving '), 'a recipe counts as a like. ', h('strong', {}, 'Searching '), 'for something is a small nudge.'),
        h('li', {}, h('strong', {}, 'Difficulty feedback '), 'sets your level. Lots of “too hard” → simpler recipes with fewer ingredients. Lots of “too easy” → more involved ones.'),
        h('li', {}, 'Recipes you’ve already cooked aren’t suggested as new — the ones you loved show under “Worth making again”.'),
        h('li', {}, 'See what it has worked out so far under “Your cooking profile” in the ', h('a', { href: '#cookbook' }, 'Cookbook'), '.')),

      h('h2', {}, 'Good to know'),
      h('ul', {},
        h('li', {}, h('strong', {}, 'Your data stays in this browser. '), 'Nothing is uploaded. That also means a different phone or computer starts fresh — use Export / Import in the Cookbook to move your data or back it up.'),
        h('li', {}, h('strong', {}, 'Sharing with friends: '), 'just send them the link. Everyone gets their own private ratings and suggestions.'),
        h('li', {}, 'Clearing your browser’s site data erases your history, so export a backup now and then.'),
        h('li', {}, 'Recipes come from ', h('a', { href: 'https://www.themealdb.com', target: '_blank', rel: 'noopener' }, 'TheMealDB'),
          ', a free community recipe database. If a search finds nothing, try simpler words — one ingredient or a dish name.'))));
  }

  // ---------- Router ----------

  function route() {
    renderToken++;
    const hash = location.hash.replace(/^#/, '') || 'cravings';
    const [name, arg] = hash.split('/');
    const tab = name === 'recipe' ? '' : name;
    document.querySelectorAll('#nav a').forEach((a) => {
      const on = a.dataset.tab === tab;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    app.replaceChildren();
    window.scrollTo(0, 0);
    if (name === 'recipe' && arg) viewRecipe(arg);
    else if (name === 'foryou') viewForYou();
    else if (name === 'cookbook') viewCookbook();
    else if (name === 'help') viewHelp();
    else viewCravings();
  }

  window.addEventListener('hashchange', route);
  route();
})();
