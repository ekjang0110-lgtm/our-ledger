// 우리의 장부 계산 엔진 (가계부_v4 수식 이식). 순수 함수만 둡니다.
export const num = v => Number(v) || 0;
export const addMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const i = y * 12 + mo - 1 + n; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`; };
export const monthDiff = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + bm - am; };
export const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sum = (arr, f) => arr.reduce((s, x) => s + num(f(x)), 0);

export function buildCtx(data) {
  const master = data.master || {}; const cards = master.cards || [];
  const cardMap = Object.fromEntries(cards.map(c => [c.name, c]));
  const autoFrom = master.auto_inst_from || '0000-00-00';
  const rows = (data.card_tx || []).map(r => {
    const c = cardMap[r.card] || {}; const useMonth = r.used_date.slice(0, 7); const day = Number(r.used_date.slice(8, 10));
    let billMonth = (c.issuer === 'kb' && r.pay_due) ? r.pay_due.slice(0, 7) : addMonth(useMonth, 1 + ((num(c.period_start) > 1 && day >= num(c.period_start)) ? 1 : 0));
    const K = num(r.inst_months); const auto = K > 1 && r.used_date >= autoFrom && num(r.amount) > 0;
    const later = auto ? Math.floor(r.amount / K) : 0; const first = auto ? r.amount - later * (K - 1) : 0;
    const onnuri = Math.max(0, Math.min(num(r.onnuri), num(r.amount))), settle = num(r.settle);
    const billAmt = num(r.amount) - onnuri, prepaidEff = Math.max(0, Math.min(num(r.prepaid), billAmt));
    const resale = r.category === '리셀';
    // 반영액(예산): 할부는 월 납입액만, 정산 받을 돈·개인 온누리 사용분은 빼고, 리셀은 예산에서 제외
    const applied = resale ? 0 : (auto ? first : num(r.amount)) + num(r.adjustment) - settle - (r.onnuri_shared ? 0 : onnuri);
    return { ...r, applied, useMonth, billMonth, K, auto, first, later, onnuri, settle, billAmt, prepaidEff, resale, unclassified: !r.category && !r.fixed && num(r.amount) > 0, person: r.person || c.person || '' };
  });
  return { ...data, master, cards, cardMap, rows, bank: data.bank_tx || [], bills: data.card_bills || [], installments: data.installments || [], loans: data.loans || [], memo: {} };
}

export const budgetFor = (master, m, cat) => { const b = master.budgets || {}; const o = (b.overrides || {})[m]; return (o && cat in o) ? num(o[cat]) : num((b.defaults || {})[cat]); };
export const budgetCats = master => { const b = master.budgets || {}; const s = new Set(Object.keys(b.defaults || {})); Object.values(b.overrides || {}).forEach(o => Object.keys(o).forEach(k => s.add(k))); return [...s]; };

export function cardBill(ctx, m, cardName) {
  const key = `bill:${m}:${cardName}`; if (ctx.memo[key]) return ctx.memo[key];
  const rs = ctx.rows.filter(r => r.card === cardName);
  const lump = sum(rs.filter(r => r.billMonth === m && r.K <= 1), r => r.billAmt);
  const prepaid = sum(rs.filter(r => r.billMonth === m), r => r.prepaidEff);
  const newInst = sum(rs.filter(r => r.auto && r.billMonth === m), r => r.first);
  const contInst = sum(rs.filter(r => { if (!r.auto) return false; const d = monthDiff(r.billMonth, m); return d >= 1 && d <= r.K - 1; }), r => r.later);
  const legacy = sum(ctx.installments.filter(i => i.card === cardName), i => (i.charges || {})[m]);
  const issuerDiscount = sum(rs.filter(r => r.billMonth === m), r => r.issuer_discount);
  const expected = lump - prepaid + newInst + contInst + legacy;
  const b = ctx.bills.find(x => x.bill_month === m && x.card === cardName);
  const actual = (b && b.actual !== null && b.actual !== undefined && b.actual !== '') ? num(b.actual) : null;
  const c = ctx.cardMap[cardName] || {};
  const payDay = Math.min(num(c.pay_day) || 1, daysIn(m));
  return ctx.memo[key] = { card: cardName, person: c.person, payAccount: c.pay_account, payDay, payDate: `${m}-${String(payDay).padStart(2, '0')}`, lump, prepaid, lumpNet: lump - prepaid, newInst, contInst, legacy, installment: newInst + contInst + legacy,
    expected, actual, final: actual === null ? expected : actual, discount: actual === null ? null : expected - actual, issuerDiscount, note: b ? b.note : '',
    status: actual === null ? '대기' : (expected - actual < 0 ? '초과' : '확정') };
}

const cardCat = (ctx, m, cat, person) => sum(ctx.rows.filter(r => r.useMonth === m && r.category === cat && (!person || r.person === person)), r => r.applied);
const bankCat = (ctx, m, cat) => sum(ctx.bank.filter(b => b.tx_date.slice(0, 7) === m && b.category === cat), b => num(b.withdrawal) - num(b.deposit));

// 용돈: 카드 분류는 '용돈' 하나. 예산 = 기본 용돈(현금 이체) + 식대 예산(예: 은경식대, 카드로 씀).
// 이체액 = 기본 − (전월 카드 용돈 중 식대 예산을 넘은 금액) − 전월 가불 − 이월 가불. 예산을 넘겨 쓴 금액은 개인 부담(이월 없음), 못 갚은 가불만 이월.
export const mealCat = person => `${person}식대`;
export function allowance(ctx, person, m) {
  const key = `al:${person}:${m}`; if (ctx.memo[key]) return ctx.memo[key];
  const master = ctx.master; const start = master.start_month || m;
  const base = sum((master.fixed_cash || []).filter(f => f.allowance && f.person === person), f => f.amount);
  const meal = budgetFor(master, m, mealCat(person));
  const used = cardCat(ctx, m, '용돈', person), advance = cardCat(ctx, m, '용돈가불', person);
  let prevUsed = 0, prevMeal = 0, prevAdvance = 0, prevCarry = 0;
  if (monthDiff(start, m) >= 0) {
    const pm = addMonth(m, -1); prevMeal = budgetFor(master, pm, mealCat(person));
    if (master.allowance_deduct_card !== false) prevUsed = cardCat(ctx, pm, '용돈', person);
    prevAdvance = cardCat(ctx, pm, '용돈가불', person); prevCarry = monthDiff(start, pm) >= 0 ? allowance(ctx, person, pm).carryOver : 0;
  }
  const cardDeduct = Math.max(0, prevUsed - prevMeal), afterCard = Math.max(0, base - cardDeduct), advDue = prevAdvance + prevCarry;
  const transfer = Math.max(0, afterCard - advDue);
  return ctx.memo[key] = { person, base, meal, budget: base + meal, used, advance, prevUsed, prevMeal, cardDeduct, prevAdvance, prevCarry, target: cardDeduct + advDue, transfer, deducted: base - transfer,
    prevOver: Math.max(0, cardDeduct - base), carryOver: Math.max(0, advDue - afterCard), over: Math.max(0, used - base - meal) };
}

export function accountBalance(ctx, name, untilExclusive) {
  const a = (ctx.master.accounts || []).find(x => x.name === name); if (!a) return 0;
  const from = ctx.master.opening_date || '0000-00-00';
  return num(a.opening) + sum(ctx.bank.filter(b => b.account === name && b.tx_date >= from && (!untilExclusive || b.tx_date < untilExclusive)), b => num(b.deposit) - num(b.withdrawal));
}

export function loanBalance(loan, m) { return Math.max(0, num(loan.balance) - sum(Object.entries(loan.plan || {}).filter(([k]) => k > (loan.base_month || '') && k <= m), ([, v]) => v)); }

export function monthSummary(ctx, m, today = todayStr()) {
  const master = ctx.master; const persons = [...new Set((master.fixed_cash || []).filter(f => f.allowance).map(f => f.person))];
  const al = Object.fromEntries(persons.map(p => [p, allowance(ctx, p, m)]));
  const rowsM = ctx.rows.filter(r => r.useMonth === m);
  // 수입
  const incomes = (master.incomes || []).map(i => ({ ...i }));
  const incomePlan = sum(incomes, i => i.amount);
  const side = -bankCat(ctx, m, '부수입');
  const salaryActual = -bankCat(ctx, m, '급여');
  // 고정(현금)
  const fixedCash = (master.fixed_cash || []).map(f => {
    const transfer = f.allowance ? (al[f.person] ? al[f.person].transfer : num(f.amount)) : num(f.amount);
    const done = ctx.bank.some(b => b.tx_date.slice(0, 7) === m && b.fixed && b.memo === f.name);
    return { ...f, transfer, done };
  });
  // 월초 일괄 출금(개인통장으로 보낼 고정지출 묶음)은 금액이 ±10% 안의 모임통장 출금이 있으면 완료로 본다
  const lumpItems = fixedCash.filter(f => !f.allowance && f.account !== '모임통장' && f.account !== '현금'), lumpSum = sum(lumpItems, f => f.transfer);
  const lumpDone = lumpSum > 0 && ctx.bank.some(b => b.account === '모임통장' && b.tx_date.slice(0, 7) === m && (/고정지출/.test(b.memo + ' ' + (b.note || '')) || (num(b.withdrawal) >= lumpSum * 0.9 && num(b.withdrawal) <= lumpSum * 1.1)));
  if (lumpDone) lumpItems.forEach(f => { f.done = true; f.lump = true; });
  const fixedCashTotal = sum(fixedCash, f => f.transfer);
  // 고정(카드)
  const fixedCard = (master.fixed_card || []).map(f => {
    const actual = sum(rowsM.filter(r => r.label === f.name), r => r.applied);
    return { ...f, actual, status: actual === 0 ? '대기' : (actual === num(f.budget) ? '일치' : '차이'), diff: actual - num(f.budget) };
  });
  const fixedCardBudget = sum(fixedCard, f => f.budget);
  const fixedCardActual = sum(rowsM.filter(r => r.fixed), r => r.applied);
  const fixedNames = new Set(fixedCard.map(f => f.name));
  const fixedCardOther = rowsM.filter(r => r.fixed && !fixedNames.has(r.label));
  // 변동
  const [y, mo] = m.split('-').map(Number); const dim = daysIn(m); const cur = today.slice(0, 7);
  const daysLeft = cur < m ? dim : cur > m ? 0 : dim - Number(today.slice(8, 10)) + 1;
  const mealCats = persons.map(mealCat); const mealBudgets = persons.map(p => ({ cat: mealCat(p), person: p, budget: al[p].meal, actual: al[p].used })).filter(x => budgetCats(master).includes(x.cat));
  const variable = budgetCats(master).filter(c => !mealCats.includes(c)).map(cat => {
    const budget = budgetFor(master, m, cat); const card = cardCat(ctx, m, cat); const bank = bankCat(ctx, m, cat); const actual = card + bank;
    return { cat, budget, card, bank, actual, left: budget - actual, rate: budget ? actual / budget : null, perDay: daysLeft > 0 ? Math.max(0, budget - actual) / daysLeft : null };
  });
  const bills = ctx.cards.map(c => cardBill(ctx, m, c.name));
  const installment = sum(bills, b => b.installment);
  const instBudget = sum(bills, b => b.contInst + b.legacy);
  const misc = sum(rowsM.filter(r => !r.category && !r.fixed), r => r.applied);
  const etc = cardCat(ctx, m, '기타'); const bankMisc = bankCat(ctx, m, '기타'), bankFamily = bankCat(ctx, m, '경조사·가족');
  const cardTotal = sum(rowsM, r => r.applied);
  const mealTotal = sum(persons, p => al[p].meal);
  const variableBudget = sum(variable, v => v.budget) + mealTotal, variableActual = sum(variable, v => v.actual) + sum(persons, p => Math.min(al[p].used, al[p].meal));
  const prevAllow = sum(persons, p => al[p].deducted);
  const spendPlan = fixedCashTotal + fixedCardBudget + variableBudget + instBudget + prevAllow;
  const income = incomePlan + side;
  // 카드대금
  const billTotal = { lump: sum(bills, b => b.lumpNet), installment: sum(bills, b => b.installment), expected: sum(bills, b => b.expected), actual: bills.some(b => b.actual !== null) ? sum(bills, b => b.actual) : null, discount: bills.some(b => b.discount !== null) ? sum(bills, b => b.discount) : null };
  const cf = cashFlow(ctx, m, today);
  // 통장 쪼개기
  const split = (master.accounts || []).map(a => {
    const fc = sum(fixedCash.filter(f => f.account === a.name), f => f.transfer); const cb = sum(bills.filter(b => b.payAccount === a.name), b => b.expected);
    return { account: a.name, person: a.person, memo: a.memo, fixedCash: fc, cardBill: cb, need: fc + cb, action: fc + cb === 0 ? '' : a.name === '모임통장' ? '직접 출금' : a.name === '현금' ? '현금 지출' : '모임 → 이체' };
  }).filter(s => s.need);
  const needTotal = sum(split, s => s.need);
  const mainStart = cf.start, mainEnd = cf.end, mainIncome = sum(incomes.filter(i => i.account === '모임통장'), i => i.amount);
  // 남는 돈(발생 기준): 카드는 갚는 달이 아니라 쓴 달의 비용. 할부는 매달 납입액(다음 달 청구분)을 이번 달 비용으로 본다.
  const instNext = sum(ctx.cards, c => { const b = cardBill(ctx, addMonth(m, 1), c.name); return b.contInst + b.legacy; });
  const bankSpend = sum(ctx.bank.filter(b => b.tx_date.slice(0, 7) === m && bankGroup(b.category) === '지출' && b.category !== '고정'), b => num(b.withdrawal) - num(b.deposit));
  const open = m >= cur;
  const remain = !open ? { variable: 0, meal: 0, fixedCard: 0 } : { variable: sum(variable, v => Math.max(0, v.budget - v.actual)), meal: sum(persons, p => Math.max(0, al[p].meal - al[p].used)), fixedCard: sum(fixedCard.filter(f => f.status === '대기'), f => num(f.budget)) };
  remain.total = remain.variable + remain.meal + remain.fixedCard;
  const spent = { fixedCash: fixedCashTotal, card: cardTotal, inst: instNext, bank: bankSpend }; spent.total = spent.fixedCash + spent.card + spent.inst + spent.bank;
  const result = { income, spent, remain, open, expense: spent.total + remain.total, left: income - spent.total - remain.total, leftNow: income - spent.total };
  const balances = (master.accounts || []).filter(a => a.tracked).map(a => ({ account: a.name, person: a.person, balance: accountBalance(ctx, a.name) }));
  const loanTotal = sum(ctx.loans, l => loanBalance(l, m));
  const saved = bankCat(ctx, m, '저축'), repaid = bankCat(ctx, m, '대출상환');
  const events = ((ctx.goals || {}).events || []).filter(e => e.month === m);
  const check = {
    unclassified: rowsM.filter(r => !r.category && !r.fixed && r.amount > 0).length,
    fixedWaiting: fixedCard.filter(f => f.status === '대기').length,
    billsMissing: bills.filter(b => b.actual === null && b.expected > 0).length,
    billsOver: bills.filter(b => b.discount !== null && b.discount < 0).length,
    carryAdvance: sum(persons, p => al[p].carryOver),
    newInstallments: rowsM.filter(r => r.K > 1 && r.amount > 0).length,
    bankReview: ctx.bank.filter(b => b.tx_date.slice(0, 7) === m && (!b.category || b.category === '확인 필요')).length,
    unsettled: unsettled(ctx).length,
  };
  return { month: m, daysLeft, incomes, incomePlan, side, salaryActual, income, fixedCash, fixedCashTotal, fixedCard, fixedCardBudget, fixedCardActual, fixedCardOther, variable, variableBudget, variableActual,
    allowance: al, persons, installment, instBudget, instNext, result, misc, etc, mealBudgets, bankMisc, bankFamily, cardTotal, spendPlan, canSave: income - spent.total - remain.total, saveRate: income ? (income - spent.total - remain.total) / income : null, planLeft: income - spendPlan,
    bills, billTotal, timeline: cf.rows, cashflow: cf, split, needTotal, mainStart, mainIncome, mainEnd, balances, loanTotal, saved, repaid, events, check };
}

// 통장 분류 묶음
export const BANK_GROUPS = { 수입: ['급여', '부수입'], 지출: ['고정', '식비', '낚시', '용돈', '경조사·가족', '기타'], 이동: ['이체', '정산입금', '카드대금', '저축', '대출상환'] };
export const bankGroup = cat => Object.keys(BANK_GROUPS).find(g => BANK_GROUPS[g].includes(cat)) || (cat ? '지출' : '');
export const unsettled = ctx => ctx.rows.filter(r => r.settle > 0 && !r.settle_done).sort((a, b) => a.used_date.localeCompare(b.used_date));

// 이번 청구월의 할부 내역(회차)
export function billInstItems(ctx, m) {
  const out = [];
  ctx.rows.filter(r => r.auto).forEach(r => { const d = monthDiff(r.billMonth, m); if (d >= 0 && d <= r.K - 1) out.push({ name: r.label || r.merchant, card: r.card, person: r.person, nth: d + 1, K: r.K, amount: d === 0 ? r.first : r.later, total: r.amount, auto: true, used: r.used_date }); });
  ctx.installments.forEach(i => { const v = num((i.charges || {})[m]); if (!v) return; const ms = Object.keys(i.charges || {}).filter(k => num(i.charges[k])).sort(); out.push({ name: i.item, card: i.card || '미지정', person: (ctx.cardMap[i.card] || {}).person || '', nth: ms.indexOf(m) + 1, K: ms.length, amount: v, total: sum(ms, k => i.charges[k]), auto: false }); });
  return out.sort((a, b) => a.card.localeCompare(b.card) || b.amount - a.amount);
}
// 청구월별 대시보드
export function billBoard(ctx, months) {
  return months.map(m => { const bills = ctx.cards.map(c => cardBill(ctx, m, c.name)); const entered = bills.filter(b => b.actual !== null);
    return { month: m, bills, lump: sum(bills, b => b.lumpNet), installment: sum(bills, b => b.installment), expected: sum(bills, b => b.expected), actual: entered.length ? sum(bills, b => b.final) : null, entered: entered.length, cards: bills.filter(b => b.expected > 0 || b.actual !== null).length }; });
}
export function billMonthRange(ctx) { const ms = ctx.rows.map(r => r.billMonth).sort(); return { first: ms[0] || null, last: ms[ms.length - 1] || null }; }

// 온누리: 개인 혜택분은 예산에서 빼고 사람별 사용 누계만, 공용 충전분은 잔액 관리
export function onnuriSummary(ctx) {
  const rows = ctx.rows.filter(r => r.onnuri > 0); const byPerson = {}, byMonth = {};
  rows.filter(r => !r.onnuri_shared).forEach(r => { byPerson[r.person] = (byPerson[r.person] || 0) + r.onnuri; (byMonth[r.useMonth] = byMonth[r.useMonth] || {})[r.person] = ((byMonth[r.useMonth] || {})[r.person] || 0) + r.onnuri; });
  const charged = sum(ctx.master.onnuri_charges || [], c => c.amount), sharedUsed = sum(rows.filter(r => r.onnuri_shared), r => r.onnuri);
  return { rows, byPerson, byMonth, charged, sharedUsed, sharedBalance: charged - sharedUsed };
}

export function goalTracker(ctx, today = todayStr()) {
  const g = ctx.goals || {}, master = ctx.master; const sc = g.scenario || {};
  const incomePlan = sum(master.incomes || [], i => i.amount);
  const fixed = sum(master.fixed_cash || [], f => f.amount) + sum(master.fixed_card || [], f => f.budget);
  const surplus = incomePlan - fixed - num(sc.monthly_variable);
  const start = g.tracker_start || master.start_month; const endM = (g.wedding_date || g.target_date || '').slice(0, 7) || addMonth(start, 24);
  const rows = []; let planCum = num(g.base_cumulative), actCum = num(g.base_cumulative);
  for (let m = start; monthDiff(m, endM) >= 0 && rows.length < 60; m = addMonth(m, 1)) {
    const actual = bankCat(ctx, m, '저축') + bankCat(ctx, m, '대출상환'); planCum += surplus; actCum += actual;
    rows.push({ month: m, plan: surplus, planCum, actual, actCum, diff: actCum - planCum, rate: g.target ? actCum / g.target : null });
  }
  const cur = rows.filter(r => r.month <= today.slice(0, 7)).pop();
  const total = surplus * num(sc.months) + num(sc.loan_payoff) + num(sc.interest_saving);
  return { incomePlan, fixed, variable: num(sc.monthly_variable), surplus, months: num(sc.months), projected: surplus * num(sc.months), total, gap: total - num(g.target), rows, achieved: cur ? cur.actCum : num(g.base_cumulative), rate: g.target ? (cur ? cur.actCum : num(g.base_cumulative)) / g.target : null,
    dday: g.target_date ? Math.round((new Date(g.target_date) - new Date(today)) / 86400000) : null };
}

export function taxClass(tax, merchant) {
  const m = (merchant || '').toUpperCase();
  if ((tax.exclude_keywords || []).some(k => k && m.includes(k.toUpperCase()))) return '제외';
  if ((tax.transit_keywords || []).some(k => k && m.includes(k.toUpperCase()))) return '대중교통';
  return '신용';
}

export function taxSummary(ctx) {
  const tax = ctx.tax || {}; const P = tax.params || {}; const out = {};
  for (const [person, info] of Object.entries(tax.people || {})) {
    const from = tax.auto_start || `${tax.year}-01-01`, to = `${tax.year}-12-31`;
    const rs = ctx.rows.filter(r => r.person === person && r.used_date >= from && r.used_date <= to && r.amount > 0);
    const auto = { 신용: 0, 대중교통: 0, 제외: 0 }; rs.forEach(r => { auto[taxClass(tax, r.merchant)] += r.amount; });
    const man = info.manual || {}; const S = num(info.salary); const low = S <= num(P.culture_salary);
    const credit = auto.신용 + num(man.credit), debit = num(man.debit), market = num(man.market), transit = auto.대중교통 + num(man.transit), culture = num(man.culture);
    const total = credit + debit + market + transit + culture; const threshold = S * num(P.threshold);
    const A = credit + (low ? 0 : culture), B = debit + (low ? culture : 0), C = market + transit;
    const gross = A * P.r_credit + B * P.r_debit + C * P.r_market;
    const thr = threshold <= A ? threshold * P.r_credit : threshold <= A + B ? A * P.r_credit + (threshold - A) * P.r_debit : A * P.r_credit + B * P.r_debit + (threshold - A - B) * P.r_market;
    const deductible = Math.max(0, gross - thr);
    const baseLimit = low ? num(P.base_low) + Math.min(num(info.children) * num(P.child_low), num(P.child_low_max)) : num(P.base_high) + Math.min(num(info.children) * num(P.child_high), num(P.child_high_max));
    const d1 = Math.min(deductible, baseLimit); const extraLimit = low ? num(P.extra_low) : num(P.extra_high);
    const d2 = Math.max(0, Math.min(deductible - d1, extraLimit, C * P.r_market + (low ? culture : 0) * P.r_debit - Math.max(0, thr - A * P.r_credit - debit * P.r_debit)));
    const ded = d1 + d2; const remainBase = Math.max(0, baseLimit - d1);
    out[person] = { salary: S, auto, credit, debit, market, transit, culture, total, threshold, toThreshold: Math.max(0, threshold - total), deductible, baseLimit, d1, extraLimit, d2, deduction: ded, saving: ded * num(info.marginal), remainBase,
      needDebit: total < threshold ? null : remainBase / P.r_debit, strategy: total < threshold ? '문턱 전 → 혜택 좋은 신용카드' : d1 < baseLimit ? '문턱 넘음 → 체크·현금영수증(30%)' : '기본한도 소진 → 전통시장·대중교통·문화비' };
  }
  return out;
}

export function monthsWithData(ctx) { const s = new Set(); ctx.rows.forEach(r => s.add(r.useMonth)); ctx.bank.forEach(b => s.add(b.tx_date.slice(0, 7))); return [...s].sort(); }

const sq = v => String(v || '').replace(/\s/g, '').toUpperCase();
export function applyRules(master, cardName, merchant) {
  const m = sq(merchant);
  for (const r of master.rules || []) { const kw = sq(r.keyword); if (!kw) continue; if (m.includes(kw) && (!r.card || sq(r.card) === sq(cardName))) return r; }
  return null;
}
// 미분류 건의 1차 자동 분류 제안: ① 자동분류 규칙 ② 같은 가맹점의 지난 분류(2건 이상, 80% 이상 같을 때)
export function suggest(ctx, row) {
  const rule = applyRules(ctx.master, row.card, row.merchant);
  if (rule) return { category: rule.category || '', fixed: !!rule.fixed, label: rule.label || '', why: '규칙' };
  // 이전 달까지의 같은 가맹점 건만 본다. 분류 없이 둔 건(기타)도 한 표로 세어, 쿠팡처럼 용도가 섞이는 곳은 제안하지 않는다.
  const e = {}; let tot = 0; const k = sq(row.merchant), mon = row.used_date.slice(0, 7); if (!k) return null;
  for (const r of ctx.rows) { if (r.useMonth >= mon || r.resale || num(r.amount) <= 0 || sq(r.merchant) !== k) continue; const sig = JSON.stringify([r.category || '', !!r.fixed, r.fixed ? (r.label || '') : '']); e[sig] = (e[sig] || 0) + 1; tot++; }
  if (tot < 2) return null; const [sig, n] = Object.entries(e).sort((a, b) => b[1] - a[1])[0]; const [category, fixed, label] = JSON.parse(sig);
  if (n / tot < 0.8 || (!category && !fixed)) return null;
  return { category, fixed, label, why: '이력' };
}

// 2026-11-13 개편(v2) 데이터 정리: 저장소 종류와 무관하게 같은 규칙을 쓰도록 계획만 만든다.
export function migrateV2(data) {
  const master = structuredClone(data.docs.master || {}); if (!master.cards || (master.schema || 1) >= 2) return null;
  const autoFrom = master.auto_inst_from || '9999'; const cardPatches = [], bankPatches = [];
  for (const r of data.card_tx) {
    const p = {}; const amt = num(r.amount), K = num(r.inst_months);
    // 리셀: 은경 국민 10월 쿠팡 특가(당근 판매 예정)·취소완료 건 → 리셀, 전액 선결제 처리
    if (r.card === '은경 국민' && r.used_date >= '2026-10-01' && r.used_date <= '2026-10-31' && amt > 0 && amt + num(r.adjustment) === 0 && /당근예정|취소완료/.test(r.label || '')) { p.category = '리셀'; p.prepaid = amt; }
    // 할부: 손으로 월 납입액에 맞춰 둔 조정액은 자동 계산으로 대체
    if (K > 1 && r.used_date >= autoFrom && amt > 0) { const later = Math.floor(amt / K), first = amt - later * (K - 1); if (num(r.adjustment) === first - amt) { p.adjustment = 0; p.raw = { ...(r.raw || {}), excel_applied: first }; } }
    if (Object.keys(p).length) cardPatches.push({ id: r.id, row: r, patch: p });
  }
  const B = { '7월 생활비!5:모임통장': { category: '기타', note: '내용 불명(2026-11-13 은경 확인: 기타 처리)' }, '7월 생활비!7:모임통장': { category: '이체' }, '9월 생활비!29:모임통장': { category: '이체', note: '2026-10-07 유영민 입금과 상계' }, '10월 생활비!11:모임통장': { category: '이체', note: '2026-09-30 현금입금예정과 상계' }, '10월 생활비!18:모임통장': { category: '부수입', note: '영민 본가 용돈 현금 입금' } };
  for (const b of data.bank_tx) {
    if (B[b.source_ref] && b.category === '확인 필요') bankPatches.push({ id: b.id, row: b, patch: B[b.source_ref] });
    else if (b.fixed && b.category === '이체' && b.source === 'check') bankPatches.push({ id: b.id, row: b, patch: { category: '고정' } });
  }
  const known = Object.values(BANK_GROUPS).flat(); const extra = (master.bank_categories || []).filter(c => !known.includes(c) && !['할인적립사용', '확인 필요'].includes(c));
  master.bank_categories = [...BANK_GROUPS.수입, ...BANK_GROUPS.지출, ...extra, ...BANK_GROUPS.이동];
  if (!(master.card_categories || []).includes('리셀')) master.card_categories = [...(master.card_categories || []), '리셀'];
  master.cards = master.cards.map(({ discount_to, ...c }) => c); delete master.carry; master.allowance_deduct_card = true; master.onnuri_charges = master.onnuri_charges || []; master.schema = 2;
  return { master, cardPatches, bankPatches };
}

// 2026-11-13 2차(v3): 은경식대 분류를 용돈으로 통일(예산은 따로 유지), 카드 카테고리 '기타' 추가
export function migrateV3(data) {
  const master = structuredClone(data.docs.master || {}); if (!master.cards || (master.schema || 1) !== 2) return null;
  const cardPatches = data.card_tx.filter(r => /식대$/.test(r.category || '')).map(r => ({ id: r.id, row: r, patch: { category: '용돈' } }));
  const bankPatches = data.bank_tx.filter(b => /식대$/.test(b.category || '')).map(b => ({ id: b.id, row: b, patch: { category: '용돈' } }));
  master.card_categories = (master.card_categories || []).filter(c => !/식대$/.test(c)); if (!master.card_categories.includes('기타')) { const i = master.card_categories.indexOf('리셀'); master.card_categories.splice(i < 0 ? master.card_categories.length : i, 0, '기타'); }
  master.bank_categories = (master.bank_categories || []).filter(c => !/식대$/.test(c));
  master.rules = (master.rules || []).map(r => /식대$/.test(r.category || '') ? { ...r, category: '용돈' } : r); master.schema = 3;
  return { master, cardPatches, bankPatches };
}

// 모임통장 자금 흐름: 오늘(은행 내역 반영일)까지는 실제 거래, 이후는 예정.
// 예정 규칙(은경님 운영 방식): 월초 고정지출 일괄 출금(개인통장으로) → 10일 급여·카드대금(사람별)·용돈 이체 → 모임통장 자동이체(월세 등) → 말일 다음 달 선지급 급여
export function cashFlow(ctx, m, today = todayStr()) {
  const key = `cf:${m}:${today}`; if (ctx.memo[key]) return ctx.memo[key];
  const master = ctx.master, MAIN = '모임통장', flow = master.flow || {}, dim = daysIn(m), cur = today.slice(0, 7);
  const fixedDay = Math.min(num(flow.fixed_day) || 2, dim), cardDay = Math.min(num(flow.card_day) || 10, dim);
  const opening = (master.opening_date || '0000-00').slice(0, 7); const tracked = m >= opening;
  const persons = [...new Set((master.fixed_cash || []).filter(f => f.allowance).map(f => f.person))];
  const al = Object.fromEntries(persons.map(p => [p, allowance(ctx, p, m)]));
  const fixed = (master.fixed_cash || []).map(f => ({ ...f, transfer: f.allowance ? (al[f.person] ? al[f.person].transfer : num(f.amount)) : num(f.amount) })).filter(f => f.transfer);
  const plan = [];
  // 전월 말에 미리 들어오는 급여(영민)는 이번 달 1일 수입으로 본다
  const hasEarly = (master.incomes || []).some(i => i.early && i.account === MAIN);
  const earlySal = b => hasEarly && b.account === MAIN && b.category === '급여' && num(b.deposit) > 0 && Number(b.tx_date.slice(8)) >= 25;
  const prevM = addMonth(m, -1), carryRows = ctx.bank.filter(b => b.tx_date.slice(0, 7) === prevM && earlySal(b)), carry = sum(carryRows, b => b.deposit);
  (master.incomes || []).filter(i => i.account === MAIN && num(i.amount)).forEach(i => { if (i.early) { if (!carry && m >= cur) plan.push({ day: 1, label: `${i.name} (전월 말 입금 예정분)`, inn: num(i.amount), out: 0, person: i.person, kind: 'income', early: true }); } else plan.push({ day: Math.min(num(i.day) || 1, dim), label: `${i.name} 입금`, inn: num(i.amount), out: 0, person: i.person, kind: 'income' }); });
  const lump = fixed.filter(f => !f.allowance && f.account !== MAIN && f.account !== '현금');
  if (lump.length) plan.push({ day: fixedDay, label: '고정지출 일괄 출금 → 개인통장', inn: 0, out: sum(lump, f => f.transfer), kind: 'fixed', detail: lump.map(f => ({ name: f.name, amount: f.transfer, person: f.person })) });
  fixed.filter(f => !f.allowance && f.account === MAIN).forEach(f => plan.push({ day: Math.min(num(f.day) || 1, dim), label: f.name, inn: 0, out: f.transfer, person: f.person, kind: 'fixed' }));
  fixed.filter(f => f.allowance && f.account !== '현금').forEach(f => plan.push({ day: Math.min(num(f.day) || cardDay, dim), label: `${f.name} 이체`, inn: 0, out: f.transfer, person: f.person, kind: 'allow' }));
  const byPerson = {}; ctx.cards.forEach(c => { const b = cardBill(ctx, m, c.name); if (!b.final) return; (byPerson[c.person] = byPerson[c.person] || []).push(b); });
  Object.entries(byPerson).forEach(([p, bs]) => plan.push({ day: cardDay, label: `${p} 카드대금 이체 → 개인통장`, inn: 0, out: sum(bs, b => b.final), person: p, kind: 'card', estimated: bs.some(b => b.actual === null), detail: bs.map(b => ({ name: `${b.card} (${b.payDay}일 자동이체)`, amount: b.final, person: p })) }));
  // 아직 끝나지 않은 달(지난달 = 이번 달 청구 대상)의 남은 예산은 카드로 더 쓸 것으로 보고 카드대금 이체에 더한다
  const um = addMonth(m, -1);
  if (um >= cur) { const rest = monthSummary(ctx, um, today).result.remain.total; if (rest > 0) plan.push({ day: cardDay, label: `${Number(um.slice(5))}월 남은 예산 카드 사용 예상분`, inn: 0, out: rest, person: '공동', kind: 'card', estimated: true }); }
  plan.sort((a, b) => a.day - b.day || b.inn - a.inn);
  // 실제 거래 반영 범위
  const sync = (master.bank_sync || {})[MAIN]; const acts = ctx.bank.filter(b => b.account === MAIN && b.tx_date.slice(0, 7) === m && !earlySal(b)).sort((a, b) => a.tx_date.localeCompare(b.tx_date) || String(a.source_ref || '').localeCompare(String(b.source_ref || '')) || a.id - b.id);
  let covered = '';
  if (m < cur) covered = `${m}-${String(dim).padStart(2, '0')}`;
  else if (m === cur) { const last = acts.length ? acts[acts.length - 1].tx_date : ''; const sy = sync && sync.synced && sync.synced.slice(0, 7) === m ? sync.synced : ''; covered = [last, sy].sort().pop() || ''; }
  const coveredDay = covered ? Number(covered.slice(8)) : 0;
  const start = !tracked ? null : m <= cur ? accountBalance(ctx, MAIN, `${m}-01`) - carry : cashFlow(ctx, addMonth(m, -1), today).end;
  const rows = []; let bal = start;
  if (carry) { if (bal !== null) bal += carry; rows.push({ day: 1, date: carryRows[0].tx_date, label: `${carryRows.map(b => b.memo).join(', ')}`, note: `${carryRows.map(b => b.tx_date).join(', ')} 입금 → 이번 달 1일 수입으로 봄`, category: '급여', inn: carry, out: 0, actual: true, bal, id: carryRows[0].id }); }
  acts.filter(b => b.tx_date <= (covered || '0000')).forEach(b => { if (bal !== null) bal += num(b.deposit) - num(b.withdrawal); rows.push({ day: Number(b.tx_date.slice(8)), date: b.tx_date, label: b.memo, note: b.note, category: b.category, inn: num(b.deposit), out: num(b.withdrawal), actual: true, bal, id: b.id }); });
  plan.filter(p => p.day > coveredDay).forEach(p => { if (bal !== null) bal += p.inn - p.out; rows.push({ ...p, actual: false, bal }); });
  const nextSalary = 0;
  const low = rows.reduce((a, r) => r.bal !== null && (a === null || r.bal < a) ? r.bal : a, start);
  let check = null; if (sync && sync.balance !== null && sync.balance !== undefined && sync.last_date && sync.last_date.slice(0, 7) === m) { const mine = accountBalance(ctx, MAIN, addDay(sync.last_date)); check = { date: sync.last_date, bank: num(sync.balance), mine, diff: mine - num(sync.balance), synced: sync.synced }; }
  return ctx.memo[key] = { month: m, start, end: bal, rows, covered, coveredDay, nextSalary, low, check, tracked, fixedDay, cardDay };
}
export const addDay = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

// 2026-11-13 3차(v4): 실제 운영 방식 반영 — 월초 고정지출 일괄 출금(2일), 10일 카드대금·용돈 이체, 영민 월급은 전월 말 선지급
export function migrateV4(data) {
  const master = structuredClone(data.docs.master || {}); if (!master.cards || (master.schema || 1) !== 3) return null;
  master.flow = { fixed_day: 2, card_day: 10, ...(master.flow || {}) };
  master.incomes = (master.incomes || []).map(i => i.person === '영민' && i.early === undefined ? { ...i, early: true } : i);
  master.fixed_cash = (master.fixed_cash || []).map(f => f.allowance && num(f.day) === 1 ? { ...f, day: 10 } : f);
  master.schema = 4; return { master, cardPatches: [], bankPatches: [] };
}
