/* Public intake: page 1 = all information on one page, page 2 = document uploads. */
(function () {
  'use strict';
  const SECTIONS = window.INTAKE_SCHEMA.sections;
  const DOCS = window.INTAKE_SCHEMA.docs;
  const OFFICE = window.INTAKE_OFFICE;
  const UI = window.INTAKE_UI;
  const DEMO = !!window.INTAKE_DEMO;
  const STATIC = !!window.INTAKE_STATIC; // no server: answers are sent by WhatsApp or email
  const SEND_KEY = 'iq-intake-send';
  const URL_MAX = 7000;
  const MAX_FILE = 15 * 1024 * 1024;
  const BATCH_BYTES = 40 * 1024 * 1024;
  const BATCH_FILES = 20;
  const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';
  const OK_EXT = /\.(pdf|jpe?g|png|webp|heic|heif)$/i;
  const DRAFT_KEY = 'iq-intake-draft-v2';
  const LINK_RE = /^#u-(IQ-\d{8}-[A-Z2-9]{6,8})-([a-f0-9]{48})$/;

  const state = {
    lang: 'ar', view: 'info', v: {}, r: {}, errors: {},
    ref: null, token: null, pending: {}, uploaded: [], busy: false,
  };
  let conds = [];
  let observer = null;

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const tx = (o) => (o ? (o[state.lang] != null ? o[state.lang] : o.ar) : '');
  function t(k, vars) {
    let s = tx(UI[k]) || k;
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
    return s;
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const toLatinDigits = (x) => x.replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x0660).replace(/[\u06F0-\u06F9]/g, (d) => d.charCodeAt(0) - 0x06F0).replace(/[\u066B\u066C]/g, (d) => (d === '\u066B' ? '.' : ','));
  const safeId = (key) => 'f-' + key.replace(/[^a-zA-Z0-9_-]/g, '-');
  const isEmpty = (v) => v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
  function test(scope, c) {
    const val = scope[c.f];
    if (c.in) return c.in.includes(val);
    if (c.not) return !c.not.includes(val);
    if (c.any) return Array.isArray(val) ? val.some((x) => x !== 'none') : !!val;
    return true;
  }
  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const DATE_VAL = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
  function parseDateVal(v) {
    const m = DATE_VAL.exec(String(v || ''));
    return m ? { y: m[1], m: m[2] ? String(+m[2]) : '', d: m[3] ? String(+m[3]) : '' } : null;
  }
  function yearRange(f) {
    const now = new Date().getFullYear();
    if (f.yrs === 'future') return [now + 20, 1960];
    if (f.yrs === 'near') return [now + 6, 1940];
    return [now, 1900];
  }
  const daysIn = (y, m) => (m ? new Date(+(y || 2000), +m, 0).getDate() : 31);
  const fmtSize = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const optLabel = (opts, v) => { const o = (opts || []).find((x) => x.v === v); return o ? o[state.lang] || o.ar : ''; };
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k, s) { try { return JSON.parse((s || localStorage).getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v, s) { try { (s || localStorage).setItem(k, JSON.stringify(v)); } catch (e) { /* unavailable */ } },
    del(k, s) { try { (s || localStorage).removeItem(k); } catch (e) { /* unavailable */ } },
  };
  function icon(svg) { const s = h('span', { class: 'ico', 'aria-hidden': 'true' }); s.innerHTML = svg; return s; }
  const UPLOAD_SVG = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---------- draft ----------
  let saveTimer = null;
  function saveDraftSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(DRAFT_KEY, { v: state.v, r: state.r, lang: state.lang }), 400);
  }
  function loadDraft() {
    const d = store.get(DRAFT_KEY);
    if (d && (Object.keys(d.v || {}).length || Object.keys(d.r || {}).length)) {
      state.v = d.v || {}; state.r = d.r || {}; state.lang = d.lang === 'en' ? 'en' : 'ar';
      return true;
    }
    return false;
  }

  // ---------- field rendering ----------
  function setVal(scope, id, key, val) {
    scope[id] = val;
    if (state.errors[key]) {
      delete state.errors[key];
      const wrap = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (wrap) {
        wrap.classList.remove('invalid');
        const err = wrap.querySelector('.err'); if (err) { err.textContent = ''; err.hidden = true; }
        wrap.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
      }
      paintNavErrors();
    }
    updateConds();
    saveDraftSoon();
  }

  function labelParts(f) {
    return [tx(f.label), f.req ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null, f.opt ? h('span', { class: 'opt' }, ' (' + t('optional') + ')') : null];
  }
  function wrapField(f, key, control, legend) {
    const id = safeId(key);
    const err = state.errors[key];
    const label = legend ? h('legend', { class: 'lbl' }, labelParts(f)) : h('label', { class: 'lbl', for: id }, labelParts(f));
    const help = f.help ? h('p', { class: 'help', id: id + '-help' }, tx(f.help)) : null;
    const errEl = h('p', { class: 'err', id: id + '-err', role: 'alert', hidden: !err }, err || '');
    return h(legend ? 'fieldset' : 'div', { class: 'field span-' + (f.w || 6) + (err ? ' invalid' : ''), 'data-key': key }, label, help, control, errEl);
  }

  function renderField(f, scope, prefix) {
    const key = prefix ? prefix + '.' + f.id : f.id;
    const id = safeId(key);
    const described = [f.help ? id + '-help' : null, id + '-err'].filter(Boolean).join(' ');
    const invalid = state.errors[key] ? 'true' : null;
    let el;
    switch (f.type) {
      case 'heading':
        el = h('div', { class: 'span-6 subhead' }, h('h3', null, tx(f.label)), f.help ? h('p', { class: 'help' }, tx(f.help)) : null);
        break;
      case 'note':
        el = h('p', { class: 'span-6 note' }, tx(f.label));
        break;
      case 'repeat':
        el = buildRepeat(f);
        break;
      case 'checkbox': {
        const input = h('input', { type: 'checkbox', id, 'aria-describedby': id + '-err', 'aria-invalid': invalid });
        input.checked = !!scope[f.id];
        input.addEventListener('change', () => setVal(scope, f.id, key, input.checked));
        el = h('div', { class: 'field span-6 consent' + (state.errors[key] ? ' invalid' : ''), 'data-key': key },
          h('label', { class: 'check', for: id }, input, h('span', null, labelParts(f))),
          h('p', { class: 'err', id: id + '-err', role: 'alert', hidden: !state.errors[key] }, state.errors[key] || ''));
        break;
      }
      case 'radio':
      case 'checks': {
        const multi = f.type === 'checks';
        const group = h('div', { class: 'pills' });
        (f.opts || []).forEach((o, i) => {
          const oid = id + '-' + i;
          const input = h('input', { type: multi ? 'checkbox' : 'radio', id: oid, name: id, value: o.v, 'aria-describedby': described });
          input.checked = multi ? (Array.isArray(scope[f.id]) && scope[f.id].includes(o.v)) : scope[f.id] === o.v;
          input.addEventListener('change', () => {
            if (multi) {
              const cur = new Set(Array.isArray(scope[f.id]) ? scope[f.id] : []);
              input.checked ? cur.add(o.v) : cur.delete(o.v);
              setVal(scope, f.id, key, [...cur]);
            } else setVal(scope, f.id, key, o.v);
            if (prefix) refreshItemTitle(input);
          });
          group.append(h('label', { class: 'pill', for: oid }, input, h('span', null, o[state.lang] || o.ar)));
        });
        el = wrapField(f, key, group, true);
        break;
      }
      case 'select': {
        const sel = h('select', { id, 'aria-describedby': described, 'aria-invalid': invalid }, h('option', { value: '' }, t('choose')),
          (f.opts || []).map((o) => h('option', { value: o.v }, o[state.lang] || o.ar)));
        sel.value = scope[f.id] || '';
        sel.addEventListener('change', () => { setVal(scope, f.id, key, sel.value); if (prefix) refreshItemTitle(sel); });
        el = wrapField(f, key, sel);
        break;
      }
      case 'textarea': {
        const ta = h('textarea', { id, rows: 3, 'aria-describedby': described, 'aria-invalid': invalid, dir: f.dir || 'auto' });
        ta.value = scope[f.id] || '';
        ta.addEventListener('input', () => setVal(scope, f.id, key, ta.value));
        el = wrapField(f, key, ta);
        break;
      }
      case 'date':
      case 'month': {
        // dropdowns only: Month / Day / Year (no typing). Partial dates are allowed: year, or year + month.
        const full = f.type === 'date';
        const pk = f.id + '$';
        if (!scope[pk] && scope[f.id] && !parseDateVal(scope[f.id])) scope[f.id] = '';
        const parts = Object.assign({ y: '', m: '', d: '' }, scope[pk] || parseDateVal(scope[f.id]) || {});
        const [hi, lo] = yearRange(f);
        const years = []; for (let y = hi; y >= lo; y--) years.push(String(y));
        if (parts.y && !years.includes(parts.y)) years.unshift(parts.y);
        const mk = (part, ph, opts, extraId) => {
          const sel = h('select', { id: extraId, class: 'dp dp-' + part, dir: 'ltr', 'aria-label': tx(f.label) + ': ' + ph, 'aria-describedby': described, 'aria-invalid': invalid },
            h('option', { value: '' }, ph), opts.map(([v, l]) => h('option', { value: v }, l)));
          sel.value = parts[part];
          return sel;
        };
        const mSel = mk('m', t('month'), MONTHS_EN.map((n, i) => [String(i + 1), (i + 1) + ' · ' + n]), id);
        const dSel = full ? mk('d', t('day'), [], id + '-d') : null;
        const ySel = mk('y', t('year'), years.map((y) => [y, y]), id + '-y');
        const fillDays = () => {
          if (!dSel) return;
          const max = daysIn(parts.y, parts.m);
          dSel.replaceChildren(h('option', { value: '' }, t('day')), ...Array.from({ length: max }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
          if (parts.d && +parts.d > max) parts.d = '';
          dSel.value = parts.d;
        };
        fillDays();
        const compose = () => (parts.y ? parts.y + (parts.m ? '-' + pad2(parts.m) + (full && parts.d ? '-' + pad2(parts.d) : '') : '') : '');
        [[mSel, 'm'], [dSel, 'd'], [ySel, 'y']].forEach(([sel, part]) => sel && sel.addEventListener('change', () => {
          parts[part] = sel.value;
          if (part !== 'd') fillDays();
          if (parts.y || parts.m || parts.d) scope[pk] = Object.assign({}, parts); else delete scope[pk];
          setVal(scope, f.id, key, compose());
          if (prefix) refreshItemTitle(sel);
        }));
        const group = h('div', { class: 'datesel' + (full ? '' : ' two') }, mSel, dSel, ySel);
        el = wrapField(full ? Object.assign({}, f, { w: Math.max(f.w || 6, 3) }) : f, key, group, true);
        break;
      }
      default: {
        const type = { tel: 'tel', email: 'email' }[f.type] || 'text';
        const attrs = { id, type, 'aria-describedby': described, 'aria-invalid': invalid, dir: f.dir || 'auto', placeholder: f.ph || null };
        if (f.type === 'number') { attrs.inputmode = 'decimal'; attrs.dir = 'ltr'; }
        if (f.type === 'tel') { attrs.inputmode = 'tel'; attrs.autocomplete = key === 'phone' ? 'tel' : null; }
        if (f.type === 'email') attrs.autocomplete = 'email';
        const input = h('input', attrs);
        input.value = scope[f.id] || '';
        input.addEventListener('input', () => {
          if (f.type === 'tel' || f.type === 'number') {
            const norm = toLatinDigits(input.value);
            if (norm !== input.value) { const pos = input.selectionStart; input.value = norm; try { input.setSelectionRange(pos, pos); } catch (e) { /* not supported for this type */ } }
          }
          setVal(scope, f.id, key, input.value);
          if (prefix) refreshItemTitle(input);
        });
        el = wrapField(f, key, input);
      }
    }
    if (f.show && el) conds.push({ el, scope, cond: f.show });
    return el;
  }

  function itemTitle(f, item, i) {
    const parts = (f.titleFrom || []).map((k) => {
      const sub = f.fields.find((x) => x.id === k);
      const val = item[k];
      if (isEmpty(val)) return '';
      return sub && sub.opts ? optLabel(sub.opts, val) : String(val);
    }).filter(Boolean);
    return parts.length ? parts.join(' · ') : tx(f.itemLabel) + ' ' + (i + 1);
  }
  function refreshItemTitle(node) {
    const card = node.closest('.item');
    if (card && card._f) card.querySelector('.item-title').textContent = itemTitle(card._f, card._item, card._i);
  }

  function buildRepeat(f) {
    const list = state.r[f.id] || (state.r[f.id] = []);
    const wrap = h('div', { class: 'span-6 repeat', id: 'rep-' + f.id });
    const head = f.label ? h('div', { class: 'subhead' }, h('h3', null, tx(f.label)), f.help ? h('p', { class: 'help' }, tx(f.help)) : null) : null;
    const items = h('div', { class: 'items' });
    const adds = h('div', { class: 'adds' });
    function paint(focusLast) {
      conds = conds.filter((c) => !items.contains(c.el));
      items.replaceChildren();
      if (!list.length) items.append(h('p', { class: 'empty' }, t('noneYet')));
      list.forEach((item, i) => {
        const prefix = f.id + '.' + i;
        const card = h('div', { class: 'item' },
          h('div', { class: 'item-head' },
            h('span', { class: 'item-num' }, String(i + 1)),
            h('span', { class: 'item-title' }, itemTitle(f, item, i)),
            h('button', {
              type: 'button', class: 'btn link danger',
              onclick: () => {
                list.splice(i, 1);
                for (const k of Object.keys(state.errors)) if (k.startsWith(f.id + '.')) delete state.errors[k];
                saveDraftSoon(); paint(); paintNavErrors();
              },
            }, t('remove'))),
          h('div', { class: 'grid' }, f.fields.map((sf) => renderField(sf, item, prefix))));
        card._f = f; card._item = item; card._i = i;
        items.append(card);
      });
      updateConds();
      if (focusLast) {
        const cards = items.querySelectorAll('.item');
        const last = cards[cards.length - 1];
        if (last) {
          last.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
          const ctrls = last.querySelectorAll('input, select, textarea');
          const target = focusLast === 'preset' ? ctrls[1] || ctrls[0] : ctrls[0];
          if (target) target.focus({ preventScroll: true });
        }
      }
    }
    const quick = (f.quick || []).concat(f.add || !f.quick ? [{ preset: {}, label: { ar: '+ ' + (f.add ? f.add.ar : ''), en: '+ ' + (f.add ? f.add.en : '') } }] : []);
    quick.forEach((q) => adds.append(h('button', {
      type: 'button', class: 'btn chip',
      onclick: () => { list.push(Object.assign({}, q.preset)); saveDraftSoon(); paint(Object.keys(q.preset).length ? 'preset' : 'first'); },
    }, tx(q.label))));
    wrap.append(...[head, items, adds].filter(Boolean));
    paint();
    if (f.show) conds.push({ el: wrap, scope: state.v, cond: f.show });
    return wrap;
  }

  function updateConds() { for (const c of conds) c.el.hidden = !test(c.scope, c.cond); }

  // ---------- validation & collection ----------
  function walkFields(fields, scope, prefix, fn) {
    for (const f of fields) {
      if (f.show && !test(scope, f.show)) continue;
      const key = prefix ? prefix + '.' + f.id : f.id;
      if (f.type === 'repeat') { (state.r[f.id] || []).forEach((item, j) => walkFields(f.fields, item, f.id + '.' + j, fn)); continue; }
      if (['heading', 'note', 'file'].includes(f.type)) continue;
      fn(f, scope, key);
    }
  }
  function validateAll() {
    const errs = {};
    for (const s of SECTIONS) walkFields(s.fields, state.v, '', (f, scope, key) => {
      const val = scope[f.id];
      if (f.type === 'date' || f.type === 'month') {
        const p = scope[f.id + '$'] || parseDateVal(val) || {};
        if (!p.y && !p.m && !p.d) { if (f.req) errs[key] = t('required'); return; }
        if (!p.y) errs[key] = t('chooseYear');
        else if (p.d && !p.m) errs[key] = t('chooseMonth');
        else if (f.req && f.type === 'date' && !(p.m && p.d)) errs[key] = t('fullDate');
        return;
      }
      if (f.req && isEmpty(val)) { errs[key] = t(f.type === 'checkbox' ? 'mustAgree' : 'required'); return; }
      if (isEmpty(val)) return;
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val).trim())) errs[key] = t('invalidEmail');
      if (f.type === 'tel' && !/^\+?[\d\s\-()]{7,20}$/.test(String(val).trim())) errs[key] = t('invalidPhone');
    });
    return errs;
  }
  const sectionOfKey = (key) => { const top = key.split('.')[0]; return SECTIONS.findIndex((s) => s.fields.some((f) => f.id === top)); };
  function collect() {
    const out = {};
    const pick = (fields, scope, target) => {
      for (const f of fields) {
        if (f.show && !test(scope, f.show)) continue;
        if (['heading', 'note', 'file'].includes(f.type)) continue;
        if (f.type === 'repeat') {
          const items = (state.r[f.id] || []).map((item) => { const o = {}; pick(f.fields, item, o); return o; }).filter((o) => Object.keys(o).length);
          if (items.length) target[f.id] = items;
          continue;
        }
        const val = scope[f.id];
        if (!isEmpty(val)) target[f.id] = typeof val === 'string' ? val.trim() : val;
      }
    };
    for (const s of SECTIONS) pick(s.fields, state.v, out);
    return out;
  }

  // ---------- chrome ----------
  function renderChrome() {
    document.documentElement.lang = state.lang;
    document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
    document.title = tx(OFFICE.title) + ' · ' + tx(OFFICE.name);
    $('office-name').textContent = tx(OFFICE.name);
    $('form-title').textContent = tx(OFFICE.title);
    $('lang-btn').textContent = t('langBtn');
    $('lang-btn').setAttribute('lang', state.lang === 'ar' ? 'en' : 'ar');
    $('privacy').textContent = t(STATIC ? 'privacyStatic' : 'privacy');
    const cc = $('contact-cards');
    if (cc) cc.replaceChildren(...contactCards());
    const demo = $('demo-banner'); demo.hidden = !DEMO; demo.textContent = t('demo');
  }

  // ---------- page 1: information ----------
  function navButton(s, i) {
    return h('li', null, h('button', {
      type: 'button', class: 'step-link', 'data-sec': s.id,
      onclick: () => { const el = $('sec-' + s.id); if (el) { el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); el.querySelector('h2').focus({ preventScroll: true }); } },
    }, h('span', { class: 'num' }, String(i + 1)), h('span', { class: 'name' }, tx(s.title))));
  }
  function paintNavErrors() {
    const counts = {};
    for (const k of Object.keys(state.errors)) { const i = sectionOfKey(k); counts[i] = (counts[i] || 0) + 1; }
    document.querySelectorAll('#steps .step-link').forEach((b, i) => b.classList.toggle('has-err', !!counts[i]));
  }

  function renderInfo(restored) {
    conds = [];
    if (observer) observer.disconnect();
    $('steps').hidden = false;
    $('steps').setAttribute('aria-label', t('sections'));
    $('steps').replaceChildren(h('p', { class: 'nav-step' }, t('stepInfo')), h('ol', null, SECTIONS.map(navButton)));

    const banner = restored ? h('div', { class: 'banner-inline info' }, h('span', null, t('draftRestored')), h('button', {
      type: 'button', class: 'btn link', onclick: () => { store.del(DRAFT_KEY); state.v = {}; state.r = {}; state.errors = {}; renderInfo(false); window.scrollTo({ top: 0 }); },
    }, t('clearDraft'))) : null;

    const secs = SECTIONS.map((s, i) => h('section', { class: 'sec-card', id: 'sec-' + s.id, 'aria-labelledby': 'h-' + s.id },
      h('div', { class: 'sec-head' },
        h('span', { class: 'sec-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('div', null, h('h2', { id: 'h-' + s.id, tabindex: '-1' }, tx(s.title)), s.intro ? h('p', { class: 'intro' }, tx(s.intro)) : null)),
      h('div', { class: 'grid' }, s.fields.map((f) => renderField(f, state.v, '')))));

    const submitBtn = h('button', { type: 'submit', class: 'btn primary big', id: 'submit-btn' }, t(STATIC ? 'continueSend' : 'saveContinue'));
    const form = h('form', { id: 'info-form', novalidate: true },
      h('div', { class: 'page-head' }, h('p', { class: 'eyebrow' }, t('stepInfo')), h('p', { class: 'intro lead' }, t('formIntro'))),
      banner, secs,
      h('div', { class: 'submit-area' }, h('p', { id: 'form-msg', class: 'form-msg bad', role: 'alert', hidden: true }), submitBtn, h('p', { class: 'autosave' }, t('autosave'))));
    form.addEventListener('submit', (e) => { e.preventDefault(); submitInfo(); });
    $('main').replaceChildren(form);
    updateConds();
    paintNavErrors();

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) {
          const id = en.target.id.slice(4);
          document.querySelectorAll('#steps .step-link').forEach((b) => b.classList.toggle('current', b.dataset.sec === id));
          const cur = document.querySelector('#steps .step-link.current');
          const nav = $('steps');
          if (cur && nav.scrollWidth > nav.clientWidth + 4) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
        }
      }, { rootMargin: '-35% 0px -60% 0px' });
      document.querySelectorAll('.sec-card').forEach((s) => observer.observe(s));
    }
  }

  async function submitInfo() {
    if (state.busy) return;
    state.errors = validateAll();
    if (Object.keys(state.errors).length) {
      const y = window.scrollY;
      renderInfo(false);
      window.scrollTo({ top: y });
      const m = $('form-msg'); m.textContent = t('fixErrors'); m.hidden = false;
      const bad = document.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
      if (bad) { bad.scrollIntoView({ block: 'center' }); bad.focus({ preventScroll: true }); }
      return;
    }
    if (STATIC) {
      store.set(DRAFT_KEY, { lang: state.lang, v: state.v, r: state.r });
      const prev = store.get(SEND_KEY, sessionStorage);
      state.ref = (prev && prev.ref) || newRef();
      store.set(SEND_KEY, { ref: state.ref }, sessionStorage);
      state.view = 'send';
      render(); window.scrollTo({ top: 0 });
      return;
    }
    const btn = $('submit-btn'); const msg = $('form-msg');
    state.busy = true; btn.disabled = true; btn.textContent = t('saving'); msg.hidden = true;
    try {
      let res;
      if (DEMO) {
        await new Promise((r) => setTimeout(r, 700));
        res = { ok: true, ref: 'IQ-00000000-DEMO22', token: 'd'.repeat(48) };
      } else {
        const r = await fetch('api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: state.lang, values: collect() }) });
        res = await r.json().catch(() => null);
        if (!r.ok || !res || !res.ok) throw new Error(res && res.error || 'fail');
      }
      store.del(DRAFT_KEY);
      state.ref = res.ref; state.token = res.token; state.uploaded = []; state.pending = {};
      store.set('iq-intake-session', { ref: state.ref, token: state.token }, sessionStorage);
      if (!DEMO) { try { history.replaceState(null, '', '#u-' + state.ref + '-' + state.token); } catch (e) { /* ignore */ } }
      state.view = 'docs';
      render(); window.scrollTo({ top: 0 });
    } catch (e) {
      msg.textContent = e.message === 'rate_limited' ? t('rateLimited') : t('sendFail'); msg.hidden = false;
      btn.disabled = false; btn.textContent = t('saveContinue');
    } finally { state.busy = false; }
  }

  // ---------- page 2: documents ----------
  function privateLink() {
    if (DEMO) return 'https://atlanticway.org/#u-' + state.ref + '-…';
    return location.origin + location.pathname + '#u-' + state.ref + '-' + state.token;
  }
  function copyButton(text) {
    const b = h('button', { type: 'button', class: 'btn ghost small' }, t('copyLink'));
    b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); b.textContent = t('copied'); } catch (e) { /* ignore */ } });
    return b;
  }

  function renderFileField(f) {
    const pending = state.pending[f.id] || (state.pending[f.id] = []);
    const id = safeId(f.id);
    const input = h('input', { type: 'file', id, multiple: true, accept: ACCEPT, class: 'sr-only', 'aria-describedby': (f.help ? id + '-help ' : '') + id + '-err' });
    const drop = h('label', { class: 'drop', for: id }, icon(UPLOAD_SVG), h('span', { class: 'drop-main' }, t('chooseFiles')), h('span', { class: 'drop-sub' }, t('dropHint')));
    const ul = h('ul', { class: 'files' });
    const field = wrapField(f, f.id, h('div', { class: 'file-box' }, input, drop, ul));
    const errEl = field.querySelector('.err');
    function paint() {
      const done = state.uploaded.filter((u) => u.field === f.id);
      ul.replaceChildren(
        ...done.map((u) => h('li', { class: 'done' }, h('span', { class: 'tick', 'aria-label': t('uploadedLabel') }, '✓'), h('span', { class: 'fname', dir: 'auto' }, u.name), h('span', { class: 'fsize' }, fmtSize(u.size)))),
        ...pending.map((file, i) => h('li', null,
          h('span', { class: 'fname', dir: 'auto' }, file.name), h('span', { class: 'fsize' }, fmtSize(file.size)),
          h('button', { type: 'button', class: 'btn icon', 'aria-label': t('remove') + ' ' + file.name, onclick: () => { pending.splice(i, 1); paint(); } }, '×'))));
    }
    function addFiles(files) {
      const msgs = [];
      for (const file of files) {
        if (!OK_EXT.test(file.name)) { msgs.push(t('fileType', { name: file.name })); continue; }
        if (file.size > MAX_FILE) { msgs.push(t('fileTooBig', { name: file.name })); continue; }
        if (pending.some((x) => x.name === file.name && x.size === file.size)) continue;
        pending.push(file);
      }
      errEl.textContent = msgs.join(' · '); errEl.hidden = !msgs.length;
      field.classList.toggle('invalid', !!msgs.length);
      paint();
    }
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer) addFiles(e.dataTransfer.files); });
    paint();
    field.classList.add('filefield');
    return field;
  }

  function renderDocs() {
    if (observer) observer.disconnect();
    $('steps').hidden = false;
    $('steps').setAttribute('aria-label', t('sections'));
    $('steps').replaceChildren(h('p', { class: 'nav-step' }, t('stepDocs')), h('ol', null, DOCS.map((g, i) => h('li', null, h('button', {
      type: 'button', class: 'step-link', onclick: () => { const el = $('grp-' + g.id); if (el) el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth' }); },
    }, h('span', { class: 'num' }, String(i + 1)), h('span', { class: 'name' }, tx(g.title)))))));
    const link = privateLink();
    const uploadBtn = h('button', { type: 'button', class: 'btn primary big', id: 'upload-btn', onclick: uploadPending }, t('uploadBtn'));
    $('main').replaceChildren(h('div', { class: 'docs-page' },
      h('div', { class: 'page-head' }, h('p', { class: 'eyebrow' }, t('stepDocs')), h('h2', { id: 'docs-title', tabindex: '-1' }, t('docsTitle')), h('p', { class: 'intro' }, t('docsIntro')), h('p', { class: 'intro lead tip' }, t('docsTip'))),
      h('div', { class: 'refbox' },
        h('div', null, h('p', { class: 'eyebrow' }, t('refLabel')), h('p', { class: 'ref', dir: 'ltr' }, state.ref)),
        h('div', { class: 'linkline' }, h('p', { class: 'help' }, t('laterLink')), h('code', { class: 'link', dir: 'ltr' }, link), copyButton(link))),
      h('p', { class: 'note' }, t('fileRules')),
      DOCS.map((g) => h('section', { class: 'sec-card', id: 'grp-' + g.id }, h('div', { class: 'sec-head' }, h('h2', null, tx(g.title))), h('div', { class: 'grid' }, g.fields.map(renderFileField)))),
      h('div', { class: 'submit-area' },
        h('p', { id: 'upload-msg', class: 'form-msg', role: 'status', hidden: true }),
        h('div', { class: 'actions' }, uploadBtn, h('button', { type: 'button', class: 'btn ghost', onclick: () => { state.view = 'done'; render(); window.scrollTo({ top: 0 }); } }, t('finish'))))));
  }

  function postBatch(batch, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const { field, file } of batch) fd.append('file__' + field, file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/upload/' + encodeURIComponent(state.ref));
      xhr.setRequestHeader('X-Upload-Token', state.token);
      xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded); });
      xhr.addEventListener('load', () => {
        let res = null; try { res = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status === 200 && res && res.ok) resolve(res.files || []); else reject(new Error((res && res.error) || 'fail'));
      });
      xhr.addEventListener('error', () => reject(new Error('network')));
      xhr.send(fd);
    });
  }

  async function uploadPending() {
    if (state.busy) return;
    const all = [];
    for (const [field, list] of Object.entries(state.pending)) for (const file of list) all.push({ field, file });
    const msg = $('upload-msg'); const btn = $('upload-btn');
    if (!all.length) { msg.textContent = t('nothingSelected'); msg.className = 'form-msg bad'; msg.hidden = false; return; }
    const batches = []; let cur = []; let size = 0;
    for (const item of all) {
      if (cur.length && (size + item.file.size > BATCH_BYTES || cur.length >= BATCH_FILES)) { batches.push(cur); cur = []; size = 0; }
      cur.push(item); size += item.file.size;
    }
    if (cur.length) batches.push(cur);
    const total = all.reduce((a, x) => a + x.file.size, 0) || 1;
    let sent = 0; let count = 0;
    state.busy = true; btn.disabled = true; msg.hidden = true;
    const progress = (n) => { btn.textContent = t('uploading', { p: Math.min(100, Math.round((n / total) * 100)) }); };
    progress(0);
    try {
      for (const batch of batches) {
        const bytes = batch.reduce((a, x) => a + x.file.size, 0);
        let saved;
        if (DEMO) {
          await new Promise((r) => setTimeout(r, 400));
          saved = batch.map(({ field, file }) => ({ field, name: file.name, size: file.size }));
        } else {
          saved = await postBatch(batch, (loaded) => progress(sent + loaded));
        }
        sent += bytes; count += saved.length;
        state.uploaded.push(...saved);
        for (const { field, file } of batch) { const l = state.pending[field]; const i = l.indexOf(file); if (i >= 0) l.splice(i, 1); }
      }
      state.busy = false;
      renderDocs();
      const m = $('upload-msg'); m.textContent = t('uploadedOk', { n: count }); m.className = 'form-msg good'; m.hidden = false;
      m.scrollIntoView({ block: 'center' });
    } catch (e) {
      state.busy = false;
      renderDocs();
      const m = $('upload-msg'); m.textContent = t('uploadFail'); m.className = 'form-msg bad'; m.hidden = false;
      m.scrollIntoView({ block: 'center' });
    }
  }

  // ---------- page 2 (no server): send by WhatsApp or email ----------
  function newRef() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(b);
    const d = new Date();
    return 'IQ-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + Array.from(b, (x) => A[x % A.length]).join('');
  }
  function fmtVal(f, val) {
    if (f.type === 'checkbox') return val ? '✓' : '';
    if (f.type === 'checks') return (Array.isArray(val) ? val : [val]).map((v) => optLabel(f.opts, v) || v).join(state.lang === 'ar' ? '، ' : ', ');
    if ((f.type === 'select' || f.type === 'radio') && f.opts) return optLabel(f.opts, val) || String(val);
    return String(val).trim();
  }
  function answerLines(fields, scope, out) {
    for (const f of fields) {
      if (f.show && !test(scope, f.show)) continue;
      if (['heading', 'note', 'file'].includes(f.type)) continue;
      if (f.type === 'repeat') {
        (state.r[f.id] || []).forEach((item, i) => {
          const sub = []; answerLines(f.fields, item, sub);
          if (sub.length) { out.push('— ' + (f.label ? tx(f.label) + ': ' : '') + itemTitle(f, item, i) + ' —'); out.push(...sub); }
        });
        continue;
      }
      const val = scope[f.id];
      if (isEmpty(val)) continue;
      const v = fmtVal(f, val);
      if (v) out.push(tx(f.label) + ': ' + v);
    }
  }
  function buildText() {
    const out = ['*' + tx(OFFICE.name) + ' — ' + tx(OFFICE.title) + '*', t('refLabel') + ': ' + state.ref];
    SECTIONS.forEach((s, i) => {
      const lines = []; answerLines(s.fields, state.v, lines);
      if (lines.length) out.push('', '*' + (i + 1) + '. ' + tx(s.title) + '*', ...lines);
    });
    return out.join('\n');
  }
  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text)); } catch (e) { /* fall through */ }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;top:-1000px;opacity:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove(); return ok;
  }
  function waLink(text) {
    const enc = encodeURIComponent(text);
    if (('https://wa.me/' + OFFICE.wa + '?text=' + enc).length <= URL_MAX) return 'https://wa.me/' + OFFICE.wa + '?text=' + enc;
    if (isMobile()) return 'whatsapp://send?phone=' + OFFICE.wa + '&text=' + enc;
    return 'https://wa.me/' + OFFICE.wa + '?text=' + encodeURIComponent(t('waShort', { ref: state.ref }));
  }
  function mailLink(text) {
    const head = 'mailto:' + OFFICE.email + '?subject=' + encodeURIComponent(t('emailSubject', { ref: state.ref })) + '&body=';
    const body = text.replace(/\*/g, '');
    if (isMobile() || (head + encodeURIComponent(body)).length <= URL_MAX) return head + encodeURIComponent(body);
    return head + encodeURIComponent(t('waShort', { ref: state.ref }));
  }
  const WA_SVG = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.3 4.8 4.9-1.3A9.8 9.8 0 1 0 12 2.2Zm0 17.9c-1.5 0-3-.4-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8.1 8.1 0 1 1 12 20.1Zm4.5-6c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>';
  const MAIL_SVG = '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function contactCards() {
    return [
      h('a', { class: 'ccard', href: 'mailto:' + OFFICE.email }, h('span', { class: 'cl' }, t('emailLabel')), h('span', { class: 'cv', dir: 'ltr' }, OFFICE.email)),
      h('a', { class: 'ccard', href: 'https://wa.me/' + OFFICE.wa + '?text=' + encodeURIComponent(t('waHello')), target: '_blank', rel: 'noopener' }, h('span', { class: 'cl' }, t('whatsappLabel')), h('span', { class: 'cv', dir: 'ltr' }, OFFICE.whatsapp)),
    ];
  }
  function renderSend() {
    if (observer) observer.disconnect();
    $('steps').hidden = true;
    const text = buildText();
    const msg = h('p', { id: 'send-msg', class: 'form-msg good', role: 'status', hidden: true });
    const say = (k) => { msg.textContent = t(k); msg.hidden = false; };
    const wa = h('a', { class: 'btn big wa', href: waLink(text), target: '_blank', rel: 'noopener', id: 'send-wa' }, icon(WA_SVG), t('sendWa'));
    wa.addEventListener('click', () => { copyText(text); say('pasteHint'); });
    const em = h('a', { class: 'btn big primary', href: mailLink(text), id: 'send-email' }, icon(MAIL_SVG), t('sendEmail'));
    em.addEventListener('click', () => { copyText(text); say('emailHint'); });
    const copyBtn = h('button', { type: 'button', class: 'btn ghost small' }, t('copyAnswers'));
    copyBtn.addEventListener('click', () => copyText(text).then((ok) => { if (ok) say('answersCopied'); }));
    let fileUrl = null;
    try { fileUrl = URL.createObjectURL(new Blob(['﻿' + text.replace(/\*/g, '')], { type: 'text/plain;charset=utf-8' })); } catch (e) { fileUrl = null; }
    const dl = fileUrl ? h('a', { class: 'btn ghost small', href: fileUrl, download: 'Atlantic-Way-' + state.ref + '.txt' }, t('downloadAnswers')) : null;
    const edit = h('button', { type: 'button', class: 'btn link', onclick: () => { store.del(SEND_KEY, sessionStorage); state.view = 'info'; render(false); window.scrollTo({ top: 0 }); } }, t('editAnswers'));
    const clear = h('button', { type: 'button', class: 'btn link danger' }, t('clearMine'));
    clear.addEventListener('click', () => {
      if (!clear.dataset.armed) { clear.dataset.armed = '1'; clear.textContent = t('clearConfirm'); return; }
      store.del(DRAFT_KEY); store.del(SEND_KEY, sessionStorage);
      state.v = {}; state.r = {}; state.errors = {}; state.ref = null;
      $('main').replaceChildren(h('section', { class: 'done' }, h('h2', { tabindex: '-1', id: 'done-title' }, t('cleared')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { state.view = 'info'; render(false); window.scrollTo({ top: 0 }); } }, t('startNew'))));
      $('done-title').focus();
    });
    $('main').replaceChildren(h('div', { class: 'send-page' },
      h('div', { class: 'page-head' }, h('p', { class: 'eyebrow' }, t('stepSend')), h('h2', { id: 'send-title', tabindex: '-1' }, t('sendTitle')), h('p', { class: 'intro' }, t('sendIntro'))),
      h('div', { class: 'refbox' }, h('div', null, h('p', { class: 'eyebrow' }, t('refLabel')), h('p', { class: 'ref', dir: 'ltr' }, state.ref))),
      h('div', { class: 'send-actions' }, wa, em),
      msg,
      h('div', { class: 'send-extra' }, copyBtn, dl),
      h('section', { class: 'docs-list', 'aria-labelledby': 'docs-send-title' },
        h('h3', { id: 'docs-send-title' }, t('docsSendTitle')),
        h('p', { class: 'intro' }, t('docsSendIntro')),
        h('p', { class: 'intro lead tip' }, t('docsTipSend')),
        h('div', { class: 'doc-groups' }, DOCS.map((g) => h('div', { class: 'doc-group' }, h('h4', null, tx(g.title)), h('ul', null, g.fields.map((f) => h('li', null, tx(f.label)))))))),
      h('div', { class: 'send-foot' }, edit, clear)));
    $('send-title').focus();
  }

  function renderDone() {
    if (observer) observer.disconnect();
    $('steps').hidden = true;
    const link = privateLink();
    $('main').replaceChildren(h('section', { class: 'done', 'aria-live': 'polite' },
      h('div', { class: 'done-mark', 'aria-hidden': 'true' }, '✓'),
      h('h2', { tabindex: '-1', id: 'done-title' }, t('doneTitle')),
      h('p', { class: 'eyebrow' }, t('refLabel')),
      h('p', { class: 'ref', dir: 'ltr' }, state.ref),
      h('p', { class: 'intro' }, t('doneNote')),
      h('div', { class: 'linkline' }, h('code', { class: 'link', dir: 'ltr' }, link), copyButton(link))));
    $('done-title').focus();
  }

  function render(restored) {
    renderChrome();
    document.querySelector('.shell').classList.toggle('finished', state.view === 'done' || state.view === 'send');
    if (state.view === 'info') renderInfo(restored);
    else if (state.view === 'send') renderSend();
    else if (state.view === 'docs') renderDocs();
    else renderDone();
  }

  // ---------- boot ----------
  async function boot() {
    const m = STATIC ? null : LINK_RE.exec(location.hash || '');
    const sess = STATIC ? null : store.get('iq-intake-session', sessionStorage);
    const sent = STATIC ? store.get(SEND_KEY, sessionStorage) : null;
    if (sent && sent.ref && loadDraft()) {
      state.ref = sent.ref; state.view = 'send'; render();
    } else if (m || (sess && sess.ref && !DEMO)) {
      state.ref = m ? m[1] : sess.ref; state.token = m ? m[2] : sess.token; state.view = 'docs';
      const d = store.get(DRAFT_KEY); if (d && d.lang === 'en') state.lang = 'en';
      try {
        const r = await fetch('api/upload/' + encodeURIComponent(state.ref), { headers: { 'X-Upload-Token': state.token } });
        const res = await r.json();
        if (!r.ok || !res.ok) throw new Error('bad');
        state.uploaded = res.files || [];
        store.set('iq-intake-session', { ref: state.ref, token: state.token }, sessionStorage);
      } catch (e) {
        store.del('iq-intake-session', sessionStorage);
        renderChrome();
        $('steps').hidden = true;
        $('main').replaceChildren(h('p', { class: 'form-msg bad' }, t('linkInvalid')));
        return;
      }
      render();
    } else {
      render(loadDraft());
    }
    $('lang-btn').addEventListener('click', () => {
      state.lang = state.lang === 'ar' ? 'en' : 'ar';
      if (Object.keys(state.errors).length) state.errors = validateAll();
      const y = window.scrollY;
      render(false); window.scrollTo({ top: y });
      if (state.view === 'info') saveDraftSoon();
    });
  }
  boot();
})();
