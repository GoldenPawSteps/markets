import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  TrendingUp, Search, Plus, Wallet, Trophy, LogIn, LogOut, X, Check, Loader2,
  MessageSquare, Clock, CheckCircle2, Coins, Activity, ChevronRight, Send,
  AlertCircle, Wifi, WifiOff, Sparkles, BarChart3, Users, ArrowUpRight, ArrowDownRight,
  Sun, Moon,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, getInitialLanguage, translate } from './i18n';

/* ============================ Config ============================ */
// Point these at your FastAPI server. The Vite dev server proxies /api and /ws to backend localhost:8000.
// Production can use either the backend root URL or an /api prefix, and the client will fall back automatically.
const defaultApiHost = (() => {
  if (typeof window === 'undefined') return 'http://localhost:8000';
  if (import.meta.env.DEV) return '/api';
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.hostname}:8000`;
})();
const defaultWsHost = (() => {
  if (typeof window === 'undefined') return 'ws://localhost:8000/ws';
  if (import.meta.env.DEV) return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:8000/ws`;
})();
const API_BASE = (typeof window !== 'undefined' && (window.__FORECAST_API__ || import.meta.env.VITE_API_BASE)) || defaultApiHost;
const WS_BASE  = (typeof window !== 'undefined' && (window.__FORECAST_WS__ || import.meta.env.VITE_WS_BASE)) || defaultWsHost;
const usingDevProxy = import.meta.env.DEV && API_BASE === '/api';
const backendAccessMode = usingDevProxy ? 'Vite proxy active' : 'Direct backend access';

if (typeof window !== 'undefined') {
  console.debug('ForeCast config', { API_BASE, WS_BASE, usingDevProxy, backendAccessMode });
}

const CATEGORIES = ['Crypto', 'Economics', 'Sports', 'Tech', 'Weather', 'Climate', 'Politics', 'Other'];
const LINE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7'];

/* ============================ Format helpers ============================ */
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const money = (x) => (x < 0 ? '−' : '') + nf.format(Math.abs(Number(x) || 0));
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function fromNow(iso, t) {
  const diff = new Date(iso).getTime() - Date.now();
  const past = diff < 0; const s = Math.abs(diff) / 1000;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const str = d > 0 ? `${d}d` : h > 0 ? `${h}h` : `${m}m`;
  return past ? `${str} ${t?.('ago') || 'ago'}` : `${t?.('in') || 'in'} ${str}`;
}
function hashColor(str) {
  let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return LINE_COLORS[h % LINE_COLORS.length];
}
const tradeUser = (t) => t.user || { name: t.user_name || 'Bot', avatar: (t.user_name || 'B').slice(0, 2).toUpperCase(), color: hashColor(t.user_name || 'Bot') };

/* ============================ LMSR (ported from the backend) ============================ */
function lmsrPrices(shares, b) {
  const m = Math.max(...shares);
  const ex = shares.map((q) => Math.exp((q - m) / b));
  const s = ex.reduce((a, c) => a + c, 0);
  return ex.map((e) => e / s);
}
function lmsrCost(shares, b) {
  const m = Math.max(...shares);
  const s = shares.reduce((a, q) => a + Math.exp((q - m) / b), 0);
  return m + b * Math.log(s);
}
function costToTrade(shares, b, idx, delta) {
  const after = shares.slice(); after[idx] += delta;
  return lmsrCost(after, b) - lmsrCost(shares, b);
}
function maxAffordable(shares, b, idx, budget) {
  if (budget <= 0) return 0;
  let hi = 1; while (costToTrade(shares, b, idx, hi) < budget && hi < 5e6) hi *= 2;
  let lo = 0;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (costToTrade(shares, b, idx, mid) <= budget) lo = mid; else hi = mid; }
  return Math.floor(lo);
}
function localQuote(market, outcomeId, side, qty, balance, held, t) {
  const shares = market.outcomes.map((o) => o.shares_outstanding);
  const b = market.liquidity_param;
  const idx = market.outcomes.findIndex((o) => o.id === outcomeId);
  const cur = lmsrPrices(shares, b)[idx];
  if (!qty || qty <= 0) return { shares: 0, side, cur_price: cur, error: t?.('enterQuantity') || 'Enter a quantity' };
  const delta = side === 'buy' ? qty : -qty;
  const cost = costToTrade(shares, b, idx, delta);
  const after = shares.slice(); after[idx] += delta;
  const newPrice = lmsrPrices(after, b)[idx];
  const abscost = Math.abs(cost);
  let error = null;
  if (side === 'buy' && cost > (balance ?? Infinity) + 1e-9) error = t?.('insufficientBalance') || 'Insufficient balance';
  if (side === 'sell' && qty > (held ?? 0) + 1e-9) error = t?.('notEnoughShares') || 'Not enough shares';
  return {
    shares: qty, side, cur_price: cur, new_price: newPrice, avg_price: abscost / qty,
    cost: abscost, proceeds: side === 'sell' ? -cost : 0,
    max_payout: side === 'buy' ? qty : null, max_profit: side === 'buy' ? qty - abscost : null,
    outcome_id: outcomeId, outcome_label: market.outcomes[idx].label, error,
  };
}

/* ============================ HTTP client ============================ */
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

function getErrorMessage(error, t) {
  const msg = typeof error === 'string'
    ? error
    : error?.message || error?.detail || error?.response?.detail || error?.response?.message || '';
  const status = error?.status;
  const lower = String(msg).toLowerCase();
  if (lower.includes('insufficient balance')) return t?.('insufficientBalance') || 'Insufficient balance';
  if (lower.includes('not enough shares')) return t?.('notEnoughShares') || 'Not enough shares';
  if (lower.includes('market not found')) return t?.('marketNotFound') || 'Market not found';
  if (lower.includes('market is not open')) return t?.('marketNotOpen') || 'Market is not open';
  if (lower.includes('enter a quantity')) return t?.('enterQuantity') || 'Enter a quantity';
  if (lower.includes('that name is taken')) return t?.('nameTaken') || 'That name is taken';
  if (lower.includes('request failed')) return t?.('requestFailed') || 'Request failed';
  return msg || (t?.('requestFailed') || 'Request failed');
}

function getApiBaseCandidates(base) {
  const candidates = [];
  if (base) candidates.push(base);
  if (base && base.endsWith('/api')) candidates.push(base.replace(/\/api$/, ''));
  return Array.from(new Set(candidates));
}

async function requestJson(path, { method = 'GET', body, headers = {}, timeout = 8000, parseJson = true, form = false } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  const bases = getApiBaseCandidates(API_BASE);
  let lastError = null;
  try {
    for (const base of bases) {
      try {
        const res = await fetch(base + path, {
          method,
          headers: form ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
          body: body ? (form ? body : JSON.stringify(body)) : undefined,
          signal: ctrl.signal,
        });
        const text = await res.text();
        const data = parseJson && text ? JSON.parse(text) : text;
        if (!res.ok) {
          if (res.status === 404 && base !== bases[bases.length - 1]) continue;
          const err = new Error((data && (data.detail || data.message)) || `HTTP ${res.status}`);
          err.status = res.status;
          err.detail = data?.detail || data?.message;
          err.response = data;
          throw err;
        }
        return data;
      } catch (error) {
        if (error?.status === 404 && base !== bases[bases.length - 1]) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
  } finally { clearTimeout(id); }
  throw lastError || new Error('Request failed');
}

async function http(path, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  return requestJson(path, { method, body, headers, timeout, parseJson: true });
}

async function loginHttp(username, password) {
  const body = new URLSearchParams({ username, password });
  return requestJson('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    parseJson: true,
    form: true,
  });
}

/* ============================ Demo data + engine ============================ */
let _id = 0; const makeId = () => `d${(++_id).toString(36)}${Date.now().toString(36).slice(-3)}`;
const NOW = Date.now(); const DAY = 86400000;

function genHistory(endPrices, startMs, endMs, n = 30) {
  const u = 1 / endPrices.length; const pts = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n; const ease = f * f * (3 - 2 * f);
    let row = endPrices.map((p) => Math.max(0.01, u + (p - u) * ease + (Math.random() - 0.5) * 0.02 * (1 - ease)));
    const s = row.reduce((a, c) => a + c, 0); row = row.map((x) => x / s);
    pts.push({ t: new Date(startMs + (endMs - startMs) * f).toISOString(), values: row });
  }
  return pts;
}

