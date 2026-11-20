import * as C from './calc.js?v=23';
import { supabaseStore, demoStore } from './store.js?v=23';
import { gridFromBuffer, parseGrid, pickCard, cardKey, parseTossGrid } from './parse.js?v=23';
import { decryptOffice, isEncryptedOffice } from './decrypt.js?v=23';
import { bioAvailable, bioEnabled, bioEnable, bioDisable, bioUnlock, bioAsked, markAsked } from './biolock.js?v=23';
import { esc, won, signed, pct, toNum, fmtDigits, monthLabel, personClass, who, parseDate, dateInput, toast, openModal, closeModal, moneyInput, options, bar, listEditor, readList, addRow } from './ui.js?v=23';

const app = document.querySelector('#app');
const S = { store: null, session: null, member: null, data: null, ctx: null, month: C.todayStr().slice(0, 7), route: 'home', sub: '', cardFilter: { card: '', kind: '' }, bankFilter: '모임통장', sel: new Set(), bulkCat: '', bankSort: 'desc', billOpen: '', cfOpen: (() => { try { return localStorage.getItem('ol_cfopen') === '1'; } catch { return false; } })(), flash: '', stage: {}, busy: false, authMode: 'in' };
const LISTS = {};
const NAV = [['home', '홈', '⌂'], ['cards', '카드', '▤'], ['bank', '통장', '⇄'], ['bills', '카드대금', '₩'], ['fixed', '고정지출', '▣'], ['more', '더보기', '⋯']];
const MORE = [['budget', '예산', '변동지출 기본 예산과 월별 조정'], ['inst', '할부', '할부 청구 일정'], ['loans', '대출', '잔액과 상환 계획'], ['onnuri', '온누리', '개인 사용 누계·공용 충전 잔액'], ['goals', '목표', '5천만 목표·시나리오·가족행사'], ['tax', '연말정산', '카드공제 예상'], ['trend', '월별 추이', '월별 실적 한눈에'], ['closes', '월 마감 기록', '마감한 달의 숫자 보관'], ['master', '기초 데이터', '통장·카드·수입·고정지출·자동분류'], ['data', '데이터 관리', '가져오기·내보내기·엑셀 대조'], ['audit', '변경 이력', '누가 무엇을 바꿨는지'], ['account', '계정', '초대 코드·로그아웃']];

const master = () => S.data.docs.master || {};
const doc = k => S.data.docs[k];
function rebuild() { const d = S.data.docs; S.ctx = C.buildCtx({ master: d.master || {}, goals: d.goals || {}, installments: d.installments || [], loans: d.loans || [], tax: d.tax || {}, card_tx: S.data.card_tx, bank_tx: S.data.bank_tx, card_bills: S.data.card_bills }); }
async function run(fn, okMsg) { if (S.busy) return; S.busy = true; document.body.classList.add('busy'); try { await fn(); if (okMsg) toast(okMsg); } catch (e) { console.error(e); toast(e.message || '오류가 발생했습니다.', true); } finally { S.busy = false; document.body.classList.remove('busy'); } }
async function saveDoc(key, value, msg = '저장했습니다.') { await run(async () => { await S.store.saveDoc(key, value); S.data.docs[key] = value; rebuild(); render(); }, msg); }

// ---------- 시작
async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) { const seed = await (await fetch(q.get('demo') || './seed.json')).json(); S.store = demoStore(seed); }
  else S.store = supabaseStore();
  S.store.onAuth((ev) => { if (ev === 'SIGNED_OUT') { S.session = null; S.member = null; S.data = null; render(); } });
  window.addEventListener('hashchange', () => { parseHash(); render(); window.scrollTo(0, 0); });
  parseHash(); await enter();
  if ('serviceWorker' in navigator && !q.has('demo')) navigator.serviceWorker.register('./sw.js').catch(() => { });
}
function parseHash() { const [r, sub] = location.hash.replace(/^#\/?/, '').split('/'); S.route = NAV.some(n => n[0] === r) ? r : 'home'; S.sub = sub || ''; }
async function enter() {
  app.innerHTML = '<div class="boot">불러오는 중…</div>';
  try {
    S.session = await S.store.session(); if (!S.session) return render();
    if (S.store.mode !== 'demo' && bioEnabled() && !S.unlocked) { if (Date.now() - lastSeen() < LOCK_AFTER) S.unlocked = true; else { await lockScreen(); return; } }
    S.member = await S.store.membership(); if (!S.member) return render();
    S.data = await S.store.loadAll(); await migrate(); rebuild();
    const months = C.monthsWithData(S.ctx); if (!months.length && !S.data.docs.master) { location.hash = '#/more/data'; }
    render(); setTimeout(offerBio, 800);
  } catch (e) { console.error(e); app.innerHTML = `<div class="boot">연결하지 못했습니다.<br><small>${esc(e.message)}</small><br><button class="btn" onclick="location.reload()">다시 시도</button></div>`; }
}

// ---------- 용돈(개인 몫) 남은 금액: 예산(기본+식대) − 이번 달 용돈 카드 사용 − 이번 달 가불 − 지난달 초과·가불로 이번 달 이체에서 뺀 금액
const allowLeft = a => a.budget - a.used - a.advance - a.deducted;
const sum = (xs, f) => xs.reduce((t, x) => t + (Number(f(x)) || 0), 0);
// 용돈 쓴 내역 집계: 내용(라벨)이 같은 것끼리, 금액 큰 순
const aggBy = rows => { const g = new Map(); rows.forEach(r => { const k = (r.label || r.merchant || '기타').replace(/\s*\(.*\)$/, ''); const o = g.get(k) || { k, n: 0, v: 0 }; o.n++; o.v += r.applied; g.set(k, o); }); return [...g.values()].sort((a, b) => b.v - a.v); };
// 이달 진행: 날짜 경과 대비 공동 변동예산 소진율(예산이 날짜보다 빨리 줄면 경고색)
function progressBox(s, m) {
  const dim = new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate(), passed = dim - s.daysLeft, dRate = dim ? passed / dim : 1;
  const bRate = s.sharedBudget ? s.sharedActual / s.sharedBudget : 0, fast = bRate > dRate + 0.05;
  const perDay = s.daysLeft > 0 ? Math.max(0, s.result.remain.variable) / s.daysLeft : 0;
  const bar = (r, cls) => `<span class="pg-bar"><i class="${cls}" style="width:${Math.min(100, Math.round(r * 100))}%"></i>${r > 1 ? '<em class="over"></em>' : ''}</span>`;
  return `<div class="progbox"><div class="as-h"><span class="nolink">이달 진행</span><small>${s.daysLeft > 0 ? `남은 ${s.daysLeft}일` : '마감'}</small></div>
    <div class="pg"><span class="pg-l">날짜</span>${bar(dRate, 'd')}<b>${passed} / ${dim}일</b></div>
    <div class="pg"><span class="pg-l">공동 예산</span>${bar(bRate, fast ? 'b warn' : 'b')}<b class="${bRate > 1 ? 'neg' : ''}">${Math.round(bRate * 100)}%</b></div>
    <p class="pg-note">${s.daysLeft > 0 ? (fast ? `날짜보다 예산이 빨리 줄고 있어요 · 남은 공동 변동예산 하루 ${won(perDay)}` : `날짜 속도 안쪽이에요 · 남은 공동 변동예산 하루 ${won(perDay)}`) : `공동 변동예산 ${won(s.sharedActual)} / ${won(s.sharedBudget)}`}</p></div>`;
}
function allowStrip(s) {
  const ps = (s.persons || []).filter(p => s.allowance[p] && s.allowance[p].budget); if (!ps.length) return '';
  return `<div class="allowstrip tap" data-act="breakdown" data-k="allow" role="button" tabindex="0"><div class="as-h"><span>용돈 (개인 몫) ›</span><small>이번 달 예산 기준 · 식대 포함</small></div>${ps.map(p => { const a = s.allowance[p], v = allowLeft(a); return `<div class="as-p">${who(p)}<span class="as-n">${esc(p)}<small>예산 ${won(a.budget)} · 사용 ${won(a.used + a.advance)}</small></span><b class="${v < 0 ? 'neg' : ''}">${v < 0 ? '▲ ' + won(-v) + ' 초과' : won(v) + ' 남음'}</b></div>`; }).join('')}</div>`;
}
// ---------- 홈 금액 상세(수입·쓴 돈·남은 예산)
function breakdownModal(kind) {
  const m = S.month, s = C.monthSummary(S.ctx, m), R = s.result, mo = Number(m.slice(5));
  const line = (name, amt, sub = '', cls = '') => `<div class="bd ${cls}"><span>${name}${sub ? `<small>${sub}</small>` : ''}</span><b>${won(amt)}</b></div>`;
  const group = (title, total, body, open = false) => `<details class="bdg" ${open ? 'open' : ''}><summary><span>${title}</span><b>${won(total)}</b></summary><div class="bdb">${body || '<p class="muted small">없음</p>'}</div></details>`;
  let html = '';
  if (kind === 'spent') {
    const rows = S.ctx.rows.filter(r => r.useMonth === m && r.applied);
    const cat = r => r.fixed ? '고정(카드)' : r.resale ? '리셀' : r.category || '미분류';
    const by = {}; rows.forEach(r => { const k = cat(r); (by[k] = by[k] || []).push(r); });
    const order = ['고정(카드)', '식비', '낚시', '용돈', '용돈가불', '기타', '미분류']; const keys = Object.keys(by).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99 || a.localeCompare(b));
    const cardBody = keys.map(k => { const list = by[k].sort((a, b) => b.applied - a.applied); const t = list.reduce((a, r) => a + r.applied, 0);
      return `<details class="bdg sub ${k === '미분류' ? 'warnbox' : ''}"><summary><span>${k === '미분류' ? '! ' : ''}${esc(k)} <small>${list.length}건</small></span><b>${won(t)}</b></summary><div class="bdb">${list.map(r => line(`${who(r.person)}${esc(r.label || r.merchant)}`, r.applied, `${r.used_date.slice(5).replace('-', '/')} · ${esc(r.card)}${r.K > 1 ? ` · ${r.K}개월 할부 첫 달` : ''}`)).join('')}
        ${k === '미분류' ? `<a class="btn ghost sm" href="#/cards" data-act="todo" data-kind="un" data-flash="un">카드 화면에서 분류하기</a>` : ''}</div></details>`; }).join('');
    const inst = C.billInstItems(S.ctx, C.addMonth(m, 1)).filter(i => !(i.auto && i.nth === 1));
    const bank = S.ctx.bank.filter(b => b.tx_date.slice(0, 7) === m && C.bankGroup(b.category) === '지출' && b.category !== '고정');
    html = `<h2>${mo}월 쓴 돈 ${won(R.spent.total)}원</h2><p class="muted small">카드는 쓴 달 기준입니다. 미분류도 쓴 돈에 들어갑니다.</p>
      ${group('고정 이체 (현금)', R.spent.fixedCash, s.fixedCash.map(f => line(`${who(f.person)}${esc(f.name)}`, f.transfer, `${f.day}일 · ${esc(f.account)}${f.done ? ' · ✔ 완료' : ''}`)).join(''))}
      ${group(`카드 사용 (${rows.length}건)`, R.spent.card, cardBody, true)}
      ${group('할부 월 납입 (이전 구매분)', R.spent.inst, inst.map(i => line(`${who(i.person)}${esc(i.name)}`, i.amount, `${esc(i.card)} · ${i.nth}/${i.K}회 · 총 ${won(i.total)}`)).join(''))}
      ${group('통장 지출', R.spent.bank, bank.map(b => line(esc(b.memo), C.num(b.withdrawal) - C.num(b.deposit), `${b.tx_date.slice(5).replace('-', '/')} · ${esc(b.category)}`)).join(''))}`;
  } else if (kind === 'remain') {
    html = `<h2>${mo}월 공동 남은 예산 ${won(R.remain.variable + R.remain.fixedCard)}원</h2><p class="muted small">이번 달에 예산만큼 더 쓴다고 보고 남는 돈에서 미리 뺀 금액입니다. 예산을 넘긴 항목은 0으로 봅니다. 용돈은 개인 몫이라 따로 봅니다(식대 남은 금액만 남는 돈 계산에 포함).</p>
      ${group('변동지출', R.remain.variable, s.variable.map(v => line(esc(v.cat), Math.max(0, v.budget - v.actual), `예산 ${won(v.budget)} · 사용 ${won(v.actual)}${v.actual > v.budget ? ' · ▲ 초과' : ''}`)).join(''), true)}
      ${group('식대 (용돈 예산 중)', R.remain.meal, s.persons.filter(p => s.allowance[p].meal).map(p => { const a = s.allowance[p]; return line(`${who(p)}${p} 식대`, Math.max(0, a.meal - a.used), `식대 예산 ${won(a.meal)} · 용돈 사용 ${won(a.used)}`); }).join(''), true)}
      ${group('아직 결제 안 된 고정(카드)', R.remain.fixedCard, s.fixedCard.filter(f => f.status === '대기').map(f => line(`${who(f.person)}${esc(f.name)}`, f.budget, esc(f.card || ''))).join(''), true)}`;
  } else if (kind === 'allow') {
    const ps = s.persons.filter(p => s.allowance[p] && s.allowance[p].budget);
    const calcRow = (lab, amt, sub = '', cls = '') => `<div class="ac ${cls}"><span>${lab}${sub ? `<small>${sub}</small>` : ''}</span><b>${amt}</b></div>`;
    html = `<h2>${mo}월 용돈 <small class="muted">개인 몫</small></h2><p class="muted small">식대도 용돈 예산에 들어 있고, 공동 예산과는 따로 봅니다. 이번 달 예산만 계산하고, 초과분은 각자 비자금으로 채웁니다(다음 달로 넘기지 않음). 가불만 다음 달 용돈에서 갚습니다.</p>
      ${ps.map(p => { const a = s.allowance[p], v = allowLeft(a);
        const rows = S.ctx.rows.filter(r => r.useMonth === m && r.person === p && (r.category === '용돈' || r.category === '용돈가불') && r.applied).sort((x, y) => (x.used_date + (x.used_time || '')).localeCompare(y.used_date + (y.used_time || '')));
        return `<section class="acard"><header>${who(p)}<b>${esc(p)} 용돈</b><em class="${v < 0 ? 'neg' : 'pos'}">${v < 0 ? '▲ ' + won(-v) + ' 초과' : won(v) + ' 남음'}</em></header>
        <div class="acalc">${calcRow('예산', won(a.budget), `기본 ${won(a.base)}${a.meal ? ` + 식대 ${won(a.meal)}` : ''}`)}
          ${a.deducted ? calcRow('− 지난달 가불 상환', won(a.deducted), `가불은 다음 달 용돈에서 갚기로 한 돈 → 이번 달 이체 ${won(a.transfer)}`) : ''}
          ${calcRow('− 용돈 카드 사용', won(a.used), `${rows.filter(r => r.category === '용돈').length}건`)}
          ${a.advance ? calcRow('− 이번 달 가불', won(a.advance), '다음 달 이체에서 차감') : ''}
          ${calcRow(v < 0 ? '= 초과' : '= 남음', (v < 0 ? '▲ ' : '') + won(Math.abs(v)), '', 'tot ' + (v < 0 ? 'neg' : ''))}</div>
        <details class="alist" ${rows.length ? 'open' : ''}><summary><span>쓴 내역 ${rows.length}건</span><b>합계 ${won(sum(rows, r => r.applied))}</b></summary>${rows.length > 1 ? `<div class="agg">${aggBy(rows).map(g => `<span>${esc(g.k)} <small>${g.n}건</small> <b>${won(g.v)}</b></span>`).join('')}</div>` : ''}${rows.length ? rows.map(r => `<div class="al"><span class="d">${r.used_date.slice(5).replace('-', '/')}</span><span class="m">${esc(r.label || r.merchant)}<small>${esc(r.card)}${r.category === '용돈가불' ? ' · 가불' : ''}${r.memo ? ' · ' + esc(r.memo) : ''}</small></span><b>${won(r.applied)}</b></div>`).join('') : '<p class="muted small">이번 달 용돈 카드 사용이 없습니다.</p>'}</details></section>`; }).join('')}`;
  } else {
    const side = S.ctx.bank.filter(b => b.tx_date.slice(0, 7) === m && b.category === '부수입');
    html = `<h2>${mo}월 수입 ${won(s.income)}원</h2><p class="muted small">급여는 기초 데이터의 계획 금액, 부수입은 통장에 "부수입"으로 기록된 금액입니다. 영민 월급은 전월 말에 들어와도 이번 달 수입으로 봅니다.</p>
      ${group('급여', s.incomePlan, (master().incomes || []).map(i => line(`${who(i.person)}${esc(i.name)}`, i.amount, i.early ? '전월 말 입금 → 이번 달 1일 수입' : `${i.day}일 · ${esc(i.account)}`)).join(''), true)}
      ${group('부수입', s.side, side.map(b => line(esc(b.memo), C.num(b.deposit) - C.num(b.withdrawal), `${b.tx_date.slice(5).replace('-', '/')} · ${esc(b.account)}`)).join(''), true)}`;
  }
  openModal(`${html}<div class="actions"><button class="btn" data-act="modalClose">닫기</button></div>`);
}
// ---------- 모바일: 넓은 표를 카드형 줄로 바꿀 수 있게 각 칸에 제목을 붙인다(화면 폭이 좁을 때만 CSS가 적용)
function mobilize(root) {
  root.querySelectorAll('table.tbl').forEach(t => {
    if (t.classList.contains('board') || t.classList.contains('sched') || t.dataset.rt) return;
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim()); if (heads.length < 4) return;
    const mh = Number(t.dataset.mhead || 1); t.dataset.rt = '1'; t.classList.add('rt');
    t.querySelectorAll('tbody tr').forEach(tr => { const tds = [...tr.children]; if (tds.length === 1) { tr.classList.add('full'); return; }
      tds.forEach((td, i) => { if (i < mh) td.classList.add('h'); else td.dataset.l = heads[i] || ''; if (!td.textContent.trim() && !td.querySelector('input,button,select')) td.classList.add('e'); }); });
  });
}
// ---------- 지문·얼굴 잠금
// 마지막으로 앱을 본 시각을 기기에 남겨, 새로고침하거나 잠깐 다른 앱을 다녀와도 5분 안이면 다시 묻지 않는다
const LOCK_AFTER = 5 * 60 * 1000;
const lastSeen = () => { try { return Number(localStorage.getItem('ol_seen') || 0); } catch { return 0; } };
const markSeen = () => { if (!S.unlocked) return; try { localStorage.setItem('ol_seen', String(Date.now())); } catch { } };
setInterval(() => { if (!document.hidden) markSeen(); }, 20000);
window.addEventListener('pagehide', markSeen);
document.addEventListener('visibilitychange', () => { if (document.hidden) markSeen(); else if (S.unlocked && bioEnabled() && Date.now() - lastSeen() > LOCK_AFTER) { S.unlocked = false; enter(); } else markSeen(); });
async function lockScreen(auto = true) {
  app.innerHTML = `<div class="auth"><div class="card lock"><div class="lockicon" aria-hidden="true">🔒</div><h1>우리의 장부</h1><p class="muted">지문 또는 얼굴로 열어 주세요</p>
    <button class="btn wide" id="bioBtn">잠금 해제</button><p class="muted small" id="biomsg"></p><button class="link" id="pwBtn">비밀번호로 다시 로그인</button></div></div>`;
  const go = async () => { try { if (await bioUnlock()) { S.unlocked = true; markSeen(); await enter(); } } catch (e) { const m = document.querySelector('#biomsg'); if (m) m.textContent = '확인하지 못했습니다. 다시 눌러 주세요.'; } };
  document.querySelector('#bioBtn').onclick = go;
  document.querySelector('#pwBtn').onclick = () => run(async () => { bioDisable(); await S.store.signOut(); S.session = null; S.unlocked = false; render(); });
  if (auto) setTimeout(go, 150);
}
async function offerBio() {
  if (S.store.mode === 'demo' || bioEnabled() || bioAsked() || !(await bioAvailable())) return;
  openModal(`<h2>다음부터 지문으로 열까요?</h2><p class="muted small">이 기기의 지문·얼굴 인식으로 앱을 엽니다. 로그인은 유지되고, 생체 정보는 기기 밖으로 나가지 않습니다. 더보기 > 계정에서 언제든 끌 수 있습니다.</p>
    <div class="actions"><button class="btn ghost" id="bioNo">나중에</button><button class="btn" id="bioYes">지문으로 열기 켜기</button></div>`, sheet => {
    sheet.querySelector('#bioNo').onclick = () => { markAsked(); closeModal(); };
    sheet.querySelector('#bioYes').onclick = async () => { try { await bioEnable(S.session.user.email); S.unlocked = true; markSeen(); closeModal(); toast('다음부터 지문·얼굴로 열립니다.'); } catch { toast('설정하지 못했습니다. 더보기 > 계정에서 다시 시도해 주세요.', true); } };
  });
}

