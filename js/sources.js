// Camada de fontes: busca, valida e devolve dados já normalizados.
// Fontes (todas gratuitas, endpoints não oficiais):
//  - Yahoo Finance  (v8/finance/chart): cotação, histórico, proventos, desdobramentos
//  - Status Invest  (busca avançada):   P/L, P/VP, DY, classificação setorial B3, liquidez
//  - TradingView    (scanner):          P/L, P/VP, DY e tipo do ativo — usado para conferência

import * as C from './calc.js';

export class SourceError extends Error {
  constructor(source, message, code) { super(message); this.source = source; this.code = code || 'ERR'; }
}

async function fetchWithTimeout(url, opts = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** fetch + JSON com 1 nova tentativa em erro de rede, 429 ou 5xx. */
async function getJSON(source, urls, opts = {}, { timeout = 20000, retries = 1 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const url of list) {
      try {
        const r = await fetchWithTimeout(url, opts, timeout);
        if (r.status === 404) {
          let body = null; try { body = await r.json(); } catch { /* sem corpo */ }
          throw new SourceError(source, body?.chart?.error?.description || 'Não encontrado', 'NOT_FOUND');
        }
        if (r.status === 429 || r.status >= 500) { lastErr = new SourceError(source, `HTTP ${r.status}`, 'HTTP_' + r.status); continue; }
        if (!r.ok) throw new SourceError(source, `HTTP ${r.status}`, 'HTTP_' + r.status);
        const text = await r.text();
        try { return JSON.parse(text); }
        catch { throw new SourceError(source, 'Resposta não é JSON (possível bloqueio ou página de verificação)', 'NOT_JSON'); }
      } catch (e) {
        if (e instanceof SourceError && (e.code === 'NOT_FOUND' || e.code === 'NOT_JSON' || e.code.startsWith('HTTP_4'))) throw e;
        lastErr = e.name === 'AbortError' ? new SourceError(source, 'Tempo esgotado', 'TIMEOUT') : (e instanceof SourceError ? e : new SourceError(source, String(e.message || e), 'NETWORK'));
      }
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

// ---------------------------------------------------------------- Yahoo

const YH = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
export const yahooSymbol = t => (t.startsWith('^') || t.includes('.') || t.includes('=') || t.includes('-') || C.isForeign(t)) ? t : `${t}.SA`;

async function yahooChart(symbol, qs) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams(qs)}`;
  const json = await getJSON('yahoo', YH.map(h => h + path));
  try { return C.parseYahooChart(json); }
  catch (e) { throw new SourceError('yahoo', e.message, e.code === 'Not Found' ? 'NOT_FOUND' : 'NO_DATA'); }
}

/** Histórico diário de 5 anos + 20 dias (para a base do 5A existir mesmo se cair em fim de semana/feriado). */
export async function yahooHistory(ticker, nowMs = Date.now()) {
  const p2 = Math.floor(nowMs / 1000) + 86400;
  const p1 = Math.floor(Date.parse(C.addDays(C.addYears(C.brDate(nowMs), -5), -20) + 'T00:00:00Z') / 1000);
  return yahooChart(yahooSymbol(ticker), { period1: p1, period2: p2, interval: '1d', events: 'div|split', includeAdjustedClose: 'true' });
}

/**
 * Primeiro pregão disponível no Yahoo (coluna Início).
 * 1) Série longa e leve (range=max, interval=1mo; o Yahoo devolve barras ~semanais): data do primeiro pregão
 *    e saltos atípicos no histórico antigo, que viram aviso na célula.
 * 2) Janela diária de ~3 semanas a partir do primeiro pregão: fechamento exato do primeiro dia. O Yahoo
 *    aplica desdobramentos e proventos de forma global, então close/adj desses dias saem iguais aos de uma
 *    consulta até hoje (conferido em 13/11/2026: PETR4 e ITUB4, diferença ≤ 1,5e-6).
 */
export async function yahooInception(ticker) {
  const sym = yahooSymbol(ticker);
  const coarse = await yahooChart(sym, { range: 'max', interval: '1mo', events: 'div|split', includeAdjustedClose: 'true' });
  const firstMs = coarse.meta.firstTradeDate ?? (coarse.bars[0] ? Date.parse(coarse.bars[0].date + 'T12:00:00Z') : null);
  if (!firstMs) return null;
  const clean = C.cleanGlitches(coarse.bars, coarse.splits, { eventDays: 10 });
  const jumps = C.findJumps(clean.bars, coarse.splits, 10);
  const p1 = Math.floor(firstMs / 1000) - 86400;
  const res = await yahooChart(sym, { period1: p1, period2: p1 + 25 * 86400, interval: '1d', events: 'div|split', includeAdjustedClose: 'true' });
  const b = res.bars[0];
  if (!b) return null;
  // primeiro dia muito diferente da série longa também é sinal de dado ruim
  const c0 = clean.bars[0];
  if (c0 && (b.close / c0.close > 3 || b.close / c0.close < 1 / 3)) jumps.unshift({ date: c0.date, prevDate: b.date, from: b.close, to: c0.close });
  return { date: b.date, close: b.close, adj: b.adj, jumps };
}

/** Fechamento na data (ou no último pregão antes dela), por uma janela curta. Usado para o dólar do 1º pregão do cripto. */
export async function yahooCloseOn(symbol, dateIso) {
  const t = Math.floor(Date.parse(dateIso + 'T12:00:00Z') / 1000);
  const res = await yahooChart(yahooSymbol(symbol), { period1: t - 10 * 86400, period2: t + 2 * 86400, interval: '1d' });
  const i = C.lastIdxOnOrBefore(res.bars, dateIso);
  return i >= 0 ? res.bars[i].close : null;
}

/** Preço de ~N horas atrás (último fechamento de 1 h até lá). Para o dólar das 24 h do cripto em reais. */
export async function yahooPriceAgo(symbol, hours = 24, nowMs = Date.now()) {
  const json = await getJSON('yahoo', YH.map(h => `${h}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1h`));
  const r = json?.chart?.result?.[0];
  if (!r) throw new SourceError('yahoo', 'sem barras de 1 h', 'NO_DATA');
  const target = nowMs / 1000 - hours * 3600, ts = r.timestamp || [], cl = r.indicators?.quote?.[0]?.close || [];
  let best = null;
  for (let i = 0; i < ts.length; i++) if (ts[i] <= target && cl[i] > 0) best = cl[i];
  return best;
}

/** Busca leve a cada atualização: cotação + últimos 5 pregões + eventos recentes. */
export async function yahooRecent(ticker) {
  return yahooChart(yahooSymbol(ticker), { range: '5d', interval: '1d', events: 'div|split', includeAdjustedClose: 'true' });
}

/** Para a faixa de mercado: variação do dia via range=1d (chartPreviousClose = fechamento anterior). */
export async function yahooDay(symbol) {
  return yahooChart(symbol, { range: '1d', interval: '1d' });
}

// ---------------------------------------------------------------- Status Invest

export const siUrl = ct => `https://statusinvest.com.br/category/advancedsearchresultpaginated?search=${encodeURIComponent('{}')}&orderColumn=&isAsc=&page=0&take=5000&CategoryType=${ct}`;
export const SI_CATEGORIES = { acao: 1, fii: 2, bdr: 4 };
export const SI_OPTS = {
  credentials: 'include',
  headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
};
const SI_MIN_ROWS = { acao: 300, fii: 300, bdr: 300 }; // proteção contra resposta parcial

export async function statusInvest(kind) {
  const json = await getJSON('si', siUrl(SI_CATEGORIES[kind]), SI_OPTS);
  const list = json?.list;
  if (!Array.isArray(list) || list.length < SI_MIN_ROWS[kind]) {
    throw new SourceError('si', `Lista de ${kind} veio incompleta (${Array.isArray(list) ? list.length : 0} itens)`, 'PARTIAL');
  }
  return C.normalizeSI(list, kind);
}

// ---------------------------------------------------------------- TradingView

const TV_COLS = ['name', 'description', 'type', 'subtype', 'close', 'price_earnings_ttm', 'price_book_fq', 'dividends_yield_current', 'sector', 'industry'];

export const TV_URL = 'https://scanner.tradingview.com/brazil/scan';
export function tvRequest(tickers, columns = TV_COLS) {
  return { method: 'POST', body: JSON.stringify({ filter: [{ left: 'name', operation: 'in_range', right: tickers }], columns, range: [0, tickers.length + 20] }) };
}

export async function tradingView(tickers) {
  if (!tickers.length) return {};
  const json = await getJSON('tv', TV_URL, tvRequest(tickers));
  if (!Array.isArray(json?.data)) throw new SourceError('tv', 'Resposta sem dados', 'NO_DATA');
  const out = {};
  for (const row of json.data) {
    if (!String(row.s).startsWith('BMFBOVESPA:')) continue;
    const d = Object.fromEntries(TV_COLS.map((c, i) => [c, row.d[i]]));
    const n = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    out[d.name] = {
      ticker: d.name, name: d.description, type: d.type, subtype: d.subtype,
      close: n(d.close), pl: n(d.price_earnings_ttm), pvp: n(d.price_book_fq), dy: n(d.dividends_yield_current),
      sector: d.sector, industry: d.industry,
    };
  }
  return out;
}

/**
 * Futuros de Ibovespa (WIN/IND) no TradingView: série contínua (variações) + contrato vigente (preço,
 * vencimento confirmado pelo próprio TradingView). Devolve { [chave]: { cont, contract, at } }.
 */
const TV_FUT_COLS = ['name', 'description', 'close', 'change', 'Perf.W', 'Perf.1M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y', 'Perf.All', 'expiration'];
export async function tvFutures(keys, nowMs = Date.now()) {
  const want = keys.map(k => [k, C.FUTURES[k]]).filter(([, f]) => f?.src === 'tv');
  if (!want.length) return {};
  const fronts = Object.fromEntries(want.map(([k, f]) => [k, f.monthly ? C.b3MonthlyFront(f.prefix, nowMs) : C.b3FrontContract(f.prefix, nowMs)]));
  const tickers = want.flatMap(([k, f]) => [f.cont, `BMFBOVESPA:${fronts[k].tvCode}`]);
  const json = await getJSON('tv', 'https://scanner.tradingview.com/global/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers }, columns: TV_FUT_COLS }) });
  if (!Array.isArray(json?.data)) throw new SourceError('tv', 'Resposta sem dados', 'NO_DATA');
  const bySym = Object.fromEntries(json.data.map(r => [r.s, Object.fromEntries(TV_FUT_COLS.map((c, i) => [c, r.d[i]]))]));
  const at = Date.now();
  const out = {};
  for (const [k, f] of want) {
    const c = bySym[`BMFBOVESPA:${fronts[k].tvCode}`];
    const exp = c?.expiration ? String(c.expiration) : null; // AAAAMMDD do TradingView vale mais que a regra
    out[k] = {
      cont: bySym[f.cont] || null,
      contract: c ? { code: fronts[k].code, expiry: exp ? `${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}` : fronts[k].expiry, close: c.close, change: c.change } : null,
      at,
    };
  }
  return out;
}

/** Cotações ao vivo do celular, todas numa consulta: { símbolo: {close, change (% do dia), chg24 (% em 24 h)} }. */
export async function tvLive(symbols) {
  if (!symbols.length) return {};
  const columns = ['close', 'change', '24h_close_change|5'];
  const json = await getJSON('tv', 'https://scanner.tradingview.com/global/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers: symbols }, columns }), cache: 'no-store' }, { timeout: 12000, retries: 2 });
  if (!Array.isArray(json?.data)) throw new SourceError('tv', 'Resposta sem dados', 'NO_DATA');
  return Object.fromEntries(json.data.map(r => [r.s, { close: r.d[0], change: r.d[1], chg24: r.d[2] }]));
}

/** Gráfico intradiário do detalhe:'1d' (pontos de 5 min) ou '5d' (15 min). */
export async function yahooIntraday(ticker, range) {
  const json = await getJSON('yahoo', YH.map(h => `${h}/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}?${new URLSearchParams({ range, interval: range === '1d' ? '5m' : '15m', includePrePost: 'false' })}`));
  try { return C.parseYahooIntraday(json); }
  catch (e) { throw new SourceError('yahoo', e.message, e.code === 'Not Found' ? 'NOT_FOUND' : 'NO_DATA'); }
}

// ---------------------------------------------------------------- Juros (23/11/2026)

/** DI futuro no TradingView (taxa, variação do dia em p.p., variações de período em % da taxa, vencimento). */
const TV_DI_COLS = ['name', 'close', 'change_abs', 'Perf.W', 'Perf.1M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y', 'expiration'];
export async function tvRates(keys) {
  const want = keys.filter(C.isDI);
  if (!want.length) return {};
  const json = await getJSON('tv', 'https://scanner.tradingview.com/global/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers: want.map(C.diTvSymbol) }, columns: TV_DI_COLS }) });
  if (!Array.isArray(json?.data)) throw new SourceError('tv', 'Resposta sem dados', 'NO_DATA');
  const bySym = Object.fromEntries(json.data.map(r => [r.s, Object.fromEntries(TV_DI_COLS.map((c, i) => [c, r.d[i]]))]));
  const at = Date.now();
  return Object.fromEntries(want.filter(k => bySym[C.diTvSymbol(k)]).map(k => [k, { ...bySym[C.diTvSymbol(k)], at }]));
}

/** Texto em latin1 (ANBIMA e Tesouro Transparente), com nova tentativa em erro de rede, 429 ou 5xx. 404 → null. */
async function getLatin1(source, url, timeout = 30000) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchWithTimeout(url, { cache: 'no-store' }, timeout);
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { lastErr = new SourceError(source, `HTTP ${r.status}`, 'HTTP_' + r.status); }
      else if (!r.ok) throw new SourceError(source, `HTTP ${r.status}`, 'HTTP_' + r.status);
      else return new TextDecoder('latin1').decode(await r.arrayBuffer());
    } catch (e) {
      if (e instanceof SourceError && e.code.startsWith('HTTP_4')) throw e;
      lastErr = e.name === 'AbortError' ? new SourceError(source, 'Tempo esgotado', 'TIMEOUT') : (e instanceof SourceError ? e : new SourceError(source, String(e.message || e), 'NETWORK'));
    }
    if (attempt === 0) await sleep(1500);
  }
  throw lastErr;
}

/** Taxas indicativas da ANBIMA de um dia (NTN-B). null = sem arquivo (feriado, fim de semana, ainda não publicado ou fora da janela de ~5 pregões). */
export async function anbimaDay(dateIso) {
  const txt = await getLatin1('anbima', `https://www.anbima.com.br/informacoes/merc-sec/arqs/ms${dateIso.slice(2).replace(/-/g, '')}.txt`);
  return txt == null ? null : C.parseAnbimaMs(txt);
}

/** Histórico do Tesouro Direto (CSV oficial do Tesouro Transparente, ~15 MB): NTN-B por vencimento. */
export const TESOURO_CSV = 'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/precotaxatesourodireto.csv';
export async function tesouroNtnb() {
  const txt = await getLatin1('tesouro', TESOURO_CSV, 120000);
  if (txt == null) throw new SourceError('tesouro', 'arquivo do Tesouro Direto não encontrado', 'NOT_FOUND');
  const parsed = C.parseTesouroCsv(txt);
  if (!Object.keys(parsed).length) throw new SourceError('tesouro', 'CSV do Tesouro Direto sem NTN-B (formato mudou?)', 'NO_DATA');
  return parsed;
}

/**
 * Diagnóstico: faz a chamada como a extensão faria e devolve o que veio (status, tipo, tamanho, tempo,
 * JSON ou o começo do texto, ex.: página de verificação do Cloudflare). Nunca lança erro.
 */
export async function probe(url, opts = {}, timeout = 30000) {
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(url, opts, timeout);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* não é JSON */ }
    return { url, status: r.status, ok: r.ok, ms: Date.now() - t0, contentType: r.headers.get('content-type'), bytes: text.length, json, head: json ? null : text.slice(0, 800) };
  } catch (e) {
    return { url, status: null, ok: false, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'Tempo esgotado' : String(e.message || e) };
  }
}

/** Executa tarefas com no máximo `limit` em paralelo. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { results[k] = { ok: true, value: await fn(items[k], k) }; }
      catch (e) { results[k] = { ok: false, error: e }; }
    }
  });
  await Promise.all(workers);
  return results;
}