function buildDemo() {
  const users = {};
  const add = (name, avatar, color, bal, admin = false, bot = true) => {
    const u = { id: makeId(), name, avatar, color, balance: bal, start_balance: bal, realized_pnl: 0, is_admin: admin, is_bot: bot };
    users[u.id] = u; return u;
  };
  const you = add('You', 'YO', '#4f46e5', 1000, true, false);
  const bots = [
    add('QuantWhale', 'QW', '#0891b2', 2200), add('MarketMaven', 'MM', '#7c3aed', 1500),
    add('HedgeHog', 'HH', '#d97706', 900), add('OddsOracle', 'OO', '#16a34a', 1800),
    add('PaperHands', 'PH', '#e11d48', 650), add('DiamondMind', 'DM', '#4f46e5', 1300),
  ];
  const specs = [
    ['Will it rain in New York City tomorrow?', 'Measurable precipitation in Central Park during the calendar day.', 'binary', 'Weather', 140, ['Yes', 'No'], 1, 14, [0.36, 0.64], null],
    ['Will Bitcoin close above $100,000 this year?', 'Settles on the daily close of a major spot index.', 'binary', 'Crypto', 170, ['Yes', 'No'], 120, 40, [0.58, 0.42], null],
    ['Will the Fed cut rates at the next meeting?', 'Based on the official FOMC target-range decision.', 'binary', 'Economics', 150, ['Yes', 'No'], 22, 18, [0.70, 0.30], null],
    ['Who will win the next World Cup?', 'A categorical market across leading national teams.', 'categorical', 'Sports', 260, ['Brazil', 'Argentina', 'France', 'Spain', 'Field'], 200, 30, [0.24, 0.21, 0.19, 0.16, 0.20], null],
    ['Did the spring event reveal a foldable phone?', 'A market that has reached its close date and awaits resolution.', 'binary', 'Tech', 150, ['Yes', 'No'], -3, 20, [0.42, 0.58], null],
    ['Did the home team win Game 7?', 'A resolved example market showing payouts.', 'binary', 'Sports', 130, ['Yes', 'No'], -9, 22, [0.62, 0.38], 'Yes'],
  ];
  const markets = specs.map(([q, desc, type, cat, b, labels, closeDays, ago, target, win]) => {
    const outcomes = labels.map((label, i) => ({ id: makeId(), label, position: i, shares_outstanding: b * Math.log(target[i]) }));
    const createdMs = NOW - ago * DAY; const closeMs = NOW + closeDays * DAY;
    const m = {
      id: makeId(), question: q, description: desc, category: cat, type, liquidity_param: b,
      resolution_criteria: 'Resolves per the stated criteria using the official source at close.',
      created_by: bots[0].id, created_at: new Date(createdMs).toISOString(),
      close_date: new Date(closeMs).toISOString(), volume: 200 + Math.random() * 4000,
      status: win ? 'resolved' : 'open', resolved_outcome_id: null, outcomes,
      history: genHistory(target, createdMs, Math.min(NOW, closeMs)), recent_trades: [], comments: [],
    };
    for (let i = 0; i < 4; i++) {
      const oc = outcomes[Math.floor(Math.random() * outcomes.length)]; const bot = bots[Math.floor(Math.random() * bots.length)];
      m.recent_trades.unshift({ id: makeId(), side: Math.random() > 0.4 ? 'buy' : 'sell', shares: 1 + Math.floor(Math.random() * 6), price: target[outcomes.indexOf(oc)], outcome_id: oc.id, outcome_label: oc.label, created_at: new Date(NOW - Math.random() * 5 * DAY).toISOString(), user_name: bot.name });
    }
    if (win) { const w = outcomes.find((o) => o.label === win); m.resolved_outcome_id = w.id; m.history.push({ t: m.close_date, values: outcomes.map((o) => (o.id === w.id ? 1 : 0)) }); }
    return m;
  });
  markets[1].comments = [{ id: makeId(), text: 'ETF flows look strong — leaning yes here.', created_at: new Date(NOW - 6 * 3600000).toISOString(), user: { name: 'QuantWhale', avatar: 'QW', color: '#0891b2' } }];
  const positions = [];
  const buy = (mq, label, qty) => {
    const m = markets.find((x) => x.question === mq); const oc = m.outcomes.find((o) => o.label === label);
    positions.push({ id: makeId(), user_id: you.id, market_id: m.id, outcome_id: oc.id, shares: qty, avg_price: lmsrPrices(m.outcomes.map((o) => o.shares_outstanding), m.liquidity_param)[m.outcomes.indexOf(oc)] });
  };
  buy('Will the Fed cut rates at the next meeting?', 'Yes', 80);
  buy('Will Bitcoin close above $100,000 this year?', 'Yes', 60);
  buy('Who will win the next World Cup?', 'Brazil', 50);
  return { users, you, bots, markets, positions, trades: [] };
}
const demoState = buildDemo();
const demoEmitter = {
  handlers: new Set(),
  emit(e) { this.handlers.forEach((h) => { try { h(e); } catch { /* ignore */ } }); },
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); },
};

const statusOf = (m) => (m.resolved_outcome_id ? 'resolved' : new Date(m.close_date).getTime() <= Date.now() ? 'closed' : 'open');
function marketOut(m, detail = false) {
  const prices = lmsrPrices(m.outcomes.map((o) => o.shares_outstanding), m.liquidity_param);
  const base = {
    id: m.id, question: m.question, description: m.description, category: m.category, type: m.type,
    status: statusOf(m), close_date: m.close_date, created_at: m.created_at, volume: m.volume,
    liquidity_param: m.liquidity_param, created_by: m.created_by, resolved_outcome_id: m.resolved_outcome_id,
    outcomes: m.outcomes.map((o, i) => ({ id: o.id, label: o.label, position: o.position, price: prices[i], shares_outstanding: o.shares_outstanding })),
  };
  if (!detail) return base;
  return { ...base, resolution_criteria: m.resolution_criteria, creator: { id: m.created_by, name: (demoState.users[m.created_by] || {}).name }, history: m.history.slice(-200), recent_trades: m.recent_trades.slice(0, 20), comments: m.comments.slice() };
}
function demoTrade(userId, marketId, outcomeId, side, qty, t) {
  const m = demoState.markets.find((x) => x.id === marketId);
  if (!m) throw new Error(t?.('marketNotFound') || 'Market not found');
  if (statusOf(m) !== 'open') throw new Error(t?.('marketNotOpen') || 'Market is not open');
  const u = demoState.users[userId];
  const shares = m.outcomes.map((o) => o.shares_outstanding);
  const b = m.liquidity_param; const idx = m.outcomes.findIndex((o) => o.id === outcomeId);
  let pos = demoState.positions.find((p) => p.user_id === userId && p.outcome_id === outcomeId);
  const held = pos ? pos.shares : 0;
  const delta = side === 'buy' ? qty : -qty;
  const cost = costToTrade(shares, b, idx, delta);
  if (side === 'buy' && cost > u.balance + 1e-9) throw new Error(t?.('insufficientBalance') || 'Insufficient balance');
  if (side === 'sell' && qty > held + 1e-9) throw new Error(t?.('notEnoughShares') || 'Not enough shares');
  m.outcomes[idx].shares_outstanding += delta;
  const perShare = Math.abs(cost) / qty;
  if (side === 'buy') {
    const ns = held + qty; const basis = pos ? pos.shares * pos.avg_price : 0;
    if (pos) { pos.shares = ns; pos.avg_price = (basis + cost) / ns; }
    else { pos = { id: makeId(), user_id: userId, market_id: marketId, outcome_id: outcomeId, shares: ns, avg_price: cost / ns }; demoState.positions.push(pos); }
  } else {
    u.realized_pnl += (-cost) - qty * (pos ? pos.avg_price : 0);
    if (held - qty <= 1e-9) { demoState.positions = demoState.positions.filter((p) => p !== pos); pos = null; }
    else pos.shares = held - qty;
  }
  u.balance -= cost; m.volume += Math.abs(cost);
  const prices = lmsrPrices(m.outcomes.map((o) => o.shares_outstanding), b);
  const created_at = new Date().toISOString();
  const tr = { id: makeId(), user_id: userId, user_name: u.name, market_id: marketId, outcome_id: outcomeId, outcome_label: m.outcomes[idx].label, side, shares: qty, price: perShare, cost: Math.abs(cost), created_at };
  m.recent_trades.unshift(tr); m.recent_trades = m.recent_trades.slice(0, 30);
  demoState.trades.unshift({ ...tr, question: m.question });
  m.history.push({ t: created_at, values: prices });
  const pricesPayload = m.outcomes.map((o, i) => ({ outcome_id: o.id, label: o.label, price: prices[i], shares_outstanding: o.shares_outstanding }));
  demoEmitter.emit({ type: 'market_update', market_id: marketId, prices: pricesPayload, volume: m.volume, trade: tr });
  return { trade: tr, prices: pricesPayload, balance: u.balance, realized_pnl: u.realized_pnl, market_volume: m.volume, position: pos ? { outcome_id: outcomeId, shares: pos.shares, avg_price: pos.avg_price } : null };
}
function demoResolve(marketId, winId, t) {
  const m = demoState.markets.find((x) => x.id === marketId); if (!m) throw new Error(t?.('marketNotFound') || 'Market not found');
  demoState.positions.filter((p) => p.market_id === marketId).forEach((p) => {
    const u = demoState.users[p.user_id]; const payout = p.outcome_id === winId ? p.shares : 0;
    u.balance += payout; u.realized_pnl += payout - p.shares * p.avg_price;
  });
  demoState.positions = demoState.positions.filter((p) => p.market_id !== marketId);
  m.status = 'resolved'; m.resolved_outcome_id = winId;
  const final = m.outcomes.map((o) => (o.id === winId ? 1 : 0));
  m.history.push({ t: new Date().toISOString(), values: final });
  const payload = { type: 'market_resolved', market_id: marketId, status: 'resolved', resolved_outcome_id: winId, prices: m.outcomes.map((o, i) => ({ outcome_id: o.id, label: o.label, price: final[i] })) };
  demoEmitter.emit(payload);
  return payload;
}
let demoBotsStarted = false;
function startDemoBots() {
  if (demoBotsStarted) return; demoBotsStarted = true;
  setInterval(() => {
    const open = demoState.markets.filter((m) => statusOf(m) === 'open');
    if (!open.length) return;
    const m = open[Math.floor(Math.random() * open.length)];
    const oc = m.outcomes[Math.floor(Math.random() * m.outcomes.length)];
    const bot = demoState.bots[Math.floor(Math.random() * demoState.bots.length)];
    try { demoTrade(bot.id, m.id, oc.id, 'buy', 1 + Math.floor(Math.random() * 4)); } catch { /* ignore */ }
  }, 2800);
}

