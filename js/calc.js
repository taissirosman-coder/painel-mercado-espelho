// Motor de cálculo puro (sem rede, sem DOM). Usado pela página e pelos testes.
// Convenções:
//  - Datas no fuso da B3 (America/Sao_Paulo), formato 'AAAA-MM-DD'.
//  - Variações em fração (0.0123 = +1,23%). DY em % (8.14 = 8,14%).

export const TZ = 'America/Sao_Paulo';
const _fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** ms -> 'AAAA-MM-DD' no fuso da B3 */
export function brDate(ms) { return _fmtDate.format(new Date(ms)); }
/** ms -> 'AAAA-MM-DD' em UTC (cripto fecha o dia à meia-noite UTC, 21h de Brasília) */
export const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
/** Data da cotação no calendário do próprio ativo (cripto em UTC; o resto no fuso da B3). */
export const quoteDate = q => q?.type === 'CRYPTOCURRENCY' ? utcDate(q.time) : brDate(q.time);

/** ms -> {wd:0..6 (dom=0), minutes: minutos desde 00:00} no fuso da B3 */
export function brClock(ms) {
  const parts = Object.fromEntries(_fmtParts.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { wd, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Soma meses; se o dia não existe no mês de destino, usa o último dia (31/08 - 6M = 28/02 ou 29/02). */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const tm = m - 1 + n;
  const ty = y + Math.floor(tm / 12);
  const mm = ((tm % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, mm + 1, 0)).getUTCDate();
  return `${ty}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export const addYears = (iso, n) => addMonths(iso, 12 * n);

const isPos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const r4 = v => Math.round(v * 1e4) / 1e4;
const r6 = v => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- Yahoo

/** Converte a resposta do endpoint v8/finance/chart em estrutura limpa. Lança erro se não houver dados. */
export function parseYahooChart(json) {
  const res = json?.chart?.result?.[0];
  if (!res) {
    const e = json?.chart?.error;
    const err = new Error(e?.description || 'Sem dados no Yahoo');
    err.code = e?.code || 'NO_DATA';
    throw err;
  }
  const ts = res.timestamp || [];
  // Data de cada barra: B3, índices e futuros no fuso da B3 (conferido); cripto em UTC (barras às 00h UTC,
  // sem horário de verão); câmbio pela data de Londres (barras à meia-noite local; +12 h cobre o verão).
  const type = res.meta?.instrumentType;
  const dateOf = type === 'CRYPTOCURRENCY' ? utcDate : type === 'CURRENCY' ? (ms => utcDate(ms + 12 * 3600e3)) : brDate;
  const q = res.indicators?.quote?.[0] || {};
  const a = res.indicators?.adjclose?.[0]?.adjclose || [];
  const byDate = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (!isPos(c)) continue; // remove barras sem negócio / nulas
    const adj = isPos(a[i]) ? a[i] : null;
    const d = dateOf(ts[i] * 1000);
    byDate.set(d, { date: d, close: type === 'CRYPTOCURRENCY' ? r6(c) : r4(c), adj: adj == null ? null : r6(adj) });
  }
  const bars = fillAdj([...byDate.values()].sort((x, y) => x.date < y.date ? -1 : 1));
  const divs = Object.values(res.events?.dividends || {})
    .filter(d => isPos(d.amount))
    .map(d => ({ date: dateOf(d.date * 1000), amount: r6(d.amount) }))
    .sort((x, y) => x.date < y.date ? -1 : 1);
  const splits = Object.values(res.events?.splits || {})
    .map(s => ({ date: dateOf(s.date * 1000), ratio: s.splitRatio || `${s.numerator}:${s.denominator}` }))
    .sort((x, y) => x.date < y.date ? -1 : 1);
  const m = res.meta || {};
  const meta = {
    symbol: m.symbol,
    price: num(m.regularMarketPrice),
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    changePct: num(m.regularMarketChangePercent),
    prevClose: num(m.chartPreviousClose),
    currency: m.currency || null,
    name: m.longName || m.shortName || null,
    shortName: m.shortName || null,
    type: m.instrumentType || null,
    regularStart: m.currentTradingPeriod?.regular?.start ? m.currentTradingPeriod.regular.start * 1000 : null,
    regularEnd: m.currentTradingPeriod?.regular?.end ? m.currentTradingPeriod.regular.end * 1000 : null,
    firstTradeDate: m.firstTradeDate ? m.firstTradeDate * 1000 : null,
  };
  return { meta, bars, divs, splits };
}

/**
 * Preenche adj ausente com a razão adj/close da barra válida mais próxima À FRENTE (o ajuste de uma barra
 * depende só dos eventos posteriores a ela). Barras no fim da série, sem nenhuma válida à frente, recebem
 * fator 1: a barra mais recente nunca é ajustada. (Usar o fator da barra anterior erraria o retorno total
 * do dia em que o provento fica ex.)
 */
export function fillAdj(bars) {
  let k = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].adj != null) k = bars[i].adj / bars[i].close;
    else bars[i] = { ...bars[i], adj: r6(bars[i].close * k), adjFilled: true };
  }
  return bars;
}

// ---------------------------------------------------------------- Qualidade do histórico do Yahoo

const JUMP = 3; // fator: preço multiplicado ou dividido por mais de 3 de uma barra para a outra
const nearEvent = (date, splits, days) => (splits || []).some(s => Math.abs(Date.parse(s.date) - Date.parse(date)) <= days * 864e5);

/**
 * Remove trechos curtos de dado errado: o preço salta por um fator > 3 sem desdobramento/grupamento
 * registrado e VOLTA ao nível anterior (±50%) em até `maxRun` barras. Caso real: XPML11 registrada a
 * R$ 1,07 de 14 a 16/01/2026 (preço real ~R$ 110). Um salto que não volta não é removido (ver findJumps).
 */
export function cleanGlitches(bars, splits, { maxRun = 10, eventDays = 3 } = {}) {
  const out = [], removed = [];
  let i = 0;
  while (i < bars.length) {
    const prev = out[out.length - 1];
    if (prev) {
      const r = bars[i].close / prev.close;
      if ((r > JUMP || r < 1 / JUMP) && !nearEvent(bars[i].date, splits, eventDays)) {
        let j = i;
        while (j < bars.length && j - i < maxRun) {
          const rr = bars[j].close / prev.close;
          if (rr <= 1.5 && rr >= 1 / 1.5) break;
          j++;
        }
        if (j < bars.length && j - i < maxRun) {
          for (let k = i; k < j; k++) removed.push(bars[k]);
          i = j;
          continue;
        }
      }
    }
    out.push(bars[i]);
    i++;
  }
  return { bars: out, removed };
}

/**
 * Saltos atípicos que não voltam (fator > 3 entre barras seguidas, sem evento registrado). Podem ser
 * ajuste faltando no Yahoo (RADL3 em 06/2000; B3SA3 em 05/2011) ou movimento real (Americanas em
 * 01/2023), então não são corrigidos: viram aviso nas variações cuja base é anterior ao salto.
 */
export function findJumps(bars, splits, eventDays = 3) {
  const jumps = [];
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].close / bars[i - 1].close;
    if ((r > JUMP || r < 1 / JUMP) && !nearEvent(bars[i].date, splits, eventDays)) {
      jumps.push({ date: bars[i].date, prevDate: bars[i - 1].date, from: bars[i - 1].close, to: bars[i].close });
    }
  }
  return jumps;
}

/** Junta barras recentes (busca leve) ao histórico longo. Barras da mesma data são substituídas. */
export function mergeBars(histBars, recentBars) {
  const map = new Map(histBars.map(b => [b.date, b]));
  for (const b of recentBars) map.set(b.date, b);
  return [...map.values()].sort((x, y) => x.date < y.date ? -1 : 1);
}

/** Há provento/desdobramento no dado recente que o histórico ainda não conhece? (então o ajuste mudou → rebaixar histórico) */
export function hasNewEvents(hist, recent) {
  const key = e => `${e.date}|${e.amount ?? e.ratio}`;
  const known = new Set([...(hist.divs || []), ...(hist.splits || [])].map(key));
  const lastHist = hist.bars?.length ? hist.bars[hist.bars.length - 1].date : '0000-00-00';
  const firstRecent = recent.bars?.length ? recent.bars[0].date : '9999-99-99';
  return [...(recent.divs || []), ...(recent.splits || [])]
    .some(e => e.date >= firstRecent && !known.has(key(e)) && e.date >= addDays(lastHist, -10));
}

/**
 * Série final: histórico + preço corrente. Se a última barra é do mesmo dia da cotação, o fechamento
 * dela é trocado pelo preço corrente (mantendo o fator de ajuste da barra).
 */
export function buildSeries(bars, quote) {
  const out = bars.slice();
  if (!quote || !isPos(quote.price) || !quote.time) return out;
  const qd = quoteDate(quote);
  const last = out[out.length - 1];
  if (last && last.date === qd) {
    const k = last.adj ? last.adj / last.close : 1;
    out[out.length - 1] = { date: qd, close: quote.price, adj: r6(quote.price * k) };
  } else if (!last || qd > last.date) {
    out.push({ date: qd, close: quote.price, adj: quote.price });
  }
  return out;
}

/** Último índice com data <= alvo (busca binária). -1 se nenhum. */
export function lastIdxOnOrBefore(bars, target) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export const PERIODS = [
  { key: 'dia', label: 'Dia' },
  { key: 'd5', label: '5d' },
  { key: 'd30', label: '30d' },
  { key: 'm6', label: '6M' },
  { key: 'ytd', label: 'YTD' },
  { key: 'y1', label: '1A' },
  { key: 'y5', label: '5A' },
  { key: 'ini', label: 'Início' },
];

/**
 * Variações conforme definições combinadas:
 *  Dia: vs fechamento do pregão anterior | 5d: vs 5 pregões atrás
 *  30d, 6M, 1A, 5A: vs último fechamento com data <= (data de referência − período), datas corridas
 *  YTD: vs último fechamento do ano anterior
 *  Início: vs fechamento do primeiro pregão disponível no Yahoo (`inception`, buscado à parte; para papéis
 *  antigos o Yahoo começa em 2000, então não é necessariamente o IPO)
 * mode: 'price' (fechamento ajustado só por desdobramentos/bonificações) | 'tr' (também por proventos)
 */
export function computeVariations(series, mode = 'price', inception = null) {
  const key = mode === 'tr' ? 'adj' : 'close';
  const L = series.length - 1;
  const out = { refDate: L >= 0 ? series[L].date : null, firstDate: series[0]?.date ?? null };
  if (L < 0) { for (const p of PERIODS) out[p.key] = { v: null, base: null, why: 'sem histórico' }; return out; }
  const cur = series[L][key];
  const ref = series[L].date;
  const mk = (i, why) => {
    if (i < 0 || !series[i] || !isPos(series[i][key])) return { v: null, base: null, why: why || 'histórico insuficiente' };
    return { v: cur / series[i][key] - 1, base: series[i].date, baseValue: series[i][key] };
  };
  const at = target => {
    if (series[0].date > target) return { v: null, base: null, why: `histórico desde ${series[0].date}` };
    return mk(lastIdxOnOrBefore(series, target));
  };
  out.dia = mk(L - 1);
  out.d5 = mk(L - 5);
  out.d30 = at(addDays(ref, -30));
  out.m6 = at(addMonths(ref, -6));
  out.ytd = at(`${Number(ref.slice(0, 4)) - 1}-12-31`);
  out.y1 = at(addYears(ref, -1));
  out.y5 = at(addYears(ref, -5));
  // Início: barra do primeiro pregão (consulta própria) ou, se a série já começa nele, a primeira barra
  const first = inception && isPos(inception[key]) && inception.date <= series[0].date ? inception : null;
  out.ini = first
    ? { v: cur / first[key] - 1, base: first.date, baseValue: first[key] }
    : { v: null, base: null, why: 'primeiro pregão ainda não carregado' };
  return out;
}

/** DY (%) pelos proventos com data-ex nos 365 dias até a data de referência. */
export function dyFromDivs(divs, refDate, price) {
  if (!isPos(price) || !refDate) return { dy: null, sum: 0, items: [] };
  const start = addDays(refDate, -365);
  const items = (divs || []).filter(d => d.date > start && d.date <= refDate);
  const sum = items.reduce((a, d) => a + d.amount, 0);
  return { dy: sum / price * 100, sum: r6(sum), items };
}

// ---------------------------------------------------------------- Setor

export function median(xs) {
  const a = xs.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Normaliza linhas do Status Invest (ações/BDRs: categoria 1/4; FIIs: categoria 2). */
export function normalizeSI(list, kind) {
  return (list || []).filter(x => x && x.ticker).map(x => ({
    ticker: String(x.ticker).toUpperCase(),
    companyId: x.companyid ?? x.ticker,
    name: x.companyname || null,
    price: num(x.price),
    pl: kind === 'fii' ? null : num(x.p_l),
    pvp: num(x.p_vp),
    dy: num(x.dy),
    liq: num(x.liquidezmediadiaria) ?? 0,
    seg: (kind === 'fii' ? x.segment : x.segmentname) || null,
    sub: x.subsectorname || null,
    sec: x.sectorname || null,
    vpa: num(x.vpa ?? x.valorpatrimonialcota),
    lpa: num(x.lpa),
  }));
}

export const PEER_CFG = {
  acao: { minLiq: 1_000_000, minPeers: 5, skip: [] },
  fii: { minLiq: 500_000, minPeers: 5, skip: ['Indefinido', 'Outros'] },
  bdr: { minLiq: 100_000, minPeers: 5, skip: [] },
};

function dedupeByCompany(rows) {
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.companyId);
    if (!cur || r.liq > cur.liq) best.set(r.companyId, r);
  }
  return [...best.values()];
}

export function groupStats(rows) {
  const pl = rows.filter(r => isPos(r.pl)).map(r => r.pl);
  const pvp = rows.filter(r => isPos(r.pvp)).map(r => r.pvp);
  const dy = rows.filter(r => typeof r.dy === 'number' && Number.isFinite(r.dy) && r.dy >= 0).map(r => r.dy);
  return { n: rows.length, pl: median(pl), nPl: pl.length, pvp: median(pvp), nPvp: pvp.length, dy: median(dy), nDy: dy.length };
}

/**
 * Grupo de pares: segmento da B3 → se tiver menos de minPeers empresas líquidas, sobe para subsetor → setor.
 * Liquidez mínima e 1 ticker por empresa (o mais líquido), para ON/PN/unit não contarem em dobro.
 */
export function peerGroup(universe, ticker, cfg) {
  const me = universe.find(x => x.ticker === ticker);
  if (!me) return null;
  const liquid = dedupeByCompany(universe.filter(x => x.liq >= cfg.minLiq));
  const levels = [['seg', 'segmento'], ['sub', 'subsetor'], ['sec', 'setor']];
  for (const [lv, label] of levels) {
    const name = me[lv];
    if (!name || cfg.skip.includes(name)) continue;
    const peers = liquid.filter(x => x[lv] === name);
    if (peers.length >= cfg.minPeers) {
      return { level: lv, levelLabel: label, name, peers: peers.sort((a, b) => b.liq - a.liq), ...groupStats(peers), me };
    }
  }
  return { level: null, levelLabel: null, name: me.seg || me.sub || me.sec, peers: [], n: 0, pl: null, pvp: null, dy: null, me };
}

/** Prêmio/desconto relativo (P/L, P/VP): valor/mediana − 1. */
export function premium(v, med) { return (isPos(v) && isPos(med)) ? v / med - 1 : null; }

/**
 * Retrato do Status Invest (espelho do celular, onde o Status Invest bloqueia o servidor) levado ao preço
 * atual. Ações e FIIs: P/L e P/VP escalam com o preço e o DY com o inverso (lucro, patrimônio e proventos
 * fixos desde o retrato), o que reproduz a conta da própria fonte. BDRs ficam como no retrato: o lucro é
 * da empresa lá fora, em dólar, e o preço do BDR também mexe com o câmbio.
 */
export function repriceSI(row, price, cls) {
  if (!row || cls === 'bdr' || !isPos(row.price) || !isPos(price)) return row;
  const k = price / row.price;
  const sc = v => (typeof v === 'number' && Number.isFinite(v)) ? v * k : v;
  return { ...row, pl: sc(row.pl), pvp: sc(row.pvp), dy: (typeof row.dy === 'number' && Number.isFinite(row.dy)) ? row.dy / k : row.dy, price, repriced: true };
}

// ---------------------------------------------------------------- Futuros de índices (pedido do usuário, 18/11/2026)

/**
 * Futuros acompanhados. EUA: série contínua do vencimento mais próximo no Yahoo (=F), com histórico diário,
 * então passam pelo mesmo motor das ações (fechamento contra fechamento; sem ajuste de rolagem).
 * Brasil (WIN/IND): o Yahoo não tem; preço do contrato vigente e variações da série contínua do
 * TradingView (WIN1!/IND1!), na convenção dele (base na abertura), escolha do usuário em 18/11/2026.
 */
export const FUTURES = {
  WIN: { src: 'tv', prefix: 'WIN', cont: 'BMFBOVESPA:WIN1!', name: 'Ibovespa mini futuro', region: 'Brasil', dec: 0 },
  IND: { src: 'tv', prefix: 'IND', cont: 'BMFBOVESPA:IND1!', name: 'Ibovespa futuro (contrato cheio)', region: 'Brasil', dec: 0 },
  'ES=F': { src: 'yahoo', name: 'S&P 500 futuro (E-mini)', region: 'EUA', dec: 2 },
  'NQ=F': { src: 'yahoo', name: 'Nasdaq 100 futuro (E-mini)', region: 'EUA', dec: 2 },
  'YM=F': { src: 'yahoo', name: 'Dow Jones futuro (mini)', region: 'EUA', dec: 0 },
  'RTY=F': { src: 'yahoo', name: 'Russell 2000 futuro (E-mini)', region: 'EUA', dec: 2 },
};

/**
 * O que o usuário digita → chave do futuro. WIN, WINZ26, WINZ2026, WIN1!, WIN$ → WIN (sempre o contrato
 * vigente, que rola sozinho no vencimento); ES, ES=F, ES1! → ES=F. Outra coisa → null.
 */
export function normalizeFuture(input) {
  const s = String(input || '').toUpperCase().trim();
  let m = s.match(/^(WIN|IND)(?:[FGHJKMNQUVXZ]\d{2}(?:\d{2})?|1!|\$|\$N)?$/);
  if (m) return m[1];
  m = s.match(/^(ES|NQ|YM|RTY)(?:=F|1!)?$/);
  return m ? `${m[1]}=F` : null;
}

const B3_MONTHS = { 2: 'G', 4: 'J', 6: 'M', 8: 'Q', 10: 'V', 12: 'Z' };
/** Vencimento B3 dos futuros de Ibovespa: quarta-feira mais próxima do dia 15 (conferido com o TV em 7 contratos). */
export function b3IndexExpiry(year, month) {
  const d15 = new Date(Date.UTC(year, month - 1, 15));
  const off = ((3 - d15.getUTCDay()) + 7) % 7; // dias até a próxima quarta
  const day = off <= 3 ? 15 + off : 15 + off - 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
/** Contrato vigente (meses pares; vence no dia do vencimento, então até ele inclusive). */
export function b3FrontContract(prefix, nowMs = Date.now()) {
  const today = brDate(nowMs);
  let [y, m] = today.split('-').map(Number);
  for (let i = 0; i < 14; i++, m++) {
    if (m > 12) { m = 1; y++; }
    if (!B3_MONTHS[m]) continue;
    const exp = b3IndexExpiry(y, m);
    if (exp >= today) return { code: `${prefix}${B3_MONTHS[m]}${String(y).slice(2)}`, tvCode: `${prefix}${B3_MONTHS[m]}${y}`, expiry: exp };
  }
  return null;
}

const TV_PERF = { d5: 'Perf.W', d30: 'Perf.1M', m6: 'Perf.6M', ytd: 'Perf.YTD', y1: 'Perf.Y', y5: 'Perf.5Y', ini: 'Perf.All' };
/**
 * Linha de um futuro da B3 a partir do TradingView (sem histórico diário). Mesmo formato das demais linhas.
 *  cont: série contínua (variações); contract: contrato vigente (preço, vencimento).
 */
export function buildTvFutureRow({ t, fut, cont, contract, at = null, error = null }) {
  const price = contract?.close ?? cont?.close ?? null;
  const vars = {};
  for (const mode of ['price', 'tr']) {
    const v = {};
    const chg = contract?.change ?? cont?.change;
    v.dia = typeof chg === 'number' ? { v: chg / 100, base: null, tv: 'dia' } : { v: null, why: 'sem dado no TradingView' };
    for (const [k, col] of Object.entries(TV_PERF)) {
      const x = cont?.[col];
      v[k] = typeof x === 'number' && Number.isFinite(x) ? { v: x / 100, base: null, tv: 'periodo' } : { v: null, why: 'sem dado no TradingView' };
    }
    vars[mode] = v;
  }
  const none = { v: null, src: null };
  return {
    t, cls: 'futuro', fut, price, vars, h: null, q: at ? { time: at } : null, series: [], last: null,
    name: `${fut.name}${contract?.code ? ` · ${contract.code}, vence ${contract.expiry.slice(8, 10)}/${contract.expiry.slice(5, 7)}/${contract.expiry.slice(0, 4)}` : ''}`,
    contract: contract || null, si: null, tv: null, dyc: { dy: null, items: [] }, pl: none, pvp: { ...none }, dy: { ...none },
    peers: null, checks: [], checksFail: [], error: error || (price == null ? 'sem cotação no TradingView' : null), noTrade: false, stale: false, mkt: null,
  };
}

// ---------------------------------------------------------------- Criptomoedas (pedido do usuário, 18/11/2026)

/**
 * Cripto direto (não ETF). Fonte: Yahoo, que só tem pares em dólar (BTC-USD…; os em reais dão 404, testado
 * em 18/11/2026). Em reais: cotação em dólar × dólar do Yahoo (BRL=X) do mesmo dia; conferido com o
 * CoinGecko: BTC em reais −0,14%, a mesma diferença do preço em dólar (só o horário da cotação).
 * Chaves: BTC-USD (padrão ao digitar BTC) e BTC-BRL (digitando BTC-BRL, BTCBRL ou BTC/BRL).
 */
export const isCrypto = t => /^[A-Z][A-Z0-9]{1,9}-(USD|BRL)$/.test(String(t || ''));
/**
 * Criptos aceitas só pela sigla (BTC, ETH…). Nomes conferidos no Yahoo em 18/11/2026. Ficam de fora siglas
 * que no Yahoo são outro token: TON-USD é um "TON Token" de US$ 0,002 (não o Toncoin), ARB-USD é "ARbit"
 * (não o Arbitrum), AB-USD é "Arma The Battle Ground"; UNI, SUI, APT, PEPE e POL não existem com esse símbolo.
 * Qualquer outra entra só com o sufixo explícito (XYZ-USD), e a inclusão mostra o nome do Yahoo.
 */
export const CRYPTO_BASES = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'TRX', 'AVAX', 'DOT', 'LINK', 'LTC',
  'BCH', 'XLM', 'ATOM', 'SHIB', 'USDT', 'USDC', 'NEAR', 'HBAR', 'ICP', 'ETC', 'AAVE', 'OP']);
export function normalizeCrypto(input) {
  const s = String(input || '').toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{4}\d/.test(s)) return null; // ticker da B3
  const quote = q => q === 'BRL' ? 'BRL' : 'USD'; // USDT conta como dólar
  let m = s.match(/^([A-Z][A-Z0-9]{1,9})[-\/](USDT|USD|BRL)$/); // sufixo explícito: qualquer cripto
  if (m) return `${m[1]}-${quote(m[2])}`;
  m = s.match(/^([A-Z]{2,6}?)(USDT|USD|BRL)?$/); // só a sigla, ou colada ao sufixo: lista fechada
  return m && CRYPTO_BASES.has(m[1]) ? `${m[1]}-${quote(m[2])}` : null;
}
/** Símbolo no Yahoo (a versão em reais usa o par em dólar). */
export const yahooKey = t => isCrypto(t) && t.endsWith('-BRL') ? t.replace(/-BRL$/, '-USD') : t;

/** Dólar (fechamento) na data, ou no último dia útil antes dela (fim de semana usa a sexta). */
export function fxAt(fxBars, date) { const i = lastIdxOnOrBefore(fxBars || [], date); return i >= 0 ? fxBars[i].close : null; }

/**
 * Versão em reais de um cripto: cada fechamento × dólar do mesmo dia; preço atual × dólar atual;
 * primeiro pregão × dólar daquele dia (fx.at, buscado à parte). Sem dólar, devolve h nulo (linha sem dado).
 */
export function toBRL(h, q, fx) {
  if (!h?.bars?.length || !fx?.bars?.length) return { h: null, q: null };
  const bars = [];
  for (const b of h.bars) { const k = fxAt(fx.bars, b.date); if (k) bars.push({ ...b, close: b.close * k, adj: (b.adj ?? b.close) * k }); }
  let inception = null;
  if (h.inception) {
    const k = fx.at?.[h.inception.date] ?? (h.inception.date >= fx.bars[0].date ? fxAt(fx.bars, h.inception.date) : null);
    if (k) inception = { ...h.inception, close: h.inception.close * k, adj: (h.inception.adj ?? h.inception.close) * k };
  }
  // Dia em reais (24 h móveis): (1 + variação do cripto em 24 h) × (dólar agora ÷ dólar de 24 h atrás) − 1
  const c = q?.changePct;
  const chgBRL = Number.isFinite(c) && isPos(fx.live) && isPos(fx.h24) ? ((1 + c / 100) * (fx.live / fx.h24) - 1) * 100 : null;
  return { h: { ...h, bars, inception }, q: q && isPos(fx.live) ? { ...q, price: q.price * fx.live, currency: 'BRL', changePct: chgBRL } : q };
}

// ---------------------------------------------------------------- Agrupamento da lista

/**
 * ETF de renda fixa: índice de títulos públicos, crédito ou juros (IMA-B, IRF-M, Tesouro, Selic, Treasury,
 * debêntures, "Renda Fixa"). O resto é renda variável (ações, exterior, ouro, cripto), que é como a
 * Receita trata ETF que não é de renda fixa. Regras conferidas com as descrições do TradingView de 16/11/2026.
 */
const RE_ETF_RF = /RENDA FIXA|IMA-?B|IRF-?M|IDKA|TESOURO|TREASURY|SELIC|DEB[EÊ]NTURE|TAXAS? DE JUROS|\bCDI\b|IPCA\s?\+/;
export function etfKind(name) { return RE_ETF_RF.test(String(name || '').toUpperCase()) ? 'Renda fixa' : 'Renda variável'; }

/**
 * Administradoras de shopping. A B3 as põe em Financeiro › Exploração de Imóveis, junto com galpões e
 * escritórios (LOGG3, HBRE3, SYNE3); a separação é pedido do usuário (16/11/2026: ALOS3 e MULT3).
 * Iguatemi (IGTI), General Shopping (GSHP3) e BR Malls (BRML3, incorporada pela Allos) são do mesmo ramo.
 */
export const SHOPPINGS = new Set(['ALOS3', 'MULT3', 'IGTI11', 'IGTI3', 'IGTI4', 'GSHP3', 'BRML3']);

/**
 * Holdings que a B3 põe no segmento Bancos, mas não são banco (pedido do usuário: "bancos de fato"):
 * Itaúsa (ITSA) e Alfa Holdings (RPAD). Conferido na lista do Status Invest de 13/11/2026.
 */
export const NOT_BANKS = new Set(['ITSA3', 'ITSA4', 'RPAD3', 'RPAD5', 'RPAD6']);

export const NO_CLASS = 'Sem classificação B3';

/**
 * Nome do grupo de uma linha (PC e celular usam esta mesma função).
 *  - Ações e BDRs: classificação da B3 (Status Invest) no nível escolhido. No nível "setor", com as
 *    subdivisões pedidas pelo usuário (16/11/2026):
 *      Consumo Cíclico → separa Construção civil;
 *      Consumo não Cíclico → separa Frigoríficos (Carnes e Derivados) e Supermercados (Comércio e
 *        Distribuição › Alimentos);
 *      Financeiro → Bancos, Shoppings (administradoras) e Outras financeiras.
 *  - FIIs: segmento. Fiagro, FI-Infra, FIP-IE: o tipo. ETFs: renda fixa ou renda variável.
 */
export function groupName({ t, cls, name, tvName, sec, sub, seg }, level = 'sec') {
  if (cls === 'cripto') return String(t).endsWith('-BRL') ? 'Em reais (convertido pelo dólar)' : 'Em dólar';
  if (cls === 'futuro') return FUTURES[t]?.region === 'Brasil' ? 'Índices B3' : 'Índices EUA';
  if (cls === 'etf') return etfKind(tvName || name);
  if (cls === 'fundo') return fundKind(tvName || name, t);
  if (cls === 'fii') return seg ? `FII · ${seg}` : 'FII · sem segmento';
  if (cls !== 'acao' && cls !== 'bdr') return 'Outros';
  if (!sec) return NO_CLASS;
  if (level === 'sub') return sub || sec;
  if (level === 'seg') return seg || sub || sec;
  if (sec === 'Consumo Cíclico' && sub === 'Construção Civil') return `${sec} · Construção civil`;
  if (sec === 'Consumo não Cíclico') {
    if (seg === 'Carnes e Derivados') return `${sec} · Frigoríficos`;
    if (sub === 'Comércio e Distribuição') return `${sec} · Supermercados e atacarejo`;
  }
  if (/^Financeiro/.test(sec)) {
    if (SHOPPINGS.has(t)) return `${sec} · Shoppings`;
    if (seg === 'Bancos' && !NOT_BANKS.has(t)) return `${sec} · Bancos`;
    return `${sec} · Outras financeiras`;
  }
  return sec;
}

// ---------------------------------------------------------------- Classificação e conferência

// "FIGARO": erro de digitação na descrição do TradingView para RURA11 (Itaú Asset Rural Fiagro), 16/11/2026
const RE_FIAGRO = /FIAGRO|FIGARO|AGROINDUSTRI|CADEIAS PRODUTIVAS/;
const RE_OUTRO_FUNDO = /FIAGRO|FIGARO|AGROINDUSTRI|CADEIAS PRODUTIVAS|INFRA|PARTICIPA[CÇ]/;

/**
 * Ajustes de classificação informados pelo usuário, quando as fontes classificam diferente.
 * BTRA11 (16/11/2026): é Fiagro; a descrição oficial ainda diz "Fundo de Investimento Imobiliário BTG
 * Pactual Terras Agrícolas" e ele não está na lista de FIIs do Status Invest.
 */
export const CLASS_OVERRIDE = {
  BTRA11: { cls: 'fundo', kind: 'Fiagro' },
};
const RE_FII = /\bFII\b|IMOBILI/;
const RE_ETF = /\bETF\b|ÍNDICE|INDICE|ISHARES|IT NOW|TREND/;
const RE_UNIT = /\bUNITS?\b/;

/**
 * Classe do ativo. Ordem: listas do Status Invest (oficial para ação/FII/BDR) → TradingView → nome no Yahoo.
 * Armadilha do TradingView: units (TAEE11, BPAC11) vêm como fund/etf; a descrição delas diz "Unit(s)".
 * Fiagro, FI-Infra e FIP-IE viram 'fundo' (mesma aba dos FIIs, a pedido do usuário).
 */
export function classify(ticker, si, tv, yahooMeta) {
  if (FUTURES[ticker] || yahooMeta?.type === 'FUTURE') return 'futuro';
  if (isCrypto(ticker) || yahooMeta?.type === 'CRYPTOCURRENCY') return 'cripto';
  if (CLASS_OVERRIDE[ticker]) return CLASS_OVERRIDE[ticker].cls;
  if (si?.acao?.has(ticker)) return 'acao';
  if (si?.fii?.has(ticker)) return 'fii';
  if (si?.bdr?.has(ticker)) return 'bdr';
  if (tv) {
    const d = String(tv.name || '').toUpperCase();
    if (tv.type === 'dr') return 'bdr';
    if (tv.type === 'stock') return 'acao';
    if (tv.type === 'fund' && tv.subtype === 'etf') return RE_UNIT.test(d) ? 'acao' : 'etf';
    if (tv.type === 'fund') return RE_OUTRO_FUNDO.test(d) ? 'fundo' : RE_FII.test(d) ? 'fii' : 'fundo';
  }
  const n = (yahooMeta?.name || '').toUpperCase();
  if (RE_OUTRO_FUNDO.test(n)) return 'fundo';
  if (RE_FII.test(n)) return 'fii';
  if (RE_ETF.test(n)) return 'etf';
  return 'outro';
}

/** Rótulo do fundo listado que não é FII (pela descrição/nome; ajuste do usuário tem prioridade). */
export function fundKind(name, ticker) {
  if (ticker && CLASS_OVERRIDE[ticker]?.kind) return CLASS_OVERRIDE[ticker].kind;
  const n = String(name || '').toUpperCase();
  if (RE_FIAGRO.test(n)) return 'Fiagro';
  if (/PARTICIPA[CÇ]|FIP/.test(n)) return 'FIP-IE';
  if (/INFRA/.test(n)) return 'FI-Infra';
  return 'Fundo';
}

export const TOL = { price: 0.015, mult: 0.15, dy: 1.0 };

/** Conferência entre fontes. Retorna lista de checagens com status. */
export function crossChecks({ price, si, tv, dyCalc, cls }) {
  const checks = [];
  const rel = (a, b) => Math.abs(a / b - 1);
  if (isPos(price)) {
    const alt = [];
    if (si && isPos(si.price)) alt.push(['Status Invest', si.price]);
    if (tv && isPos(tv.close)) alt.push(['TradingView', tv.close]);
    if (alt.length) checks.push({ metric: 'Preço', base: ['Yahoo', price], alt, ok: alt.some(([, v]) => rel(v, price) <= TOL.price), tol: '1,5%' });
  }
  if (cls === 'acao' && si && tv) {
    if (isPos(si.pl) && isPos(tv.pl)) checks.push({ metric: 'P/L', base: ['Status Invest', si.pl], alt: [['TradingView', tv.pl]], ok: rel(tv.pl, si.pl) <= TOL.mult, tol: '15%' });
    if (isPos(si.pvp) && isPos(tv.pvp)) checks.push({ metric: 'P/VP', base: ['Status Invest', si.pvp], alt: [['TradingView', tv.pvp]], ok: rel(tv.pvp, si.pvp) <= TOL.mult, tol: '15%' });
  }
  if (si && typeof si.dy === 'number') {
    const alt = [];
    if (typeof dyCalc === 'number') alt.push(['Proventos Yahoo', dyCalc]);
    if (cls === 'acao' && tv && typeof tv.dy === 'number') alt.push(['TradingView', tv.dy]);
    // Confirmado se ao menos uma fonte independente concorda (mesma regra do preço). Com "todas", o DY
    // errado do TradingView acendia alarme falso (caso real 13/11/2026: BBDC4 SI 11,11%, Yahoo 11,10%, TV 1,46%).
    if (alt.length) checks.push({ metric: 'DY', base: ['Status Invest', si.dy], alt, ok: alt.some(([, v]) => Math.abs(v - si.dy) <= TOL.dy), tol: '1 p.p.' });
  } else if (cls === 'acao' && tv && typeof tv.dy === 'number' && typeof dyCalc === 'number') {
    // sem Status Invest o DY exibido vem do TradingView; confere com os proventos do Yahoo
    checks.push({ metric: 'DY', base: ['TradingView', tv.dy], alt: [['Proventos Yahoo', dyCalc]], ok: Math.abs(dyCalc - tv.dy) <= TOL.dy, tol: '1 p.p.' });
  }
  return checks;
}

/**
 * Pregão aberto/fechado.
 * 1) Se a faixa foi consultada há pouco (ibovMeta.fetchedAt), decide pelas cotações: aberto se, na consulta,
 *    o Ibovespa tinha negócio de hoje com no máximo 25 min de defasagem (o Yahoo atrasa ~15 min).
 *    Motivo: em 13/11/2026 o Yahoo informou fim do pregão às 17h, mas houve negócios até 18h.
 * 2) Sem consulta recente: usa o período regular informado pelo Yahoo (lida com feriados).
 */
export function marketState(nowMs, ibovMeta) {
  const f = ibovMeta?.fetchedAt;
  if (f && nowMs - f < 40 * 60_000 && ibovMeta.time && brDate(ibovMeta.time) === brDate(nowMs)) {
    if (f - ibovMeta.time <= 25 * 60_000) return 'aberto';
    if (nowMs >= (ibovMeta.regularStart ?? 0)) return 'fechado';
  }
  if (ibovMeta?.regularStart && ibovMeta?.regularEnd) {
    const today = brDate(nowMs);
    if (nowMs >= ibovMeta.regularStart && nowMs <= ibovMeta.regularEnd && brDate(ibovMeta.regularStart) === today) {
      // Houve negócio hoje? (em feriado o Yahoo não registra negócio no dia)
      if (ibovMeta.time && brDate(ibovMeta.time) === today) return 'aberto';
      // Primeiros minutos: a cotação chega com ~15 min de atraso
      if (nowMs - ibovMeta.regularStart < 30 * 60_000) return 'abertura';
    }
  }
  return 'fechado';
}

/**
 * Janela em que a página atualiza a cada 30 min: seg–sex, 9h45–18h35 de Brasília.
 * Vai até 18h35 para incluir a rodada das 18h32: com o pregão terminando às 18h e o atraso de ~15 min do
 * Yahoo, a rodada das 18h02 ainda pega preços de ~17h47; a das 18h32 pega o fechamento.
 */
export function inRefreshWindow(nowMs) {
  const { wd, minutes } = brClock(nowMs);
  return wd >= 1 && wd <= 5 && minutes >= 9 * 60 + 45 && minutes <= 18 * 60 + 35;
}

/** Próximo horário de atualização: próximo :02 ou :32 dentro da janela; fora dela, próxima abertura da janela. */
export function nextRefreshAt(nowMs) {
  const step = 60_000;
  let t = Math.ceil((nowMs + 1) / step) * step;
  for (let i = 0; i < 60 * 24 * 8; i++, t += step) {
    const { minutes } = brClock(t);
    const mm = minutes % 60;
    if (inRefreshWindow(t) && (mm === 2 || mm === 32 || minutes === 9 * 60 + 45)) return t;
  }
  return nowMs + 30 * 60_000;
}

// ---------------------------------------------------------------- Linha calculada (PC e espelho do celular)

const evKey = e => `${e.date}|${e.amount ?? e.ratio}`;
const mergeEv = (a, b) => { const m = new Map((a || []).map(e => [evKey(e), e])); (b || []).forEach(e => m.set(evKey(e), e)); return [...m.values()].sort((x, y) => x.date < y.date ? -1 : 1); };

/**
 * Junta a busca leve (últimos pregões) ao histórico guardado, descarta trechos de dado errado do Yahoo
 * (cleanGlitches) e recalcula os saltos atípicos (findJumps).
 */
export function mergeHistory(h, recent) {
  const out = { ...h, bars: mergeBars(h.bars || [], recent.bars || []), divs: mergeEv(h.divs, recent.divs), splits: mergeEv(h.splits, recent.splits), name: h.name || recent.meta?.name || null };
  const cg = cleanGlitches(out.bars, out.splits);
  return { ...out, bars: cg.bars, glitches: [...new Set([...(h.glitches || []), ...cg.removed.map(b => b.date)])], jumps: findJumps(cg.bars, out.splits) };
}

/**
 * Tudo o que aparece numa linha do painel, a partir dos dados já buscados. Usada pela extensão (app.js)
 * e pelo espelho do celular (mirror/build.mjs), para os dois mostrarem exatamente os mesmos números.
 *  h: histórico {bars, divs, splits, inception, jumps, name}; q: cotação (meta do Yahoo);
 *  si: linha do Status Invest; siUniverse: lista da classe (medianas); siAt/tvAt: horário dos dados;
 *  ibovMeta: meta do Ibovespa com fetchedAt (estado do pregão e pregão atual).
 */
export function buildRow({ t, cls, h, q, si = null, siUniverse = null, siAt = null, tv = null, tvAt = null, ibovMeta = null, now = Date.now(), error = null }) {
  // Sem negócio no último pregão: o preço repete o último negócio e a série ganha uma barra no pregão atual,
  // para o Dia sair 0% e os demais períodos contarem a partir de hoje (não da data do último negócio).
  const ibovDate = ibovMeta?.time ? brDate(ibovMeta.time) : null;
  let series = h ? buildSeries(h.bars, q) : [];
  const lastTrade = series[series.length - 1];
  const noTrade = cls !== 'cripto' && !!(lastTrade && ibovDate && lastTrade.date < ibovDate); // cripto negocia todo dia
  if (noTrade) series = [...series, { date: ibovDate, close: lastTrade.close, adj: lastTrade.adj, carried: true }];
  const last = series[series.length - 1];
  const price = (q?.price > 0 && q.time && (!lastTrade || quoteDate(q) >= lastTrade.date)) ? q.price : (last?.close ?? null);
  const vars = { price: computeVariations(series, 'price', h?.inception), tr: computeVariations(series, 'tr', h?.inception) };
  if (cls === 'cripto' && q) {
    // Dia do cripto: 24 h móveis (agora × 24 h atrás), como CoinGecko e corretoras; escolha do usuário em 18/11/2026.
    // O Yahoo já entrega isso em regularMarketChangePercent (conferido com barras de 1 h: −1,546% × −1,537%).
    const c = q.changePct;
    for (const m of ['price', 'tr']) vars[m].dia = Number.isFinite(c) ? { v: c / 100, base: null, roll24: true } : { v: null, base: null, why: 'variação de 24 h indisponível' };
  }
  const dyc = dyFromDivs(h?.divs, last?.date, price);
  const dyYahoo = dyc.items.length ? dyc.dy : null; // sem proventos registrados no Yahoo = sem dado (não 0%)

  const pick = (...opts) => { for (const [v, src] of opts) if (typeof v === 'number' && Number.isFinite(v)) return { v, src }; return { v: null, src: null }; };
  let pl = { v: null, src: null }, pvp = { v: null, src: null }, dy = { v: null, src: null };
  if (cls === 'acao') { pl = pick([si?.pl, 'Status Invest'], [tv?.pl, 'TradingView']); pvp = pick([si?.pvp, 'Status Invest'], [tv?.pvp, 'TradingView']); dy = pick([si?.dy, 'Status Invest'], [tv?.dy, 'TradingView'], [dyYahoo, 'Proventos Yahoo']); }
  else if (cls === 'fii') { pvp = pick([si?.pvp, 'Status Invest']); dy = pick([si?.dy, 'Status Invest'], [dyYahoo, 'Proventos Yahoo']); }
  else if (cls === 'bdr') { pl = pick([si?.pl, 'Status Invest']); pvp = pick([si?.pvp, 'Status Invest']); dy = pick([si?.dy, 'Status Invest'], [dyYahoo, 'Proventos Yahoo']); }
  else if (dyYahoo != null) { dy = { v: dyYahoo, src: 'Proventos Yahoo' }; }

  // Idade dos dados de múltiplos: antigos se não são do pregão atual, ou têm mais de 1 h com o pregão aberto
  const mkt = marketState(now, ibovMeta);
  const ageOf = at => {
    if (!at) return null;
    const old = (ibovDate && brDate(at) < ibovDate) || (mkt === 'aberto' && now - at > 60 * 60_000);
    return old ? at : null;
  };
  const staleAt = { 'Status Invest': ageOf(siAt), 'TradingView': ageOf(tvAt) };
  for (const m of [pl, pvp, dy]) if (m.src && staleAt[m.src]) m.staleAt = staleAt[m.src];

  const peers = siUniverse && PEER_CFG[cls] ? peerGroup(siUniverse, t, PEER_CFG[cls]) : null;
  const checks = crossChecks({ price, si, tv, dyCalc: dyYahoo, cls });
  const quoteAge = q?.time ? now - q.time : null;
  const stale = mkt === 'aberto' && quoteAge != null && quoteAge > 50 * 60_000;

  return {
    t, cls, h, q, series, price, last: lastTrade, vars, si, tv, dyc, pl, pvp, dy, peers, checks,
    name: h?.name || q?.name || si?.name || tv?.name || '',
    error, noTrade, stale, mkt,
    checksFail: checks.filter(c => !c.ok),
  };
}
