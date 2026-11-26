// 저장소: Supabase(실사용) / 메모리(데모·테스트)
const URL_ = 'https://nmaibecunwprpuunizuu.supabase.co';
const KEY_ = 'sb_publishable_J_aN_rr5fjloNj5S0iMEhQ_TplbuOQr';
const CARD_COLS = ['card', 'person', 'approval_no', 'used_date', 'used_time', 'merchant', 'raw_amount', 'amount', 'canceled', 'inst_months', 'status', 'pay_due', 'issuer_discount', 'category', 'fixed', 'label', 'adjustment', 'prepaid', 'memo', 'source', 'raw', 'settle', 'settle_done', 'onnuri', 'onnuri_shared', 'spread_months', 'inst_checked', 'cancel_ref'];
const BANK_COLS = ['tx_date', 'account', 'memo', 'deposit', 'withdrawal', 'category', 'fixed', 'note', 'source', 'source_ref'];
const pick = (o, cols) => Object.fromEntries(cols.filter(c => o[c] !== undefined).map(c => [c, o[c]]));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const fail = e => { if (e) throw new Error(e.message || String(e)); };

// 비어 있으면 안 되는 카드 열(DB not null)의 기본값
const cardDefaults = r => ({ settle: r.settle ?? 0, settle_done: r.settle_done ?? false, onnuri: Number.isFinite(Number(r.onnuri)) && r.onnuri !== null && r.onnuri !== undefined ? Number(r.onnuri) : 0, onnuri_shared: r.onnuri_shared ?? false, adjustment: r.adjustment ?? 0, prepaid: r.prepaid ?? 0, issuer_discount: r.issuer_discount ?? 0, spread_months: r.spread_months ?? 0, inst_checked: r.inst_checked ?? false, cancel_ref: r.cancel_ref ?? '' });
export function supabaseStore() {
  const sb = window.supabase.createClient(URL_, KEY_, { auth: { persistSession: true, autoRefreshToken: true } });
  let hid = null; const ver = {}; // 설정 문서별 마지막으로 본 수정 시각(동시 저장 충돌 확인용)
  const all = async (table, order) => { const out = []; for (let from = 0; ; from += 1000) { const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999); fail(error); out.push(...data); if (data.length < 1000) break; } return out; };
  return {
    mode: 'supabase',
    async session() { const { data } = await sb.auth.getSession(); return data.session; },
    onAuth(cb) { sb.auth.onAuthStateChange((ev, s) => cb(ev, s)); },
    async signIn(email, password) { const { error } = await sb.auth.signInWithPassword({ email, password }); fail(error); },
    async signUp(email, password) { const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }); fail(error); return !!data.session; },
    async signOut() { await sb.auth.signOut(); hid = null; },
    async membership() {
      const { data, error } = await sb.from('ledger_members').select('household_id,user_id,display_name'); fail(error);
      if (!data.length) return null; hid = data[0].household_id;
      const { data: h, error: e2 } = await sb.from('ledger_households').select('id,name,invite_code,max_members').single(); fail(e2);
      const { data: u } = await sb.auth.getUser();
      return { household: h, members: data, me: data.find(m => m.user_id === u.user.id) };
    },
    async create(name, display) { const { error } = await sb.rpc('ledger_create', { p_name: name, p_display: display }); fail(error); },
    async join(code, display) { const { error } = await sb.rpc('ledger_join', { p_code: code.trim().toUpperCase(), p_name: display }); fail(error); },
    async loadAll() {
      const [docs, card_tx, bank_tx, card_bills, closes] = await Promise.all([all('ledger_docs', 'key'), all('ledger_card_tx', 'id'), all('ledger_bank_tx', 'id'), all('ledger_card_bills', 'bill_month'), all('ledger_closes', 'month')]);
      docs.forEach(d => { ver[d.key] = d.updated_at; });
      return { docs: Object.fromEntries(docs.map(d => [d.key, d.value])), card_tx, bank_tx, card_bills, closes };
    },
    // 내가 불러온 뒤 다른 쪽이 먼저 저장했으면 덮어쓰지 않고 conflict 오류(최신 내용 포함)를 던진다. force면 그대로 저장
    async saveDoc(key, value, force) {
      if (ver[key] && !force) {
        const { data, error } = await sb.from('ledger_docs').update({ value }).eq('household_id', hid).eq('key', key).eq('updated_at', ver[key]).select('updated_at'); fail(error);
        if (data.length) { ver[key] = data[0].updated_at; return; }
        const { data: cur, error: e2 } = await sb.from('ledger_docs').select('value,updated_at,updated_by').eq('household_id', hid).eq('key', key).maybeSingle(); fail(e2);
        if (cur) { const err = new Error('다른 곳에서 먼저 저장했습니다.'); err.conflict = cur; ver[key] = cur.updated_at; throw err; }
      }
      const { data, error } = await sb.from('ledger_docs').upsert({ household_id: hid, key, value }).select('updated_at'); fail(error); if (data && data[0]) ver[key] = data[0].updated_at;
    },
    // 같이 쓰는 사람의 접속·수정 상태(프레즌스)와 "방금 바꿨어요" 알림. 실패해도 앱은 그대로 동작한다
    live(uid, h) {
      try {
        let ready = false, state = null;
        const ch = sb.channel(`ledger-${hid}`, { config: { presence: { key: uid }, broadcast: { self: false } } });
        ch.on('presence', { event: 'sync' }, () => { const st = ch.presenceState(); h.onPeers(Object.entries(st).map(([key, metas]) => ({ key, ...metas[metas.length - 1] }))); })
          .on('broadcast', { event: 'changed' }, ({ payload }) => h.onChanged(payload))
          .subscribe(status => { if (status === 'SUBSCRIBED') { ready = true; if (state) ch.track(state); } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') ready = false; if (h.onStatus) h.onStatus(status === 'SUBSCRIBED' ? 'on' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'err' : status === 'CLOSED' ? 'off' : 'wait'); });
        return { track(s) { state = s; if (ready) ch.track(s).catch(() => { }); }, notify(p) { if (ready) ch.send({ type: 'broadcast', event: 'changed', payload: p }).catch(() => { }); } };
      } catch (e) { console.warn('live', e); return null; }
    },
    async insertCards(rows) { const out = []; for (const part of chunk(rows, 300)) { const { data, error } = await sb.from('ledger_card_tx').insert(part.map(r => ({ ...pick(r, CARD_COLS), ...cardDefaults(r), household_id: hid })), { defaultToNull: false }).select(); fail(error); out.push(...data); } return out; },
    async updateCard(id, patch) { const { data, error } = await sb.from('ledger_card_tx').update(pick(patch, CARD_COLS)).eq('id', id).select().single(); fail(error); return data; },
    async deleteCard(id) { const { error } = await sb.from('ledger_card_tx').delete().eq('id', id); fail(error); },
    async insertBank(rows) { const out = []; for (const part of chunk(rows, 300)) { const { data, error } = await sb.from('ledger_bank_tx').insert(part.map(r => ({ ...pick(r, BANK_COLS), household_id: hid }))).select(); fail(error); out.push(...data); } return out; },
    async updateBank(id, patch) { const { data, error } = await sb.from('ledger_bank_tx').update(pick(patch, BANK_COLS)).eq('id', id).select().single(); fail(error); return data; },
    async deleteBank(id) { const { error } = await sb.from('ledger_bank_tx').delete().eq('id', id); fail(error); },
    async importBank(account, rows, synced) { const { data, error } = await sb.rpc('ledger_import_bank', { p_account: account, p_rows: rows, p_synced: synced }); fail(error); return data; },
    async setBill(bill_month, card, actual, note) { const row = { household_id: hid, bill_month, card, actual, note: note || '' }; const { error } = await sb.from('ledger_card_bills').upsert(row); fail(error); return row; },
    async saveClose(month, snapshot, memo) { const { data: u } = await sb.auth.getUser(); const row = { household_id: hid, month, snapshot, memo: memo || '', closed_at: new Date().toISOString(), closed_by: u.user.id }; const { error } = await sb.from('ledger_closes').upsert(row); fail(error); return row; },
    async audit() { const { data, error } = await sb.from('ledger_audit').select('*').order('id', { ascending: false }).limit(200); fail(error); return data; },
  };
}

