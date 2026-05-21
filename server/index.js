import cors from 'cors';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'stats.json');
const port = Number(process.env.PORT || 8787);
const adminPassword = process.env.ADMIN_PASSWORD || '';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const defaultDb = {
  referrals: [],
  walletBindings: [],
  trades: [],
  settlements: []
};

async function readDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(dbPath, 'utf8');
    return { ...defaultDb, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeDb(defaultDb);
    return structuredClone(defaultDb);
  }
}

async function writeDb(db) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeAddress(address) {
  if (typeof address !== 'string') return '';
  return address.trim().toLowerCase();
}

function requireAdmin(req, res, next) {
  if (!adminPassword) return res.status(503).json({ error: 'ADMIN_PASSWORD is not configured' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token === adminPassword) return next();
  return res.status(401).json({ error: 'ADMIN_PASSWORD required' });
}

function publicReferral(referral, req) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return {
    ...referral,
    url: `${baseUrl}/?ref=${encodeURIComponent(referral.code)}`
  };
}

function normalizeReferral(referral) {
  const referrerWallet = normalizeAddress(referral.referrerWallet || referral.name);
  return {
    ...referral,
    referrerWallet: /^0x[a-f0-9]{40}$/.test(referrerWallet) ? referrerWallet : ''
  };
}

const commissionRate = Number(process.env.COMMISSION_RATE || 0.01);

function tradeVolume(trade) {
  if (trade.side !== 'buy') return 0;
  return Number(trade.usdtAmount || 0);
}

function isTradeSettled(db, tradeId) {
  return db.settlements.some((settlement) => Array.isArray(settlement.tradeIds) && settlement.tradeIds.includes(tradeId));
}

function summarize(db) {
  const byReferral = new Map();
  for (const referral of db.referrals) {
    const normalizedReferral = normalizeReferral(referral);
    byReferral.set(referral.code, {
      code: referral.code,
      name: normalizedReferral.name,
      referrerWallet: normalizedReferral.referrerWallet,
      createdAt: referral.createdAt,
      wallets: 0,
      buyUsdt: 0,
      sellUsdt: 0,
      totalUsdt: 0,
      unsettledUsdt: 0,
      commissionUsdt: 0,
      unsettledCommissionUsdt: 0,
      tradeCount: 0
    });
  }

  for (const binding of db.walletBindings) {
    const item = byReferral.get(binding.ref);
    if (item) item.wallets += 1;
  }

  for (const trade of db.trades) {
    const item = byReferral.get(trade.ref);
    if (!item) continue;
    const value = tradeVolume(trade);
    if (value <= 0) continue;
    if (trade.side === 'buy') item.buyUsdt += value;
    item.totalUsdt += value;
    item.commissionUsdt += value * commissionRate;
    if (!isTradeSettled(db, trade.id)) {
      item.unsettledUsdt += value;
      item.unsettledCommissionUsdt += value * commissionRate;
    }
    item.tradeCount += 1;
  }

  return [...byReferral.values()].sort((a, b) => b.buyUsdt + b.sellUsdt - (a.buyUsdt + a.sellUsdt));
}

function referralDetail(db, code) {
  const referral = db.referrals.find((item) => item.code === code);
  if (!referral) return null;
  const trades = db.trades.filter((trade) => trade.ref === code && trade.side === 'buy').slice().reverse();
  const bindings = db.walletBindings.filter((binding) => binding.ref === code);
  const walletMap = new Map();

  for (const binding of bindings) {
    walletMap.set(binding.wallet, {
      wallet: binding.wallet,
      boundAt: binding.createdAt,
      buyUsdt: 0,
      sellUsdt: 0,
      totalUsdt: 0,
      unsettledUsdt: 0,
      commissionUsdt: 0,
      unsettledCommissionUsdt: 0,
      tradeCount: 0
    });
  }

  for (const trade of trades) {
    if (!walletMap.has(trade.wallet)) {
      walletMap.set(trade.wallet, {
        wallet: trade.wallet,
        boundAt: '',
        buyUsdt: 0,
        sellUsdt: 0,
        totalUsdt: 0,
        unsettledUsdt: 0,
        commissionUsdt: 0,
        unsettledCommissionUsdt: 0,
        tradeCount: 0
      });
    }
    const item = walletMap.get(trade.wallet);
    const value = tradeVolume(trade);
    if (value <= 0) continue;
    if (trade.side === 'buy') item.buyUsdt += value;
    item.totalUsdt += value;
    item.commissionUsdt += value * commissionRate;
    if (!isTradeSettled(db, trade.id)) {
      item.unsettledUsdt += value;
      item.unsettledCommissionUsdt += value * commissionRate;
    }
    item.tradeCount += 1;
  }

  const summary = summarize(db).find((item) => item.code === code);
  const settlements = db.settlements.filter((settlement) => settlement.ref === code).slice().reverse();
  return {
    referral: normalizeReferral(referral),
    summary,
    wallets: [...walletMap.values()].sort((a, b) => b.totalUsdt - a.totalUsdt),
    trades,
    settlements
  };
}

