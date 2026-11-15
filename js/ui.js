// 화면 공통 도구
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const won = n => (n === null || n === undefined || n === '' || isNaN(n)) ? '-' : Math.round(Number(n)).toLocaleString('ko-KR');
export const signed = n => (n > 0 ? '+' : '') + won(n);
export const pct = v => (v === null || v === undefined || isNaN(v)) ? '-' : `${Math.round(v * 100)}%`;
export const plain = v => String(v ?? '').replace(/[,\s원]/g, '');
export const toNum = v => { const n = Number(plain(v)); return isNaN(n) ? 0 : Math.round(n); };
export const fmtDigits = v => { v = String(v ?? '').trim(); const neg = v.startsWith('-'); const d = v.replace(/[^\d]/g, ''); return (neg ? '-' : '') + (d ? Number(d).toLocaleString('ko-KR') : ''); };
export const monthLabel = m => `${m.slice(0, 4)}년 ${Number(m.slice(5))}월`;
export const who = p => p === '은경' ? '<span class="who ek" title="은경">은</span>' : p === '영민' ? '<span class="who ym" title="영민">영</span>' : p === '공동' ? '<span class="who co" title="공동">공</span>' : '';
// 날짜 직접 입력: 1113 · 11-13 · 261113 · 20261113 · 2026-11-13 모두 인식 (base = 기준 연-월)
export function parseDate(v, base) {
  const t = String(v ?? '').trim(); let y, m, d; const parts = t.split(/[^\d]+/).filter(Boolean);
  if (parts.length === 3) { [y, m, d] = parts.map(Number); if (y < 100) y += 2000; }
  else if (parts.length === 2) { y = Number(base.slice(0, 4)); [m, d] = parts.map(Number); }
  else if (parts.length === 1) { const g = parts[0]; if (g.length === 8) { y = +g.slice(0, 4); m = +g.slice(4, 6); d = +g.slice(6); } else if (g.length === 6) { y = 2000 + +g.slice(0, 2); m = +g.slice(2, 4); d = +g.slice(4); } else if (g.length === 3 || g.length === 4) { y = +base.slice(0, 4); m = +g.slice(0, g.length - 2); d = +g.slice(-2); } else if (g.length <= 2) { y = +base.slice(0, 4); m = +base.slice(5, 7); d = +g; } else return null; }
  else return null;
  const dt = new Date(y, m - 1, d); if (!(y > 2000 && y < 2100) || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export const dateInput = (name, value, base) => `<input name="${name}" data-date data-base="${base}" inputmode="numeric" autocomplete="off" placeholder="예: 1113" value="${esc(value || '')}" required>`;
document.addEventListener('change', e => { const i = e.target; if (!i.dataset || i.dataset.date === undefined) return; const d = parseDate(i.value, i.dataset.base || ''); if (d) i.value = d; i.classList.toggle('bad', !d); });
export const personClass = p => p === '은경' ? 'p-ek' : p === '영민' ? 'p-ym' : p === '공동' ? 'p-co' : '';

export function toast(msg, bad = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg; document.body.append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3200);
}
export function openModal(html, onReady) {
  closeModal();
  const wrap = document.createElement('div'); wrap.className = 'modal'; wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) closeModal(); });
  document.body.append(wrap); document.body.classList.add('noscroll');
  if (onReady) onReady(wrap.querySelector('.sheet'));
  return wrap;
}
export function closeModal() { document.querySelector('.modal')?.remove(); document.body.classList.remove('noscroll'); }