// ---------- 화면
function render() {
  if (!S.session) return viewAuth();
  if (!S.member) return viewJoin();
  if (!S.data) return;
  const body = ({ home: viewHome, cards: viewCards, bank: viewBank, bills: viewBills, fixed: viewFixed, more: viewMore })[S.route]();
  const title = S.route === 'more' && S.sub ? (MORE.find(m => m[0] === S.sub) || [])[1] : NAV.find(n => n[0] === S.route)[1];
  const monthless = S.route === 'more' && !['budget', 'inst', 'loans'].includes(S.sub);
  app.innerHTML = `<div class="shell">
  <aside class="side"><div class="brand"><b>우리의 장부</b><small>${esc(S.member.household.name)}</small></div>
    <nav>${NAV.map(n => `<a href="#/${n[0]}" class="${S.route === n[0] ? 'on' : ''}"><i>${n[2]}</i>${n[1]}</a>`).join('')}</nav>
    <div class="sidefoot">${esc(S.member.me?.display_name || '')} · <a href="#/more/account">계정</a></div></aside>
  <main><header class="top"><div class="ttl">${S.route === 'more' && S.sub ? '<a class="back" href="#/more">‹</a>' : ''}<h1>${esc(title)}</h1></div>
    ${monthless ? '' : `<div class="monthnav"><button data-act="month" data-d="-1" aria-label="이전 달">‹</button><label><input type="month" id="monthpick" value="${S.month}"><span>${monthLabel(S.month)}</span></label><button data-act="month" data-d="1" aria-label="다음 달">›</button></div>`}</header>
    <div class="content">${body}</div></main>
  <nav class="tabbar">${NAV.map(n => `<a href="#/${n[0]}" class="${S.route === n[0] ? 'on' : ''}"><i>${n[2]}</i>${n[1]}</a>`).join('')}</nav></div>`;
  const mp = document.querySelector('#monthpick'); if (mp) mp.onchange = () => { if (mp.value) { S.month = mp.value; render(); } };
  const bb = document.querySelector('#biobox'); if (bb) bioAvailable().then(ok => { bb.innerHTML = !ok ? '<span class="muted small">이 기기·브라우저는 지문·얼굴 잠금을 지원하지 않습니다.</span>' : bioEnabled() ? '<span class="tag ok">✔ 지문·얼굴 잠금 켜짐</span><button class="btn ghost sm" data-act="bioOff">끄기</button>' : '<span class="muted small">앱을 열 때 지문·얼굴로 확인합니다.</span><button class="btn sm" data-act="bioOn">지문·얼굴 잠금 켜기</button>'; });
  mobilize(app);
  if (S.flash) { S.flash = ''; setTimeout(() => document.querySelector('.flash')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60); }
}

function viewAuth() {
  const up = S.authMode === 'up';
  app.innerHTML = `<div class="auth"><div class="card"><h1>우리의 장부</h1><p class="muted">은경·영민 공동 가계부</p>
  <form id="authform"><label>이메일<input name="email" type="email" required autocomplete="username"></label><label>비밀번호 (6자 이상)<input name="password" type="password" minlength="6" required autocomplete="${up ? 'new-password' : 'current-password'}"></label>
  <button class="btn wide">${up ? '가입하기' : '로그인'}</button></form>
  <button class="link" data-act="authMode">${up ? '이미 계정이 있어요 → 로그인' : '처음이에요 → 가입하기'}</button><p class="muted small" id="authmsg"></p></div></div>`;
  document.querySelector('#authform').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); run(async () => {
    if (up) { const ok = await S.store.signUp(f.email, f.password); if (!ok) { document.querySelector('#authmsg').textContent = '가입 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 이 화면에서 로그인해 주세요. (링크를 눌렀을 때 빈 화면이 떠도 정상입니다)'; S.authMode = 'in'; return; } }
    else await S.store.signIn(f.email, f.password);
    S.unlocked = true; markSeen(); await enter(); setTimeout(offerBio, 400);
  }); };
}
function viewJoin() {
  app.innerHTML = `<div class="auth"><div class="card"><h1>가계부 연결</h1><p class="muted">처음 만드는 사람은 새 가계부를, 초대받은 사람은 초대 코드를 입력하세요.</p>
  <form id="joinform"><label>내 이름<select name="display"><option>은경</option><option>영민</option></select></label><label>초대 코드 (새로 만들면 비워 두세요)<input name="code" autocomplete="off" placeholder="예: A1B2C3D4E5F6"></label><button class="btn wide">시작하기</button></form>
  <button class="link" data-act="logout">다른 계정으로 로그인</button></div></div>`;
  document.querySelector('#joinform').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); run(async () => { if (f.code.trim()) await S.store.join(f.code, f.display); else await S.store.create('은경·영민 가계부', f.display); await enter(); }); };
}

const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
const sec = (title, body, extra = '') => `<section class="card"><div class="sechead"><h2>${title}</h2>${extra}</div>${body}</section>`;
const tag = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;