export function demoStore(seed) {
  let id = 1; const db = { docs: structuredClone(seed.docs || {}), card_tx: (seed.card_tx || []).map(r => ({ ...r, id: id++ })), bank_tx: (seed.bank_tx || []).map(r => ({ ...r, id: id++ })), card_bills: [], closes: [] };
  const log = []; const dver = {}, seen = {};
  return {
    mode: 'demo',
    async session() { return { user: { id: 'demo', email: 'demo@local' } }; }, onAuth() { }, async signIn() { }, async signUp() { return true; }, async signOut() { },
    async membership() { return { household: { id: 'demo', name: '데모 가계부', invite_code: 'DEMO', max_members: 2 }, members: [{ user_id: 'demo', display_name: '은경' }], me: { user_id: 'demo', display_name: '은경' } }; },
    async create() { }, async join() { },
    async loadAll() { return structuredClone(db); },
    async saveDoc(k, v, force) { if (!force && dver[k] !== (seen[k] || 0)) { seen[k] = dver[k]; const err = new Error('다른 곳에서 먼저 저장했습니다.'); err.conflict = { value: structuredClone(db.docs[k]), updated_by: 'peer' }; throw err; } db.docs[k] = structuredClone(v); dver[k] = (dver[k] || 0) + 1; seen[k] = dver[k]; },
    // 시험용: 다른 사람이 저장한 것처럼 문서를 바꾼다
    _peerEdit(k, fn) { fn(db.docs[k]); dver[k] = (dver[k] || 0) + 1; },
    // 데모: 같은 브라우저의 다른 탭과 BroadcastChannel로 접속 상태·변경 알림을 흉내 낸다
    live(uid, h) { const me = Math.random().toString(36).slice(2), bc = new BroadcastChannel('ol-demo-live'), peers = new Map(); let state = null;
      const emit = () => h.onPeers([...peers.entries()].filter(([, v]) => Date.now() - v.at < 6000).map(([key, v]) => ({ key, ...v.s })));
      bc.onmessage = e => { const m = e.data; if (m.from === me) return; if (m.t === 'state') { peers.set(m.from, { s: m.s, at: Date.now() }); emit(); } else if (m.t === 'bye') { peers.delete(m.from); emit(); } else if (m.t === 'changed') h.onChanged(m.p); };
      setInterval(() => { if (state) bc.postMessage({ t: 'state', from: me, s: state }); emit(); }, 2000); addEventListener('pagehide', () => bc.postMessage({ t: 'bye', from: me }));
      setTimeout(() => h.onStatus && h.onStatus('on'), 300);
      return { track(s) { state = s; bc.postMessage({ t: 'state', from: me, s }); }, notify(p) { bc.postMessage({ t: 'changed', from: me, p }); } }; },
    async insertCards(rows) { const out = rows.map(r => ({ ...pick(r, CARD_COLS), ...cardDefaults(r), id: id++ })); db.card_tx.push(...out); return structuredClone(out); },
    async updateCard(i, patch) { const r = db.card_tx.find(x => x.id === i); const before = { ...r }; Object.assign(r, pick(patch, CARD_COLS)); log.unshift({ id: log.length + 1, tbl: 'ledger_card_tx', row_id: String(i), action: 'update', actor: 'demo', before, after: { ...r }, at: new Date().toISOString() }); return { ...r }; },
    async deleteCard(i) { db.card_tx = db.card_tx.filter(x => x.id !== i); },
    async insertBank(rows) { const out = rows.map(r => ({ ...pick(r, BANK_COLS), id: id++ })); db.bank_tx.push(...out); return structuredClone(out); },
    async updateBank(i, patch) { const r = db.bank_tx.find(x => x.id === i); Object.assign(r, pick(patch, BANK_COLS)); return { ...r }; },
    async deleteBank(i) { db.bank_tx = db.bank_tx.filter(x => x.id !== i); },
    // 서버 함수 ledger_import_bank_core와 같은 규칙(데모용)
    async importBank(account, rows, synced) {
      const m = db.docs.master || {}; const open = m.opening_date || '1900-01-01'; const r0 = { inserted: 0, matched: 0, duplicate: 0, before_opening: 0 }; let last = null;
      for (const r of rows.slice().sort((a, b) => a.source_ref.localeCompare(b.source_ref))) {
        if (r.tx_date < open) { r0.before_opening++; continue; } if (!last || r.source_ref > last.source_ref) last = r;
        if (db.bank_tx.some(b => b.source_ref === r.source_ref)) { r0.duplicate++; continue; }
        const hit = db.bank_tx.filter(b => b.account === account && b.tx_date === r.tx_date && (b.deposit || 0) === r.deposit && (b.withdrawal || 0) === r.withdrawal && !String(b.source_ref || '').startsWith('toss|') && b.source !== 'toss').sort((a, b) => a.id - b.id)[0];
        if (hit) { hit.source_ref = r.source_ref; if (!hit.note) hit.note = r.note; r0.matched++; continue; }
        let category = '', fixed = false;
        if (r.kind === '이자입금') category = '부수입'; else if (r.kind === '자동이체') { category = '고정'; fixed = true; } else if (r.deposit > 0 && (m.incomes || []).some(i => Number(i.amount) === r.deposit)) category = '급여';
        else { const prev = db.bank_tx.filter(b => b.account === account && b.memo === r.memo && b.category && b.source === 'toss' && (b.deposit > 0) === (r.deposit > 0)).sort((a, b) => b.tx_date.localeCompare(a.tx_date) || b.id - a.id)[0]; if (prev) { category = prev.category; fixed = !!prev.fixed; } }
        db.bank_tx.push({ id: id++, tx_date: r.tx_date, account, memo: r.memo, deposit: r.deposit, withdrawal: r.withdrawal, category, fixed, note: r.note, source: 'toss', source_ref: r.source_ref }); r0.inserted++;
      }
      m.bank_sync = { ...(m.bank_sync || {}), [account]: { synced, at: new Date().toISOString(), ref: 'app', last_date: last && last.tx_date, last_ref: last && last.source_ref, balance: last && last.balance } }; db.docs.master = m;
      return r0;
    },
    async setBill(bill_month, card, actual, note) { db.card_bills = db.card_bills.filter(b => !(b.bill_month === bill_month && b.card === card)); const row = { bill_month, card, actual, note: note || '' }; db.card_bills.push(row); return row; },
    async saveClose(month, snapshot, memo) { db.closes = db.closes.filter(c => c.month !== month); const row = { month, snapshot, memo: memo || '', closed_at: new Date().toISOString(), closed_by: 'demo' }; db.closes.push(row); return row; },
    async audit() { return log; },
  };
}
