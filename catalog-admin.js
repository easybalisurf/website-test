// catalog-admin.js — super-admin CRUD for the service catalogue (disciplines / services /
// per-level prices / multi-session discount / spots), managed entirely from inside the bot.
// Everything the website's Live Forecast and booking form read (via GET /catalog) is editable
// here. All UI text is English on purpose (bot content is English; only client-entered fields
// stay in their original language). Register once from index.js: registerCatalogAdmin({...}).

const LEVELS = ['first-timer', 'beginner', 'intermediate', 'advanced'];
const LEVEL_LABEL = { 'first-timer': 'First timer', 'beginner': 'Beginner', 'intermediate': 'Intermediate', 'advanced': 'Advanced' };

function registerCatalogAdmin({ bot, db, Markup, requireUser, trackReply, conversationState, clearScreen, trackUserMessage }) {
  const P = () => db.getPool();
  const isSuper = u => u && u.role === 'super_admin';

  // ---- data helpers ----
  async function discList() { const [r] = await P().execute('SELECT * FROM disciplines ORDER BY sort, id'); return r; }
  async function discById(id) { const [[d]] = await P().execute('SELECT * FROM disciplines WHERE id = ?', [id]); return d; }
  async function svcList(discId) { const [r] = await P().execute('SELECT * FROM services WHERE discipline_id = ? ORDER BY sort, id', [discId]); return r; }
  async function svcById(id) { const [[s]] = await P().execute('SELECT * FROM services WHERE id = ?', [id]); return s; }
  async function pricesFor(svcId) { const [r] = await P().execute('SELECT * FROM service_prices WHERE service_id = ?', [svcId]); const by = {}; for (const p of r) by[p.level] = p; return by; }
  async function spotsFor(discId) { const [r] = await P().execute('SELECT * FROM spots WHERE discipline_id = ? ORDER BY level, sort, id', [discId]); return r; }

  // ---- screen render (edit in place on nav, reply on entry) ----
  async function show(ctx, text, keyboard, entry) {
    const extra = { parse_mode: 'HTML', ...(keyboard || {}) };
    if (entry) return trackReply(ctx, text, extra);
    try { await ctx.editMessageText(text, extra); } catch (e) { await trackReply(ctx, text, extra); }
  }

  // ---- HOME: disciplines ----
  async function renderHome(ctx, entry) {
    const ds = await discList();
    const rows = ds.map(d => ([
      Markup.button.callback(`${d.is_active ? '●' : '○'} ${d.label}`, `cat_disc_${d.id}`),
      Markup.button.callback(d.is_active ? '○' : '●', `cat_disctgl_${d.id}`),
      ...(d.dkey === 'surf' ? [Markup.button.callback(' ', 'cat_langnoop')] : [Markup.button.callback('✕', `cat_discdel_${d.id}`)])
    ]));
    rows.push([Markup.button.callback('+ Add discipline', 'cat_discadd')]);
    const text = '<b>Disciplines</b>\n\nTap a discipline to manage its services & spots.\nShown on site ●   ○ Hidden';
    await show(ctx, text, Markup.inlineKeyboard(rows), entry);
  }

  // ---- LANGUAGES view ----
  async function renderLanguages(ctx, entry) {
    const [langs] = await P().execute('SELECT * FROM languages ORDER BY sort, id');
    const rows = langs.map(l => [
      Markup.button.callback(`${l.label} (${l.code})`, 'cat_langnoop'),
      ...(String(l.code).toLowerCase() === 'en' ? [Markup.button.callback(' ', 'cat_langnoop')] : [Markup.button.callback('✕', `cat_langdel_${l.id}`)])
    ]);
    rows.push([Markup.button.callback('+ Add language', 'cat_langadd')]);
    await show(ctx, '<b>Languages</b>\nUsed by the booking form (instructor language) and instructor profiles.', Markup.inlineKeyboard(rows), entry);
  }

  // ---- DISCIPLINE view: services + spots ----
  async function renderDiscipline(ctx, discId, entry) {
    const d = await discById(discId); if (!d) return renderHome(ctx, entry);
    const svcs = await svcList(discId);
    const rows = svcs.map(s => ([
      Markup.button.callback(`${s.is_active ? '●' : '○'} ${s.label}`, `cat_svc_${s.id}`),
      Markup.button.callback('✕', `cat_svcdel_${s.id}`)
    ]));
    rows.push([Markup.button.callback('+ Add service', `cat_svcadd_${discId}`)]);
    rows.push([Markup.button.callback('Spots', `cat_spots_${discId}`)]);
    rows.push([Markup.button.callback('« Disciplines', 'cat_home')]);
    await show(ctx, `<b>${d.label}</b> — services`, Markup.inlineKeyboard(rows), entry);
  }

  // ---- SERVICE view: prices per level + discount ----
  async function renderService(ctx, svcId, entry) {
    const s = await svcById(svcId); if (!s) return renderHome(ctx, entry);
    const pr = await pricesFor(svcId);
    const r5 = x => Math.round(x / 5) * 5;
    let text = `<b>${s.label}</b>\nDuration: ${Number(s.duration_hours)}h · Max group: ${s.max_group}\n\n<b>Base price per level</b> (rider #1):\n`;
    for (const lv of LEVELS) {
      const p = pr[lv];
      const pct = lv === 'advanced' ? Number(s.adv_extra_pct) : Number(s.extra_pct);
      text += `• ${LEVEL_LABEL[lv]}: ${p ? '$' + p.base + ' (+$' + r5(p.base * pct / 100) + ' / extra rider)' : '—'}\n`;
    }
    text += `\n<b>Extra rider</b>: +${Number(s.extra_pct)}% of base (advanced ${Number(s.adv_extra_pct)}%), rounded to $5`;
    text += `\n<b>Multi-session discount</b> (per extra session):\n• base −${(Number(s.base_rate) * 100).toFixed(2)}% · advanced −${(Number(s.adv_base_rate) * 100).toFixed(2)}%`;
    text += `\n\nRental $${s.rental}/pp · Deposit $${s.deposit}`;
    text += `\n\n<b>Add-ons enabled on the form</b>: Rental ${s.rental_enabled ? '✓' : '✕'} · Media ${s.media_enabled ? '✓' : '✕'} · Transfers ${s.transfers_enabled ? '✓' : '✕'}`;
    const rows = [
      [Markup.button.callback(`${LEVEL_LABEL[LEVELS[0]]} base`, `cat_price_${svcId}_0`), Markup.button.callback(`${LEVEL_LABEL[LEVELS[1]]} base`, `cat_price_${svcId}_1`)],
      [Markup.button.callback(`${LEVEL_LABEL[LEVELS[2]]} base`, `cat_price_${svcId}_2`), Markup.button.callback(`${LEVEL_LABEL[LEVELS[3]]} base`, `cat_price_${svcId}_3`)],
      [Markup.button.callback('Extra rider %', `cat_extrapct_${svcId}`), Markup.button.callback('Multi-session discount', `cat_rate_${svcId}`)],
      [Markup.button.callback('Duration', `cat_duration_${svcId}`), Markup.button.callback('Max group size', `cat_maxgrp_${svcId}`)],
      [Markup.button.callback('— Rental —', 'cat_langnoop')],
      [Markup.button.callback(`Rental: ${s.rental_enabled ? 'ON' : 'OFF'}`, `cat_addontgl_rental_${svcId}`), Markup.button.callback('Price / Deposit', `cat_fees_${svcId}`), Markup.button.callback(`Disc ${Number(s.rental_discount_pct)}%/day`, `cat_rentaldisc_${svcId}`)],
      [Markup.button.callback('— Media —', 'cat_langnoop')],
      [Markup.button.callback(`Media: ${s.media_enabled ? 'ON' : 'OFF'}`, `cat_addontgl_media_${svcId}`), Markup.button.callback(`Disc ${Number(s.media_discount_pct)}%/day`, `cat_mediadisc_${svcId}`)],
      [Markup.button.callback('— Transfers —', 'cat_langnoop')],
      [Markup.button.callback(`Transfers: ${s.transfers_enabled ? 'ON' : 'OFF'}`, `cat_addontgl_transfers_${svcId}`)],
      [Markup.button.callback(s.is_active ? '○ Hide' : '● Show', `cat_svctgl_${svcId}`), Markup.button.callback('« Back', `cat_disc_${s.discipline_id}`)]
    ];
    await show(ctx, text, Markup.inlineKeyboard(rows), entry);
  }

  // ---- SPOTS view ----
  async function renderSpots(ctx, discId, entry) {
    const d = await discById(discId); if (!d) return renderHome(ctx, entry);
    const spots = await spotsFor(discId);
    const label = s => s.name;
    const rows = [];
    let text = `<b>${d.label} — spots</b>\n`;
    if (d.dkey === 'surf') {
      for (const lv of LEVELS) {
        const mine = spots.filter(s => s.level === lv);
        text += `\n<b>${LEVEL_LABEL[lv]}</b>: ${mine.length ? mine.map(label).join(', ') : '—'}`;
        for (const s of mine) rows.push([
          Markup.button.callback(label(s), `cat_spotren_${s.id}`),
          Markup.button.callback(s.rental_price != null ? `🏄 $${s.rental_price}` : '🏄 default', `cat_spotrental_${s.id}`),
          Markup.button.callback('✕', `cat_spotdel_${s.id}`)
        ]);
        rows.push([Markup.button.callback(`+ Add ${LEVEL_LABEL[lv]} spot`, `cat_spotadd_${discId}_${LEVELS.indexOf(lv)}`)]);
      }
    } else {
      text += `\n${spots.length ? spots.map(label).join(', ') : '—'}`;
      for (const s of spots) rows.push([Markup.button.callback(label(s), `cat_spotren_${s.id}`), Markup.button.callback(s.rental_price != null ? `🏄 $${s.rental_price}` : '🏄 default', `cat_spotrental_${s.id}`), Markup.button.callback('✕', `cat_spotdel_${s.id}`)]);
      rows.push([Markup.button.callback('+ Add spot', `cat_spotadd_${discId}_-1`)]);
    }
    text += '\n\n🏄 shows the rental price for this spot — tap to override the service default, or clear it. Deleting a spot removes it everywhere — the site rebuilds automatically.';
    rows.push([Markup.button.callback('« Back', `cat_disc_${discId}`)]);
    await show(ctx, text, Markup.inlineKeyboard(rows), entry);
  }

  // ================= entry (menu button) =================
  bot.hears(/Disciplines/, async (ctx) => {
    const user = await requireUser(ctx);
    if (!isSuper(user)) return;
    await clearScreen(ctx.chat.id);
    trackUserMessage(ctx);
    await renderHome(ctx, true);
  });
  // ================= navigation =================
  bot.action('cat_home', guard(async ctx => renderHome(ctx)));
  bot.action('cat_langs', guard(async ctx => renderLanguages(ctx)));
  bot.action('cat_langnoop', guard(async ctx => {}));
  bot.action('cat_langadd', guard(async ctx => { setStep(ctx, { step: 'cat_lang_code' }); await trackReply(ctx, 'New language — send its code + label, e.g.  fr French'); }));
  bot.action(/cat_langdel_(\d+)/, guard(async ctx => {
    const [[l]] = await P().execute('SELECT code FROM languages WHERE id = ?', [ctx.match[1]]);
    if (l && String(l.code).toLowerCase() === 'en') { await ctx.answerCbQuery('English can\'t be removed'); return; }
    await P().execute('DELETE FROM languages WHERE id = ?', [ctx.match[1]]);
    await audit(ctx, 'catalog_language_delete', { id: ctx.match[1] });
    await renderLanguages(ctx);
  }));
  bot.action(/cat_disc_(\d+)/, guard(async ctx => renderDiscipline(ctx, ctx.match[1])));
  bot.action(/cat_svc_(\d+)/, guard(async ctx => renderService(ctx, ctx.match[1])));
  bot.action(/cat_spots_(\d+)/, guard(async ctx => renderSpots(ctx, ctx.match[1])));

  // ================= toggles / deletes =================
  bot.action(/cat_disctgl_(\d+)/, guard(async ctx => { await P().execute('UPDATE disciplines SET is_active = 1 - is_active WHERE id = ?', [ctx.match[1]]); await renderHome(ctx); }));
  bot.action(/cat_discdel_(\d+)/, guard(async ctx => {
    const id = ctx.match[1];
    const [[d]] = await P().execute('SELECT dkey FROM disciplines WHERE id = ?', [id]);
    if (d && d.dkey === 'surf') { await ctx.answerCbQuery('Surf can\'t be removed'); return; }
    const [svcs] = await P().execute('SELECT id FROM services WHERE discipline_id = ?', [id]);
    for (const s of svcs) await P().execute('DELETE FROM service_prices WHERE service_id = ?', [s.id]);
    await P().execute('DELETE FROM services WHERE discipline_id = ?', [id]);
    await P().execute('DELETE FROM spots WHERE discipline_id = ?', [id]);
    await P().execute('DELETE FROM disciplines WHERE id = ?', [id]);
    await audit(ctx, 'catalog_discipline_delete', { id });
    await renderHome(ctx);
  }));
  bot.action(/cat_svctgl_(\d+)/, guard(async ctx => { await P().execute('UPDATE services SET is_active = 1 - is_active WHERE id = ?', [ctx.match[1]]); await renderService(ctx, ctx.match[1]); }));
  bot.action(/cat_svcdel_(\d+)/, guard(async ctx => {
    const s = await svcById(ctx.match[1]); if (!s) return;
    await P().execute('DELETE FROM service_prices WHERE service_id = ?', [s.id]);
    await P().execute('DELETE FROM services WHERE id = ?', [s.id]);
    await audit(ctx, 'catalog_service_delete', { id: s.id });
    await renderDiscipline(ctx, s.discipline_id);
  }));
  bot.action(/cat_spotdel_(\d+)/, guard(async ctx => {
    const [[sp]] = await P().execute('SELECT * FROM spots WHERE id = ?', [ctx.match[1]]); if (!sp) return;
    await P().execute('DELETE FROM spots WHERE id = ?', [sp.id]);
    await audit(ctx, 'catalog_spot_delete', { id: sp.id, name: sp.name });
    await renderSpots(ctx, sp.discipline_id);
  }));

  // ================= multi-step adds/edits (text) =================
  bot.action('cat_discadd', guard(async ctx => { setStep(ctx, { step: 'cat_disc_key' }); await trackReply(ctx, 'New discipline — send its KEY (lowercase, e.g. kite):'); }));
  bot.action(/cat_svcadd_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_svc_label', discId: +ctx.match[1] }); await trackReply(ctx, 'New service — send its name (e.g. "Single Private session (2h)"):'); }));
  bot.action(/cat_price_(\d+)_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_price_val', svcId: +ctx.match[1], level: LEVELS[+ctx.match[2]] }); await trackReply(ctx, `Send the base price (rider #1) for "${LEVEL_LABEL[LEVELS[+ctx.match[2]]]}", e.g. 80`); }));
  bot.action(/cat_extrapct_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_extrapct_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Extra-rider price = % of base, added per extra rider, rounded to $5.\nSend: <standard%> <advanced%>\ne.g. 70 72'); }));
  bot.action(/cat_rate_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_rate_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Send discount rates as 4 numbers (fractions per extra session):\n<baseRate> <extraRate> <advBaseRate> <advExtraRate>\ne.g. 0.0714 0.1 0.0625 0.0833'); }));
  bot.action(/cat_fees_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_fees_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Send: <rental/pp> <deposit>\ne.g. 20 100'); }));
  bot.action(/cat_maxgrp_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_maxgrp_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Send the max number of riders per session for this service, e.g. 3'); }));
  bot.action(/cat_duration_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_duration_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Send the session length in hours (site slots + forecast windows follow this), e.g. 2 or 3'); }));
  bot.action(/cat_addontgl_(rental|media|transfers)_(\d+)/, guard(async ctx => {
    const col = ctx.match[1] + '_enabled', id = +ctx.match[2];
    await P().execute(`UPDATE services SET ${col} = 1 - ${col} WHERE id = ?`, [id]);
    await audit(ctx, 'catalog_addon_toggle', { svcId: id, addon: ctx.match[1] });
    await renderService(ctx, id);
  }));
  bot.action(/cat_rentaldisc_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_rentaldisc_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Send the rental discount — % off per additional day/session (e.g. 10 = 10% cheaper per rider each extra day), e.g. 10'); }));
  bot.action(/cat_mediadisc_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_mediadisc_val', svcId: +ctx.match[1] }); await trackReply(ctx, 'Send the media discount — % off per additional day/session, e.g. 15'); }));
  bot.action(/cat_spotadd_(\d+)_(-?\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_spot_val', discId: +ctx.match[1], levelIdx: +ctx.match[2] }); await trackReply(ctx, 'New spot — send: Name; lat; lon; shore(deg); region\ne.g. Nusa Dua; -8.796; 115.228; 100; Nusa Dua'); }));
  bot.action(/cat_spotren_(\d+)/, guard(async ctx => { setStep(ctx, { step: 'cat_spot_ren', spotId: +ctx.match[1] }); await trackReply(ctx, 'Send the new name for this spot:'); }));
  bot.action(/cat_spotrental_(\d+)/, guard(async ctx => {
    setStep(ctx, { step: 'cat_spot_rental_val', spotId: +ctx.match[1] });
    await trackReply(ctx, 'Send a rental price ($) to override the service default for this spot, or send "-" to clear the override and use the default again.');
  }));

  // Text step handler (reached via next() from index.js's own text handler for non-catalog steps)
  bot.on('text', async (ctx, next) => {
    const st = conversationState.get(ctx.from.id);
    if (!st || !String(st.step || '').startsWith('cat_')) return next();
    const user = await requireUser(ctx);
    if (!isSuper(user)) { conversationState.delete(ctx.from.id); return; }
    trackUserMessage(ctx);
    const text = ctx.message.text.trim();
    try {
      if (st.step === 'cat_place_name') {
        const [[mx]] = await P().execute('SELECT COALESCE(MAX(sort), -1) AS s FROM places');
        await P().execute('INSERT INTO places (name, sort, is_active) VALUES (?, ?, 1)', [text, mx.s + 1]);
        await audit(ctx, 'catalog_place_add', { name: text });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Place "${text}" added. Manage it under Catalog → Places.`);
      }
      if (st.step === 'cat_disc_key') { st.key = text.toLowerCase().replace(/[^a-z0-9]/g, ''); st.step = 'cat_disc_label'; return trackReply(ctx, 'Now send the display label (e.g. Kite):'); }
      if (st.step === 'cat_disc_label') {
        const [[mx]] = await P().execute('SELECT COALESCE(MAX(sort), -1) AS s FROM disciplines');
        await P().execute('INSERT INTO disciplines (dkey, label, sort, is_active) VALUES (?, ?, ?, 0)', [st.key, text, mx.s + 1]);
        await audit(ctx, 'catalog_discipline_add', { key: st.key });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Discipline "${text}" added (hidden). Open Catalog to add its service, prices & spots, then Show it.`);
      }
      if (st.step === 'cat_svc_label') {
        const skey = 'svc' + Date.now().toString(36);
        const [r] = await P().execute(
          `INSERT INTO services (discipline_id, skey, label, duration_hours, base_rate, extra_rate, adv_base_rate, adv_extra_rate, rental, deposit, media, sort, is_active)
           VALUES (?, ?, ?, 2, 0, 0, 0, 0, 0, 0, 200, 0, 1)`, [st.discId, skey, text]);
        for (const lv of LEVELS) await P().execute('INSERT INTO service_prices (service_id, level, base, extra_person) VALUES (?, ?, 0, 0)', [r.insertId, lv]);
        await audit(ctx, 'catalog_service_add', { id: r.insertId });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Service "${text}" added. Set its per-level prices and discount from the Catalog.`);
      }
      if (st.step === 'cat_price_val') {
        const b = Number(text.trim());
        if (!Number.isFinite(b)) return trackReply(ctx, 'Please send one number, e.g. 80');
        await P().execute('INSERT INTO service_prices (service_id, level, base, extra_person) VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE base = VALUES(base)', [st.svcId, st.level, Math.round(b)]);
        await audit(ctx, 'catalog_price_set', { svcId: st.svcId, level: st.level, base: b });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, '✓ Base price updated. Reopen the service to see it.');
      }
      if (st.step === 'cat_extrapct_val') {
        const [std, adv] = text.split(/\s+/).map(Number);
        if (![std, adv].every(Number.isFinite)) return trackReply(ctx, 'Please send 2 numbers, e.g. 70 72');
        await P().execute('UPDATE services SET extra_pct = ?, adv_extra_pct = ? WHERE id = ?', [std, adv, st.svcId]);
        await audit(ctx, 'catalog_extrapct_set', { svcId: st.svcId, std, adv });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, '✓ Extra-rider % updated.');
      }
      if (st.step === 'cat_rate_val') {
        const n = text.split(/\s+/).map(Number);
        if (n.length !== 4 || !n.every(Number.isFinite)) return trackReply(ctx, 'Please send 4 numbers, e.g. 0.0714 0.1 0.0625 0.0833');
        await P().execute('UPDATE services SET base_rate = ?, extra_rate = ?, adv_base_rate = ?, adv_extra_rate = ? WHERE id = ?', [n[0], n[1], n[2], n[3], st.svcId]);
        await audit(ctx, 'catalog_rates_set', { svcId: st.svcId, rates: n });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, '✓ Discount rates updated.');
      }
      if (st.step === 'cat_fees_val') {
        const [r, d] = text.split(/\s+/).map(Number);
        if (![r, d].every(Number.isFinite)) return trackReply(ctx, 'Please send 2 numbers, e.g. 20 100');
        await P().execute('UPDATE services SET rental = ?, deposit = ? WHERE id = ?', [Math.round(r), Math.round(d), st.svcId]);
        await audit(ctx, 'catalog_fees_set', { svcId: st.svcId });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, '✓ Rental / deposit updated.');
      }
      if (st.step === 'cat_maxgrp_val') {
        const g = parseInt(text.trim(), 10);
        if (!Number.isFinite(g) || g < 1) return trackReply(ctx, 'Please send a whole number ≥ 1, e.g. 3');
        await P().execute('UPDATE services SET max_group = ? WHERE id = ?', [g, st.svcId]);
        await audit(ctx, 'catalog_maxgroup_set', { svcId: st.svcId, maxGroup: g });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Max group set to ${g}.`);
      }
      if (st.step === 'cat_duration_val') {
        const h = Number(text.trim().replace(',', '.'));
        if (!Number.isFinite(h) || h <= 0 || h > 12) return trackReply(ctx, 'Please send a number of hours, e.g. 2 or 3');
        await P().execute('UPDATE services SET duration_hours = ? WHERE id = ?', [h, st.svcId]);
        await audit(ctx, 'catalog_duration_set', { svcId: st.svcId, hours: h });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Session length set to ${h}h — slots & forecast windows on the site now use ${h}h blocks.`);
      }
      if (st.step === 'cat_rentaldisc_val' || st.step === 'cat_mediadisc_val') {
        const pct = Number(text.trim());
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return trackReply(ctx, 'Please send a number 0-100, e.g. 10');
        const col = st.step === 'cat_rentaldisc_val' ? 'rental_discount_pct' : 'media_discount_pct';
        await P().execute(`UPDATE services SET ${col} = ? WHERE id = ?`, [pct, st.svcId]);
        await audit(ctx, 'catalog_discount_set', { svcId: st.svcId, field: col, pct });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Discount set to ${pct}%/day.`);
      }
      if (st.step === 'cat_media_val') {
        // legacy step id kept for safety; media price now lives in Settings → Media price (global)
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, 'Media price is now set once for all services — use Settings → Media price.');
      }
      if (st.step === 'cat_spot_val') {
        const parts = text.split(';').map(s => s.trim());
        if (parts.length < 4) return trackReply(ctx, 'Format: Name; lat; lon; shore; region');
        const [name, lat, lon, shore, region] = parts;
        if (![+lat, +lon, +shore].every(Number.isFinite)) return trackReply(ctx, 'lat, lon and shore must be numbers.');
        const level = st.levelIdx >= 0 ? LEVELS[st.levelIdx] : null;
        const [[mx]] = await P().execute('SELECT COALESCE(MAX(sort), -1) AS s FROM spots WHERE discipline_id = ?', [st.discId]);
        const [[pl]] = await P().execute('SELECT id FROM places ORDER BY sort, id LIMIT 1');
        await P().execute('INSERT INTO spots (discipline_id, level, name, lat, lon, shore, region, sort, is_active, place_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
          [st.discId, level, name, +lat, +lon, Math.round(+shore), region || null, mx.s + 1, pl ? pl.id : null]);
        await audit(ctx, 'catalog_spot_add', { name, level });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Spot "${name}" added — it's now live in the forecast & form.`);
      }
      if (st.step === 'cat_spot_ren') {        await P().execute('UPDATE spots SET name = ? WHERE id = ?', [text, st.spotId]);
        await audit(ctx, 'catalog_spot_rename', { id: st.spotId, name: text });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Renamed to "${text}".`);
      }
      if (st.step === 'cat_spot_rental_val') {
        const [[sp]] = await P().execute('SELECT discipline_id FROM spots WHERE id = ?', [st.spotId]);
        if (!sp) { conversationState.delete(ctx.from.id); return trackReply(ctx, 'Spot not found.'); }
        if (text.trim() === '-') {
          await P().execute('UPDATE spots SET rental_price = NULL WHERE id = ?', [st.spotId]);
          await audit(ctx, 'catalog_spot_rental_clear', { id: st.spotId });
          conversationState.delete(ctx.from.id);
          return trackReply(ctx, '✓ Override cleared — this spot now uses the service default rental price.');
        }
        const price = Number(text.trim());
        if (!Number.isFinite(price) || price < 0) return trackReply(ctx, 'Send a number, e.g. 25, or "-" to clear.');
        await P().execute('UPDATE spots SET rental_price = ? WHERE id = ?', [Math.round(price), st.spotId]);
        await audit(ctx, 'catalog_spot_rental_set', { id: st.spotId, price });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Rental price for this spot set to $${Math.round(price)}.`);
      }
      if (st.step === 'cat_lang_code') {
        const parts = text.split(/\s+/);
        const code = (parts.shift() || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
        const label = parts.join(' ').trim() || code;
        if (!code) return trackReply(ctx, 'Send a code then a label, e.g.  fr French');
        const [[mx]] = await P().execute('SELECT COALESCE(MAX(sort),-1) s FROM languages');
        await P().execute('INSERT INTO languages (code, label, sort, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE label = VALUES(label), is_active = 1', [code, label, mx.s + 1]);
        await audit(ctx, 'catalog_language_add', { code, label });
        conversationState.delete(ctx.from.id);
        return trackReply(ctx, `✓ Language "${label}" (${code}) added. It now appears on the booking form and can be assigned to instructors.`);
      }
    } catch (e) {
      console.error('catalog text step error:', e.message);
      conversationState.delete(ctx.from.id);
      return trackReply(ctx, 'Something went wrong — try again from the Catalog menu.');
    }
    return next();
  });

  // ---- helpers ----
  function guard(fn) {
    return async ctx => {
      const user = await requireUser(ctx);
      if (!isSuper(user)) return ctx.answerCbQuery('Not authorized');
      try { await fn(ctx); } catch (e) { console.error('catalog action error:', e.message); }
      try { await ctx.answerCbQuery(); } catch (e) {}
    };
  }
  function setStep(ctx, obj) { conversationState.set(ctx.from.id, obj); }
  async function audit(ctx, action, details) { try { await db.logAction(ctx.from.username, 'super_admin', action, null, details); } catch (e) {} }
}

module.exports = { registerCatalogAdmin };