app.get('/api/config', (_req, res) => {
  res.json({
    chainId: Number(process.env.CHAIN_ID || 56),
    chainName: process.env.CHAIN_NAME || 'BNB Smart Chain',
    rpcUrl: process.env.RPC_URL || 'https://bsc-dataseed.binance.org',
    routerAddress: (process.env.ROUTER_ADDRESS || '0x10ED43C718714eb63d5aA57B78B54704E256024E').toLowerCase(),
    usdtAddress: (process.env.USDT_ADDRESS || '0x55d398326f99059fF775485246999027B3197955').toLowerCase(),
    targetTokenAddress: (process.env.TARGET_TOKEN_ADDRESS || '0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD').toLowerCase(),
    targetTokenDisplay: process.env.TARGET_TOKEN_DISPLAY || '0x6cBf442EaA9539Ff93ba2dd7726933bB7b66FeeD',
    defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS || 100)
  });
});

app.get('/api/referrals', async (req, res, next) => {
  try {
    const db = await readDb();
    res.json({ referrals: db.referrals.map((referral) => publicReferral(normalizeReferral(referral), req)) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/referrals', requireAdmin, async (req, res, next) => {
  try {
    const db = await readDb();
    const referrerWallet = normalizeAddress(req.body.referrerWallet || req.body.name);
    if (!/^0x[a-f0-9]{40}$/.test(referrerWallet)) return res.status(400).json({ error: 'Invalid referrer wallet' });
    const requestedCode = String(req.body.code || '').trim().toLowerCase();
    const code = requestedCode || referrerWallet.slice(2, 10);
    if (!/^[a-z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'Invalid referral code' });
    if (db.referrals.some((item) => item.code === code)) return res.status(409).json({ error: 'Referral code exists' });

    const referral = { id: randomUUID(), code, name: referrerWallet, referrerWallet, createdAt: nowIso() };
    db.referrals.push(referral);
    await writeDb(db);
    res.status(201).json({ referral: publicReferral(referral, req) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bind-wallet', async (req, res, next) => {
  try {
    const wallet = normalizeAddress(req.body.wallet);
    const ref = String(req.body.ref || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    if (!ref) return res.status(400).json({ error: 'Missing ref' });

    const db = await readDb();
    if (!db.referrals.some((item) => item.code === ref)) return res.status(404).json({ error: 'Referral not found' });
    const existing = db.walletBindings.find((item) => item.wallet === wallet);
    if (existing) {
      return res.json({ binding: existing, alreadyBound: true });
    }

    const binding = { id: randomUUID(), ref, wallet, createdAt: nowIso() };
    db.walletBindings.push(binding);
    await writeDb(db);
    res.status(201).json({ binding, alreadyBound: false });
  } catch (error) {
    next(error);
  }
});

app.get('/api/referral-wallet-stats', async (req, res, next) => {
  try {
    const wallet = normalizeAddress(req.query.wallet);
    const ref = String(req.query.ref || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    if (!ref) return res.status(400).json({ error: 'Missing ref' });

    const db = await readDb();
    if (!db.referrals.some((item) => item.code === ref)) return res.status(404).json({ error: 'Referral not found' });
    const trades = db.trades.filter((trade) => trade.ref === ref && trade.wallet === wallet && trade.side === 'buy');
    const totalBuyUsdt = trades.reduce((sum, trade) => sum + tradeVolume(trade), 0);
    const unsettledBuyUsdt = trades
      .filter((trade) => !isTradeSettled(db, trade.id))
      .reduce((sum, trade) => sum + tradeVolume(trade), 0);

    res.json({
      ref,
      wallet,
      buyCount: trades.length,
      totalBuyUsdt,
      unsettledBuyUsdt,
      commissionRate,
      estimatedCommissionUsdt: totalBuyUsdt * commissionRate,
      unsettledCommissionUsdt: unsettledBuyUsdt * commissionRate
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/referral-public-stats', async (req, res, next) => {
  try {
    const ref = String(req.query.ref || '').trim().toLowerCase();
    if (!ref) return res.status(400).json({ error: 'Missing ref' });

    const db = await readDb();
    const referral = db.referrals.find((item) => item.code === ref);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });

    const trades = db.trades.filter((trade) => trade.ref === ref && trade.side === 'buy');
    const buyerWallets = new Set(trades.map((trade) => trade.wallet));
    const totalBuyUsdt = trades.reduce((sum, trade) => sum + tradeVolume(trade), 0);

    res.json({
      ref,
      name: referral.name,
      buyerCount: buyerWallets.size,
      buyCount: trades.length,
      totalBuyUsdt
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/trades', async (req, res, next) => {
  try {
    const wallet = normalizeAddress(req.body.wallet);
    const ref = String(req.body.ref || '').trim().toLowerCase();
    const side = req.body.side === 'sell' ? 'sell' : 'buy';
    const txHash = String(req.body.txHash || '').trim().toLowerCase();
    const usdtAmount = Number(req.body.usdtAmount || 0);
    const tokenAmount = String(req.body.tokenAmount || '0');

    if (!/^0x[a-f0-9]{40}$/.test(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: 'Invalid txHash' });
    if (!Number.isFinite(usdtAmount) || usdtAmount <= 0) return res.status(400).json({ error: 'Invalid usdtAmount' });

    const db = await readDb();
    if (!db.referrals.some((item) => item.code === ref)) return res.status(404).json({ error: 'Referral not found' });
    if (db.trades.some((item) => item.txHash === txHash)) return res.status(409).json({ error: 'Trade already recorded' });

    const binding = db.walletBindings.find((item) => item.wallet === wallet);
    const tradeRef = binding?.ref || ref;
    const trade = { id: randomUUID(), ref: tradeRef, wallet, side, txHash, usdtAmount, tokenAmount, createdAt: nowIso() };
    db.trades.push(trade);
    await writeDb(db);
    res.status(201).json({ trade });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    const db = await readDb();
    res.json({
      summary: summarize(db),
      walletBindings: db.walletBindings,
      trades: db.trades.slice().reverse(),
      settlements: db.settlements.slice().reverse(),
      commissionRate
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/referrals/:code/detail', async (req, res, next) => {
  try {
    const db = await readDb();
    const code = String(req.params.code || '').trim().toLowerCase();
    const detail = referralDetail(db, code);
    if (!detail) return res.status(404).json({ error: 'Referral not found' });
    res.json({ ...detail, commissionRate });
  } catch (error) {
    next(error);
  }
});

app.post('/api/referrals/:code/settlements', requireAdmin, async (req, res, next) => {
  try {
    const db = await readDb();
    const code = String(req.params.code || '').trim().toLowerCase();
    const referral = db.referrals.find((item) => item.code === code);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });

    const tradeIds = db.trades
      .filter((trade) => trade.ref === code && trade.side === 'buy' && !isTradeSettled(db, trade.id))
      .map((trade) => trade.id);
    if (tradeIds.length === 0) return res.status(400).json({ error: 'No unsettled trades' });

    const trades = db.trades.filter((trade) => tradeIds.includes(trade.id));
    const totalUsdt = trades.reduce((sum, trade) => sum + tradeVolume(trade), 0);
    const settlement = {
      id: randomUUID(),
      ref: code,
      createdAt: nowIso(),
      from: trades.reduce((earliest, trade) => !earliest || trade.createdAt < earliest ? trade.createdAt : earliest, ''),
      to: trades.reduce((latest, trade) => !latest || trade.createdAt > latest ? trade.createdAt : latest, ''),
      tradeIds,
      tradeCount: trades.length,
      walletCount: new Set(trades.map((trade) => trade.wallet)).size,
      totalUsdt,
      commissionRate,
      commissionUsdt: totalUsdt * commissionRate,
      note: String(req.body.note || '').trim()
    };

    db.settlements.push(settlement);
    await writeDb(db);
    res.status(201).json({ settlement, detail: referralDetail(db, code) });
  } catch (error) {
    next(error);
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  try {
    await fs.access(path.join(distDir, 'index.html'));
    res.sendFile(path.join(distDir, 'index.html'));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Fixed referral swap server listening on http://127.0.0.1:${port}`);
});
