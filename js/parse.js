// 카드사 원본 파일(롯데·현대 HTML형 xls, 국민 xls) → 공통 행
export const norm = v => (v === null || v === undefined) ? '' : String(v).replace(/\s+/g, '');
export const toInt = v => { if (v === null || v === undefined || v === '') return 0; if (typeof v === 'number') return Math.round(v); const s = String(v).replace(/[^\d.\-]/g, ''); const n = parseFloat(s); return isNaN(n) ? 0 : Math.round(n); };
const pad = n => String(n).padStart(2, '0');
export function pdate(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && v > 40000 && v < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  const m = String(v ?? '').match(/^\s*(\d{4})\D+(\d{1,2})\D+(\d{1,2})/); return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
}
export function ptime(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) { const s = Math.round(v * 86400); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}`; }
  const m = String(v ?? '').match(/^\s*(\d{1,2}):(\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : '';
}
const ISS = { '이용일자': 'lotte', '이용일': 'kb', '승인일': 'hd' };
const apr = v => norm(v).split('.')[0].replace(/^0+(?=.)/, '');
function rowOf(iss, get) {
  if (iss === 'lotte') {
    const d = pdate(get('이용일자')); if (!d) return null;
    const raw = toInt(get('이용금액')), canc = norm(get('취소여부')).toUpperCase() === 'Y', camt = Math.abs(toInt(get('취소금액'))); const amt = Math.max(0, raw - (canc ? (camt || raw) : 0)); // 롯데 파일은 취소금액이 음수(−)로 나옴
    return { used_date: d, used_time: ptime(get('이용시간')), merchant: String(get('이용가맹점') ?? '').trim(), raw_amount: raw, amount: amt, canceled: canc && amt === 0, inst_months: norm(get('이용구분')) === '일시불' ? 0 : toInt(get('할부개월')),
      status: (canc ? '취소' : '') + (norm(get('매입여부')).toUpperCase() === 'Y' ? '매입' : ''), approval_no: apr(get('승인번호')), pay_due: null, issuer_discount: 0, onnuri: Math.min(toInt(get('온누리상품권사용금액')), Math.max(0, amt)), raw: { 포인트사용: toInt(get('포인트사용')), 업종: String(get('업종') ?? ''), 이용카드: String(get('이용카드') ?? ''), 이용구분: String(get('이용구분') ?? '') } };
  }
  if (iss === 'kb') {
    const d = pdate(get('이용일')); if (!d) return null;
    const raw = toInt(get('국내이용금액(원)')), st = norm(get('상태')), canc = st.includes('취소'); const m = norm(get('결제방법')).replace('일시불', '').match(/(\d+)/);
    return { used_date: d, used_time: ptime(get('이용시간')), merchant: String(get('이용하신곳') ?? '').trim(), raw_amount: raw, amount: canc ? 0 : raw, canceled: canc, inst_months: m ? Number(m[1]) : 0, status: st, approval_no: apr(get('승인번호')), pay_due: pdate(get('결제예정일')), issuer_discount: toInt(get('할인금액')),
      raw: { 이용고객명: String(get('이용고객명') ?? ''), 이용카드명: String(get('이용카드명') ?? ''), 결제방법: String(get('결제방법') ?? ''), 해외: String(get('해외이용금액($)') ?? '') } };
  }
  const d = pdate(get('승인일')); if (!d) return null;
  const raw = toInt(get('승인금액')), st = norm(get('승인구분')), canc = st.includes('취소');
  return { used_date: d, used_time: ptime(get('승인시각')), merchant: String(get('가맹점명') ?? '').trim(), raw_amount: raw, amount: canc ? 0 : raw, canceled: canc, inst_months: norm(get('이용구분')) === '일시불' ? 0 : toInt(get('할부개월')), status: st, approval_no: apr(get('승인번호')), pay_due: null, issuer_discount: 0,
    raw: { 카드구분: String(get('카드구분') ?? ''), 이용구분: String(get('이용구분') ?? ''), 취소일: String(get('취소일') ?? '') } };
}
export function gridFromBuffer(buf) {
  const bytes = new Uint8Array(buf); let i = 0; while (i < bytes.length && (bytes[i] === 13 || bytes[i] === 10 || bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 0xEF || bytes[i] === 0xBB || bytes[i] === 0xBF)) i++;
  if (bytes[i] === 0x3C) { // HTML
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(bytes), 'text/html');
    return [...doc.querySelectorAll('tr')].map(tr => [...tr.children].filter(c => /^T[DH]$/.test(c.tagName)).map(c => c.textContent.trim()));
  }
  const wb = window.XLSX.read(bytes, { type: 'array' }); const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}
export function parseGrid(grid) {
  for (let i = 0; i < Math.min(grid.length, 60); i++) {
    const n = grid[i].map(norm); const hit = n.find(v => ISS[v]);
    if (!hit || !n.includes('승인번호')) continue;
    const iss = ISS[hit]; const hdr = {}; n.forEach((v, j) => { if (v && !(v in hdr)) hdr[v] = j; });
    const rows = [];
    for (const r of grid.slice(i + 1)) { const t = rowOf(iss, name => (name in hdr) ? r[hdr[name]] : null); if (t) rows.push(t); }
    // 같은 승인번호·날짜가 한 파일에 두 번 나오면 합침(취소 전표)
    const map = new Map(); const out = [];
    for (const t of rows) { const k = t.approval_no ? `${t.approval_no}|${t.used_date}` : null; if (k && map.has(k)) { const p = map.get(k); if (t.canceled || p.canceled) { p.canceled = true; p.amount = 0; p.status = '취소'; } else { p.amount += t.amount; p.raw_amount += t.raw_amount; } } else { if (k) map.set(k, t); out.push(t); } }
    return { issuer: iss, rows: out };
  }
  return { issuer: null, rows: [] };
}
export function pickCard(master, issuer, rows) {
  const cands = (master.cards || []).filter(c => c.issuer === issuer); if (!cands.length) return null;
  if (issuer === 'kb') { const nm = (rows.find(r => r.raw && r.raw.이용고객명) || { raw: {} }).raw.이용고객명 || ''; const c = cands.find(c => c.person && nm.includes(c.person)); return c || (cands.length === 1 ? cands[0] : null); }
  return cands[0];
}
export const cardKey = r => r.approval_no ? `${r.card}|${r.approval_no}|${r.used_date}` : `${r.card}||${r.used_date}|${r.used_time}|${r.merchant}|${r.raw_amount}`;

// 토스뱅크 거래내역 엑셀(암호 해제 후) → 통장 거래. 서버 함수 ledger_import_bank와 같은 형식
export function parseTossGrid(grid) {
  let hdr = null, synced = null; const rows = [];
  for (const raw of grid) {
    const v = (raw || []).map(x => x === undefined || x === null ? '' : x);
    const pi = v.findIndex(x => x === '조회기간'); if (pi >= 0 && v[pi + 1]) synced = String(v[pi + 1]).split('-').pop().trim().replace(/\./g, '-');
    if (!hdr) { if (v.includes('거래 일시') && v.includes('거래 후 잔액')) { hdr = {}; v.forEach((k, i) => { if (k) hdr[k] = i; }); } continue; }
    const dt = String(v[hdr['거래 일시']] || '').trim(); if (!/^\d{4}\.\d{2}\.\d{2}/.test(dt)) continue;
    const amt = Math.round(Number(String(v[hdr['거래 금액']]).replace(/,/g, '')) || 0); const balRaw = v[hdr['거래 후 잔액']]; const bal = balRaw === '' ? '' : Math.round(Number(String(balRaw).replace(/,/g, '')));
    const memo = String(v[hdr['적요']] || '').trim(), m2 = hdr['메모'] !== undefined ? String(v[hdr['메모']] || '').trim() : '';
    const kind = String(v[hdr['거래 유형']] || '').trim(), inst = String(v[hdr['거래 기관']] || '').trim();
    const [d, t] = dt.split(' '); const date = d.replace(/\./g, '-');
    rows.push({ tx_date: date, memo: (memo + (m2 ? ' · ' + m2 : '')).slice(0, 80), kind, deposit: Math.max(amt, 0), withdrawal: Math.max(-amt, 0), balance: bal === '' ? null : bal, note: (kind + (inst ? ' · ' + inst : '')).slice(0, 200), source_ref: `toss|${date} ${t || ''}|${amt}|${bal}` });
  }
  return hdr ? { bank: '토스뱅크', synced, rows } : null;
}