const fl = (key, cond = true) => S.flash === key && cond ? ' flash' : '';
function viewHome() {
  const m = S.month, s = C.monthSummary(S.ctx, m), g = C.goalTracker(S.ctx), ms = master();
  if (!ms.cards) return `<section class="card empty">아직 데이터가 없습니다. <a href="#/more/data">데이터 관리</a>에서 이관 파일을 가져와 주세요.</section>`;
  const closed = S.data.closes.find(c => c.month === m); const ck = s.check; const mo = Number(m.slice(5)); const today = C.todayStr(); const isCur = today.slice(0, 7) === m, td = Number(today.slice(8));
  const todo = [[ck.unclassified, '미분류 카드', `${ck.unclassified}건`, '카테고리를 고른 뒤 한 번에 반영하세요', '#/cards', 'un', 'un'], [ck.bankReview, '통장 미분류', `${ck.bankReview}건`, '분류가 비어 있는 통장 거래', '#/bank', 'bankun'], [ck.unsettled, '정산 미수', `${ck.unsettled}건`, '아직 돌려받지 못한 돈', '#/cards', 'settle', 'settle'],
    [ck.fixedWaiting, '고정(카드) 결제 대기', `${ck.fixedWaiting}건`, '이번 달 결제가 아직 안 잡힌 고정 항목', '#/fixed', 'fixedwait'], [ck.billsMissing, '청구서 미입력', `${ck.billsMissing}건`, '카드사 청구 금액을 넣어 주세요', '#/bills', 'billmissing'], [ck.billsOver, '청구액이 승인보다 큼', `${ck.billsOver}건`, '빠진 카드 내역이 있는지 확인', '#/bills', 'billover'],
    [ck.newInstallments, '이번 달 새 할부 결제', `${ck.newInstallments}건`, '할부로 결제한 건이 맞는지 확인(다음 달부터 나눠 청구)', '#/cards', 'inst', 'inst'], [ck.carryAdvance, '이월 중인 가불', `${won(ck.carryAdvance)}원`, '다음 달 용돈에서 차감 예정', '', '']].filter(t => t[0]);
  const alRow = (label, f, cls = '') => `<tr class="${cls}"><td>${label}</td>${s.persons.map(p => `<td class="r">${f(s.allowance[p])}</td>`).join('')}</tr>`;
  const R = s.result; const parts = [['고정 이체', R.spent.fixedCash, 'a'], ['카드 사용', R.spent.card, 'b'], ['할부 납입', R.spent.inst, 'd'], ['통장 지출', R.spent.bank, 'f'], ['남은 예산', R.remain.total, 'c']].filter(p => p[1] > 0);
  const vRate = s.sharedBudget ? s.sharedActual / s.sharedBudget : null; const unsettled = C.unsettled(S.ctx);
  const cf = s.cashflow; let marked = false;
  // 지난 실제 내역은 접어 두고, 지금 잔액부터 앞으로의 흐름이 먼저 보이게 한다 (펼치면 바로 확인)
  const pastN = cf.rows.filter(r => r.actual).length, futN = cf.rows.length - pastN, fold = pastN > 0 && futN > 0;
  const lastAct = fold ? [...cf.rows].reverse().find(r => r.actual) : null;
  const pastIn = fold ? cf.rows.filter(r => r.actual).reduce((a, r) => a + r.inn, 0) : 0, pastOut = fold ? cf.rows.filter(r => r.actual).reduce((a, r) => a + r.out, 0) : 0;
  const cvLabel = cf.covered ? `${Number(cf.covered.slice(5, 7))}월 ${Number(cf.covered.slice(8))}일` : '';
  const tlRows = cf.rows.map(t => { let pre = ''; if (!marked && !t.actual && cf.rows.some(r => r.actual)) { marked = true; pre = fold ? `<tr class="sum nowbal"><td></td><td>지금 잔액 <small class="muted">${cvLabel}까지 실제 통장</small></td><td></td><td></td><td class="r"><b class="${lastAct.bal < 0 ? 'neg' : ''}">${won(lastAct.bal)}</b></td></tr><tr class="today"><td colspan="5">▼ 앞으로 예정</td></tr>` : `<tr class="today"><td colspan="5">${cvLabel ? `${cvLabel}까지 실제 통장 내역` : ''} ▼ 아래는 앞으로 예정</td></tr>`; }
    const det = t.detail ? `<br><small class="muted">${t.detail.map(d => `${esc(d.name)} ${won(d.amount)}`).join(' · ')}</small>` : t.note ? `<br><small class="muted">${esc(t.note)}</small>` : '';
    return `${pre}<tr class="${t.actual ? 'past' : ''}${t.actual && fold ? ' cfpast' : ''} ${t.next ? 'nextpay' : ''}"><td class="r">${t.day}일</td><td>${t.actual ? `<span class="src">실제</span>${t.category ? tag(t.category, 'cat') + ' ' : tag('! 미분류', 'warn') + ' '}` : t.estimated ? '<span class="src est">예정·승인기준</span>' : '<span class="src est">예정</span>'}${who(t.person)}${esc(t.label)}${det}</td><td class="r pos">${t.inn ? '+' + won(t.inn) : ''}</td><td class="r">${t.out ? '−' + won(t.out) : ''}</td><td class="r">${t.bal === null ? '' : `<b class="${t.bal < 0 ? 'neg' : ''}">${t.bal < 0 ? '▲ ' : ''}${won(t.bal)}</b>`}</td></tr>`; }).join('');
  const vrow = (name, sub, actual, budget, perDay) => { const left = budget - actual; return `<div class="vrow"><div class="vhead"><b>${name}</b><span><b>${won(actual)}</b> <small>/ ${won(budget)}</small></span></div>${bar(actual, budget)}<div class="vfoot"><span>${left < 0 ? tag(`▲ 초과 ${won(-left)}`, 'over') : `남음 ${won(left)}`}${sub ? ` · ${sub}` : ''}</span><span>${perDay === null || perDay === undefined ? '' : `하루 ${won(perDay)}`}</span></div></div>`; };
  return `
  <section class="hero hero2">
    <div class="hero-l"><div class="hero-main"><span>${mo}월 ${R.open ? '예상 ' : ''}남는 돈 <small>(카드는 쓴 달 기준)</small></span><b class="${s.canSave < 0 ? 'neg' : ''}">${s.canSave < 0 ? '▲ ' : ''}${won(s.canSave)}<small>원</small></b><em>${R.open ? `지금까지 쓴 돈만 빼면 ${won(R.leftNow)} · 남은 예산을 다 쓴다고 가정` : '이 달 확정 실적'}</em></div>
    <div class="flow"><div class="tap" data-act="breakdown" data-k="income" role="button" tabindex="0"><span>수입 ›</span><b>${won(s.income)}</b><small>급여 ${won(s.incomePlan)}${s.side ? ` + 부수입 ${won(s.side)}` : ''}</small></div><i>−</i>
      <div class="tap" data-act="breakdown" data-k="spent" role="button" tabindex="0"><span>쓴 돈 ›</span><b>${won(R.spent.total)}</b><small>고정 + 카드 사용 + 할부 + 통장</small></div>${R.open ? `<i>−</i><div class="tap" data-act="breakdown" data-k="remain" role="button" tabindex="0"><span>공동 남은 예산 ›</span><b>${won(R.remain.variable + R.remain.fixedCard)}</b><small>변동 ${won(R.remain.variable)} · 고정 대기 ${won(R.remain.fixedCard)}</small></div>${R.remain.meal ? `<i>−</i><div class="tap" data-act="breakdown" data-k="remain" role="button" tabindex="0"><span>용돈 식대 남음 ›</span><b>${won(R.remain.meal)}</b><small>카드로 쓸 식대 예산</small></div>` : ''}` : ''}<i>=</i>
      <div><span>남는 돈</span><b>${won(s.canSave)}</b><small>저축·상환 여력</small></div></div></div>
    <div class="hero-r">${allowStrip(s)}${progressBox(s, m)}</div>
    <div class="stack" role="img" aria-label="수입 대비 지출 구성">${parts.map(p => `<i class="sg-${p[2]}" style="flex:${p[1]}"></i>`).join('')}${s.canSave > 0 ? `<i class="sg-g" style="flex:${s.canSave}"></i>` : ''}</div>
    <div class="legend">${parts.map(p => `<span><i class="sg-${p[2]}"></i>${p[0]} <b>${won(p[1])}</b></span>`).join('')}${s.canSave > 0 ? `<span><i class="sg-g"></i>남는 돈 <b>${won(s.canSave)}</b></span>` : ''}</div>
  </section>
  <div class="kpis four">
    ${kpi('모임통장 예상 월말', cf.end === null ? '-' : won(cf.end), cf.nextSalary ? `다음 달 월급 ${won(cf.nextSalary)} 포함 · 빼면 <b>${won(cf.end - cf.nextSalary)}</b>` : !cf.tracked ? '기초잔액 기준일 이전 달' : `월초 ${won(cf.start)} · 월중 최저 ${won(cf.low)}`, cf.end < 0 || cf.low < 0 ? 'neg' : '')}
    ${kpi('공동 변동지출 사용', `${won(s.sharedActual)}`, `예산 ${won(s.sharedBudget)} 중 ${pct(vRate)} · 남은 ${s.daysLeft}일 (식대 제외)`, vRate > 1 ? 'neg' : '')}
    ${kpi('고정지출 이체', `${s.fixedCash.filter(f => f.done).length} / ${s.fixedCash.length} 완료`, `합계 ${won(s.fixedCashTotal)} · <a href="#/fixed">고정지출 보기</a>`)}
    ${kpi('목표 달성률', pct(g.rate), `${won(g.achieved)} / ${won((S.ctx.goals || {}).target)}`)}
  </div>
  ${todo.length ? `<section class="card"><div class="sechead"><h2>확인할 것 ${todo.length}가지</h2><span class="muted small">누르면 해당 화면으로 가서 고칠 곳을 표시합니다</span></div><div class="todos">${todo.map(t => { const inner = `<b class="tn">!</b><div><strong>${esc(t[1])} <em>${esc(t[2])}</em></strong><small>${esc(t[3])}</small></div>${t[4] ? '<i>›</i>' : ''}`; return t[4] ? `<a class="todoitem" href="${t[4]}" data-act="todo" data-flash="${t[5]}" ${t[6] !== undefined ? `data-kind="${t[6]}"` : ''}>${inner}</a>` : `<div class="todoitem">${inner}</div>`; }).join('')}</div></section>` : ''}
  <div class="grid2"><div class="col">
  ${sec('자금 흐름 · 모임통장 잔액', !cf.tracked ? '<div class="empty">기초잔액 기준일 이전 달이라 잔액을 계산하지 않습니다.</div>' : `${cf.check ? `<div class="chk ${cf.check.diff ? 'bad' : ''}">${cf.check.diff ? `▲ 은행 잔액과 ${won(Math.abs(cf.check.diff))}원 차이` : '✔ 은행 잔액과 일치'} <small>${cf.check.date} 기준 은행 ${won(cf.check.bank)} · 장부 ${won(cf.check.mine)}</small></div>` : ''}
    <table class="tbl tl${fold && S.cfOpen ? ' cfopen' : ''}" data-mhead="2"><thead><tr><th class="r">일</th><th>내용</th><th class="r">입금</th><th class="r">출금</th><th class="r">잔액</th></tr></thead><tbody>
    ${fold ? `<tr class="cffold"><td colspan="5"><button type="button" class="cfbtn" data-act="cfToggle" aria-expanded="${S.cfOpen ? 'true' : 'false'}"><span class="cfx">${S.cfOpen ? '▾ 지난 내역 접기' : '▸ 지난 내역 펼치기'}</span><span class="cfs">${pastN}건 · ${mo}월 1일~${Number((cf.covered || '').slice(8)) || ''}일 · 입금 +${won(pastIn)} · 출금 −${won(pastOut)}</span></button></td></tr>` : ''}
    <tr class="sum${fold ? ' cfpast' : ''}"><td></td><td>월초 잔액</td><td></td><td></td><td class="r">${won(cf.start)}</td></tr>${tlRows}
    <tr class="sum"><td></td><td>예상 월말${cf.nextSalary ? ` <small class="muted">다음 달 월급 빼면 ${won(cf.end - cf.nextSalary)}</small>` : ''}</td><td></td><td></td><td class="r ${cf.end < 0 ? 'neg' : ''}">${won(cf.end)}</td></tr></tbody></table>
    <p class="muted small">실제 = 통장에 기록된 거래, 예정 = 운영 규칙으로 만든 일정입니다. 월초(${cf.fixedDay}일)에 고정지출을 개인통장으로 한 번에 빼고, ${cf.cardDay}일에 급여를 받은 뒤 카드대금(청구서 금액, 없으면 승인기준)과 용돈을 개인통장으로 보내며, 카드사 자동이체는 개인통장에서 나갑니다. 날짜는 기초 데이터 > 분류·기준에서 바꿉니다.</p>`)}
  ${sec('통장 쪼개기 · 이번 달 필요액', `<table class="tbl"><thead><tr><th>통장</th><th class="r hide-s">고정(이체)</th><th class="r hide-s">카드대금</th><th class="r">필요액</th><th>처리</th></tr></thead><tbody>${s.split.map(x => `<tr><td>${who(x.person)}${esc(x.account)}</td><td class="r hide-s">${won(x.fixedCash)}</td><td class="r hide-s">${won(x.cardBill)}</td><td class="r">${won(x.need)}</td><td>${esc(x.action)}</td></tr>`).join('')}
    <tr class="sum"><td>합계</td><td class="hide-s"></td><td class="hide-s"></td><td class="r">${won(s.needTotal)}</td><td></td></tr></tbody></table>
    <p class="muted small">장부 잔액(오늘): ${s.balances.map(b => `${esc(b.account)} ${won(b.balance)}`).join(' · ')} · 월말 대출 잔액 ${won(s.loanTotal)}</p>`)}
  </div><div class="col">
  ${sec('변동지출 · 용돈', `<div class="vlist">${s.variable.map(v => vrow(esc(v.cat), '', v.actual, v.budget, v.perDay)).join('')}
    ${s.persons.map(p => { const a = s.allowance[p]; return vrow(`${who(p)}${p} 용돈`, a.meal ? `기본 ${won(a.base)} + 식대 ${won(a.meal)}` : '', a.used, a.budget, null); }).join('')}</div>
    <table class="tbl mt"><tbody>
    ${s.persons.filter(p => s.allowance[p].advance).map(p => `<tr><td>${who(p)}${p} 가불 <small class="muted">다음 달 용돈에서 차감</small></td><td class="r">${won(s.allowance[p].advance)}</td></tr>`).join('')}
    <tr><td>할부 <small class="muted">월 납입액(다음 달 청구분)</small></td><td class="r">${won(s.instNext)}</td></tr>
    <tr><td>기타 <small class="muted">카테고리 "기타"</small></td><td class="r">${won(s.etc)}</td></tr>
    ${s.misc ? `<tr><td>미분류 <small class="muted">아직 분류 안 한 카드</small></td><td class="r">${won(s.misc)}</td></tr>` : ''}
    ${s.bankMisc ? `<tr><td>기타 <small class="muted">통장·현금</small></td><td class="r">${won(s.bankMisc)}</td></tr>` : ''}${s.bankFamily ? `<tr><td>경조사·가족 <small class="muted">통장</small></td><td class="r">${won(s.bankFamily)}</td></tr>` : ''}
    <tr class="sum"><td>카드 사용 합계 <small class="muted">사용일 기준 반영액</small></td><td class="r">${won(s.cardTotal)}</td></tr></tbody></table>`, `<a class="link" href="#/more/budget">예산 편집</a>`)}
  ${sec('용돈 이체 계산', `<table class="tbl"><thead><tr><th></th>${s.persons.map(p => `<th class="r">${who(p)}${p}</th>`).join('')}</tr></thead><tbody>
    ${alRow('기본 용돈 (현금 이체)', a => won(a.base))}${ms.allowance_deduct_card !== false ? alRow('− 전월 카드 용돈 중 식대 예산 초과분', a => won(Math.min(a.cardDeduct, a.base)) + `<br><small class="muted">전월 ${won(a.prevUsed)}${a.prevMeal ? ` − 식대 ${won(a.prevMeal)}` : ''}${a.prevOver ? ` · 초과 ${won(a.prevOver)}은 개인 부담` : ''}</small>`) : ''}${alRow('− 전월 가불', a => won(a.prevAdvance))}${alRow('− 이월된 가불', a => won(a.prevCarry))}
    ${alRow('<b>= 이번 달 이체액</b>', a => `<b>${won(a.transfer)}</b>`, 'sum')}${alRow('다음 달로 이월되는 가불', a => won(a.carryOver))}</tbody></table>
    <p class="muted small">카드 분류는 "용돈" 하나로 통일하고, 예산은 기본 용돈 + 식대 예산을 합쳐서 봅니다. 예산을 넘겨 쓴 금액은 표시만 하고 넘기지 않습니다(개인 부담). "용돈가불"만 다음 달 이체액에서 빼고, 다 못 갚으면 이월합니다.</p>`)}
  ${unsettled.length ? sec(`정산 미수 ${unsettled.length}건 · ${won(unsettled.reduce((a, r) => a + r.settle, 0))}원`, `<table class="tbl"><tbody>${unsettled.map(r => `<tr><td>${who(r.person)}${esc(r.label || r.merchant)}<br><small class="muted">${r.used_date} · ${esc(r.card)}${r.memo ? ' · ' + esc(r.memo) : ''}</small></td><td class="r">${won(r.settle)}</td><td class="c"><button class="btn ghost sm" data-act="settleDone" data-id="${r.id}">받음</button></td></tr>`).join('')}</tbody></table>`) : ''}
  ${s.events.length ? sec('이번 달 가족행사', s.events.map(e => `<div class="line"><span>${esc(e.event)} (${esc(e.target)})</span><b>${won(e.amount)}</b></div>`).join('')) : ''}
  </div></div>
  <div class="row gap end"><span class="muted small">${closed ? `마감 저장: ${closed.closed_at.slice(0, 10)}` : '아직 마감하지 않은 달입니다.'}</span><button class="btn ghost" data-act="closeMonth">${closed ? '마감 다시 저장' : '월 마감 저장'}</button></div>`;
}
function viewFixed() {
  const m = S.month, s = C.monthSummary(S.ctx, m); const doneN = s.fixedCash.filter(f => f.done).length, wait = s.fixedCard.filter(f => f.status === '대기').length;
  return `<div class="kpis four">${kpi('고정 이체 합계', won(s.fixedCashTotal), `${s.fixedCash.length}개 항목`)}${kpi('이체 완료', `${doneN} / ${s.fixedCash.length}`, `남은 금액 ${won(s.fixedCash.filter(f => !f.done).reduce((a, f) => a + f.transfer, 0))}`)}${kpi('고정 카드 예산', won(s.fixedCardBudget), `승인 ${won(s.fixedCardActual)}`)}${kpi('카드 결제 대기', `${wait}건`, `${s.fixedCard.length}개 중 ${s.fixedCard.length - wait}개 결제됨`)}</div>
  <div class="grid2"><div class="col">${sec('고정지출 (현금·이체)', `<table class="tbl"><thead><tr><th>항목</th><th class="hide-s">출금계좌</th><th class="r">일</th><th class="r">이체액</th><th class="c">완료</th></tr></thead><tbody>
    ${s.fixedCash.map((f, i) => `<tr><td>${who(f.person)}${esc(f.name)}${f.allowance && f.transfer !== f.amount ? ` <small class="muted">(기본 ${won(f.amount)})</small>` : ''}${f.note ? `<br><small class="muted">${esc(f.note)}</small>` : ''}</td><td class="hide-s">${esc(f.account)}</td><td class="r">${f.day}일</td><td class="r">${won(f.transfer)}</td><td class="c"><button class="check ${f.done ? 'on' : ''}" data-act="fixedDone" data-i="${i}" title="이체 완료 기록" aria-label="${f.done ? '완료됨' : '미완료'}">${f.done ? '✔' : ''}</button></td></tr>`).join('')}
    <tr class="sum"><td>합계</td><td class="hide-s"></td><td></td><td class="r">${won(s.fixedCashTotal)}</td><td class="c">${doneN}/${s.fixedCash.length}</td></tr></tbody></table>
    <p class="muted small">완료 칸을 누르면 통장 거래(분류 "고정")가 함께 기록됩니다. 다시 누르면 그 기록을 지웁니다.</p>`, `<a class="link" href="#/more/master">항목 편집</a>`)}</div>
  <div class="col">${sec('고정지출 (카드)', `<table class="tbl"><thead><tr><th class="r">일</th><th>항목</th><th class="hide-s">카드</th><th class="r">예산</th><th class="r">승인</th><th class="c">상태</th></tr></thead><tbody>
    ${s.fixedCard.map(f => `<tr class="${fl('fixedwait', f.status === '대기').trim()}"><td class="r nowrap">${f.date ? `${Number(f.date.slice(8))}일` : f.expDay ? `<span class="muted" title="지난달 결제일·결제일 기준 예상">~${f.expDay === 31 ? '말' : f.expDay}일</span>` : '<span class="muted">-</span>'}</td><td>${who(f.person)}${esc(f.name)}${f.due ? `<br><small class="muted">${esc(f.due)}</small>` : ''}</td><td class="hide-s">${esc(f.card || '-')}</td><td class="r">${won(f.budget)}</td><td class="r">${f.actual ? won(f.actual) : ''}</td><td class="c">${f.status === '대기' ? tag('대기', 'wait') : f.status === '일치' ? tag('✔ 일치', 'ok') : tag(signed(f.diff), 'warn')}</td></tr>`).join('')}
    ${s.fixedCardOther.length ? `<tr><td></td><td colspan="2">그 외 고정 표시 ${s.fixedCardOther.length}건</td><td></td><td class="r">${won(s.fixedCardOther.reduce((a, r) => a + r.applied, 0))}</td><td class="c">${tag('! 항목명 확인', 'warn')}</td></tr>` : ''}
    <tr class="sum"><td></td><td>합계</td><td class="hide-s"></td><td class="r">${won(s.fixedCardBudget)}</td><td class="r">${won(s.fixedCardActual)}</td><td></td></tr></tbody></table>
    <p class="muted small">"대기"는 이번 달에 그 항목 이름으로 고정 표시된 카드 결제가 아직 없다는 뜻입니다. 결제일이 지나 카드 파일을 올리면 자동으로 채워집니다. 금액이 예산과 다르면 차이를 표시합니다.</p>`, `<a class="link" href="#/more/master">항목 편집</a>`)}</div></div>`;
}
function billTable(s, editable = false) {
  const items = editable ? C.billInstItems(S.ctx, s.month) : [];
  return `<table class="tbl"><thead><tr><th>카드</th><th class="r hide-s">결제일</th><th class="r">일시불</th><th class="r">할부</th><th class="r">승인기준</th><th class="r">실제청구</th>${editable ? '<th class="r hide-s">차액</th>' : ''}</tr></thead><tbody>
  ${s.bills.map(b => { const mine = items.filter(i => i.card === b.card); const open = editable && S.billOpen === b.card && mine.length;
    return `<tr class="${fl('billmissing', b.actual === null && b.expected > 0).trim()}${fl('billover', b.discount !== null && b.discount < 0)}"><td>${who(b.person)}${esc(b.card)}</td><td class="r hide-s">${b.payDay}일</td><td class="r">${won(b.lumpNet)}</td><td class="r">${editable && mine.length ? `<button class="exp" data-act="billOpen" data-card="${esc(b.card)}" aria-expanded="${open ? 'true' : 'false'}">${open ? '▾' : '▸'} ${won(b.installment)} <small>${mine.length}건</small></button>` : won(b.installment)}</td><td class="r"><b>${won(b.expected)}</b></td>
    <td class="r">${editable ? `<input class="billin" data-money inputmode="numeric" autocomplete="off" data-card="${esc(b.card)}" value="${b.actual === null ? '' : fmtDigits(b.actual)}" placeholder="청구서 금액">` : (b.actual === null ? tag('대기', 'wait') : won(b.actual))}</td>
    ${editable ? `<td class="r hide-s">${b.discount === null ? '' : (b.discount < 0 ? tag(`▲ ${won(-b.discount)} 더 청구`, 'over') : b.discount > 0 ? `−${won(b.discount)}` : tag('✔ 일치', 'ok'))}</td>` : ''}</tr>
    ${open ? `<tr class="sub"><td colspan="7"><table class="tbl sm"><thead><tr><th>할부 항목</th><th class="c">회차</th><th class="r">총액</th><th class="r">이번 달 납입</th></tr></thead><tbody>${mine.map(i => `<tr><td>${esc(i.name)}</td><td class="c">${i.nth}/${i.K}</td><td class="r">${won(i.total)}</td><td class="r">${won(i.amount)}</td></tr>`).join('')}</tbody></table></td></tr>` : ''}`; }).join('')}
  <tr class="sum"><td>합계</td><td class="hide-s"></td><td class="r">${won(s.billTotal.lump)}</td><td class="r">${won(s.billTotal.installment)}</td><td class="r">${won(s.billTotal.expected)}</td><td class="r">${s.billTotal.actual === null ? '' : won(s.billTotal.actual)}</td>${editable ? `<td class="r hide-s">${s.billTotal.discount === null ? '' : signed(-s.billTotal.discount)}</td>` : ''}</tr></tbody></table>`;
}
// ---------- 카드
const kindMatch = (r, k) => !k ? true : k === 'un' ? r.unclassified : k === 'fixed' ? !!r.fixed : k === 'settle' ? r.settle > 0 : k === 'onnuri' ? r.onnuri > 0 : k === 'inst' ? (r.K > 1 && r.amount > 0) : r.category === k;
function cardRows() {
  const f = S.cardFilter; const rs = S.ctx.rows.filter(r => r.useMonth === S.month && (!f.card || r.card === f.card) && kindMatch(r, f.kind));
  return rs.sort((a, b) => (b.used_date + b.used_time).localeCompare(a.used_date + a.used_time) || b.id - a.id);
}
// 미분류 건의 선택 상태(저장 전). 처음 볼 때 자동분류 제안을 미리 선택해 둔다.
function stageOf(r) {
  if (!S.stage[r.id]) { const sug = C.suggest(S.ctx, r); S.stage[r.id] = sug ? { category: sug.category, fixed: sug.fixed, label: sug.label, why: sug.why, auto: true } : { category: '', fixed: false, label: '', auto: false }; }
  return S.stage[r.id];
}
const stagePending = (r, st) => !!(st.category || st.fixed || (st.memo !== undefined && st.memo !== (r.memo || '')));
function stageList() { return S.ctx.rows.filter(r => r.useMonth === S.month && r.unclassified).map(r => ({ r, st: stageOf(r) })).filter(x => stagePending(x.r, x.st)); }
// 여러 건 선택(체크박스 · PC 우클릭) → 카테고리 한 번에 바꾸기
function bulkBar(rs) {
  const cats = master().card_categories || []; const allOn = rs.length && rs.every(r => S.sel.has(r.id)); const own = bulkOwn().length;
  const n = S.bulkCat ? S.sel.size : own;
  return `<div class="applybar bulk on" id="bulkbar"><span><b>${S.sel.size}건</b> 선택 <small class="muted">${S.bulkCat ? '→ 모두 아래에서 고른 분류로 바뀝니다' : `· 각 줄에서 고른 분류 ${own}건 반영 (아래를 누르면 선택 전체를 한 분류로)`}</small></span>
    <div class="pick">${cats.map(c => `<button class="pk ${S.bulkCat === c ? 'on' : ''}" data-act="bulkPick" data-cat="${esc(c)}">${S.bulkCat === c ? '✔ ' : ''}${esc(c)}</button>`).join('')}<button class="pk fx ${S.bulkCat === '__fixed' ? 'on' : ''}" data-act="bulkPick" data-cat="__fixed">${S.bulkCat === '__fixed' ? '✔ ' : ''}고정</button><button class="pk ${S.bulkCat === '__none' ? 'on' : ''}" data-act="bulkPick" data-cat="__none">${S.bulkCat === '__none' ? '✔ ' : ''}미분류로</button></div>
    <div class="row gap"><button class="btn ghost sm" data-act="selAll">${allOn ? '전체 해제' : '보이는 것 전체 선택'}</button><button class="btn ghost sm" data-act="selClear">선택 해제</button><button class="btn" data-act="bulkApply" ${n ? '' : 'disabled'}>✔ ${n}건 반영</button></div></div>`;
}
// 선택한 건 중 각 줄에서 카테고리를 골라 둔 것(일괄 분류를 고르지 않았을 때 반영 대상)
function bulkOwn() { return [...S.sel].map(id => S.ctx.rows.find(r => r.id === id)).filter(r => r && r.unclassified && S.stage[r.id] && (S.stage[r.id].category || S.stage[r.id].fixed)); }
function applyBar() {
  const list = stageList(); const auto = list.filter(x => x.st.auto).length, mine = list.length - auto; const onUn = S.cardFilter.kind === 'un';
  if (!list.length) return `<div class="applybar" id="applybar"><span class="muted">미분류 건의 카테고리를 눌러 골라 두고, 다 고른 뒤 한 번에 반영하세요.</span></div>`;
  return `<div class="applybar on" id="applybar"><span><b>분류 대기 ${list.length}건</b> <small class="muted">${mine ? `직접 고른 ${mine}건` : ''}${mine && auto ? ' · ' : ''}${auto ? `자동 제안 ${auto}건` : ''} · 아직 저장 안 됨</small></span>
    ${onUn ? '' : `<button class="btn ghost" data-act="cardFilter" data-k="kind" data-v="un">미분류에서 확인</button>`}<button class="btn ghost" data-act="stageClear">제안 지우기</button><button class="btn" data-act="stageApply">✔ ${list.length}건 반영</button></div>`;
}
function viewCards() {
  const ms = master(); const all = S.ctx.rows.filter(r => r.useMonth === S.month); const rs = cardRows(); const f = S.cardFilter; const cats = ms.card_categories || []; const fixedNames = (ms.fixed_card || []).map(x => x.name);
  const chip = (k, v, label, n) => `<button class="chip ${f[k] === v ? 'on' : ''}" data-act="cardFilter" data-k="${k}" data-v="${esc(v)}">${esc(label)} <small>${n}</small></button>`;
  const inCard = all.filter(r => !f.card || r.card === f.card), inKind = all.filter(r => kindMatch(r, f.kind)); const nK = k => inCard.filter(r => kindMatch(r, k)).length;
  const unAll = all.filter(r => r.unclassified).length;
  const stage = r => { const st = stageOf(r); const sug = st.auto && (st.category || st.fixed); return `<div class="stage ${sug ? 'sug' : ''}" data-act="noop"><div class="pick">${sug ? `<span class="autob" title="${st.why === '규칙' ? '자동분류 규칙에 맞음' : '같은 가맹점의 지난 분류를 따름'}">자동 제안</span>` : ''}${cats.map(c => `<button class="pk ${st.category === c ? 'on' : ''}" data-act="stagePick" data-id="${r.id}" data-cat="${esc(c)}">${st.category === c ? '✔ ' : ''}${esc(c)}</button>`).join('')}<button class="pk fx ${st.fixed ? 'on' : ''}" data-act="stagePick" data-id="${r.id}" data-cat="__fixed">${st.fixed ? '✔ ' : ''}고정</button>
      ${st.fixed ? `<select class="stfix" data-id="${r.id}" aria-label="고정 항목">${options(fixedNames.includes(st.label) || !st.label ? fixedNames : [st.label, ...fixedNames], st.label, '고정 항목 선택')}</select>` : ''}</div>
      <input class="stmemo" data-id="${r.id}" placeholder="메모" maxlength="200" autocomplete="off" value="${esc(st.memo !== undefined ? st.memo : (r.memo || ''))}"></div>`; };
  return `<section class="card"><div class="row gap wrap"><label class="btn">카드사 파일 올리기<input type="file" id="cardfiles" accept=".xls,.xlsx,.html" multiple hidden></label><button class="btn ghost" data-act="cardNew">직접 추가</button><a class="link" href="#/more/master">자동분류 규칙</a></div>
    <p class="muted small">카드사에서 받은 이용내역 파일을 그대로 올리세요(여러 개 가능). 카드를 자동 인식하고 새 건만 추가하며, 취소·매입 상태는 갱신합니다.</p><div id="uploadResult"></div></section>
  <div class="filters"><div class="chips scroll">${chip('kind', '', '전체', nK(''))}${chip('kind', 'un', '미분류', nK('un'))}${chip('kind', 'fixed', '고정', nK('fixed'))}${cats.map(c => chip('kind', c, c, nK(c))).join('')}${chip('kind', 'inst', '할부', nK('inst'))}${chip('kind', 'settle', '정산', nK('settle'))}${chip('kind', 'onnuri', '온누리', nK('onnuri'))}</div>
  <div class="chips scroll">${chip('card', '', '전체 카드', inKind.length)}${(ms.cards || []).map(c => chip('card', c.name, c.name, inKind.filter(r => r.card === c.name).length)).join('')}</div></div>
  <section class="card flush"><div class="listhead">${(() => { const sel = rs.filter(r => !r.spreadPart), on = sel.length && sel.every(r => S.sel.has(r.id)), some = !on && sel.some(r => S.sel.has(r.id)); return `<button class="ck allck ${on ? 'on' : some ? 'some' : ''}" data-act="selAll" role="checkbox" aria-checked="${on ? 'true' : some ? 'mixed' : 'false'}" aria-label="보이는 ${sel.length}건 전체 선택" title="보이는 ${sel.length}건 전체 선택">${on ? '✔' : some ? '−' : ''}</button>`; })()}<span>${rs.length}건${S.sel.size ? ` · <b class="selc">${S.sel.size}건 선택</b>` : ''}</span><b>반영액 ${won(rs.reduce((a, r) => a + r.applied, 0))}원</b></div>
  ${rs.length ? rs.map(r => `<div class="item ${r.canceled ? 'cancel' : ''}${fl('un', r.unclassified)}${fl('settle', r.settle > 0 && !r.settle_done)}${fl('inst', r.K > 1 && r.amount > 0)}" data-act="cardEdit" data-id="${r.id}"${r.spreadPart ? '' : ` data-sel="${S.sel.has(r.id) ? 1 : 0}"`}>
    <div class="i1">${r.spreadPart ? '<span class="ck ghostck" aria-hidden="true">↻</span>' : `<button class="ck ${S.sel.has(r.id) ? 'on' : ''}" data-act="selToggle" data-id="${r.id}" role="checkbox" aria-checked="${S.sel.has(r.id)}" aria-label="선택">${S.sel.has(r.id) ? '✔' : ''}</button>`}<span class="d dt">${r.used_date.slice(5).replace('-', '/')}${r.used_time ? ` <small>${esc(String(r.used_time).slice(0, 5))}</small>` : ''}</span>${who(r.person)}<span class="m">${esc(r.label || r.merchant)}</span><b class="a">${won(r.applied)}</b></div>
    <div class="i2"><span>${esc(r.card)}${r.label ? ' · ' + esc(r.merchant) : ''}${r.K > 1 ? ` · ${r.K}개월 할부${r.auto ? ` (총 ${won(r.amount)})` : ''}` : ''}${r.spread ? (r.spreadPart ? ` · ${Number(r.used_date.slice(5, 7))}월 결제 ${won(r.spreadFirst + r.spreadLater * (r.spread - 1))} 나눠 반영 ${r.spreadPart}/${r.spread}회` : ` · 일시불 ${won(r.amount)} → 예산 ${r.spread}개월 나눠 반영 1/${r.spread}회`) : ''}${r.canceled ? ' · 취소' : ''}${r.adjustment ? ` · 조정 ${signed(r.adjustment)}` : ''}${r.prepaid ? ` · 선결제 ${won(r.prepaid)}` : ''}${r.settle ? ` · 정산 −${won(r.settle)}(${r.settle_done ? '받음' : '미수'})` : ''}${r.onnuri ? ` · 온누리 ${won(r.onnuri)}` : ''}${r.memo && !r.unclassified ? ' · ' + esc(r.memo) : ''}</span>
      <span>${r.K > 1 && r.amount > 0 && !r.spreadPart ? (r.inst_checked ? tag('할부 확인됨', 'ok') : `<button type="button" class="miniok" data-act="instOk" data-id="${r.id}">✔ 할부 맞음</button>`) : ''}${r.fixed ? tag('고정', 'fix') : ''}${r.category ? tag(r.category, 'cat') : (r.unclassified ? tag('미분류', 'warn') : '')}</span></div>
    ${r.unclassified ? stage(r) : ''}</div>`).join('') : '<div class="empty">이 조건의 카드 내역이 없습니다.</div>'}</section>
  ${S.sel.size ? bulkBar(rs) : unAll ? applyBar() : ''}`;
}
function cardModal(r) {
  const ms = master(); const isNew = !r; r = r || { card: (ms.cards[0] || {}).name, used_date: C.todayStr().slice(0, 7) === S.month ? C.todayStr() : `${S.month}-01`, merchant: '', amount: 0, category: '', fixed: false, label: '', adjustment: 0, prepaid: 0, memo: '', source: 'manual', inst_months: 0, settle: 0, settle_done: false, onnuri: 0, onnuri_shared: false };
  openModal(`<h2>${isNew ? '카드 내역 추가' : '카드 내역'}</h2>
  ${isNew ? '' : `<div class="rawinfo"><b>${who(r.person)}${esc(r.merchant)}</b><span>${esc(r.card)} · ${r.used_date} ${esc(r.used_time || '')} · 승인번호 ${esc(r.approval_no || '-')}</span><span>이용금액 ${won(r.raw_amount)}원${r.K > 1 ? ` · ${r.K}개월 할부${r.auto ? ` (첫 달 ${won(r.first)}, 이후 월 ${won(r.later)})` : ''}` : ''}${r.status ? ' · ' + esc(r.status) : ''}${r.pay_due ? ' · 결제예정 ' + r.pay_due : ''}</span></div>`}
  <form id="cardform" class="form" autocomplete="off">
  ${isNew ? `<label>카드<select name="card">${options((ms.cards || []).map(c => c.name), r.card)}</select></label><label>사용일${dateInput('used_date', r.used_date, S.month)}</label><label class="full">가맹점<input name="merchant" required maxlength="100" autocomplete="off"></label><label>금액${moneyInput('amount', '', 'required')}</label><label>할부 개월 (일시불 0)<input name="inst_months" inputmode="numeric" value="0" autocomplete="off"></label>` : ''}
  <div class="full"><span class="lbl">카테고리</span><div class="chips" id="catchips">${['', ...(ms.card_categories || [])].map(c => `<button type="button" class="chip ${r.category === c ? 'on' : ''}" data-cat="${esc(c)}">${c || '없음'}</button>`).join('')}</div></div>
  <label class="chk"><input type="checkbox" name="fixed" ${r.fixed ? 'checked' : ''}> 고정지출</label>
  <label>내용 (고정 항목명·설명)<input name="label" list="fixednames" value="${esc(r.label)}" maxlength="60" autocomplete="off"><datalist id="fixednames">${(ms.fixed_card || []).map(f => `<option value="${esc(f.name)}">`).join('')}</datalist></label>
  <label class="full">메모<input name="memo" value="${esc(r.memo)}" maxlength="200" autocomplete="off"></label>
  <div class="full grp"><span class="lbl">정산 · 같이 쓰고 내 카드로 결제한 경우</span><div class="form in"><label>정산 받을 금액 (타인 몫)${moneyInput('settle', r.settle || '')}</label><label class="chk"><input type="checkbox" name="settle_done" ${r.settle_done ? 'checked' : ''}> 정산 받음</label></div></div>
  <div class="full grp"><span class="lbl">금액 조정</span><div class="form in"><label>조정액 (+/−)${moneyInput('adjustment', r.adjustment || '')}</label><label>선결제 금액${moneyInput('prepaid', r.prepaid || '')}</label>
    <label>온누리 사용액${moneyInput('onnuri', r.onnuri || '')}</label><label class="chk"><input type="checkbox" name="onnuri_shared" ${r.onnuri_shared ? 'checked' : ''}> 공용 충전분으로 결제</label></div></div>
  <div class="full grp"><span class="lbl">예산 나눠 반영 · 일시불로 결제했지만 비용은 몇 달에 나눠 잡기</span><div class="form in"><label>나눠 반영할 개월 (안 나누면 0)<input name="spread_months" inputmode="numeric" value="${r.spread_months || 0}" autocomplete="off"></label><div class="muted small">카드대금(청구)은 일시불 그대로이고, 반영액만 사용한 달부터 개월 수만큼 나눠 잡습니다. 할부 결제 건에는 쓰지 않습니다.</div></div></div>
  <div class="full muted small">반영액 = 금액(할부는 월 납입액, 나눠 반영은 1회분) + 조정액 − 정산 받을 금액 − 개인 온누리. 선결제·온누리는 카드대금(승인기준)에서 빠집니다. "리셀"은 예산에 넣지 않습니다.</div>
  <div class="actions full">${!isNew && r.source === 'manual' ? '<button type="button" class="btn danger" id="carddel">삭제</button>' : ''}<button type="button" class="btn ghost" data-act="modalClose">닫기</button><button class="btn">저장</button></div></form>`, sheet => {
    let cat = r.category; sheet.querySelectorAll('#catchips .chip').forEach(b => b.onclick = () => { cat = b.dataset.cat; sheet.querySelectorAll('#catchips .chip').forEach(x => x.classList.toggle('on', x === b)); });
    sheet.querySelector('#cardform').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const el = e.target.elements;
      const patch = { category: cat, fixed: el.fixed.checked, label: f.label.trim(), adjustment: toNum(f.adjustment), prepaid: toNum(f.prepaid), memo: f.memo.trim(), settle: Math.max(0, toNum(f.settle)), settle_done: el.settle_done.checked && toNum(f.settle) > 0, onnuri: Math.max(0, toNum(f.onnuri)), onnuri_shared: el.onnuri_shared.checked, spread_months: Math.max(0, Math.min(36, Math.round(toNum(f.spread_months)) || 0)) };
      let date = null; if (isNew) { date = parseDate(f.used_date, S.month); if (!date) return toast('사용일을 확인해 주세요. 예: 1113 또는 2026-11-13', true); }
      run(async () => {
        if (isNew) { const amt = toNum(f.amount); const c = ms.cards.find(c => c.name === f.card) || {}; const [row] = await S.store.insertCards([{ ...patch, card: f.card, person: c.person || '', used_date: date, merchant: f.merchant.trim(), raw_amount: amt, amount: amt, inst_months: Number(f.inst_months) || 0, source: 'manual', approval_no: '', canceled: false, status: '', issuer_discount: 0, used_time: '' }]); S.data.card_tx.push(row); }
        else { const row = await S.store.updateCard(r.id, patch); Object.assign(S.data.card_tx.find(x => x.id === r.id), row); delete S.stage[r.id]; }
        closeModal(); rebuild(); render();
      }, '저장했습니다.'); };
    const del = sheet.querySelector('#carddel'); if (del) del.onclick = () => { if (!confirm('이 내역을 삭제할까요?')) return; run(async () => { await S.store.deleteCard(r.id); S.data.card_tx = S.data.card_tx.filter(x => x.id !== r.id); closeModal(); rebuild(); render(); }, '삭제했습니다.'); };
  });
}
async function handleBankFile(file, password) {
  let buf = new Uint8Array(await file.arrayBuffer());
  try {
    if (isEncryptedOffice(XLSX, buf)) {
      if (!password) return openModal(`<h2>파일 비밀번호</h2><p class="muted small">은행에서 메일로 받은 엑셀은 비밀번호가 걸려 있습니다(토스뱅크: 생년월일 6자리). 비밀번호는 저장하지 않고, 파일도 이 기기 안에서만 풀어 읽습니다.</p>
        <form id="pwform" class="form" autocomplete="off"><label class="full">비밀번호<input name="pw" type="password" inputmode="numeric" autocomplete="off" required></label><div class="actions full"><button type="button" class="btn ghost" data-act="modalClose">닫기</button><button class="btn">열기</button></div></form>`, sheet => {
        sheet.querySelector('[name=pw]').focus(); sheet.querySelector('#pwform').onsubmit = e => { e.preventDefault(); const pw = e.target.elements.pw.value; closeModal(); toast('파일을 여는 중…'); handleBankFile(file, pw); }; });
      buf = await decryptOffice(XLSX, buf, password);
    }
    const parsed = parseTossGrid(gridFromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    if (!parsed || !parsed.rows.length) return toast('은행 거래내역을 찾지 못했습니다. 지금은 토스뱅크 엑셀만 읽을 수 있습니다.', true);
    const ms = master(); const open = ms.opening_date || '0000'; const known = new Set(S.data.bank_tx.map(b => b.source_ref)); const use = parsed.rows.filter(r => r.tx_date >= open); const fresh = use.filter(r => !known.has(r.source_ref));
    openModal(`<h2>${esc(parsed.bank)} 거래내역 가져오기</h2><div class="rawinfo"><b>${esc(file.name)}</b><span>전체 ${parsed.rows.length}건 · 조회 끝 ${parsed.synced || '-'}</span><span>기초잔액 기준일(${esc(open)}) 이후 ${use.length}건 중 새 거래 ${fresh.length}건</span></div>
      <form id="tossform" class="form" autocomplete="off"><label>넣을 통장<select name="account">${options((ms.accounts || []).filter(a => a.tracked).map(a => a.name), '모임통장')}</select></label><div></div>
      <div class="full">${fresh.length ? `<table class="tbl sm"><thead><tr><th>날짜</th><th>내용</th><th class="r">입금</th><th class="r">출금</th><th class="r">은행 잔액</th></tr></thead><tbody>${fresh.slice().sort((a, b) => a.source_ref.localeCompare(b.source_ref)).map(r => `<tr><td>${r.tx_date}</td><td>${esc(r.memo)}<br><small class="muted">${esc(r.note)}</small></td><td class="r pos">${r.deposit ? '+' + won(r.deposit) : ''}</td><td class="r">${r.withdrawal ? won(r.withdrawal) : ''}</td><td class="r">${won(r.balance)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">새로 넣을 거래가 없습니다. 잔액 대조만 갱신합니다.</p>'}</div>
      <p class="full muted small">직접 적어 둔 같은 날짜·금액 거래가 있으면 새로 넣지 않고 은행 내역과 연결만 합니다. 이자는 부수입, 자동이체는 고정, 급여와 같은 금액 입금은 급여로 넣고, 나머지는 전에 같은 내용으로 분류한 대로 따라갑니다.</p>
      <div class="actions full"><button type="button" class="btn ghost" data-act="modalClose">닫기</button><button class="btn">가져오기</button></div></form>`, sheet => {
      sheet.querySelector('#tossform').onsubmit = e => { e.preventDefault(); const account = e.target.elements.account.value;
        run(async () => { const r = await S.store.importBank(account, use, parsed.synced || C.todayStr()); S.data = await S.store.loadAll(); closeModal(); rebuild(); render(); toast(`새 거래 ${r.inserted}건 · 기존 기록과 연결 ${r.matched}건 · 이미 있음 ${r.duplicate}건`); }); }; });
  } catch (e) { toast(e.message || String(e), true); }
}
async function handleCardFiles(files) {
  const ms = master(); const box = document.querySelector('#uploadResult'); box.innerHTML = '<p class="muted">파일을 읽는 중…</p>';
  const existing = new Map(S.data.card_tx.map(r => [cardKey(r), r])); const plan = []; const lines = [];
  for (const file of files) {
    try {
      const { issuer, rows } = parseGrid(gridFromBuffer(await file.arrayBuffer()));
      if (!issuer) { lines.push(`<li class="neg">${esc(file.name)}: 카드 이용내역을 찾지 못했습니다.</li>`); continue; }
      const card = pickCard(ms, issuer, rows); if (!card) { lines.push(`<li class="neg">${esc(file.name)}: 어느 카드인지 알 수 없습니다. 기초 데이터의 카드 목록을 확인해 주세요.</li>`); continue; }
      let add = 0, upd = 0, same = 0;
      for (const t of rows) {
        const row = { ...t, card: card.name, person: card.person }; const k = cardKey(row); const old = existing.get(k);
        if (old) { const ch = ['raw_amount', 'amount', 'canceled', 'inst_months', 'status', 'pay_due', 'issuer_discount', 'onnuri'].filter(c => c === 'onnuri' ? (row.onnuri !== undefined && C.num(old.onnuri) !== C.num(row.onnuri)) : (String(old[c] ?? '') !== String(row[c] ?? '') && !(c === 'pay_due' && !row[c]))); if (ch.length && old.id) { plan.push({ type: 'upd', id: old.id, patch: Object.fromEntries(ch.map(c => [c, row[c]])) }); upd++; } else same++; }
        else { const rule = C.applyRules(ms, card.name, row.merchant); const n = { ...row, category: rule ? (rule.category || '') : '', fixed: rule ? !!rule.fixed : false, label: rule ? (rule.label || '') : '', adjustment: 0, prepaid: 0, memo: '', source: 'upload' }; plan.push({ type: 'add', row: n }); existing.set(k, n); add++; }
      }
      const ds = rows.map(r => r.used_date).sort();
      lines.push(`<li><b>${esc(card.name)}</b> ${esc(file.name)} — ${rows.length}건 (${ds[0] || ''}~${ds[ds.length - 1] || ''}): 새 건 ${add} · 상태 변경 ${upd} · 중복 ${same}</li>`);
    } catch (e) { console.error(e); lines.push(`<li class="neg">${esc(file.name)}: 읽지 못했습니다 (${esc(e.message)})</li>`); }
  }
  const adds = plan.filter(p => p.type === 'add'), upds = plan.filter(p => p.type === 'upd');
  // 여러 파일을 고르면 확인 버튼 없이 한 번에 저장(중복은 승인번호로 걸러짐)
  const summary = `<ul class="plain">${lines.join('')}</ul>`;
  if (!plan.length) { box.innerHTML = summary + '<p class="muted">새로 반영할 내용이 없습니다(이미 올라간 내역).</p>'; return; }
  box.innerHTML = summary + `<p class="muted">저장하는 중… 새 건 ${adds.length}건 · 갱신 ${upds.length}건</p>`;
  await run(async () => {
    if (adds.length) S.data.card_tx.push(...await S.store.insertCards(adds.map(a => a.row)));
    for (const u of upds) { const row = await S.store.updateCard(u.id, u.patch); Object.assign(S.data.card_tx.find(x => x.id === u.id), row); }
    const months = [...new Set(adds.map(a => a.row.used_date.slice(0, 7)))].sort(); if (months.length && !months.includes(S.month)) S.month = months[months.length - 1];
    rebuild(); render();
    const nb = document.querySelector('#uploadResult'); if (nb) { nb.innerHTML = summary + `<p class="ok">✔ 저장 완료 · 새 건 ${adds.length}건 추가 · ${upds.length}건 갱신</p>`; nb.scrollIntoView({ block: 'nearest' }); }
  }, `카드 파일 ${files.length}개 · 새 건 ${adds.length}건 추가, ${upds.length}건 갱신했습니다.`);
}

// ---------- 통장
function viewBank() {
  const ms = master(); const accts = (ms.accounts || []).filter(a => a.tracked); const m = S.month; const acc = S.bankFilter; const from = ms.opening_date || '0000-00-00';
  let rs = S.ctx.bank.filter(b => b.tx_date.slice(0, 7) === m && (!acc || b.account === acc)).slice().sort((a, b) => a.tx_date.localeCompare(b.tx_date) || a.id - b.id);
  const names = acc ? [acc] : accts.map(a => a.name); const start = names.reduce((a, n) => a + C.accountBalance(S.ctx, n, `${m}-01`), 0); const tracked = `${m}-31` >= from;
  let bal = start; rs = rs.map(b => { const on = b.tx_date >= from && names.includes(b.account); if (on) bal += C.num(b.deposit) - C.num(b.withdrawal); return { ...b, bal: on ? bal : null }; });
  const inn = rs.reduce((a, b) => a + C.num(b.deposit), 0), out = rs.reduce((a, b) => a + C.num(b.withdrawal), 0); const end = bal;
  const g = { 수입: 0, 지출: 0, 이동: 0, 미분류: 0 }; rs.forEach(b => { const k = C.bankGroup(b.category === '확인 필요' ? '' : b.category) || '미분류'; g[k] += k === '수입' ? C.num(b.deposit) - C.num(b.withdrawal) : k === '지출' ? C.num(b.withdrawal) - C.num(b.deposit) : C.num(b.deposit) + C.num(b.withdrawal); });
  if (S.bankSort !== 'asc') rs.reverse();
  return `<div class="row gap wrap"><div class="chips scroll grow">${accts.map(a => `<button class="chip ${acc === a.name ? 'on' : ''}" data-act="bankFilter" data-v="${esc(a.name)}">${esc(a.name)}</button>`).join('')}<button class="chip ${!acc ? 'on' : ''}" data-act="bankFilter" data-v="">전체 합산</button></div>
    <button class="btn ghost" data-act="bankSort">${S.bankSort === 'asc' ? '↑ 오래된 순' : '↓ 최신 순'}</button><label class="btn ghost">은행 파일 올리기<input type="file" id="bankfile" accept=".xlsx,.xls" hidden></label><button class="btn ghost" data-act="bankPaste">여러 건 붙여넣기</button><button class="btn" data-act="bankNew">거래 추가</button></div>
  ${(() => { const sy = (ms.bank_sync || {})[acc || '모임통장']; if (!sy) return ''; const mine = C.accountBalance(S.ctx, acc || '모임통장', C.addDay(sy.last_date)); const d = mine - C.num(sy.balance);
    return `<div class="chk ${d ? 'bad' : ''}">${d ? `▲ 은행 잔액과 ${won(Math.abs(d))}원 차이 — 빠진 거래가 있는지 확인하세요` : '✔ 은행 잔액과 일치'} <small>${esc(acc || '모임통장')} · 은행 내역 ${sy.synced || ''}까지 반영(${String(sy.at || '').slice(0, 10)} 가져옴) · ${sy.last_date} 기준 은행 ${won(sy.balance)} / 장부 ${won(mine)}</small></div>`; })()}
  <section class="balflow"><div><span>${Number(m.slice(5))}월 초 잔액</span><b>${tracked ? won(start) : '-'}</b></div><i>+</i><div><span>입금 ${rs.filter(b => b.deposit).length}건</span><b class="pos">${won(inn)}</b></div><i>−</i><div><span>출금 ${rs.filter(b => b.withdrawal).length}건</span><b>${won(out)}</b></div><i>=</i><div class="end"><span>${m === C.todayStr().slice(0, 7) ? '현재 잔액' : '월말 잔액'}</span><b class="${end < 0 ? 'neg' : ''}">${tracked ? won(end) : '-'}</b></div></section>
  <section class="card flush"><div class="listhead"><span>${acc ? esc(acc) : '장부 관리 통장 합산'} · ${rs.length}건</span><b><span class="pos">수입 +${won(g.수입)}</span> · 지출 ${won(g.지출)} · 이동 ${won(g.이동)}${g.미분류 ? ` · <span class="neg">! 미분류 ${won(g.미분류)}</span>` : ''}</b></div>
  ${rs.length ? `<div class="tablewrap"><table class="tbl bank" data-mhead="2"><thead><tr><th>날짜</th><th>내용</th><th>분류</th><th class="r">입금</th><th class="r">출금</th><th class="r">잔액</th></tr></thead><tbody>${rs.map(b => { const grp = C.bankGroup(b.category === '확인 필요' ? '' : b.category); return `<tr class="brow${fl('bankun', !grp)}" data-act="bankEdit" data-id="${b.id}"><td class="d">${b.tx_date.slice(5).replace('-', '/')}</td><td><b>${esc(b.memo)}</b>${!acc || b.note ? `<br><small class="muted">${!acc ? esc(b.account) : ''}${!acc && b.note ? ' · ' : ''}${esc(b.note || '')}</small>` : ''}</td>
      <td>${b.fixed ? tag('고정', 'fix') : ''}${grp ? tag(`${grp} · ${b.category}`, grp === '수입' ? 'ok' : grp === '이동' ? 'wait' : 'cat') : tag('! 미분류', 'warn')}</td><td class="r pos">${b.deposit ? '+' + won(b.deposit) : ''}</td><td class="r">${b.withdrawal ? '−' + won(b.withdrawal) : ''}</td><td class="r">${b.bal === null ? '<span class="muted">-</span>' : `<b class="${b.bal < 0 ? 'neg' : ''}">${won(b.bal)}</b>`}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty">이 달의 통장 거래가 없습니다.</div>'}</section>
  <p class="muted small">잔액은 기초잔액 기준일(${esc(from)}) 이후 거래부터 계산합니다. 그 이전 달은 잔액 없이 내역만 보입니다. <b>수입</b>(급여·부수입)만 수입에, <b>지출</b>은 예산 실행에 잡히고, <b>이동</b>(이체·정산입금·카드대금·저축·대출상환)은 수입·지출에 잡히지 않습니다.</p>`;
}
function parseBankLines(text, account) {
  const ms = master(); const last = {}; S.ctx.bank.forEach(b => { if (b.category) last[b.memo] = b; });
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const tk = line.split(/\t+|\s+/).filter(Boolean); const date = parseDate(tk[0], S.month); let ai = -1; for (let i = tk.length - 1; i >= 1; i--) if (/^[+\-−]?[\d,]+원?$/.test(tk[i]) && /\d/.test(tk[i])) { ai = i; break; }
    if (!date || ai < 1) return { line, error: !date ? '날짜를 읽지 못함' : '금액을 읽지 못함' };
    let memo = tk.slice(1, ai).concat(tk.slice(ai + 1)).join(' '); let dep = tk[ai].startsWith('+'); if (memo.startsWith('+')) { dep = true; memo = memo.slice(1).trim(); } const amt = toNum(tk[ai].replace(/[+\-−]/g, ''));
    if (!memo || !amt) return { line, error: !memo ? '내용이 없음' : '금액이 0' };
    const fc = (ms.fixed_cash || []).find(f => f.name === memo), inc = (ms.incomes || []).find(f => f.name === memo), p = last[memo];
    return { line, row: { tx_date: date, account, memo: memo.slice(0, 80), deposit: dep ? amt : 0, withdrawal: dep ? 0 : amt, category: fc ? '고정' : inc ? '급여' : p ? p.category : '', fixed: fc ? true : p ? !!p.fixed : false, note: '', source: 'manual' } };
  });
}
function bankPasteModal() {
  const ms = master();
  openModal(`<h2>여러 건 붙여넣기</h2><p class="muted small">한 줄에 한 건, <b>날짜 내용 금액</b> 순서로 적습니다. 금액 앞에 +를 붙이면 입금, 없으면 출금입니다. 엑셀에서 복사해 붙여도 됩니다. 전에 같은 내용으로 넣은 적이 있으면 분류를 따라갑니다.</p>
  <form id="pasteform" class="form" autocomplete="off"><label>통장<select name="account">${options((ms.accounts || []).map(a => a.name), S.bankFilter || '모임통장')}</select></label><div></div>
  <label class="full">거래 목록<textarea name="text" rows="7" spellcheck="false" placeholder="1103 이마트 35,000&#10;1105 +이자 1,200&#10;11-07 관리비 120000"></textarea></label>
  <div class="full" id="pastePrev"><p class="muted small">적으면 아래에 미리 보기가 나옵니다.</p></div>
  <div class="actions full"><button type="button" class="btn ghost" data-act="modalClose">닫기</button><button class="btn" id="pasteSave">저장</button></div></form>`, sheet => {
    const form = sheet.querySelector('#pasteform'); const prev = sheet.querySelector('#pastePrev'); let parsed = [];
    const draw = () => { parsed = parseBankLines(form.elements.text.value, form.elements.account.value); const bad = parsed.filter(p => p.error).length;
      prev.innerHTML = parsed.length ? `<table class="tbl sm"><thead><tr><th>날짜</th><th>내용</th><th>분류</th><th class="r">입금</th><th class="r">출금</th></tr></thead><tbody>${parsed.map(p => p.error ? `<tr><td colspan="5" class="neg">! ${esc(p.line)} — ${p.error}</td></tr>` : `<tr><td>${p.row.tx_date}</td><td>${esc(p.row.memo)}</td><td>${p.row.category ? tag(p.row.category, 'cat') : tag('미분류', 'warn')}</td><td class="r pos">${p.row.deposit ? '+' + won(p.row.deposit) : ''}</td><td class="r">${p.row.withdrawal ? won(p.row.withdrawal) : ''}</td></tr>`).join('')}</tbody></table><p class="muted small">읽은 건 ${parsed.length - bad}건${bad ? ` · <span class="neg">못 읽은 줄 ${bad}개(고쳐야 저장됩니다)</span>` : ''}</p>` : ''; };
    form.elements.text.oninput = draw; form.elements.account.onchange = draw;
    form.onsubmit = e => { e.preventDefault(); draw(); const ok = parsed.filter(p => p.row); if (!ok.length) return toast('저장할 거래가 없습니다.', true); if (ok.length !== parsed.length) return toast('못 읽은 줄을 고치거나 지워 주세요.', true);
      run(async () => { S.data.bank_tx.push(...await S.store.insertBank(ok.map(p => p.row))); closeModal(); rebuild(); render(); }, `${ok.length}건을 저장했습니다.`); };
  });
}
function bankModal(b) {
  const ms = master(); const isNew = !b; b = b || { tx_date: C.todayStr().slice(0, 7) === S.month ? C.todayStr() : `${S.month}-01`, account: '모임통장', memo: '', deposit: 0, withdrawal: 0, category: '', fixed: false, note: '' };
  const list = ms.bank_categories || []; const cats = (b.category && !list.includes(b.category)) ? [...list, b.category] : list;
  const catOpts = `<option value="">미분류</option>` + Object.keys(C.BANK_GROUPS).map(gp => `<optgroup label="${gp}">${options(cats.filter(c => C.bankGroup(c) === gp), b.category)}</optgroup>`).join('');
  openModal(`<h2>${isNew ? '통장 거래 추가' : '통장 거래'}</h2><form id="bankform" class="form" autocomplete="off">
  <label>날짜${dateInput('tx_date', b.tx_date, S.month)}</label><label>통장<select name="account">${options((ms.accounts || []).map(a => a.name), b.account)}</select></label>
  <label class="full">내용<input name="memo" value="${esc(b.memo)}" required maxlength="80" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>
  <label>입금${moneyInput('deposit', b.deposit || '')}</label><label>출금${moneyInput('withdrawal', b.withdrawal || '')}</label>
  <label>분류<select name="category">${catOpts}</select></label><label class="chk"><input type="checkbox" name="fixed" ${b.fixed ? 'checked' : ''}> 고정 이체</label>
  <label class="full">메모<input name="note" value="${esc(b.note)}" maxlength="200" autocomplete="off"></label>
  <div class="full muted small">날짜는 숫자만 쳐도 됩니다. 예: 1113 → ${S.month.slice(0, 4)}-11-13, 5 → ${S.month}-05. 내용에 고정지출·수입 항목명을 그대로 적으면 금액과 분류가 채워집니다.</div>
  <div class="actions full">${isNew ? '' : '<button type="button" class="btn danger" id="bankdel">삭제</button>'}<button type="button" class="btn ghost" data-act="modalClose">닫기</button><button class="btn">저장</button></div></form>`, sheet => {
    const form = sheet.querySelector('#bankform');
    form.elements.memo.onchange = () => { const v = form.elements.memo.value.trim(); const fc = (ms.fixed_cash || []).find(f => f.name === v); const inc = (ms.incomes || []).find(f => f.name === v); const mth = (parseDate(form.elements.tx_date.value, S.month) || `${S.month}-01`).slice(0, 7);
      if (fc && isNew) { form.elements.fixed.checked = true; form.elements.category.value = '고정'; if (!form.elements.withdrawal.value) { const s = C.monthSummary(S.ctx, mth); form.elements.withdrawal.value = fmtDigits((s.fixedCash.find(x => x.name === v) || {}).transfer || fc.amount); } }
      if (inc && isNew) { form.elements.category.value = '급여'; form.elements.account.value = inc.account; if (!form.elements.deposit.value) form.elements.deposit.value = fmtDigits(inc.amount); } };
    form.onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(form)); const date = parseDate(f.tx_date, S.month); if (!date) return toast('날짜를 확인해 주세요. 예: 1113 또는 2026-11-13', true);
      const row = { tx_date: date, account: f.account, memo: f.memo.trim(), deposit: toNum(f.deposit), withdrawal: toNum(f.withdrawal), category: f.category, fixed: form.elements.fixed.checked, note: f.note.trim() };
      if (!row.deposit && !row.withdrawal) return toast('입금 또는 출금 금액을 입력해 주세요.', true);
      run(async () => { if (isNew) S.data.bank_tx.push(...await S.store.insertBank([{ ...row, source: 'manual' }])); else Object.assign(S.data.bank_tx.find(x => x.id === b.id), await S.store.updateBank(b.id, row)); closeModal(); rebuild(); render(); }, '저장했습니다.'); };
    const del = sheet.querySelector('#bankdel'); if (del) del.onclick = () => { if (!confirm('이 거래를 삭제할까요?')) return; run(async () => { await S.store.deleteBank(b.id); S.data.bank_tx = S.data.bank_tx.filter(x => x.id !== b.id); closeModal(); rebuild(); render(); }, '삭제했습니다.'); };
  });
}
// ---------- 카드대금
function viewBills() {
  const m = S.month, s = C.monthSummary(S.ctx, m); const firstBill = C.billMonthRange(S.ctx).first || m; const months = Array.from({ length: 9 }, (_, i) => C.addMonth(m, i - 5)).filter(x => x >= firstBill); const board = C.billBoard(S.ctx, months); const max = Math.max(1, ...board.map(b => b.expected)); const cards = S.ctx.cards;
  const items = C.billInstItems(S.ctx, m); const cur = C.todayStr().slice(0, 7); const curBill = s;
  return `<div class="kpis four">${kpi(`${Number(m.slice(5))}월 청구 승인기준`, won(s.billTotal.expected), `${s.bills.filter(b => b.expected > 0).length}개 카드`)}${kpi('일시불', won(s.billTotal.lump), '선결제 제외')}${kpi('할부', won(s.billTotal.installment), `${items.length}건 납입`)}${kpi('실제 청구', s.billTotal.actual === null ? '대기' : won(s.billTotal.actual), s.billTotal.actual === null ? '청구서 금액을 입력하세요' : `차액 ${signed(-s.billTotal.discount)}`)}</div>
  ${sec(`${monthLabel(m)} 청구`, `${billTable(s, true)}<p class="muted small">승인기준 = 일시불(선결제·온누리 제외) + 할부(이번 달 납입분). 할부 금액(▸)을 누르면 그 카드의 할부 건이 아래에 펼쳐집니다. 청구서 금액을 넣으면 승인기준과의 차액이 표시됩니다. 카드사 할인은 각자 개인 몫이라 따로 모으지 않습니다.</p>`)}
  ${sec('청구월별 대시보드', `<div class="tablewrap"><table class="tbl board"><thead><tr><th>청구월</th>${cards.map(c => `<th class="r">${who(c.person)}${esc(c.name.replace(/^(은경|영민)\s/, ''))}</th>`).join('')}<th class="r">일시불</th><th class="r">할부</th><th class="r">승인기준</th><th class="mixh">구성</th><th class="r">실제 청구</th></tr></thead><tbody>
    ${board.map(b => `<tr class="${b.month === m ? 'cur' : ''}"><td><a href="#/bills" data-act="gotoMonth" data-m="${b.month}">${b.month}</a>${b.month === cur ? ' ' + tag('이번 달', 'wait') : b.month > cur ? ' ' + tag('예정', 'wait') : ''}</td>${b.bills.map(x => `<td class="r">${x.expected ? won(x.expected) : '<span class="muted">-</span>'}</td>`).join('')}<td class="r">${won(b.lump)}</td><td class="r">${won(b.installment)}</td><td class="r"><b>${won(b.expected)}</b></td>
      <td><div class="mix" role="img" aria-label="일시불 ${won(b.lump)} 할부 ${won(b.installment)}"><i class="lump" style="width:${Math.round(Math.max(0, b.lump) / max * 100)}%"></i><i class="inst" style="width:${Math.round(b.installment / max * 100)}%"></i></div></td>
      <td class="r">${b.actual === null ? tag('대기', 'wait') : won(b.actual) + (b.entered < b.cards ? ` <small class="muted">(${b.entered}/${b.cards})</small>` : '')}</td></tr>`).join('')}</tbody></table></div>
    <div class="legend sm"><span><i class="lump"></i>일시불 (진한 색)</span><span><i class="inst"></i>할부 (빗금)</span><span class="muted">청구월을 누르면 화면 위쪽 월이 그 달로 바뀌어, 그 달의 청구 상세(위 표)를 볼 수 있습니다. 앞으로의 달은 지금까지 승인된 건 기준입니다.</span></div>`)}
  <div>${sec('일시불 계산', `<table class="tbl"><thead><tr><th>카드</th><th class="r">일시불 승인</th><th class="r">선결제</th><th class="r">일시불 청구</th></tr></thead><tbody>${s.bills.map(b => `<tr><td>${who(b.person)}${esc(b.card)}</td><td class="r">${won(b.lump)}</td><td class="r">${b.prepaid ? '−' + won(b.prepaid) : ''}</td><td class="r"><b>${won(b.lumpNet)}</b></td></tr>`).join('')}</tbody></table><p class="muted small">${monthLabel(C.addMonth(m, -1))} 사용분입니다(국민카드는 결제예정일 기준).</p>`)}</div>`;
}
// ---------- 더보기
function viewMore() {
  if (!S.sub) return `<div class="menu">${MORE.map(m => `<a href="#/more/${m[0]}" class="card"><b>${m[1]}</b><small>${m[2]}</small></a>`).join('')}</div>`;
  return ({ budget: viewBudget, inst: viewInst, loans: viewLoans, onnuri: viewOnnuri, goals: viewGoals, tax: viewTax, trend: viewTrend, closes: viewCloses, master: viewMaster, data: viewData, audit: viewAudit, account: viewAccount })[S.sub]?.() || '';
}
function viewOnnuri() {
  const o = C.onnuriSummary(S.ctx); const ms = master(); const persons = [...new Set((ms.cards || []).map(c => c.person))]; const months = Object.keys(o.byMonth).sort().reverse();
  LISTS.onnuri = { cols: [{ k: 'date', label: '충전일', t: 'date' }, { k: 'amount', label: '충전 금액', t: 'money' }, { k: 'note', label: '메모' }], get: () => master().onnuri_charges || [], save: rows => saveDoc('master', { ...master(), onnuri_charges: rows }) };
  return `<div class="kpis three">${persons.map(p => kpi(`${who(p)}${p} 개인 온누리 사용 누계`, won(o.byPerson[p] || 0), '공동 예산에 넣지 않음')).join('')}${kpi('공용 충전 잔액', won(o.sharedBalance), `충전 ${won(o.charged)} − 사용 ${won(o.sharedUsed)}`, o.sharedBalance < 0 ? 'neg' : '')}</div>
  ${sec('월별 개인 온누리 사용', months.length ? `<table class="tbl"><thead><tr><th>월</th>${persons.map(p => `<th class="r">${who(p)}${p}</th>`).join('')}</tr></thead><tbody>${months.map(m => `<tr><td>${m}</td>${persons.map(p => `<td class="r">${won(o.byMonth[m][p] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty">아직 온누리 사용 내역이 없습니다.</div>')}
  ${sec('온누리 사용 내역', o.rows.length ? `<table class="tbl"><thead><tr><th>사용일</th><th>가맹점</th><th class="r">결제 금액</th><th class="r">온누리</th><th class="c">구분</th></tr></thead><tbody>${o.rows.slice().sort((a, b) => b.used_date.localeCompare(a.used_date)).map(r => `<tr><td>${r.used_date}</td><td>${who(r.person)}${esc(r.label || r.merchant)}</td><td class="r">${won(r.amount)}</td><td class="r">${won(r.onnuri)}</td><td class="c">${r.onnuri_shared ? tag('공용', 'fix') : tag('개인', 'cat')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">롯데카드 파일의 "온누리상품권사용금액"이 있는 건이 여기에 모입니다. 카드 내역에서 직접 넣을 수도 있습니다.</div>')}
  ${sec('공용 돈으로 충전한 기록', listEditor('onnuri', LISTS.onnuri.get(), LISTS.onnuri.cols) + '<p class="muted small">이벤트·혜택으로 받은 온누리는 개인 몫이라 적지 않습니다. 모임통장 등 공용 돈으로 충전했을 때만 적고, 그 돈으로 결제한 카드 내역에는 "공용 충전분으로 결제"를 체크하세요. 공용분 결제는 예산 실행에 그대로 잡힙니다.</p>')}`;
}
function viewBudget() {
  const ms = master(), m = S.month, s = C.monthSummary(S.ctx, m); const b = ms.budgets || { defaults: {}, overrides: {} }; const ov = (b.overrides || {})[m] || {};
  return `${sec(`${monthLabel(m)} 예산`, `<table class="tbl" id="budgettbl"><thead><tr><th>카테고리</th><th class="r">기본 예산</th><th class="r">이번 달 예산</th><th class="r">실행</th><th class="c">구분</th></tr></thead><tbody>
    ${s.variable.concat(s.mealBudgets.map(x => ({ ...x, note: ' <small class="muted">용돈과 합쳐서 관리</small>' }))).map(v => `<tr data-cat="${esc(v.cat)}"><td><b>${esc(v.cat)}</b>${v.note || ''}</td><td class="r"><input data-money data-f="def" inputmode="numeric" value="${fmtDigits((b.defaults || {})[v.cat] ?? '')}"></td><td class="r"><input data-money data-f="mon" inputmode="numeric" value="${fmtDigits(v.budget)}"></td><td class="r">${won(v.actual)}</td><td class="c">${v.cat in ov ? tag('이달 수정', 'warn') : tag('기본값', 'ok')}</td></tr>`).join('')}
    <tr data-new="1"><td><input data-f="name" placeholder="새 카테고리"></td><td class="r"><input data-money data-f="def" inputmode="numeric" placeholder="0"></td><td></td><td></td><td></td></tr></tbody></table>
    <div class="row gap end"><button class="btn" data-act="budgetSave">저장</button></div>
    <p class="muted small">기본 예산은 모든 달에 이어집니다. 이번 달 예산을 기본값과 다르게 넣으면 이 달만 바뀌고, 기본값과 같게 맞추면 "이달 수정"이 풀립니다. 새 카테고리는 카드·통장 분류에도 추가됩니다.</p>`)}
  ${sec('용돈·고정지출 예산', `<p class="muted">용돈과 고정지출 금액은 <a href="#/more/master">기초 데이터</a>에서 바꿉니다. 월 = 1일~말일, 카드는 사용한 날 기준으로 집계합니다.</p>`)}`;
}
function viewInst() {
  const months = Array.from({ length: 12 }, (_, i) => C.addMonth(S.month, i)); const auto = S.ctx.rows.filter(r => r.auto);
  const sched = (f) => months.map(f);
  const legacyRows = S.ctx.installments.map(i => ({ name: i.item, card: i.card, vals: sched(m => (i.charges || {})[m] || 0), note: i.note }));
  const autoRows = auto.map(r => ({ name: r.label || r.merchant, card: r.card, vals: sched(m => { const d = C.monthDiff(r.billMonth, m); return d === 0 ? r.first : (d >= 1 && d <= r.K - 1 ? r.later : 0); }), note: `${r.used_date} · ${won(r.amount)}원 ${r.K}개월` }));
  const rows = [...legacyRows, ...autoRows].filter(r => r.vals.some(Boolean)); const tot = months.map((_, i) => rows.reduce((a, r) => a + r.vals[i], 0));
  LISTS.instlist = { cols: [{ k: 'item', label: '물품' }, { k: 'card', label: '카드', t: 'select', opts: () => (master().cards || []).map(c => c.name), blank: '미지정' }, { k: 'seller', label: '판매처' }, { k: 'months', label: '개월', t: 'num', w: 48 }, { k: 'first_month', label: '첫 청구월', t: 'month' }, { k: 'monthly', label: '월 납입액', t: 'money' }, { k: 'note', label: '비고' }], get: () => doc('installments') || [],
    save: rows => saveDoc('installments', rows.map(r => { const old = (doc('installments') || []).find(o => o.item === r.item); const same = old && old.months === r.months && old.first_month === r.first_month && old.monthly === r.monthly; return { ...r, charges: same ? old.charges : Object.fromEntries(Array.from({ length: r.months || 0 }, (_, i) => [C.addMonth(r.first_month, i), r.monthly])) }; })) };
  return `${sec('청구 일정 (청구월 기준)', `<div class="tablewrap"><table class="tbl sm"><thead><tr><th>항목</th><th>카드</th>${months.map(m => `<th class="r">${m.slice(2)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.name)}<br><small class="muted">${esc(r.note || '')}</small></td><td>${esc(r.card || '미지정')}</td>${r.vals.map(v => `<td class="r">${v ? won(v) : ''}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="14" class="empty">예정된 할부가 없습니다.</td></tr>`}<tr class="sum"><td>합계</td><td></td>${tot.map(v => `<td class="r">${won(v)}</td>`).join('')}</tr></tbody></table></div><p class="muted small">${(master().auto_inst_from || '').slice(0, 7)} 이후 카드 할부는 카드 내역에서 자동 계산됩니다. 그 이전 할부만 아래 표에서 관리합니다.</p>`)}
  ${sec('이전 할부 (직접 관리)', listEditor('instlist', LISTS.instlist.get(), LISTS.instlist.cols) + '<p class="muted small">개월·첫 청구월·월 납입액을 바꾸면 청구 일정을 균등하게 다시 만듭니다. 조기상환 등 특수한 일정은 그대로 유지됩니다.</p>')}`;
}
function viewLoans() {
  const months = Array.from({ length: 13 }, (_, i) => C.addMonth(S.month, i - 1)); const m = S.month;
  LISTS.loanlist = { cols: [{ k: 'name', label: '대출명' }, { k: 'borrower', label: '차주', t: 'select', opts: ['은경', '영민', '공동'], blank: '-' }, { k: 'rate', label: '이율(%)', t: 'num', w: 56 }, { k: 'day', label: '이자일', t: 'num', w: 44 }, { k: 'principal', label: '실행금액', t: 'money' }, { k: 'balance', label: '기준 잔액', t: 'money' }, { k: 'base_month', label: '기준월', t: 'month' }, { k: 'note', label: '비고' }], get: () => doc('loans') || [], save: rows => saveDoc('loans', rows.map(r => ({ plan: {}, ...r }))) };
  const loans = S.ctx.loans; const tot = loans.reduce((a, l) => a + C.loanBalance(l, m), 0), prin = loans.reduce((a, l) => a + C.num(l.principal), 0);
  const yearInt = loans.reduce((a, l) => a + C.loanBalance(l, m) * C.num(l.rate) / 100, 0);
  return `<div class="kpis four">${kpi(`${Number(m.slice(5))}월 말 대출 잔액`, won(tot), `실행 ${won(prin)} 중 ${pct(prin ? 1 - tot / prin : null)} 상환`)}${kpi('이번 달 상환 계획', won(loans.reduce((a, l) => a + C.num((l.plan || {})[m]), 0)), `${loans.filter(l => C.num((l.plan || {})[m])).length}건 예정`)}${kpi('이번 달 상환 실적', won(C.monthSummary(S.ctx, m).repaid), '통장 거래 "대출상환"')}${kpi('연 이자 추정', won(yearInt), `월 약 ${won(yearInt / 12)} · 잔액 × 이율`)}</div>
  <div class="loans">${loans.map(l => { const bal = C.loanBalance(l, m), p = C.num(l.principal); const paid = p ? Math.max(0, Math.min(1, 1 - bal / p)) : 0; const next = Object.keys(l.plan || {}).filter(k => k >= m && C.num(l.plan[k])).sort()[0]; const end = Object.keys(l.plan || {}).filter(k => C.loanBalance(l, k) === 0).sort()[0];
    return `<div class="loan ${bal === 0 ? 'done' : ''}"><div class="lh"><b>${who(l.borrower)}${esc(l.name)}</b>${bal === 0 ? tag('✔ 상환 완료', 'ok') : l.rate ? tag(`연 ${l.rate}%`, 'wait') : ''}</div>
      <div class="lb"><b>${won(bal)}</b><small>/ ${won(p)}</small></div>${bar(p - bal, p)}<div class="lf"><span>상환 ${pct(paid)}</span><span>${l.day ? `이자일 ${l.day}일` : ''}</span></div>
      <div class="lm">${next ? `다음 상환 <b>${next}</b> ${won(l.plan[next])}` : '상환 계획 없음'}${end && bal > 0 ? ` · 완납 예정 ${end}` : ''}${l.note ? `<br><span class="muted">${esc(l.note)}</span>` : ''}</div></div>`; }).join('')}</div>
  ${sec('월말 잔액 일정 (상환 계획 반영)', `<div class="tablewrap"><table class="tbl sched"><thead><tr><th>대출</th>${months.map(x => `<th class="r ${x === m ? 'curc' : ''}">${x.slice(2).replace('-', '.')}</th>`).join('')}</tr></thead><tbody>${loans.map(l => `<tr><td>${who(l.borrower)}${esc(l.name)}</td>${months.map(x => { const b = C.loanBalance(l, x), pl = C.num((l.plan || {})[x]); return `<td class="r ${x === m ? 'curc' : ''} ${b === 0 ? 'zero' : ''}">${b === 0 ? '완납' : won(b)}${pl ? `<small class="repay">↓ ${won(pl)}</small>` : ''}</td>`; }).join('')}</tr>`).join('')}
    <tr class="sum"><td>합계</td>${months.map(x => `<td class="r ${x === m ? 'curc' : ''}">${won(loans.reduce((a, l) => a + C.loanBalance(l, x), 0))}</td>`).join('')}</tr></tbody></table></div><p class="muted small">↓ 표시는 그 달의 상환 계획입니다. 가로로 넘겨 보세요.</p>`)}
  ${sec('상환 계획 입력', `<form id="planform" class="row gap wrap" autocomplete="off"><select name="loan">${options(loans.map(l => l.name))}</select><input type="month" name="month" value="${m}" required>${moneyInput('amount', '', 'placeholder="상환액 (0이면 삭제)"')}<button class="btn">계획 저장</button></form>`)}
  ${sec('대출 목록 편집', listEditor('loanlist', LISTS.loanlist.get(), LISTS.loanlist.cols))}`;
}
function viewGoals() {
  const g = doc('goals') || {}, t = C.goalTracker(S.ctx); const sum = a => (a || []).reduce((x, y) => x + C.num(y.amount ?? y.balance), 0);
  const mk = (id, key, cols) => { LISTS[id] = { cols, get: () => (doc('goals') || {})[key] || [], save: rows => saveDoc('goals', { ...doc('goals'), [key]: rows }) }; return listEditor(id, LISTS[id].get(), cols); };
  const na = [{ k: 'name', label: '항목' }, { k: 'amount', label: '금액', t: 'money' }];
  return `<div class="kpis">${kpi('목표 저축액', won(g.target))}${kpi('현재 달성', won(t.achieved), `달성률 ${pct(t.rate)}`)}${kpi('목표일까지', t.dday === null ? '-' : `D-${t.dday}`, g.target_date || '')}${kpi('월 잔액 (계획)', won(t.surplus), `수입 ${won(t.incomePlan)} − 고정 ${won(t.fixed)} − 변동 ${won(t.variable)}`, t.surplus < 0 ? 'neg' : '')}${kpi(`${t.months}개월 총 저축 예상`, won(t.total), `월잔액×기간 ${won(t.projected)} 포함`)}${kpi('목표 대비', signed(t.gap), '', t.gap < 0 ? 'neg' : 'pos')}</div>
  ${sec('목표 설정', `<form id="goalform" class="form"><label>목표 저축액${moneyInput('target', g.target)}</label><label>목표일<input type="date" name="target_date" value="${esc(g.target_date || '')}"></label><label>결혼 목표<input type="date" name="wedding_date" value="${esc(g.wedding_date || '')}"></label><label>시나리오 기간(개월)<input name="months" inputmode="numeric" value="${(g.scenario || {}).months ?? ''}"></label><label>월 변동비 가정${moneyInput('monthly_variable', (g.scenario || {}).monthly_variable)}</label><label>대출 전액상환분${moneyInput('loan_payoff', (g.scenario || {}).loan_payoff)}</label><label>이자 절감 예상${moneyInput('interest_saving', (g.scenario || {}).interest_saving)}</label><label>기초 누적 (추적 시작 전)${moneyInput('base_cumulative', g.base_cumulative)}</label><div class="actions full"><button class="btn">저장</button></div></form>`)}
  ${sec('월별 트래커 (실적 = 통장 거래의 저축 + 대출상환)', `<div class="tablewrap"><table class="tbl sm"><thead><tr><th>월</th><th class="r">계획</th><th class="r">계획 누적</th><th class="r">실적</th><th class="r">실적 누적</th><th class="r">차이</th><th class="r">달성률</th></tr></thead><tbody>${t.rows.map(r => `<tr class="${r.month === S.month ? 'cur' : ''}"><td>${r.month}</td><td class="r">${won(r.plan)}</td><td class="r">${won(r.planCum)}</td><td class="r">${r.actual ? won(r.actual) : ''}</td><td class="r">${won(r.actCum)}</td><td class="r ${r.diff < 0 ? 'neg' : ''}">${won(r.diff)}</td><td class="r">${pct(r.rate)}</td></tr>`).join('')}</tbody></table></div>`)}
  ${sec('양가 가족행사 계획', mk('gevents', 'events', [{ k: 'month', label: '월', t: 'month' }, { k: 'event', label: '행사' }, { k: 'target', label: '대상' }, { k: 'amount', label: '금액', t: 'money' }, { k: 'note', label: '비고' }]))}
  ${sec(`보증금 구성 (합계 ${won(sum(g.deposit_parts))})`, mk('gdep', 'deposit_parts', na))}
  ${sec(`만기 시 보증금 반환 구성 (합계 ${won(sum(g.deposit_return))})`, mk('gret', 'deposit_return', na))}
  ${sec(`생활비 차입금 · 가족 (합계 ${won(sum(g.family_loans))})`, mk('gfam', 'family_loans', na))}
  ${sec(`저축·투자 계좌 (합계 ${won(sum(g.savings_accounts))})`, mk('gsav', 'savings_accounts', [{ k: 'name', label: '계좌' }, { k: 'balance', label: '현재 잔액', t: 'money' }]))}`;
}
function viewTax() {
  const tax = doc('tax') || {}; const r = C.taxSummary(S.ctx); const ps = Object.keys(tax.people || {});
  const row = (label, f, cls = '') => `<tr class="${cls}"><td>${label}</td>${ps.map(p => `<td class="r ${personClass(p)}">${f(r[p], p)}</td>`).join('')}</tr>`;
  const inp = (p, k, v) => `<input data-money inputmode="numeric" data-p="${p}" data-k="${k}" value="${fmtDigits(v)}">`;
  return `${sec(`${tax.year}년 귀속 신용카드 등 소득공제 (간이)`, `<table class="tbl" id="taxtbl"><thead><tr><th>항목</th>${ps.map(p => `<th class="r">${p}</th>`).join('')}</tr></thead><tbody>
  ${row('총급여 (연, 세전)', (x, p) => inp(p, 'salary', tax.people[p].salary))}
  ${row(`신용카드 (일반) — 자동 (${tax.auto_start}~)`, x => won(x.auto.신용))}${row('대중교통 — 자동', x => won(x.auto.대중교통))}
  ${row('신용카드 (일반) — 수기 (자동 집계 전)', (x, p) => inp(p, 'credit', tax.people[p].manual.credit))}${row('대중교통 — 수기', (x, p) => inp(p, 'transit', tax.people[p].manual.transit))}
  ${row('체크카드·현금영수증 — 수기', (x, p) => inp(p, 'debit', tax.people[p].manual.debit))}${row('전통시장 — 수기', (x, p) => inp(p, 'market', tax.people[p].manual.market))}${row('도서·공연 등 — 수기', (x, p) => inp(p, 'culture', tax.people[p].manual.culture))}
  ${row('총 사용액 (공제대상)', x => `<b>${won(x.total)}</b>`, 'sum')}${row('참고: 공제 제외 사용액 (자동)', x => won(x.auto.제외))}
  ${row('최저사용금액 (총급여 × 25%)', x => won(x.threshold))}${row('문턱까지 남은 사용액', x => won(x.toThreshold))}${row('공제가능금액', x => won(x.deductible))}${row('기본한도', x => won(x.baseLimit))}${row('① 기본공제', x => won(x.d1))}${row('② 추가공제 (시장·교통·문화)', x => won(x.d2))}
  ${row('총 소득공제 (①+②)', x => `<b>${won(x.deduction)}</b>`, 'sum')}${row('예상 절세액 (× 한계세율)', x => won(x.saving))}${row('체크카드로 채우려면 더 쓸 금액', x => x.needDebit === null ? '문턱 전' : won(x.needDebit))}${row('지금 전략', x => `<small>${esc(x.strategy)}</small>`)}
  </tbody></table><div class="row gap end"><button class="btn" data-act="taxSave">입력값 저장</button></div><p class="muted small">공과금·통신비·보험료·상품권 등은 가맹점 키워드로 자동 제외합니다. 세법 기준값과 키워드는 저장된 설정을 따르며, 실제 연말정산 결과와 다를 수 있습니다.</p>`)}`;
}
function viewTrend() {
  const months = C.monthsWithData(S.ctx); const cur = C.todayStr().slice(0, 7); if (!months.includes(cur)) months.push(cur);
  const rows = months.map(m => C.monthSummary(S.ctx, m)); const cats = rows[0].variable.map(v => v.cat);
  return sec('월별 실적 (사용월 기준)', `<div class="tablewrap"><table class="tbl sm"><thead><tr><th>월</th><th class="r">수입</th><th class="r">쓴 돈</th><th class="r">남는 돈</th><th class="r">급여 입금</th><th class="r">부수입</th>${cats.map(c => `<th class="r">${esc(c)}</th>`).join('')}${rows[0].persons.map(p => `<th class="r">${p} 용돈</th>`).join('')}<th class="r">고정(카드)</th><th class="r">기타</th><th class="r">카드 합계</th><th class="r">카드대금</th><th class="r">저축</th><th class="r">대출상환</th></tr></thead><tbody>
  ${rows.map(s => `<tr class="${s.month === S.month ? 'cur' : ''}"><td><a href="#/home" data-act="gotoMonth" data-m="${s.month}">${s.month}</a></td><td class="r">${won(s.income)}</td><td class="r">${won(s.result.spent.total)}${s.result.open ? `<br><small class="muted">+ 남은 예산 ${won(s.result.remain.total)}</small>` : ''}</td><td class="r"><b class="${s.canSave < 0 ? 'neg' : ''}">${s.canSave < 0 ? '▲ ' : ''}${won(s.canSave)}</b></td><td class="r">${won(s.salaryActual)}</td><td class="r">${won(s.side)}</td>${s.variable.map(v => `<td class="r ${v.left < 0 ? 'neg' : ''}">${won(v.actual)}</td>`).join('')}${s.persons.map(p => `<td class="r">${won(s.allowance[p].used + s.allowance[p].advance)}</td>`).join('')}<td class="r">${won(s.fixedCardActual)}</td><td class="r">${won(s.misc)}</td><td class="r"><b>${won(s.cardTotal)}</b></td><td class="r">${won(s.billTotal.actual ?? s.billTotal.expected)}</td><td class="r">${won(s.saved)}</td><td class="r">${won(s.repaid)}</td></tr>`).join('')}</tbody></table></div><p class="muted small">남는 돈 = 수입(급여 계획 + 부수입) − 쓴 돈(고정 이체 + 카드 사용(쓴 달 기준) + 할부 월 납입 + 통장 지출). 진행 중인 달은 남은 예산까지 뺀 예상치입니다. 빨간 숫자는 예산 초과입니다. 7~9월의 식비·낚시는 엑셀 "내용"에 적힌 단어로 분류했습니다.</p>`);
}
function closeSnapshot(m) { const s = C.monthSummary(S.ctx, m); const g = C.goalTracker(S.ctx); return { 수입: s.income, 부수입: s.side, '고정(현금) 이체': s.fixedCashTotal, '고정(카드) 예산': s.fixedCardBudget, '고정(카드) 승인': s.fixedCardActual, ...Object.fromEntries(s.variable.flatMap(v => [[`${v.cat} 예산`, v.budget], [`${v.cat} 실행`, v.actual]])), ...Object.fromEntries(s.persons.flatMap(p => [[`${p} 용돈`, s.allowance[p].used], [`${p} 가불`, s.allowance[p].advance]])), 할부: s.installment, 기타: s.misc, '카드대금 승인기준': s.billTotal.expected, '카드대금 실제': s.billTotal.actual, '승인−청구 차액': s.billTotal.discount, '모임통장 예상 월말': s.mainEnd, '저축 실적': s.saved, '대출상환 실적': s.repaid, '목표 누적': g.achieved, '대출 잔액': s.loanTotal, 저축률: s.saveRate }; }
function viewCloses() {
  const cs = S.data.closes.slice().sort((a, b) => b.month.localeCompare(a.month)); if (!cs.length) return `<section class="card empty">아직 마감한 달이 없습니다. 홈 화면 아래의 "월 마감 저장"을 누르면 그 시점의 숫자가 여기에 보관됩니다.</section>`;
  const keys = [...new Set(cs.flatMap(c => Object.keys(c.snapshot)))];
  return sec('마감 기록 (저장 당시 값)', `<div class="tablewrap"><table class="tbl sm"><thead><tr><th>항목</th>${cs.map(c => `<th class="r">${c.month}<br><small>${c.closed_at.slice(0, 10)}</small></th>`).join('')}</tr></thead><tbody>${keys.map(k => `<tr><td>${esc(k)}</td>${cs.map(c => `<td class="r">${k === '저축률' ? pct(c.snapshot[k]) : won(c.snapshot[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="muted small">마감 후 데이터를 고쳐도 이 표의 숫자는 바뀌지 않습니다. 다시 저장하면 덮어씁니다.</p>`);
}
function viewMaster() {
  const ms = master(); const acct = () => (master().accounts || []).map(a => a.name), cardsN = () => (master().cards || []).map(c => c.name); const who = ['은경', '영민', '공동'];
  const defs = [
    ['accounts', '통장 (통장 쪼개기)', [{ k: 'name', label: '통장명' }, { k: 'memo', label: '메모' }, { k: 'purpose', label: '용도' }, { k: 'person', label: '사람', t: 'select', opts: who }, { k: 'opening', label: `기초잔액 (${ms.opening_date || ''})`, t: 'money' }, { k: 'tracked', label: '장부관리', t: 'bool' }], '장부관리에 체크한 통장만 잔액을 계산합니다. 계좌번호는 저장하지 않습니다.'],
    ['cards', '카드', [{ k: 'name', label: '카드' }, { k: 'person', label: '사람', t: 'select', opts: who }, { k: 'issuer', label: '카드사 파일', t: 'select', opts: [['lotte', '롯데'], ['kb', '국민'], ['hd', '현대']] }, { k: 'pay_day', label: '결제일', t: 'num', w: 44 }, { k: 'pay_account', label: '결제계좌', t: 'select', opts: acct }, { k: 'period_start', label: '이용기간 시작일', t: 'num', w: 44 }], '카드 이름을 바꾸면 기존 내역과 연결이 끊어지니 바꾸지 마세요. 새 카드는 행을 추가하세요.'],
    ['incomes', '수입', [{ k: 'name', label: '항목' }, { k: 'person', label: '사람', t: 'select', opts: who }, { k: 'day', label: '입금일', t: 'num', w: 44 }, { k: 'amount', label: '금액', t: 'money' }, { k: 'account', label: '입금계좌', t: 'select', opts: acct }, { k: 'early', label: '전월 말 선지급', t: 'bool' }]],
    ['fixed_cash', '고정지출 (현금·이체)', [{ k: 'name', label: '항목' }, { k: 'person', label: '사람', t: 'select', opts: who }, { k: 'account', label: '출금계좌', t: 'select', opts: acct }, { k: 'day', label: '출금일', t: 'num', w: 44 }, { k: 'amount', label: '월 금액', t: 'money' }, { k: 'allowance', label: '용돈 차감', t: 'bool' }, { k: 'note', label: '비고' }], '"용돈 차감"에 체크한 항목은 전월 카드 용돈·가불만큼 이체액이 줄어듭니다. 기본 용돈을 넘겨 쓴 금액은 이월하지 않습니다.'],
    ['fixed_card', '고정지출 (카드)', [{ k: 'name', label: '항목' }, { k: 'person', label: '사람', t: 'select', opts: who }, { k: 'card', label: '카드', t: 'select', opts: cardsN, blank: '-' }, { k: 'due', label: '결제일(참고)' }, { k: 'budget', label: '월 예산', t: 'money' }, { k: 'note', label: '비고' }], '항목명이 카드 내역의 "내용"과 같아야 홈 화면에서 승인 여부가 맞춰집니다.'],
    ['rules', '자동분류 규칙', [{ k: 'keyword', label: '가맹점 키워드' }, { k: 'card', label: '적용 카드', t: 'select', opts: cardsN, blank: '전체' }, { k: 'category', label: '카테고리', t: 'select', opts: () => master().card_categories || [], blank: '-' }, { k: 'fixed', label: '고정', t: 'bool' }, { k: 'label', label: '내용(항목명)' }], '위에서부터 먼저 맞는 규칙을 적용합니다(띄어쓰기는 무시). 카드 파일을 올릴 때 새 건에 적용되고, 미분류 건에는 카드 화면에서 미리 선택된 상태로 제안됩니다.'],
  ];
  defs.forEach(([key, , cols]) => { LISTS['m_' + key] = { cols, get: () => master()[key] || [], save: rows => saveDoc('master', { ...master(), [key]: rows }) }; });
  return `<div class="chips scroll">${defs.map(d => `<a class="chip" href="javascript:void 0" data-act="jump" data-to="sec_${d[0]}">${d[1]}</a>`).join('')}</div>
  ${defs.map(([key, title, cols, help]) => `<div id="sec_${key}">${sec(title, listEditor('m_' + key, ms[key] || [], cols) + (help ? `<p class="muted small">${help}</p>` : ''))}</div>`).join('')}
  ${sec('분류·기준', `<form id="miscform" class="form"><label class="full">카드 카테고리 (쉼표로 구분)<input name="card_categories" value="${esc((ms.card_categories || []).join(', '))}"></label><label class="full">통장 분류 (쉼표로 구분)<input name="bank_categories" value="${esc((ms.bank_categories || []).join(', '))}"></label>
    <label>새 방식 시작 월<input type="month" name="start_month" value="${esc(ms.start_month || '')}"></label><label>기초잔액 기준일<input type="date" name="opening_date" value="${esc(ms.opening_date || '')}"></label>
    <label>월초 고정지출 일괄 출금일<input name="fixed_day" inputmode="numeric" autocomplete="off" value="${(ms.flow || {}).fixed_day ?? 2}"></label><label>카드대금 이체일(급여 후)<input name="card_day" inputmode="numeric" autocomplete="off" value="${(ms.flow || {}).card_day ?? 10}"></label>
    <label class="chk full"><input type="checkbox" name="deduct_card" ${ms.allowance_deduct_card !== false ? 'checked' : ''}> 전월 카드 용돈을 이번 달 용돈 이체액에서 뺍니다 (끄면 가불만 뺍니다)</label>
    <div class="actions full"><button class="btn">저장</button></div></form><p class="muted small">"용돈"·"용돈가불" 카테고리 이름은 용돈 차감 계산에, "리셀"은 예산 제외에, 통장 분류의 "급여·부수입·정산입금·고정·경조사·가족·기타·이체·카드대금·저축·대출상환"은 집계에 쓰이니 이름을 바꾸지 마세요. 새로 추가한 통장 분류는 지출로 봅니다.</p>`)}`;
}
function viewData() {
  const meta = doc('meta') || {}; const checks = (meta.checks || []).map(c => ({ ...c, actual: S.ctx.rows.filter(r => r.useMonth === c.month && r.card === c.card && r.source === 'excel').reduce((a, r) => a + ((r.raw || {}).excel_applied ?? (C.num(r.amount) + C.num(r.adjustment))), 0) }));
  const okN = checks.filter(c => c.actual === c.expected).length;
  return `${sec('가져오기 · 내보내기', `<div class="row gap wrap"><label class="btn">이관 파일(JSON) 가져오기<input type="file" id="seedfile" accept=".json" hidden></label><button class="btn ghost" data-act="export">전체 백업 내려받기</button></div><p class="muted small">이관 파일은 미니가 기존 엑셀(7~11월)과 v4 기준정보로 만든 <b>우리의장부_이관데이터.json</b>입니다. 이미 있는 내역은 건너뛰므로 다시 올려도 중복되지 않습니다. 백업 파일에는 가계부 전체가 들어 있으니 안전한 곳에 보관하세요.</p><div id="seedResult"></div>`)}
  ${checks.length ? sec(`엑셀 대조 ${okN}/${checks.length} 일치`, `<table class="tbl sm"><thead><tr><th>대상 (엑셀 시트의 반영액 합계 = 금액 + 조정액)</th><th class="r">엑셀</th><th class="r">앱</th><th class="c">결과</th></tr></thead><tbody>${checks.map(c => `<tr><td>${esc(c.label)}</td><td class="r">${won(c.expected)}</td><td class="r">${won(c.actual)}</td><td class="c">${c.actual === c.expected ? tag('일치', 'ok') : tag(signed(c.actual - c.expected), 'warn')}</td></tr>`).join('')}</tbody></table><p class="muted small">이관한 뒤 앱에서 조정액을 고치면 차이가 생길 수 있습니다.</p>`) : ''}
  ${(meta.warnings || []).length ? sec(`확인 필요 ${meta.warnings.length}건 (엑셀 이관 시 발견)`, `<ul class="plain">${meta.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`) : ''}`;
}
function viewAudit() {
  setTimeout(async () => { const box = document.querySelector('#auditbox'); if (!box) return; try { const rows = await S.store.audit(); const names = Object.fromEntries(S.member.members.map(m => [m.user_id, m.display_name])); const T = { ledger_card_tx: '카드', ledger_bank_tx: '통장', ledger_card_bills: '카드대금' }, A = { insert: '추가', update: '수정', delete: '삭제' };
    const diff = a => { const b = a.before || {}, n = a.after || {}; const skip = ['updated_at', 'updated_by', 'created_at', 'created_by', 'household_id', 'id']; if (a.action !== 'update') { const x = n.merchant || n.memo || b.merchant || b.memo || a.row_id; return esc(`${x} ${won(n.amount ?? n.withdrawal ?? n.deposit ?? n.actual ?? b.amount ?? '')}`); } return Object.keys(n).filter(k => !skip.includes(k) && JSON.stringify(b[k]) !== JSON.stringify(n[k])).map(k => `${esc(k)}: ${esc(b[k] ?? '∅')} → ${esc(n[k] ?? '∅')}`).join('<br>'); };
    box.innerHTML = rows.length ? `<table class="tbl sm"><thead><tr><th>시각</th><th>누가</th><th>대상</th><th>작업</th><th>내용</th></tr></thead><tbody>${rows.map(a => `<tr><td>${esc(new Date(a.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }))}</td><td>${esc(names[a.actor] || '-')}</td><td>${T[a.tbl] || esc(a.tbl)}</td><td>${A[a.action] || esc(a.action)}</td><td><small>${diff(a)}</small></td></tr>`).join('')}</tbody></table>` : '<div class="empty">변경 이력이 없습니다.</div>'; } catch (e) { box.textContent = e.message; } }, 0);
  return `<section class="card flush"><div id="auditbox" class="tablewrap"><div class="empty">불러오는 중…</div></div></section><p class="muted small">카드·통장·카드대금의 최근 변경 200건입니다.</p>`;
}
function viewAccount() {
  const h = S.member.household;
  return `${sec('함께 쓰는 사람', `<div class="chips">${S.member.members.map(m => `<span class="chip ${personClass(m.display_name)}">${esc(m.display_name)}</span>`).join('')}</div>
  ${S.member.members.length < h.max_members ? `<p>초대 코드: <b class="code">${esc(h.invite_code)}</b></p><p class="muted small">상대방이 이 주소에서 가입한 뒤 "가계부 연결" 화면에 이 코드를 넣으면 같은 가계부를 봅니다. 두 사람이 모두 들어오면 코드는 더 쓸 수 없습니다.</p>` : '<p class="muted small">두 사람이 모두 연결됐습니다.</p>'}`)}
  ${sec('이 기기', `<p class="muted small">${esc(S.session.user.email || '')} (${S.store.mode === 'demo' ? '데모' : '로그인됨'}) · 로그아웃하지 않으면 다시 로그인하지 않아도 됩니다.</p>
    <div class="row gap wrap" id="biobox"><span class="muted small">지문·얼굴 잠금 확인 중…</span></div>
    <div class="row gap mt"><button class="btn ghost" data-act="logout">로그아웃</button></div>`)}`;
}

async function migrate() {
  for (const fn of [C.migrateV2, C.migrateV3, C.migrateV4]) { const plan = fn(S.data); if (!plan) continue;
    for (const c of plan.cardPatches) Object.assign(S.data.card_tx.find(x => x.id === c.id), await S.store.updateCard(c.id, c.patch));
    for (const b of plan.bankPatches) Object.assign(S.data.bank_tx.find(x => x.id === b.id), await S.store.updateBank(b.id, b.patch));
    await S.store.saveDoc('master', plan.master); S.data.docs.master = plan.master; }
}
// ---------- 동작
const ACT = {
  month(el) { S.month = C.addMonth(S.month, Number(el.dataset.d)); S.sel.clear(); render(); },
  gotoMonth(el) { S.month = el.dataset.m; if (location.hash === el.getAttribute('href')) { render(); window.scrollTo(0, 0); } },
  authMode() { S.authMode = S.authMode === 'up' ? 'in' : 'up'; render(); },
  async bioOn() { try { await bioEnable(S.session.user.email); S.unlocked = true; markSeen(); toast('다음부터 지문·얼굴로 열립니다.'); render(); } catch { toast('설정하지 못했습니다. 이 기기에서 지문·얼굴 인식이 켜져 있는지 확인해 주세요.', true); } },
  bioOff() { bioDisable(); toast('지문·얼굴 잠금을 껐습니다.'); render(); },
  breakdown(el) { breakdownModal(el.dataset.k); },
  logout() { run(async () => { bioDisable(); await S.store.signOut(); S.session = null; S.member = null; S.data = null; render(); }); },
  modalClose() { closeModal(); },
  todo(el) { closeModal(); S.flash = el.dataset.flash || ''; if (el.dataset.kind !== undefined) S.cardFilter = { card: '', kind: el.dataset.kind }; },
  cfToggle(el) { S.cfOpen = !S.cfOpen; const t = el.closest('table'); t.classList.toggle('cfopen', S.cfOpen); el.setAttribute('aria-expanded', S.cfOpen ? 'true' : 'false'); el.querySelector('.cfx').textContent = S.cfOpen ? '▾ 지난 내역 접기' : '▸ 지난 내역 펼치기'; try { localStorage.setItem('ol_cfopen', S.cfOpen ? '1' : ''); } catch {} },
  billOpen(el) { S.billOpen = S.billOpen === el.dataset.card ? '' : el.dataset.card; const y = window.scrollY; render(); window.scrollTo(0, y); },
  bankSort() { S.bankSort = S.bankSort === 'asc' ? 'desc' : 'asc'; render(); },
  bankPaste() { bankPasteModal(); },
  jump(el) { document.getElementById(el.dataset.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  cardFilter(el) { S.cardFilter[el.dataset.k] = el.dataset.v; S.sel.clear(); render(); },
  instOk(el) { const id = Number(el.dataset.id); run(async () => { const row = await S.store.updateCard(id, { inst_checked: true }); Object.assign(S.data.card_tx.find(x => x.id === id), row); rebuild(); keepScroll(); }, '할부 확인했습니다.'); },
  selToggle(el) { const id = Number(el.dataset.id); S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); if (!S.sel.size) S.bulkCat = ''; keepScroll(); },
  selAll() { const rs = cardRows().filter(r => !r.spreadPart); const all = rs.length && rs.every(r => S.sel.has(r.id)); rs.forEach(r => all ? S.sel.delete(r.id) : S.sel.add(r.id)); if (!S.sel.size) S.bulkCat = ''; keepScroll(); },
  selClear() { S.sel.clear(); S.bulkCat = ''; keepScroll(); },
  bulkPick(el) { S.bulkCat = S.bulkCat === el.dataset.cat ? '' : el.dataset.cat; keepScroll(); },
  bulkApply() { const c = S.bulkCat;
    const jobs = c ? [...S.sel].map(id => [id, c === '__fixed' ? { fixed: true } : c === '__none' ? { category: '', fixed: false } : { category: c, fixed: false }])
      : bulkOwn().map(r => { const st = S.stage[r.id]; return [r.id, { category: st.category || '', fixed: !!st.fixed, label: st.fixed && st.label ? st.label : (r.label || ''), memo: st.memo !== undefined ? st.memo.trim() : (r.memo || '') }]; });
    if (!jobs.length) return;
    run(async () => { for (const [id, patch] of jobs) { Object.assign(S.data.card_tx.find(x => x.id === id), await S.store.updateCard(id, patch)); delete S.stage[id]; S.sel.delete(id); } if (c) S.sel.clear(); S.bulkCat = ''; rebuild(); keepScroll(); }, `${jobs.length}건을 반영했습니다.`); },
  cardEdit(el) { cardModal(S.ctx.rows.find(r => r.id === Number(el.dataset.id))); },
  cardNew() { cardModal(null); },
  noop() { },
  stagePick(el) { const r = S.ctx.rows.find(x => x.id === Number(el.dataset.id)); const st = stageOf(r); st.auto = false;
    if (el.dataset.cat === '__fixed') { st.fixed = !st.fixed; if (st.fixed && !st.label) { const rule = C.applyRules(master(), r.card, r.merchant); st.label = (rule && rule.label) || ''; } }
    else st.category = st.category === el.dataset.cat ? '' : el.dataset.cat;
    const y = window.scrollY; render(); window.scrollTo(0, y); },
  stageClear() { S.ctx.rows.filter(r => r.useMonth === S.month && r.unclassified).forEach(r => { S.stage[r.id] = { category: '', fixed: false, label: '', auto: false }; }); render(); },
  stageApply() { const list = stageList(); if (!list.length) return; const miss = list.filter(x => x.st.fixed && !x.st.label && !x.r.label); if (miss.length && !confirm(`고정 항목을 고르지 않은 건이 ${miss.length}건 있습니다. 그대로 반영할까요?`)) return;
    run(async () => { for (const { r, st } of list) { const patch = { category: st.category || '', fixed: !!st.fixed, label: st.fixed && st.label ? st.label : (r.label || ''), memo: st.memo !== undefined ? st.memo.trim() : (r.memo || '') }; Object.assign(S.data.card_tx.find(x => x.id === r.id), await S.store.updateCard(r.id, patch)); delete S.stage[r.id]; } rebuild(); render(); }, `${list.length}건을 반영했습니다.`); },
  settleDone(el) { const r = S.ctx.rows.find(x => x.id === Number(el.dataset.id));
    openModal(`<h2>정산 받음</h2><div class="rawinfo"><b>${who(r.person)}${esc(r.label || r.merchant)}</b><span>${r.used_date} · ${esc(r.card)}</span><span>받을 금액 <b>${won(r.settle)}원</b></span></div><p class="muted small">개인통장으로 받은 돈을 모임통장으로 옮겼다면 입금 기록까지 함께 남기세요. "정산입금"은 수입에 잡히지 않습니다.</p><div class="actions"><button class="btn ghost" data-act="modalClose">닫기</button><button class="btn ghost" data-act="settleMark" data-id="${r.id}" data-bank="0">받음만 표시</button><button class="btn" data-act="settleMark" data-id="${r.id}" data-bank="1">받음 + 모임통장 입금 기록</button></div>`); },
  settleMark(el) { const id = Number(el.dataset.id); const r = S.ctx.rows.find(x => x.id === id);
    run(async () => { Object.assign(S.data.card_tx.find(x => x.id === id), await S.store.updateCard(id, { settle_done: true }));
      if (el.dataset.bank === '1') S.data.bank_tx.push(...await S.store.insertBank([{ tx_date: C.todayStr(), account: '모임통장', memo: `정산 ${r.label || r.merchant}`.slice(0, 80), deposit: r.settle, withdrawal: 0, category: '정산입금', fixed: false, note: `${r.used_date} ${r.card} 결제분`, source: 'manual' }]));
      closeModal(); rebuild(); render(); }, '정산을 기록했습니다.'); },
  bankFilter(el) { S.bankFilter = el.dataset.v; render(); },
  bankNew() { bankModal(null); },
  bankEdit(el) { bankModal(S.data.bank_tx.find(b => b.id === Number(el.dataset.id))); },
  fixedDone(el) { const s = C.monthSummary(S.ctx, S.month); const f = s.fixedCash[Number(el.dataset.i)]; const ms = master();
    run(async () => {
      if (f.done) { const rows = S.data.bank_tx.filter(b => b.tx_date.slice(0, 7) === S.month && b.fixed && b.memo === f.name && b.source === 'check'); if (!rows.length) return toast('통장 화면에서 직접 입력한 거래입니다. 통장 화면에서 고쳐 주세요.', true); for (const b of rows) { await S.store.deleteBank(b.id); S.data.bank_tx = S.data.bank_tx.filter(x => x.id !== b.id); } }
      else { const tracked = (ms.accounts || []).find(a => a.name === f.account && a.tracked); const day = String(Math.min(f.day || 1, C.daysIn(S.month))).padStart(2, '0');
        S.data.bank_tx.push(...await S.store.insertBank([{ tx_date: `${S.month}-${day}`, account: tracked ? f.account : '모임통장', memo: f.name, deposit: 0, withdrawal: f.transfer, category: '고정', fixed: true, note: tracked ? '' : `→ ${f.account}`, source: 'check' }])); }
      rebuild(); render();
    }); },
  closeMonth() { if (!confirm(`${monthLabel(S.month)} 숫자를 지금 값으로 마감 저장할까요?`)) return; run(async () => { const row = await S.store.saveClose(S.month, closeSnapshot(S.month), ''); S.data.closes = S.data.closes.filter(c => c.month !== S.month).concat(row); render(); }, '마감을 저장했습니다.'); },
  rowAdd(el) { addRow(el.dataset.target, LISTS[el.dataset.target].cols); },
  rowDel(el) { el.closest('tr').remove(); },
  listSave(el) { const L = LISTS[el.dataset.target]; L.save(readList(el.dataset.target, L.cols, L.get())); },
  budgetSave() { const ms = structuredClone(master()); ms.budgets = ms.budgets || { defaults: {}, overrides: {} }; ms.budgets.overrides = ms.budgets.overrides || {}; const ov = { ...(ms.budgets.overrides[S.month] || {}) };
    document.querySelectorAll('#budgettbl tbody tr').forEach(tr => { const def = tr.querySelector('[data-f=def]').value;
      if (tr.dataset.new) { const name = tr.querySelector('[data-f=name]').value.trim(); if (!name) return; ms.budgets.defaults[name] = toNum(def); if (!ms.card_categories.includes(name)) ms.card_categories.push(name); if (!ms.bank_categories.includes(name)) ms.bank_categories.splice(Math.max(0, ms.bank_categories.indexOf('저축')), 0, name); return; }
      const cat = tr.dataset.cat; const d = toNum(def), mon = toNum(tr.querySelector('[data-f=mon]').value); const oldDef = C.num(master().budgets.defaults[cat]); ms.budgets.defaults[cat] = d;
      if (mon !== d && !(d !== oldDef && mon === oldDef && !(cat in ov))) ov[cat] = mon; else delete ov[cat]; });
    if (Object.keys(ov).length) ms.budgets.overrides[S.month] = ov; else delete ms.budgets.overrides[S.month]; saveDoc('master', ms); },
  taxSave() { const tax = structuredClone(doc('tax')); document.querySelectorAll('#taxtbl input[data-p]').forEach(i => { const p = tax.people[i.dataset.p]; if (i.dataset.k === 'salary') p.salary = toNum(i.value); else p.manual[i.dataset.k] = toNum(i.value); }); saveDoc('tax', tax); },
  export() { const blob = new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), docs: S.data.docs, card_tx: S.data.card_tx, bank_tx: S.data.bank_tx, card_bills: S.data.card_bills, closes: S.data.closes })], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `우리의장부_백업_${C.todayStr()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
};
function keepScroll() { const y = window.scrollY; render(); window.scrollTo(0, y); }
// PC: 카드 내역에서 마우스 오른쪽 버튼을 누르면 그 줄이 선택/해제된다
document.addEventListener('contextmenu', e => { const it = e.target.closest('.item[data-sel]'); if (!it || e.target.closest('input,select,textarea')) return; e.preventDefault(); ACT.selToggle(it); });
document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (!el || !ACT[el.dataset.act]) return; if (el.tagName === 'BUTTON') e.preventDefault(); ACT[el.dataset.act](el, e); });
document.addEventListener('input', e => { const t = e.target; if (t.classList && t.classList.contains('stmemo')) { const r = S.ctx.rows.find(x => x.id === Number(t.dataset.id)); if (!r) return; stageOf(r).memo = t.value; const bar = document.querySelector('#applybar'); if (bar) bar.outerHTML = applyBar(); } });
document.addEventListener('change', e => {
  const t = e.target;
  if (t.classList.contains('stfix')) { const r = S.ctx.rows.find(x => x.id === Number(t.dataset.id)); if (r) { const st = stageOf(r); st.label = t.value; st.auto = false; } return; }
  if (t.id === 'cardfiles' && t.files.length) { const fs = [...t.files]; t.value = ''; handleCardFiles(fs); }
  if (t.id === 'bankfile' && t.files.length) { const f = t.files[0]; t.value = ''; handleBankFile(f); }
  if (t.id === 'seedfile' && t.files.length) importSeed(t.files[0]);
  if (t.classList.contains('billin')) { const v = t.value.trim() === '' ? null : toNum(t.value); run(async () => { const row = await S.store.setBill(S.month, t.dataset.card, v, ''); S.data.card_bills = S.data.card_bills.filter(b => !(b.bill_month === S.month && b.card === t.dataset.card)).concat(row); rebuild(); render(); }, '청구액을 저장했습니다.'); }
});
document.addEventListener('submit', e => {
  const f = e.target; if (!['planform', 'goalform', 'miscform'].includes(f.id)) return; e.preventDefault(); const v = Object.fromEntries(new FormData(f));
  if (f.id === 'planform') { const loans = structuredClone(doc('loans')); const l = loans.find(x => x.name === v.loan); l.plan = l.plan || {}; const amt = toNum(v.amount); if (amt) l.plan[v.month] = amt; else delete l.plan[v.month]; saveDoc('loans', loans); }
  if (f.id === 'goalform') { const g = structuredClone(doc('goals') || {}); Object.assign(g, { target: toNum(v.target), target_date: v.target_date, wedding_date: v.wedding_date, base_cumulative: toNum(v.base_cumulative) }); g.scenario = { ...(g.scenario || {}), months: Number(v.months) || 0, monthly_variable: toNum(v.monthly_variable), loan_payoff: toNum(v.loan_payoff), interest_saving: toNum(v.interest_saving) }; saveDoc('goals', g); }
  if (f.id === 'miscform') { const ms = structuredClone(master()); const list = s => [...new Set(s.split(',').map(x => x.trim()).filter(Boolean))]; ms.card_categories = list(v.card_categories); ms.bank_categories = list(v.bank_categories); ms.start_month = v.start_month; ms.opening_date = v.opening_date; ms.allowance_deduct_card = f.elements.deduct_card.checked; ms.flow = { ...(ms.flow || {}), fixed_day: Math.min(28, Math.max(1, Number(v.fixed_day) || 2)), card_day: Math.min(28, Math.max(1, Number(v.card_day) || 10)) }; saveDoc('master', ms); }
});
async function importSeed(file) {
  const box = document.querySelector('#seedResult');
  await run(async () => {
    const seed = JSON.parse(await file.text()); if (!seed.docs || !Array.isArray(seed.card_tx)) throw new Error('이관 파일 형식이 아닙니다.');
    const hasData = !!S.data.docs.master; if (hasData && !confirm('기초 데이터가 이미 있습니다.\n[확인] 기초 데이터는 그대로 두고, 없는 카드·통장 내역만 추가합니다.')) return;
    box.innerHTML = '<p class="muted">가져오는 중… 창을 닫지 마세요.</p>';
    if (!hasData) for (const [k, v] of Object.entries(seed.docs)) { await S.store.saveDoc(k, v); S.data.docs[k] = v; }
    const have = new Set(S.data.card_tx.map(cardKey)); const cards = seed.card_tx.filter(r => !have.has(cardKey(r)));
    const refs = new Set(S.data.bank_tx.map(b => b.source_ref).filter(Boolean)); const bank = (seed.bank_tx || []).filter(b => !b.source_ref || !refs.has(b.source_ref));
    if (cards.length) S.data.card_tx.push(...await S.store.insertCards(cards));
    if (bank.length) S.data.bank_tx.push(...await S.store.insertBank(bank));
    for (const b of seed.card_bills || []) { if (!S.data.card_bills.some(x => x.bill_month === b.bill_month && x.card === b.card)) S.data.card_bills.push(await S.store.setBill(b.bill_month, b.card, b.actual, b.note)); }
    await migrate(); rebuild(); render(); toast(`가져오기 완료: 카드 ${cards.length}건 · 통장 ${bank.length}건${hasData ? '' : ' · 기초 데이터'}`);
  });
}
boot();