// 금액 입력칸: 입력하는 동안 쉼표 자동
document.addEventListener('input', e => {
  const i = e.target; if (!i.dataset || i.dataset.money === undefined) return;
  const pos = i.selectionStart ?? i.value.length, digits = i.value.slice(0, pos).replace(/\D/g, '').length;
  i.value = fmtDigits(i.value); let n = 0, p = 0; while (p < i.value.length && n < digits) { if (/\d/.test(i.value[p])) n++; p++; }
  try { i.setSelectionRange(p, p); } catch { }
});
export const moneyInput = (name, value, attrs = '') => `<input name="${name}" data-money inputmode="numeric" autocomplete="off" value="${value === null || value === undefined || value === '' ? '' : fmtDigits(value)}" ${attrs}>`;
export const options = (list, sel, blank) => (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') + list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
export const bar = (v, max, cls = '') => { const r = max > 0 ? Math.min(1, Math.max(0, v / max)) : (v > 0 ? 1 : 0); return `<div class="bar ${v > max && max > 0 ? 'over' : ''} ${cls}" role="img" aria-label="${Math.round((max > 0 ? v / max : 0) * 100)}%"><i style="width:${Math.round(r * 100)}%"></i></div>`; };

// 목록 편집기: cols=[{k,label,t,opts,w}] t: text|money|num|bool|select|month|day
export function listEditor(id, rows, cols, opt = {}) {
  const cell = (r, c, i) => {
    const v = r[c.k]; const nm = `data-k="${c.k}"`;
    if (c.t === 'bool') return `<input type="checkbox" ${nm} ${v ? 'checked' : ''}>`;
    if (c.t === 'select') return `<select ${nm}>${options(typeof c.opts === 'function' ? c.opts() : c.opts, v, c.blank)}</select>`;
    if (c.t === 'money') return `<input ${nm} data-money inputmode="numeric" value="${v === undefined || v === null || v === '' ? '' : fmtDigits(v)}">`;
    if (c.t === 'num') return `<input ${nm} inputmode="decimal" value="${esc(v ?? '')}" style="width:${c.w || 64}px">`;
    if (c.t === 'date') return `<input ${nm} data-date data-base="${new Date().getFullYear()}-01" autocomplete="off" placeholder="예: 1113" value="${esc(v ?? '')}" style="width:118px">`;
    if (c.t === 'month') return `<input type="month" ${nm} value="${esc(v ?? '')}">`;
    return `<input ${nm} autocomplete="off" value="${esc(v ?? '')}" ${c.ph ? `placeholder="${esc(c.ph)}"` : ''}>`;
  };
  return `<div class="tablewrap"><table class="edit" id="${id}"><thead><tr>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r, i) => `<tr data-i="${i}">${cols.map(c => `<td class="${c.t === 'money' ? 'r' : ''}">${cell(r, c, i)}</td>`).join('')}<td><button class="x" data-act="rowDel" title="삭제">×</button></td></tr>`).join('')}</tbody></table></div>
  <div class="row gap"><button class="btn ghost" data-act="rowAdd" data-target="${id}">+ 행 추가</button>${opt.noSave ? '' : `<button class="btn" data-act="${opt.saveAct || 'listSave'}" data-target="${id}">저장</button>`}</div>`;
}
export function readList(id, cols, originals = []) {
  return [...document.querySelectorAll(`#${id} tbody tr`)].map(tr => {
    const base = originals[Number(tr.dataset.i)] ? { ...originals[Number(tr.dataset.i)] } : {};
    cols.forEach(c => { const el = tr.querySelector(`[data-k="${c.k}"]`); if (!el) return; base[c.k] = c.t === 'bool' ? el.checked : c.t === 'money' ? toNum(el.value) : c.t === 'num' ? (el.value === '' ? 0 : Number(el.value)) : el.value.trim(); });
    return base;
  }).filter(r => cols.some(c => c.t !== 'bool' && c.t !== 'select' && r[c.k] !== '' && r[c.k] !== 0 && r[c.k] !== undefined));
}
export function addRow(id, cols) {
  const tb = document.querySelector(`#${id} tbody`); const tmp = document.createElement('tbody');
  tmp.innerHTML = listEditor('x', [{}], cols, { noSave: true }).match(/<tbody>([\s\S]*)<\/tbody>/)[1]; const tr = tmp.firstElementChild; tr.dataset.i = '-1'; tb.append(tr); tr.querySelector('input,select')?.focus();
}