/* ============================ Data sources ============================ */
function makeLiveDS(token, t) {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  return {
    mode: 'live',
    listMarkets: (p) => http(`/markets?${qs(p)}`),
    getMarket: (id) => http(`/markets/${id}`),
    quote: async ({ market, outcome_id, side, shares, balance, held }) => {
      if (token) { try { return await http(`/markets/${market.id}/quote?${qs({ outcome_id, side, shares })}`, { headers: auth }); } catch { /* fall back */ } }
      return localQuote(market, outcome_id, side, shares, balance, held, t);
    },
    trade: (b) => http('/trades', { method: 'POST', body: b, headers: auth }),
    resolve: (id, winning_outcome_id) => http(`/markets/${id}/resolve`, { method: 'POST', body: { winning_outcome_id }, headers: auth }),
    addComment: (id, text) => http(`/markets/${id}/comments`, { method: 'POST', body: { text }, headers: auth }),
    portfolio: () => http('/me/portfolio', { headers: auth }),
    myTrades: () => http('/me/trades', { headers: auth }),
    leaderboard: () => http('/leaderboard'),
    createMarket: (b) => http('/markets', { method: 'POST', body: b, headers: auth }),
    me: () => http('/auth/me', { headers: auth }),
  };
}
function makeDemoDS(userId, t) {
  const filt = (p) => {
    let list = demoState.markets.map((m) => marketOut(m));
    if (p.status) list = list.filter((m) => m.status === p.status);
    if (p.category && p.category !== 'All') list = list.filter((m) => m.category === p.category);
    if (p.q) { const q = p.q.toLowerCase(); list = list.filter((m) => m.question.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)); }
    list.sort((a, b) => (p.sort === 'newest' ? new Date(b.created_at) - new Date(a.created_at) : b.volume - a.volume));
    return list;
  };
  return {
    mode: 'demo',
    listMarkets: async (p) => filt(p),
    getMarket: async (id) => { const m = demoState.markets.find((x) => x.id === id); if (!m) throw new Error(t?.('marketNotFound') || 'Market not found'); return marketOut(m, true); },
    quote: async ({ market, outcome_id, side, shares, balance, held }) => localQuote(market, outcome_id, side, shares, balance, held, t),
    trade: async (b) => demoTrade(userId, b.market_id, b.outcome_id, b.side, b.shares, t),
    resolve: async (id, win) => demoResolve(id, win, t),
    addComment: async (id, text) => {
      const m = demoState.markets.find((x) => x.id === id); const u = demoState.users[userId];
      const c = { id: makeId(), text, created_at: new Date().toISOString(), user: { name: u.name, avatar: u.avatar, color: u.color } };
      m.comments.unshift(c); demoEmitter.emit({ type: 'comment', market_id: id, ...c }); return c;
    },
    portfolio: async () => {
      const u = demoState.users[userId]; const rows = []; let pv = 0, unreal = 0;
      demoState.positions.filter((p) => p.user_id === userId).forEach((p) => {
        const m = demoState.markets.find((x) => x.id === p.market_id); if (!m) return;
        const prices = lmsrPrices(m.outcomes.map((o) => o.shares_outstanding), m.liquidity_param);
        const i = m.outcomes.findIndex((o) => o.id === p.outcome_id); const cur = prices[i]; const value = p.shares * cur;
        pv += value; unreal += value - p.shares * p.avg_price;
        rows.push({ market_id: m.id, question: m.question, outcome_id: p.outcome_id, outcome_label: m.outcomes[i].label, shares: p.shares, avg_price: p.avg_price, cur_price: cur, value, unrealized_pnl: value - p.shares * p.avg_price });
      });
      return { net_worth: u.balance + pv, cash: u.balance, positions_value: pv, unrealized_pnl: unreal, realized_pnl: u.realized_pnl, positions: rows };
    },
    myTrades: async () => demoState.trades.filter((t) => t.user_id === userId).slice(0, 50),
    leaderboard: async () => {
      const hold = {};
      demoState.positions.forEach((p) => {
        const m = demoState.markets.find((x) => x.id === p.market_id); if (!m) return;
        const prices = lmsrPrices(m.outcomes.map((o) => o.shares_outstanding), m.liquidity_param);
        const i = m.outcomes.findIndex((o) => o.id === p.outcome_id); hold[p.user_id] = (hold[p.user_id] || 0) + p.shares * prices[i];
      });
      return Object.values(demoState.users).map((u) => { const net = u.balance + (hold[u.id] || 0); return { id: u.id, name: u.name, avatar: u.avatar, color: u.color, net_worth: net, profit: net - u.start_balance, is_bot: u.is_bot }; }).sort((a, b) => b.net_worth - a.net_worth);
    },
    createMarket: async (b) => {
      const labels = b.type === 'binary' ? ['Yes', 'No'] : b.outcomes.filter((x) => x.trim());
      const outcomes = labels.map((label, i) => ({ id: makeId(), label, position: i, shares_outstanding: 0 }));
      const u = demoState.users[userId];
      const collateral = b.liquidity_param * Math.log(labels.length);
      if (collateral > u.balance + 1e-9) {
        throw new Error(t?.('insufficientBalance') || 'Insufficient balance');
      }
      u.balance -= collateral;
      const m = { id: makeId(), question: b.question, description: b.description || '', category: b.category, type: b.type, liquidity_param: b.liquidity_param, resolution_criteria: b.resolution_criteria || '', created_by: userId, created_at: new Date().toISOString(), close_date: b.close_date, volume: 0, status: 'open', resolved_outcome_id: null, outcomes, history: [{ t: new Date().toISOString(), values: labels.map(() => 1 / labels.length) }], recent_trades: [], comments: [] };
      demoState.markets.unshift(m);
      const out = marketOut(m, true);
      demoEmitter.emit({ type: 'market_created', market: marketOut(m) });
      return { ...out, balance: u.balance };
    },
    me: async () => demoState.users[userId],
  };
}

/* ============================ Realtime hook ============================ */
function useRealtime(mode, handlerRef) {
  const wsRef = useRef(null); const topics = useRef(new Set(['feed'])); const [status, setStatus] = useState('idle');
  useEffect(() => {
    if (mode === 'demo') { setStatus('demo'); startDemoBots(); return demoEmitter.on((e) => handlerRef.current && handlerRef.current(e)); }
    if (mode !== 'live') return undefined;
    let closed = false; let retry;
    const connect = () => {
      try {
        const ws = new WebSocket(WS_BASE); wsRef.current = ws;
        ws.onopen = () => { setStatus('open'); topics.current.forEach((t) => ws.send(JSON.stringify({ action: 'subscribe', topic: t }))); };
        ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type !== 'pong') handlerRef.current && handlerRef.current(m); } catch { /* ignore */ } };
        ws.onclose = () => { setStatus('closed'); if (!closed) retry = setTimeout(connect, 2500); };
        ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
      } catch { setStatus('closed'); }
    };
    connect();
    return () => { closed = true; clearTimeout(retry); try { wsRef.current && wsRef.current.close(); } catch { /* ignore */ } };
  }, [mode, handlerRef]);
  const subscribe = useCallback((t) => { topics.current.add(t); const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action: 'subscribe', topic: t })); }, []);
  const unsubscribe = useCallback((t) => { topics.current.delete(t); const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action: 'unsubscribe', topic: t })); }, []);
  return { status, subscribe, unsubscribe };
}

