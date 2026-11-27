// Formatação pt-BR
import { TZ } from './calc.js';

const cache = new Map();
const NF = (min, max) => {
  const k = `${min}-${max}`;
  if (!cache.has(k)) cache.set(k, new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max }));
  return cache.get(k);
};
const ok = v => typeof v === 'number' && Number.isFinite(v);
/** Sinal do valor depois de arredondado a d casas: evita "−0,00%" em vermelho para −0,00004. */
export const signOf = (v, d) => { const r = Math.round(Math.abs(v) * 10 ** d); return r === 0 ? 0 : Math.sign(v); };
const sgn = (v, d, plus) => { const s = signOf(v, d); return s > 0 ? (plus ? '+' : '') : s < 0 ? '−' : ''; };
export const DASH = '—';

export const num = (v, d = 2) => ok(v) ? sgn(v, d, false) + NF(d, d).format(Math.abs(v)) : DASH;
/** fração → "+1,23%" */
export const pct = (f, d = 2) => ok(f) ? sgn(f * 100, d, true) + NF(d, d).format(Math.abs(f * 100)) + '%' : DASH;
/** já em % → "8,14%" */
export const pctAbs = (p, d = 2) => ok(p) ? sgn(p, d, false) + NF(d, d).format(Math.abs(p)) + '%' : DASH;
/** diferença de taxa em p.p. → "+2,7 bps" (juros) */
export const bps = p => ok(p) ? sgn(p * 100, 1, true) + NF(1, 1).format(Math.abs(p * 100)) + ' bps' : DASH;
/** diferença em pontos percentuais */
export const pp = (p, d = 1) => ok(p) ? sgn(p, d, true) + NF(d, d).format(Math.abs(p)) + ' p.p.' : DASH;
export const money = v => ok(v) ? sgn(v, 2, false) + 'R$ ' + NF(2, 2).format(Math.abs(v)) : DASH;
export const mult = v => ok(v) ? sgn(v, 2, false) + NF(2, 2).format(Math.abs(v)) : DASH;
/** Liquidez: a faixa (mil/mi/bi) é escolhida pelo valor já arredondado (999.999 → "R$ 1,0 mi", não "R$ 1.000 mil"). */
export const liq = v => {
  if (!ok(v)) return DASH;
  if (Math.round(v / 1e7) >= 100) return 'R$ ' + NF(2, 2).format(v / 1e9) + ' bi';   // ≥ 999,95 mi
  if (Math.round(v / 1e3) >= 1000) return 'R$ ' + NF(1, 1).format(v / 1e6) + ' mi';  // ≥ 999,5 mil
  return 'R$ ' + NF(0, 0).format(v / 1e3) + ' mil';
};
export const date = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : DASH;
export const dateShort = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : DASH;
const _time = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const _dt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const time = ms => ms ? _time.format(new Date(ms)) : DASH;
export const dateTime = ms => ms ? _dt.format(new Date(ms)).replace(',', '') : DASH;
export const ago = (ms, now = Date.now()) => {
  if (!ms) return DASH;
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  return `há ${Math.floor(h / 24)} d`;
};
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