/* ============================ Small UI atoms ============================ */
const Spinner = ({ className = 'w-5 h-5' }) => <Loader2 className={`animate-spin ${className}`} />;
function Badge({ status, t }) {
  const map = {
    open: 'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-200',
    closed: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-200',
    resolved: 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  };
  const label = { open: t?.('open') || 'Open', closed: t?.('closed') || 'Closed', resolved: t?.('resolved') || 'Resolved' }[status];
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${map[status]}`}>{label}</span>;
}
function Avatar({ user, size = 'w-8 h-8' }) {
  if (!user) return null;
  return <div className={`${size} rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0`} style={{ background: user.color }}>{user.avatar}</div>;
}
function Money({ value, className = '' }) {
  return <span className={`inline-flex items-center gap-1 ${className}`}><Coins className="w-3.5 h-3.5 text-amber-500" />{money(value)}</span>;
}
function Modal({ open, onClose, children, title }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-md overflow-hidden" initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
              <h3 className="font-bold text-slate-800 dark:text-slate-100">{title}</h3>
              <button onClick={onClose} className="text-slate-400 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================ Chart ============================ */
function PriceChart({ market, history, t }) {
  const [isDark, setIsDark] = useState(() => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')));
  useEffect(() => {
    const handler = () => setIsDark(document.documentElement.classList.contains('dark'));
    window.addEventListener('theme-change', handler);
    window.addEventListener('storage', handler);
    return () => { window.removeEventListener('theme-change', handler); window.removeEventListener('storage', handler); };
  }, []);

  const colorFor = (label) => {
    const idx = market.outcomes.findIndex((o) => o.label === label) % LINE_COLORS.length;
    const base = market.type === 'binary' ? (label === 'Yes' ? '#10b981' : '#ef4444') : LINE_COLORS[idx];
    if (!isDark) return base;
    const darkMap = {
      '#6366f1': '#8b93ff',
      '#10b981': '#34d399',
      '#f59e0b': '#fbbf24',
      '#ef4444': '#fb7185',
      '#06b6d4': '#38bdf8',
      '#a855f7': '#c084fc',
    };
    return darkMap[base.toLowerCase()] || base;
  };
  const keys = market.type === 'binary'
    ? [(market.outcomes.find((o) => o.label === 'Yes') || market.outcomes[0]).label]
    : [...market.outcomes].sort((a, b) => b.price - a.price).slice(0, 4).map((o) => o.label);
  const data = (history || []).map((h) => {
    const row = { t: h.t }; market.outcomes.forEach((o, i) => { row[o.label] = +(h.values[i] * 100).toFixed(1); }); return row;
  });
  if (!data.length) return <div className="h-72 flex items-center justify-center text-slate-400 dark:text-slate-400 text-sm">{t?.('noPriceHistory') || 'No price history yet'}</div>;
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#0b1220' : '#f1f5f9'} />
          <XAxis dataKey="t" tickFormatter={fmtDay} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#94a3b8' }} interval="preserveStartEnd" minTickGap={40} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#94a3b8' }} width={50} />
          <Tooltip formatter={(v, n) => [`${v}%`, n]} labelFormatter={fmtDay} contentStyle={{ borderRadius: 12, border: `1px solid ${isDark ? '#1f2937' : '#e2e8f0'}`, fontSize: 12, backgroundColor: isDark ? '#071028' : '#fff', color: isDark ? '#cbd5e1' : undefined }} />
          {keys.map((k) => <Line key={k} type="monotone" dataKey={k} stroke={colorFor(k)} strokeWidth={2.5} dot={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ============================ Market card + list ============================ */
function MarketCard({ market, onOpen, t }) {
  const top = [...market.outcomes].sort((a, b) => b.price - a.price).slice(0, market.type === 'binary' ? 2 : 3);
  return (
    <motion.button layout onClick={() => onOpen(market.id)} whileHover={{ y: -3 }}
      className="group market-card text-left bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 p-5 hover:shadow-xl transition-all duration-200 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-indigo-600 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-900 px-2 py-0.5 rounded-full">{t?.(market.category) || market.category}</span>
        <Badge status={market.status} t={t} />
      </div>
      <h3 className="font-semibold text-slate-800 dark:text-slate-100 leading-snug line-clamp-2">{market.question}</h3>
      <div className="flex flex-col gap-1.5 mt-auto">
        {top.map((o) => {
          const c = market.type === 'binary' ? (o.label === 'Yes' ? '#10b981' : '#ef4444') : LINE_COLORS[market.outcomes.findIndex((x) => x.id === o.id) % LINE_COLORS.length];
          return (
            <div key={o.id} className="flex items-center gap-2 text-sm">
              <span className="w-20 truncate text-slate-600 dark:text-slate-400">{o.label}</span>
              <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${o.price * 100}%`, background: c }} />
              </div>
              <span className="w-10 text-right font-semibold text-slate-700 dark:text-slate-300">{pct(o.price)}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
        <span className="inline-flex items-center gap-1"><Activity className="w-3 h-3" /> Vol {money(market.volume)}</span>
        <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {market.status === 'resolved' ? t?.('settled') || 'Settled' : fromNow(market.close_date, t)}</span>
      </div>
    </motion.button>
  );
}

function MarketsView({ ctx, markets, loading, filters, setFilters, t }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <p className="text-xs uppercase tracking-[0.3em] text-indigo-600 font-semibold">{t?.('marketsHeading') || 'Markets'}</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t?.('marketsTitle') || 'Trade event outcomes in real time'}</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t?.('marketsSubtitle') || 'Filter by status, category, and momentum to find the markets you want to trade.'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <span className="text-slate-900 dark:text-slate-100">{markets.length}</span> {t?.('marketsCount', { count: markets.length }) || `${markets.length} markets`}
          </div>
          <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700">
            {t?.('statusLabel', { status: t?.(filters.status) || (filters.status.charAt(0).toUpperCase() + filters.status.slice(1)) }) || `${t?.(filters.status) || (filters.status.charAt(0).toUpperCase() + filters.status.slice(1))} status`}
          </div>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder={t?.('searchPlaceholder') || 'Search markets…'}
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        </div>
        <select value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}
          className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-sm bg-white dark:bg-slate-900">
          <option value="trending">{t?.('sortTrending') || 'Trending'}</option>
          <option value="newest">{t?.('sortNewest') || 'Newest'}</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {['open', 'closed', 'resolved'].map((s) => (
          <button key={s} onClick={() => setFilters((f) => ({ ...f, status: s }))}
            className={`h-10 px-4 rounded-full text-sm font-medium capitalize ${filters.status === s ? 'bg-slate-800 text-white' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 hover:border-slate-300 hover:text-slate-800'}`}>{t?.(s) || s}</button>
        ))}
        <div className="w-px h-8 bg-slate-200 dark:bg-slate-800 mx-1" />
        {['All', ...CATEGORIES].map((c) => (
          <button key={c} onClick={() => setFilters((f) => ({ ...f, category: c }))}
            className={`h-10 px-4 rounded-full text-sm ${filters.category === c ? 'bg-indigo-100 text-indigo-700 font-medium' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-500 hover:border-slate-300 hover:text-slate-700'}`}>{t?.(c) || c}</button>
        ))}
      </div>
      {loading ? (
        <div className="flex justify-center py-20 text-slate-400"><Spinner className="w-8 h-8" /></div>
      ) : markets.length === 0 ? (
        <div className="text-center py-20 text-slate-400">{t?.('noMarkets') || 'No markets match these filters.'}</div>
      ) : (
        <motion.div layout className="market-grid gap-4 grid">
          {markets.map((m) => <MarketCard key={m.id} market={m} onOpen={ctx.openMarket} t={t} />)}
        </motion.div>
      )}
    </div>
  );
}

/* ============================ Trade panel ============================ */
function TradePanel({ ctx, market, t }) {
  const [outcomeId, setOutcomeId] = useState(market.outcomes[0].id);
  const [side, setSide] = useState('buy');
  const [shares, setShares] = useState(10);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const held = (ctx.portfolio?.positions || []).find((p) => p.outcome_id === outcomeId)?.shares || 0;
  const open = market.status === 'open';

  useEffect(() => { setOutcomeId(market.outcomes[0].id); }, [market.id]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try { const q = await ctx.ds.quote({ market, outcome_id: outcomeId, side, shares: Number(shares) || 0, balance: ctx.user?.balance, held }); if (alive) setQuote(q); }
      catch { if (alive) setQuote(null); }
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [outcomeId, side, shares, market, ctx.user?.balance, held]);

  const submit = async () => {
    if (!ctx.user) { ctx.requireAuth(); return; }
    setBusy(true);
    try {
      const res = await ctx.ds.trade({ market_id: market.id, outcome_id: outcomeId, side, shares: Number(shares) });
      ctx.setUserBalance(res.balance, res.realized_pnl);
      ctx.applyPrices(market.id, res.prices, res.market_volume);
      ctx.refreshPortfolio();
      ctx.toast('success', t?.('tradeSuccess', { action: t(side === 'buy' ? 'bought' : 'sold'), shares: nf.format(res.trade.shares), outcome: res.trade.outcome_label, price: pct1(res.trade.price) }) || `${side === 'buy' ? 'Bought' : 'Sold'} ${nf.format(res.trade.shares)} ${res.trade.outcome_label} @ ${pct1(res.trade.price)}`);
    } catch (e) { ctx.toast('error', getErrorMessage(e, t)); }
    finally { setBusy(false); }
  };

  const sel = market.outcomes.find((o) => o.id === outcomeId);
  const err = quote?.error;
  const disabled = busy || !open || !!err || !Number(shares);

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 space-y-3">
      <h3 className="font-bold text-slate-800 dark:text-slate-100">{t?.('tradeHeading') || 'Trade'}</h3>
      <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
        {['buy', 'sell'].map((s) => (
          <button key={s} onClick={() => setSide(s)}
            className={`py-1.5 rounded-lg text-sm font-semibold capitalize ${side === s ? (s === 'buy' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white') : 'text-slate-500 dark:text-slate-300'}`}>{t?.(s) || s}</button>
        ))}
      </div>
      <div className="space-y-1.5">
        {market.outcomes.map((o) => (
          <button key={o.id} onClick={() => setOutcomeId(o.id)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border text-sm ${outcomeId === o.id ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900' : 'border-slate-200 dark:border-slate-700'}`}>
            <span className="font-medium text-slate-700 dark:text-slate-300 truncate">{o.label}</span>
            <span className="font-bold text-slate-800 dark:text-slate-100">{pct1(o.price)}</span>
          </button>
        ))}
      </div>
      <div>
        <div className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-400 mb-1">
          <span>{t?.('shares') || 'Shares'}</span>
          <button className="text-indigo-600 font-medium" onClick={() => {
            if (side === 'sell') setShares(Math.floor(held));
            else if (ctx.user) setShares(maxAffordable(market.outcomes.map((o) => o.shares_outstanding), market.liquidity_param, market.outcomes.indexOf(sel), ctx.user.balance));
          }}>{t?.('max') || 'Max'}</button>
        </div>
        <input type="number" min="0" value={shares} onChange={(e) => setShares(e.target.value)}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-400" />
      </div>
      {quote && !err && (
        <div className="text-sm space-y-1 bg-slate-50 dark:bg-slate-800 rounded-xl p-3">
          <Row k={t?.('priceImpact') || 'Price impact'} v={`${pct1(quote.cur_price)} → ${pct1(quote.new_price)}`} />
          <Row k={t?.('avgFill') || 'Avg fill'} v={pct1(quote.avg_price)} />
          {side === 'buy'
            ? <><Row k={t?.('cost') || 'Cost'} v={<Money value={quote.cost} />} /><Row k={t?.('maxPayout') || 'Max payout'} v={<Money value={quote.max_payout} />} highlight /></>
            : <Row k={t?.('youReceive') || 'You receive'} v={<Money value={quote.proceeds} />} highlight />}
        </div>
      )}
      {err && <div className="text-sm text-rose-600 dark:text-rose-400 flex items-center gap-1.5"><AlertCircle className="w-4 h-4" />{err}</div>}
      {!open && <div className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1.5"><Clock className="w-4 h-4" />{t?.('marketStatusIs', { status: t?.(market.status) || market.status }) || `Market is ${market.status}`}</div>}
      <button onClick={submit} disabled={disabled}
        className={`w-full py-2.5 rounded-xl font-semibold text-white flex items-center justify-center gap-2 ${disabled ? 'bg-slate-300' : side === 'buy' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-rose-500 hover:bg-rose-600'}`}>
        {busy ? <Spinner /> : !ctx.user ? <><LogIn className="w-4 h-4" /> {t?.('signInToTrade') || 'Sign in to trade'}</> : <>{t?.(side === 'buy' ? 'buy' : 'sell') || (side === 'buy' ? 'Buy' : 'Sell')} {sel?.label}</>}
      </button>
    </div>
  );
}
const Row = ({ k, v, highlight }) => (
  <div className="flex items-center justify-between">
    <span className="text-slate-500 dark:text-slate-400">{k}</span>
    <span className={highlight ? 'font-bold text-slate-800 dark:text-slate-100' : 'font-medium text-slate-700 dark:text-slate-300'}>{v}</span>
  </div>
);

/* ============================ Market detail ============================ */
function ResolvePanel({ ctx, market, t }) {
  const [busy, setBusy] = useState(false);
  if (!ctx.user || !(ctx.user.is_admin || market.created_by === ctx.user.id) || market.status === 'resolved') return null;
  const resolve = async (oid) => {
    setBusy(true);
    try {
      const res = await ctx.ds.resolve(market.id, oid);
      if (res.balance != null) ctx.setUserBalance(res.balance, res.realized_pnl);
      ctx.refreshPortfolio();
      if (res.maker_refund != null) {
        ctx.toast('success', t?.('resolveRefunded', { amount: money(res.maker_refund) }) || `Market resolved & refunded ${money(res.maker_refund)} to the maker`);
      } else {
        ctx.toast('success', t?.('resolvePaidOut') || 'Market resolved & paid out');
      }
    } catch (e) { ctx.toast('error', getErrorMessage(e, t)); }
    finally { setBusy(false); }
  };
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-amber-200 dark:border-amber-700 p-4 space-y-2">
      <h3 className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-amber-500" /> {t?.('resolveHeading') || 'Resolve (admin / creator)'}</h3>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t?.('resolveHint') || 'Pick the winning outcome. Each winning share pays 1.00 credit.'}</p>
      <div className="flex flex-wrap gap-2">
        {market.outcomes.map((o) => (
          <button key={o.id} disabled={busy} onClick={() => resolve(o.id)}
            className="px-3 py-1.5 rounded-xl border border-slate-200 text-sm font-medium hover:bg-amber-50 hover:border-amber-300">{o.label}</button>
        ))}
      </div>
    </div>
  );
}

function MarketDetailView({ ctx, detail, onBack, t }) {
  const [comment, setComment] = useState('');
  if (!detail) return <div className="flex justify-center py-20 text-slate-400"><Spinner className="w-8 h-8" /></div>;
  const winner = detail.resolved_outcome_id && detail.outcomes.find((o) => o.id === detail.resolved_outcome_id);
  const addComment = async () => {
    if (!ctx.user) { ctx.requireAuth(); return; }
    if (!comment.trim()) return;
    try { await ctx.ds.addComment(detail.id, comment.trim()); setComment(''); }
    catch (e) { ctx.toast('error', getErrorMessage(e, t)); }
  };
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1"><ChevronRight className="w-4 h-4 rotate-180" /> {t?.('backToMarkets') || 'Back to markets'}</button>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{t?.(detail.category) || detail.category}</span>
              <Badge status={detail.status} t={t} />
              <span className="text-xs text-slate-400 ml-auto">{detail.status === 'resolved' ? t?.('settled') || 'Settled' : t?.('closes', { time: fromNow(detail.close_date, t) }) || `Closes ${fromNow(detail.close_date, t)}`}</span>
            </div>
            <h1 className="text-xl font-bold text-slate-800">{detail.question}</h1>
            {detail.description && <p className="text-sm text-slate-500 mt-2">{detail.description}</p>}
            {winner && (
              <div className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-xl">
                <CheckCircle2 className="w-4 h-4" /> {t?.('resolved') || 'Resolved'}: {winner.label}
              </div>
            )}
          </div>
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
            <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-indigo-500" /> {t?.('priceHistory') || 'Price history'}</h3>
            <PriceChart market={detail} history={detail.history} t={t} />
          </div>
          {detail.resolution_criteria && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
              <h3 className="font-bold text-slate-800 mb-1">{t?.('resolutionCriteriaHeading') || 'Resolution criteria'}</h3>
              <p className="text-sm text-slate-500 break-words [overflow-wrap:anywhere]">{detail.resolution_criteria}</p>
            </div>
          )}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
            <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2"><MessageSquare className="w-4 h-4 text-indigo-500" /> {t?.('discussion') || 'Discussion'}</h3>
            <div className="flex gap-2 mb-4">
              <input value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addComment()}
                placeholder={ctx.user ? (t?.('addCommentPlaceholder') || 'Add a comment…') : (t?.('signInToComment') || 'Sign in to comment')} className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
              <button onClick={addComment} className="px-3 rounded-xl bg-indigo-500 text-white hover:bg-indigo-600"><Send className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              {(detail.comments || []).length === 0 && <p className="text-sm text-slate-400">{t?.('noComments') || 'No comments yet.'}</p>}
              {(detail.comments || []).map((c) => (
                <div key={c.id} className="flex gap-2.5">
                  <Avatar user={c.user} />
                  <div>
                    <div className="text-sm"><span className="font-semibold text-slate-700">{c.user.name}</span> <span className="text-xs text-slate-400">{fromNow(c.created_at, t)}</span></div>
                    <p className="text-sm text-slate-600">{c.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <TradePanel ctx={ctx} market={detail} t={t} />
          <ResolvePanel ctx={ctx} market={detail} t={t} />
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
            <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-indigo-500" /> {t?.('recentTrades') || 'Recent trades'}</h3>
            <div className="space-y-2">
              {(detail.recent_trades || []).length === 0 && <p className="text-sm text-slate-400">{t?.('noTrades') || 'No trades yet.'}</p>}
              {(detail.recent_trades || []).map((t) => {
                const u = tradeUser(t);
                return (
                  <div key={t.id} className="flex items-center gap-2 text-sm">
                    <Avatar user={u} size="w-6 h-6" />
                    <span className="font-medium text-slate-600 truncate flex-1">{u.name}</span>
                    <span className={`inline-flex items-center gap-0.5 font-semibold ${t.side === 'buy' ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {t.side === 'buy' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}{nf.format(t.shares)}
                    </span>
                    <span className="text-slate-400 truncate max-w-16">{t.outcome_label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ Portfolio + leaderboard ============================ */
function PortfolioView({ ctx, t }) {
  const [data, setData] = useState(null); const [trades, setTrades] = useState([]); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try { const [p, trades] = await Promise.all([ctx.ds.portfolio(), ctx.ds.myTrades()]); if (alive) { setData(p); setTrades(trades); } }
      catch (e) { ctx.toast('error', getErrorMessage(e, t)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [ctx.portfolioVersion]);
  if (loading) return <div className="flex justify-center py-20 text-slate-400"><Spinner className="w-8 h-8" /></div>;
  if (!data) return <div className="text-center py-20 text-slate-400">{t?.('signInToViewPortfolio') || 'Sign in to view your portfolio.'}</div>;
  const stats = [
    { label: t?.('netWorth') || 'Net worth', value: data.net_worth, icon: Wallet },
    { label: t?.('cash') || 'Cash', value: data.cash, icon: Coins },
    { label: t?.('positions') || 'Positions', value: data.positions_value, icon: BarChart3 },
    { label: t?.('unrealizedPnl') || 'Unrealized P&L', value: data.unrealized_pnl, icon: TrendingUp, pnl: true },
    { label: t?.('realizedPnl') || 'Realized P&L', value: data.realized_pnl, icon: CheckCircle2, pnl: true },
  ];
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-indigo-600 font-semibold">{t?.('portfolioHeading') || 'Portfolio'}</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{t?.('portfolioTitle') || 'Your account snapshot'}</h2>
          </div>
          <div className="rounded-2xl bg-slate-100 px-4 py-2 text-sm text-slate-700">{t?.('portfolioPositionsCount', { count: data.positions.length }) || `Tracked across ${data.positions.length} open positions`}</div>
        </div>
        <p className="max-w-2xl text-sm text-slate-500">{t?.('portfolioSubtitle') || 'View your total value, cash balance, and recent activity. Tap a position to jump back into the market.'}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs text-slate-400"><s.icon className="w-3.5 h-3.5" />{s.label}</div>
            <div className={`text-xl font-bold mt-3 ${s.pnl ? (s.value >= 0 ? 'text-emerald-600' : 'text-rose-600') : 'text-slate-900'}`}>
              {s.pnl && s.value >= 0 ? '+' : ''}{money(s.value)}
            </div>
          </div>
        ))}
      </div>
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800">{t?.('openPositions') || 'Open positions'}</h3>
            <p className="text-sm text-slate-500">{t?.('openPositionsSubtitle') || 'Tap to open the market and manage your exposure.'}</p>
          </div>
          <span className="text-sm text-slate-400">{t?.('entriesCount', { count: data.positions.length }) || `${data.positions.length} entries`}</span>
        </div>
        {data.positions.length === 0 ? <p className="px-5 py-10 text-sm text-slate-400">{t?.('noOpenPositions') || 'No open positions.'}</p> : (
          <div className="overflow-x-auto">
            <div className="min-w-[680px] divide-y divide-slate-100">
              {data.positions.map((p) => (
                <button key={p.outcome_id} onClick={() => ctx.openMarket(p.market_id)} className="w-full text-left px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{p.question}</div>
                    <div className="mt-1 text-xs text-slate-500">{nf.format(p.shares)} × {p.outcome_label} @ {pct1(p.avg_price)} → {pct1(p.cur_price)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-slate-900">{money(p.value)}</div>
                    <div className={`text-xs font-medium ${p.unrealized_pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{p.unrealized_pnl >= 0 ? '+' : ''}{money(p.unrealized_pnl)}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {trades.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-800">{t?.('recentActivity') || 'Recent activity'}</h3>
              <p className="text-sm text-slate-500">{t?.('recentActivitySubtitle') || 'Latest trades from your account.'}</p>
            </div>
            <span className="text-sm text-slate-400">{t?.('recordsCount', { count: trades.length }) || `${trades.length} records`}</span>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[680px] divide-y divide-slate-100">
              {trades.slice(0, 12).map((t) => (
                <div key={t.id} className="px-5 py-3 flex items-center justify-between gap-4 text-sm">
                  <div className="min-w-0">
                    <span className={`font-semibold capitalize ${t.side === 'buy' ? 'text-emerald-600' : 'text-rose-600'}`}>{t.side}</span>
                    <span className="text-slate-600"> {nf.format(t.shares)} {t.outcome_label}</span>
                    <span className="text-slate-400 truncate"> · {t.question}</span>
                  </div>
                  <span className="text-slate-500 shrink-0">{pct1(t.price)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LeaderboardView({ ctx, t }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { let a = true; ctx.ds.leaderboard().then((r) => a && setRows(r)).catch(() => a && setRows([])); return () => { a = false; }; }, [ctx.portfolioVersion]);
  if (!rows) return <div className="flex justify-center py-20 text-slate-400"><Spinner className="w-8 h-8" /></div>;
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden max-w-4xl mx-auto">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-sm text-slate-500">
              <Trophy className="w-4 h-4 text-amber-500" />
              <span>{t?.('leaderboardHeading') || 'Leaderboard'}</span>
            </div>
            <h3 className="text-2xl font-bold text-slate-900">{t?.('leaderboardTitle') || 'Top traders'}</h3>
          </div>
          <p className="text-sm text-slate-500 max-w-xl">{t?.('leaderboardSubtitle') || 'See the highest net worth traders and their realized profits. The list updates as trades happen.'}</p>
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map((r, i) => (
          <div key={r.id} className="px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4">
              <span className={`w-8 text-center text-sm font-semibold ${i < 3 ? 'text-amber-500' : 'text-slate-400'}`}>{i + 1}</span>
              <div className="flex items-center gap-3 min-w-0">
                <Avatar user={r} />
                <div className="min-w-0">
                  <div className="font-semibold text-slate-800 truncate">{r.name}</div>
                  <div className="text-xs text-slate-500">{r.is_bot ? (t?.('botTrader') || 'bot trader') : (t?.('humanTrader') || 'human trader')}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold text-slate-800">{money(r.net_worth)}</div>
                <div className={`text-xs ${r.profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.profit >= 0 ? '+' : ''}{money(r.profit)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================ Create market + auth modals ============================ */
function toLocalInput(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function CreateMarketModal({ ctx, open, onClose, t }) {
  const [f, setF] = useState({ question: '', description: '', category: 'Other', type: 'binary', liquidity_param: 150, resolution_criteria: '' });
  const [outcomes, setOutcomes] = useState(['', '']);
  const [close, setClose] = useState(toLocalInput(new Date(Date.now() + 7 * DAY)));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!ctx.user) { ctx.requireAuth(); return; }
    setBusy(true);
    try {
      const m = await ctx.ds.createMarket({ ...f, liquidity_param: Number(f.liquidity_param), close_date: new Date(close).toISOString(), outcomes: f.type === 'categorical' ? outcomes : [] });
      if (typeof m.balance === 'number') {
        ctx.setUserBalance(m.balance, m.realized_pnl);
      }
      ctx.toast('success', t('marketCreated')); onClose(); ctx.openMarket(m.id);
    } catch (e) { ctx.toast('error', getErrorMessage(e, t)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t('createMarketTitle')}>
      <div className="space-y-3">
        <input value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} placeholder={t('questionPlaceholder')}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('descriptionPlaceholder')} rows={2}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        <div className="grid grid-cols-2 gap-2">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-sm bg-white dark:bg-slate-900">
            {CATEGORIES.map((c) => <option key={c} value={c}>{t?.(c) || c}</option>)}
          </select>
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-sm bg-white dark:bg-slate-900">
            <option value="binary">Binary (Yes/No)</option>
            <option value="categorical">Categorical</option>
          </select>
        </div>
        {f.type === 'categorical' && (
          <div className="space-y-2">
            {outcomes.map((o, i) => (
              <div key={i} className="flex gap-2">
                <input value={o} onChange={(e) => setOutcomes(outcomes.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`${t('outcomePlaceholder')} ${i + 1}`}
                  className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm" />
                {outcomes.length > 2 && <button onClick={() => setOutcomes(outcomes.filter((_, j) => j !== i))} className="px-2 text-slate-400"><X className="w-4 h-4" /></button>}
              </div>
            ))}
            <button onClick={() => setOutcomes([...outcomes, ''])} className="text-sm text-indigo-600 font-medium">{t('addOutcome')}</button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-slate-500">{t('closeDate')}
            <input type="datetime-local" value={close} onChange={(e) => setClose(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          </label>
          <label className="text-xs text-slate-500">{t('liquidity')}
            <input type="number" value={f.liquidity_param} onChange={(e) => setF({ ...f, liquidity_param: e.target.value })} className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          </label>
        </div>
        <input value={f.resolution_criteria} onChange={(e) => setF({ ...f, resolution_criteria: e.target.value })} placeholder={t('resolutionCriteria')}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        <button onClick={submit} disabled={busy || f.question.length < 8} className={`w-full py-2.5 rounded-xl font-semibold text-white flex items-center justify-center gap-2 ${busy || f.question.length < 8 ? 'bg-slate-300' : 'bg-indigo-500 hover:bg-indigo-600'}`}>
          {busy ? <Spinner /> : <><Plus className="w-4 h-4" /> {t('createMarket')}</>}
        </button>
      </div>
    </Modal>
  );
}

function AuthModal({ ctx, open, onClose, t }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState(ctx.dsMode === 'demo' ? 'You' : '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(ctx.dsMode === 'demo' ? 'demo1234' : '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('login');
    setName(ctx.dsMode === 'demo' ? 'You' : '');
    setEmail('');
    setPassword(ctx.dsMode === 'demo' ? 'demo1234' : '');
    setBusy(false);
  }, [open, ctx.dsMode]);

  const submit = async () => {
    setBusy(true);
    try { await ctx.doAuth(mode, { name, email, password }); onClose(); }
    catch (e) { ctx.toast('error', getErrorMessage(e, t)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={mode === 'login' ? t('login') : t('register')}>
      <div className="space-y-3">
        {ctx.dsMode === 'demo' && <div className="text-xs bg-amber-50 text-amber-700 rounded-xl px-3 py-2">{t('demoHint')}</div>}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('username')} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        {mode === 'register' && <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('email')} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={t('password')} className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        <button onClick={submit} disabled={busy} className="w-full py-2.5 rounded-xl font-semibold text-white bg-indigo-500 hover:bg-indigo-600 flex items-center justify-center gap-2">
          {busy ? <Spinner /> : mode === 'login' ? t('login') : t('register')}
        </button>
        <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
  className="w-full text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:underline dark:text-indigo-400 dark:hover:text-indigo-300">
  {mode === 'login' ? t('registerSwitch') : t('loginSwitch')}
</button>
      </div>
    </Modal>
  );
}

/* ============================ App ============================ */
export default function App() {
  const [mode, setMode] = useState('connecting'); // connecting | live | demo
  const [token, setToken] = useState(null);
  const [language, setLanguage] = useState(getInitialLanguage);
  const [user, setUser] = useState(null);
  const [view, setView] = useState({ name: 'markets' });
  const [markets, setMarkets] = useState([]);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [filters, setFilters] = useState({ status: 'open', category: 'All', q: '', sort: 'trending' });
  const [detail, setDetail] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [portfolioVersion, setPortfolioVersion] = useState(0);
  const [authOpen, setAuthOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => {
    try { return document.documentElement.classList.contains('dark') ? 'dark' : 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    const handler = () => setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('forecast-language', language);
  }, [language]);

  const t = useCallback((key, fallbackOrParams, params) => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : null;
    const values = typeof fallbackOrParams === 'object' && fallbackOrParams !== null ? fallbackOrParams : params || {};
    return translate(language, key, fallback, values);
  }, [language]);

  const toast = useCallback((type, msg) => {
    const id = makeId(); setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const ds = useMemo(() => (mode === 'demo' ? makeDemoDS(demoState.you.id, t) : makeLiveDS(token, t)), [mode, token, t]);

  /* connection probe */
  useEffect(() => {
    let alive = true;
    (async () => { try { await http('/config', { timeout: 2500 }); if (alive) setMode('live'); } catch { if (alive) setMode('demo'); } })();
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (mode === 'demo' && !user) { setUser(demoState.you); setToken('demo'); } }, [mode]); // eslint-disable-line

  /* market list */
  const loadMarkets = useCallback(async () => {
    setLoadingMarkets(true);
    try { setMarkets(await ds.listMarkets({ status: filters.status, category: filters.category, q: filters.q, sort: filters.sort, limit: 60 })); }
    catch (e) { toast('error', getErrorMessage(e, t)); }
    finally { setLoadingMarkets(false); }
  }, [ds, filters, toast]);
  useEffect(() => { if (mode !== 'connecting') loadMarkets(); }, [mode, filters, loadMarkets]);

  const refreshPortfolio = useCallback(async () => {
    if (!user) { setPortfolio(null); return; }
    try { setPortfolio(await ds.portfolio()); setPortfolioVersion((v) => v + 1); } catch { /* ignore */ }
  }, [ds, user]);
  useEffect(() => { refreshPortfolio(); }, [user, mode]); // eslint-disable-line

  const applyPrices = useCallback((marketId, prices, volume) => {
    const byId = Object.fromEntries(prices.map((p) => [p.outcome_id, p]));
    const patch = (o) => byId[o.id] ? { ...o, price: byId[o.id].price, shares_outstanding: byId[o.id].shares_outstanding ?? o.shares_outstanding } : o;
    setMarkets((ms) => ms.map((m) => m.id === marketId ? { ...m, outcomes: m.outcomes.map(patch), volume: volume ?? m.volume } : m));
    setDetail((d) => d && d.id === marketId ? { ...d, outcomes: d.outcomes.map(patch), volume: volume ?? d.volume } : d);
  }, []);

  /* realtime event handler */
  const handleEvent = useCallback((e) => {
    if (e.type === 'market_update') {
      applyPrices(e.market_id, e.prices, e.volume);
      setDetail((d) => {
        if (!d || d.id !== e.market_id) return d;
        const existing = d.recent_trades || [];
        const trades = e.trade && !existing.some((t) => t.id === e.trade.id)
          ? [e.trade, ...existing].slice(0, 20)
          : existing;
        const latestHistory = d.history?.[d.history.length - 1];
        const nextPoint = { t: e.trade?.created_at || new Date().toISOString(), values: e.prices.map((p) => p.price) };
        const history = latestHistory?.t === nextPoint.t
          ? d.history
          : [...(d.history || []), nextPoint].slice(-200);
        return { ...d, recent_trades: trades, history };
      });
    } else if (e.type === 'market_resolved') {
      const byId = Object.fromEntries(e.prices.map((p) => [p.outcome_id, p.price]));
      const patch = (o) => ({ ...o, price: byId[o.id] ?? o.price });
      setMarkets((ms) => ms.map((m) => m.id === e.market_id ? { ...m, status: 'resolved', resolved_outcome_id: e.resolved_outcome_id, outcomes: m.outcomes.map(patch) } : m));
      setDetail((d) => d && d.id === e.market_id ? { ...d, status: 'resolved', resolved_outcome_id: e.resolved_outcome_id, outcomes: d.outcomes.map(patch) } : d);
    } else if (e.type === 'market_created') {
      const m = e.market;
      const ok = (filters.status === 'All' || m.status === filters.status) && (filters.category === 'All' || m.category === filters.category);
      if (ok) setMarkets((ms) => [m, ...ms.filter((x) => x.id !== m.id)]);
    } else if (e.type === 'comment') {
      setDetail((d) => d && d.id === e.market_id ? { ...d, comments: [{ id: e.id, text: e.text, created_at: e.created_at, user: e.user }, ...(d.comments || [])] } : d);
    }
  }, [applyPrices, filters]);
  const handlerRef = useRef(handleEvent);
  useEffect(() => { handlerRef.current = handleEvent; }, [handleEvent]);
  const rt = useRealtime(mode === 'connecting' ? 'idle' : mode, handlerRef);

  /* per-market subscription */
  useEffect(() => {
    if (view.name === 'market' && detail?.id) { rt.subscribe(`market:${detail.id}`); return () => rt.unsubscribe(`market:${detail.id}`); }
    return undefined;
  }, [view.name, detail?.id, rt]);

  const openMarket = useCallback(async (id) => {
    setView({ name: 'market', id }); setDetail(null);
    try { setDetail(await ds.getMarket(id)); } catch (e) { toast('error', getErrorMessage(e, t)); }
  }, [ds, toast]);

  const doAuth = useCallback(async (kind, { name, email, password }) => {
    if (mode === 'demo') {
      const u = Object.values(demoState.users).find((x) => x.name === name) || demoState.you;
      setUser(u); setToken('demo'); toast('success', t?.('signedInAs', { name: u.name }) || `Signed in as ${u.name}`); return;
    }
    const tok = kind === 'login' ? (await loginHttp(name, password)).access_token : (await http('/auth/register', { method: 'POST', body: { name, email: email || null, password } })).access_token;
    setToken(tok);
    const me = await http('/auth/me', { headers: { Authorization: `Bearer ${tok}` } });
    setUser(me); toast('success', t?.('welcome', { name: me.name }) || `Welcome, ${me.name}`);
  }, [mode, toast]);

  const logout = () => {
    setUser(mode === 'demo' ? demoState.you : null);
    setToken(mode === 'demo' ? 'demo' : null);
    setPortfolio(null);
    setView({ name: 'markets' });
    setAuthOpen(true);
  };

  const ctx = {
    ds, dsMode: mode, user, portfolio, portfolioVersion, openMarket, toast, refreshPortfolio, applyPrices, doAuth,
    requireAuth: () => setAuthOpen(true),
    setUserBalance: (bal, realized) => setUser((u) => u ? { ...u, balance: bal, realized_pnl: realized ?? u.realized_pnl } : u),
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      {/* connection banner */}
      {mode === 'demo' && (
        <div className="bg-amber-500 text-white text-sm px-4 py-3 flex items-center justify-center gap-3 flex-wrap">
          <WifiOff className="w-4 h-4" /> {t('demoBanner')}
          <span className="rounded-full bg-white/15 dark:bg-white/10 px-2 py-0.5 text-[0.75rem] font-semibold">
            {backendAccessMode}
          </span>
          <button onClick={() => { setMode('connecting'); http('/config', { timeout: 2500 }).then(() => setMode('live')).catch(() => setMode('demo')); }} className="underline font-semibold">{t('retry')}</button>
        </div>
      )}

      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 header-shadow">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 justify-between min-w-0">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button onClick={() => setView({ name: 'markets' })} className="flex items-center gap-2 font-bold text-slate-800 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-indigo-500 flex items-center justify-center text-white"><Sparkles className="w-4 h-4" /></div>
              ForeCast
            </button>
            {mode !== 'connecting' && (
              <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${mode === 'live' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                {mode === 'live' ? <><Wifi className="w-3.5 h-3.5" /> {t('live')}</> : <><WifiOff className="w-3.5 h-3.5" /> {t('demo')}</>}
              </span>
            )}
            {!import.meta.env.PROD && (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[0.65rem] text-slate-600 break-words whitespace-normal" title={API_BASE}>
                API host: {API_BASE.replace(/^https?:\/\//, '')}
                <span className={`ml-2 rounded-full px-2 py-0.5 text-[0.65rem] font-semibold ${usingDevProxy ? 'bg-indigo-50 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-200' : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
                  {backendAccessMode}
                </span>
              </span>
            )}
          </div>
          <nav className="hidden sm:flex items-center gap-2 ml-2">
            {[['markets', t('markets'), TrendingUp], ['portfolio', t('portfolio'), Wallet], ['leaderboard', t('leaderboard'), Trophy]].map(([k, label, Icon]) => (
              <button key={k} onClick={() => setView({ name: k })} className={`px-4 py-2 rounded-2xl text-sm font-medium flex items-center gap-2 ${view.name === k ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                <Icon className="w-4 h-4" />{label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex flex-1 min-w-0 flex-wrap items-center justify-end gap-2">
            {mode === 'live' && <span className="hidden sm:inline-flex items-center gap-1 text-xs text-emerald-600"><Wifi className="w-3.5 h-3.5" />{rt.status === 'open' ? t('live') : t('connecting')}</span>}
            <label className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-2 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
              <span className="hidden sm:inline">{t('selectLanguage')}</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="bg-slate-900 text-sm font-medium outline-none text-slate-100 dark:bg-slate-900 dark:text-slate-100">
                {SUPPORTED_LANGUAGES.map((code) => <option key={code} value={code} className="bg-slate-900 text-slate-100 dark:bg-slate-900 dark:text-slate-100">{LANGUAGE_LABELS[code]}</option>)}
              </select>
            </label>
            <button onClick={() => {
              try {
                const isDark = document.documentElement.classList.toggle('dark');
                document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
                setTheme(isDark ? 'dark' : 'light');
                // notify other components in this window about the theme change
                try { window.dispatchEvent(new Event('theme-change')); } catch (e) { /* ignore */ }
              } catch (e) { /* ignore */ }
            }} title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700">
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button onClick={() => setCreateOpen(true)} className="px-4 py-2 rounded-2xl bg-indigo-500 text-white text-sm font-medium flex items-center gap-2 hover:bg-indigo-600 shadow-sm small-nav-button"><Plus className="w-4 h-4" /><span className="hidden sm:inline">{t('new')}</span></button>
            {user ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="hidden sm:inline-flex"><Money value={user.balance} className="text-sm font-semibold text-slate-700" /></span>
                <Avatar user={user} />
                <button onClick={logout} className="text-slate-400 hover:text-slate-600"><LogOut className="w-4 h-4" /></button>
              </div>
            ) : (
              <button onClick={() => setAuthOpen(true)} className="px-4 py-2 rounded-2xl border border-slate-200 text-sm font-medium flex items-center gap-2 small-nav-button"><LogIn className="w-4 h-4" />{t('signIn')}</button>
            )}
          </div>
        </div>
        <nav className="sm:hidden flex border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          {[['markets', t('markets'), TrendingUp], ['portfolio', t('portfolio'), Wallet], ['leaderboard', t('leaderboard'), Trophy]].map(([k, label, Icon]) => (
            <button key={k} onClick={() => setView({ name: k })} className={`flex-1 min-w-[84px] py-2.5 text-xs font-semibold inline-flex flex-col items-center justify-center gap-1 ${view.name === k ? 'text-indigo-600 border-b-2 border-indigo-500 bg-indigo-50' : 'text-slate-500 hover:text-slate-700'}`}>
              <Icon className="w-4 h-4" />
              <span className="leading-none">{label}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-10">
        {mode === 'connecting' ? (
          <div className="flex flex-col items-center py-24 text-slate-400 gap-3"><Spinner className="w-8 h-8" /><span className="text-sm">{t('connecting')}</span></div>
        ) : view.name === 'markets' ? (
          <div className="panel-card p-6">
            <MarketsView ctx={ctx} markets={markets} loading={loadingMarkets} filters={filters} setFilters={setFilters} t={t} />
          </div>
        ) : view.name === 'market' ? (
          <MarketDetailView ctx={ctx} detail={detail} onBack={() => setView({ name: 'markets' })} t={t} />
        ) : view.name === 'portfolio' ? (
          <PortfolioView ctx={ctx} t={t} />
        ) : (
          <LeaderboardView ctx={ctx} t={t} />
        )}
      </main>

      <CreateMarketModal ctx={ctx} open={createOpen} onClose={() => setCreateOpen(false)} t={t} />
      <AuthModal ctx={ctx} open={authOpen} onClose={() => setAuthOpen(false)} t={t} />

      {/* toasts */}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
              className={`px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2 ${t.type === 'error' ? 'bg-rose-500' : 'bg-emerald-500'}`}>
              {t.type === 'error' ? <AlertCircle className="w-4 h-4" /> : <Check className="w-4 h-4" />}{t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
