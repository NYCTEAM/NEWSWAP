import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ethers } from 'ethers';
import { ArrowDownUp, BarChart3, Copy, Link2, RefreshCcw, Wallet } from 'lucide-react';
import './styles.css';

type AppConfig = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  routerAddress: string;
  usdtAddress: string;
  targetTokenAddress: string;
  targetTokenDisplay: string;
  defaultSlippageBps: number;
};

type Referral = { id: string; code: string; name: string; referrerWallet: string; createdAt: string; url: string };

type SummaryRow = {
  code: string;
  name: string;
  referrerWallet: string;
  wallets: number;
  buyUsdt: number;
  sellUsdt: number;
  totalUsdt: number;
  unsettledUsdt: number;
  commissionUsdt: number;
  unsettledCommissionUsdt: number;
  tradeCount: number;
};

type Trade = {
  id: string;
  ref: string;
  wallet: string;
  side: 'buy' | 'sell';
  txHash: string;
  usdtAmount: number;
  tokenAmount: string;
  createdAt: string;
};

type WalletStats = {
  wallet: string;
  boundAt: string;
  buyUsdt: number;
  sellUsdt: number;
  totalUsdt: number;
  unsettledUsdt: number;
  commissionUsdt: number;
  unsettledCommissionUsdt: number;
  tradeCount: number;
};

type Settlement = {
  id: string;
  ref: string;
  createdAt: string;
  tradeCount: number;
  walletCount: number;
  totalUsdt: number;
  commissionUsdt: number;
};

type ReferralPublicStats = {
  ref: string;
  name: string;
  buyerCount: number;
  buyCount: number;
  totalBuyUsdt: number;
};

type ReferralDetail = {
  referral: Referral;
  summary: SummaryRow;
  wallets: WalletStats[];
  trades: Trade[];
  settlements: Settlement[];
  commissionRate: number;
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

const erc20Abi = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];

const routerAbi = [
  'function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)'
];

function formatNumber(value: number, fraction = 4) {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString(undefined, { maximumFractionDigits: fraction });
}

function shortAddress(value: string) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : '';
}

function currentRef() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('ref')?.trim().toLowerCase();
  if (fromUrl) {
    localStorage.setItem('swap.referral', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('swap.referral') || '';
}

async function apiJson<T>(path: string, init?: RequestInit, adminPassword?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) headers.set('Content-Type', 'application/json');
  if (adminPassword) headers.set('Authorization', `Bearer ${adminPassword}`);
  const response = await fetch(path, { ...init, headers });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Request failed: ${response.status}`);
  return json;
}

function App() {
  const isAdmin = window.location.pathname === '/admin';
  const detailMatch = window.location.pathname.match(/^\/admin\/ref\/([^/]+)$/);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    apiJson<AppConfig>('/api/config').then(setConfig).catch(console.error);
  }, []);

  if (!config) return <div className="boot">Loading swap...</div>;
  if (detailMatch) return <AdminDetailPage code={decodeURIComponent(detailMatch[1])} />;
  return isAdmin ? <AdminPage /> : <SwapPage config={config} />;
}

function SwapPage({ config }: { config: AppConfig }) {
  const [wallet, setWallet] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('TOKEN');
  const [tokenDecimals, setTokenDecimals] = useState(18);
  const [usdtDecimals, setUsdtDecimals] = useState(18);
  const [slippageBps, setSlippageBps] = useState(config.defaultSlippageBps);
  const [status, setStatus] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [refStats, setRefStats] = useState<ReferralPublicStats | null>(null);
  const ref = useMemo(currentRef, []);
  const provider = useMemo(() => new ethers.JsonRpcProvider(config.rpcUrl), [config.rpcUrl]);
  const path = useMemo(
    () => side === 'buy' ? [config.usdtAddress, config.targetTokenAddress] : [config.targetTokenAddress, config.usdtAddress],
    [config.targetTokenAddress, config.usdtAddress, side]
  );

  const loadTokenInfo = useCallback(async () => {
    const usdt = new ethers.Contract(config.usdtAddress, erc20Abi, provider);
    const token = new ethers.Contract(config.targetTokenAddress, erc20Abi, provider);
    const [usdtDec, tokenDec, symbol] = await Promise.all([
      usdt.decimals().catch(() => 18),
      token.decimals().catch(() => 18),
      token.symbol().catch(() => 'TOKEN')
    ]);
    setUsdtDecimals(Number(usdtDec));
    setTokenDecimals(Number(tokenDec));
    setTokenSymbol(String(symbol || 'TOKEN'));
  }, [config.targetTokenAddress, config.usdtAddress, provider]);

  useEffect(() => {
    loadTokenInfo().catch(() => undefined);
  }, [loadTokenInfo]);

  useEffect(() => {
    if (!ref) return;
    loadReferralStats().catch(() => undefined);
  }, [ref]);

  useEffect(() => {
    let cancelled = false;
    async function loadQuote() {
      if (!amount || Number(amount) <= 0) {
        setQuote('');
        return;
      }
      try {
        const decimalsIn = side === 'buy' ? usdtDecimals : tokenDecimals;
        const decimalsOut = side === 'buy' ? tokenDecimals : usdtDecimals;
        const router = new ethers.Contract(config.routerAddress, routerAbi, provider);
        const amounts = await router.getAmountsOut(ethers.parseUnits(amount, decimalsIn), path);
        if (!cancelled) setQuote(ethers.formatUnits(amounts[1], decimalsOut));
      } catch {
        if (!cancelled) setQuote('');
      }
    }
    const timer = window.setTimeout(loadQuote, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [amount, config.routerAddress, path, provider, side, tokenDecimals, usdtDecimals]);

  async function connectWallet() {
    if (!window.ethereum) throw new Error('Wallet not found');
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${config.chainId.toString(16)}` }] });
    const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
    const address = accounts[0] || '';
    setWallet(address);
    if (ref) {
      await apiJson('/api/bind-wallet', { method: 'POST', body: JSON.stringify({ wallet: address, ref }) }).catch(() => undefined);
      await loadReferralStats().catch(() => undefined);
    }
  }

  async function loadReferralStats() {
    if (!ref) return;
    const stats = await apiJson<ReferralPublicStats>(`/api/referral-public-stats?ref=${encodeURIComponent(ref)}`);
    setRefStats(stats);
  }

  async function ensureAllowance(tokenAddress: string, signer: ethers.Signer, owner: string, amountIn: bigint) {
    const token = new ethers.Contract(tokenAddress, erc20Abi, signer);
    const allowance: bigint = await token.allowance(owner, config.routerAddress);
    if (allowance >= amountIn) return;
    setStatus('授权中...');
    const tx = await token.approve(config.routerAddress, amountIn);
    await tx.wait();
  }

  async function executeSwap() {
    try {
      setIsBusy(true);
      setStatus('');
      if (!ref) throw new Error('缺少推荐码，请通过推荐链接进入。');
      if (!amount || Number(amount) <= 0) throw new Error('请输入数量。');
      if (!window.ethereum) throw new Error('请先安装钱包。');

      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const address = await signer.getAddress();
      setWallet(address);
      await apiJson('/api/bind-wallet', { method: 'POST', body: JSON.stringify({ wallet: address, ref }) });
      await loadReferralStats().catch(() => undefined);

      const decimalsIn = side === 'buy' ? usdtDecimals : tokenDecimals;
      const decimalsOut = side === 'buy' ? tokenDecimals : usdtDecimals;
      const amountIn = ethers.parseUnits(amount, decimalsIn);
      const router = new ethers.Contract(config.routerAddress, routerAbi, signer);
      const amounts = await router.getAmountsOut(amountIn, path);
      const minimumOut = (amounts[1] * BigInt(10000 - slippageBps)) / 10000n;
      const inputToken = side === 'buy' ? config.usdtAddress : config.targetTokenAddress;

      await ensureAllowance(inputToken, signer, address, amountIn);
      setStatus('交易提交中...');
      const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        amountIn,
        minimumOut,
        path,
        address,
        Math.floor(Date.now() / 1000) + 60 * 20
      );
      setStatus(`等待确认: ${tx.hash}`);
      await tx.wait();

      if (side === 'buy') {
        const usdtAmount = Number(amount);
        const tokenAmount = ethers.formatUnits(amounts[1], decimalsOut);
        await apiJson('/api/trades', { method: 'POST', body: JSON.stringify({ wallet: address, ref, side, txHash: tx.hash, usdtAmount, tokenAmount }) });
        await loadReferralStats().catch(() => undefined);
        setStatus('买入完成，推广统计已记录。');
      } else {
        setStatus('卖出完成，卖出交易不参与推广统计。');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '交易失败');
    } finally {
      setIsBusy(false);
    }
  }

  const fromLabel = side === 'buy' ? 'USDT' : tokenSymbol;
  const toLabel = side === 'buy' ? tokenSymbol : 'USDT';

  return (
    <main className="swap-shell">
      <section className="swap-panel">
        <div className="topbar">
          <div>
            <p className="eyebrow">Fixed referral swap</p>
            <h1>USDT / {tokenSymbol}</h1>
          </div>
          <button className="icon-text" onClick={connectWallet}><Wallet size={18} />{wallet ? shortAddress(wallet) : '连接钱包'}</button>
        </div>
        <div className="token-lock"><span>固定代币</span><strong>{config.targetTokenDisplay}</strong></div>
        <div className="segmented">
          <button className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>买入</button>
          <button className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>卖出</button>
        </div>
        <label className="amount-box"><span>支付 {fromLabel}</span><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.0" /></label>
        <div className="swap-arrow"><ArrowDownUp size={20} /></div>
        <div className="amount-box output"><span>预计获得 {toLabel}</span><strong>{quote ? formatNumber(Number(quote), 8) : '0'}</strong></div>
        <label className="slippage"><span>滑点 {slippageBps / 100}%</span><input type="range" min="10" max="500" step="10" value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} /></label>
        <button className="primary" onClick={executeSwap} disabled={isBusy}>{isBusy ? '处理中...' : `${side === 'buy' ? '买入' : '卖出'} ${tokenSymbol}`}</button>
        <div className="ref-card">
          <div><span>推荐码</span><strong>{ref || '未绑定'}</strong></div>
          <div><span>推荐购买人数</span><strong>{refStats ? `${refStats.buyerCount}` : '-'}</strong></div>
          <div><span>推荐累计买入</span><strong>{refStats ? `${formatNumber(refStats.totalBuyUsdt, 2)} USDT` : '-'}</strong></div>
          <div><span>推荐买入次数</span><strong>{refStats ? `${refStats.buyCount}` : '-'}</strong></div>
        </div>
        {status && <div className="status">{status}</div>}
      </section>
    </main>
  );
}

function AdminPage() {
  const [password, setPassword] = useState('');
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [referrerWallet, setReferrerWallet] = useState('');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');
  const auth = password.trim();

  useEffect(() => {
    localStorage.removeItem('swap.adminPassword');
  }, []);

  async function refresh() {
    setStatus('');
    const [refData, statsData] = await Promise.all([
      apiJson<{ referrals: Referral[] }>('/api/referrals'),
      apiJson<{ summary: SummaryRow[] }>('/api/stats')
    ]);
    setReferrals(refData.referrals);
    setSummary(statsData.summary);
  }

  useEffect(() => {
    if (auth) refresh().catch((error) => setStatus(error.message));
  }, []);

  async function createReferral() {
    try {
      setStatus('');
      await apiJson('/api/referrals', { method: 'POST', body: JSON.stringify({ referrerWallet, code }) }, auth);
      setReferrerWallet('');
      setCode('');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '创建失败');
    }
  }

  const referralByCode = useMemo(() => new Map(referrals.map((item) => [item.code, item])), [referrals]);

  return (
    <main className="admin-shell">
      <section className="admin-head">
        <div><p className="eyebrow">Referral dashboard</p><h1>推广统计后台</h1></div>
        <button className="icon-text" onClick={() => refresh()}><RefreshCcw size={18} />刷新</button>
      </section>

      <section className="admin-grid">
        <div className="admin-card">
          <h2><Link2 size={18} /> 创建专属链接</h2>
          <form onSubmit={(event) => { event.preventDefault(); createReferral(); }}>
            <input className="hidden-field" value="admin" readOnly autoComplete="username" aria-hidden="true" tabIndex={-1} />
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理员密码" type="password" autoComplete="new-password" name="admin-password" />
            <input value={referrerWallet} onChange={(event) => setReferrerWallet(event.target.value)} placeholder="推荐人钱包地址" />
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="推荐码，可留空自动生成" />
            <button className="primary" type="submit">创建链接</button>
          </form>
          {status && <div className="status">{status}</div>}
        </div>

        <div className="admin-card wide">
          <h2><BarChart3 size={18} /> 推荐人总览</h2>
          <div className="table referral-table">
            <div className="row header"><span>推荐人地址</span><span>人数</span><span>买入总U</span><span>未结算U</span><span>佣金</span><span>操作</span></div>
            {summary.map((item) => (
              <div className="row overview-row" key={item.code}>
                <span title={item.referrerWallet || item.name}>{item.referrerWallet ? shortAddress(item.referrerWallet) : item.name}<small>{item.code}</small></span>
                <span>{item.wallets}</span>
                <span>{formatNumber(item.totalUsdt, 2)}</span>
                <span>{formatNumber(item.unsettledUsdt, 2)}</span>
                <span>{formatNumber(item.unsettledCommissionUsdt, 2)} USDT</span>
                <span className="action-group">
                  <button className="small-action" onClick={() => openDetail(item.code, auth)}>查看</button>
                  <button className="small-action secondary" onClick={() => copyText(referralByCode.get(item.code)?.url || '')}>复制链接</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="admin-card full">
        <h2>每个推荐链接独立统计</h2>
        <div className="referral-stat-grid">
          {summary.map((item) => {
            const referral = referralByCode.get(item.code);
            const settledUsdt = item.totalUsdt - item.unsettledUsdt;
            const settledCommission = item.commissionUsdt - item.unsettledCommissionUsdt;
            return (
              <div className="referral-stat-card" key={item.code}>
                <div className="stat-card-head">
                  <span>推荐人地址</span>
                  <strong title={item.referrerWallet || item.name}>{item.referrerWallet || item.name}</strong>
                </div>
                <div className="stat-card-link">
                  <span>推荐码</span>
                  <strong>{item.code}</strong>
                </div>
                <div className="stat-card-link">
                  <span>专属链接</span>
                  <strong>{referral?.url || '-'}</strong>
                </div>
                <div className="stat-actions">
                  <button className="small-action" onClick={() => openDetail(item.code, auth)}>查看详情</button>
                  <button className="small-action secondary" onClick={() => copyText(referral?.url || '')}>复制专属链接</button>
                </div>
                <div className="stat-metrics">
                  <Metric label="购买人数" value={`${item.wallets}`} />
                  <Metric label="买入次数" value={`${item.tradeCount}`} />
                  <Metric label="总买入U" value={formatNumber(item.totalUsdt, 2)} />
                  <Metric label="已结算U" value={formatNumber(settledUsdt, 2)} />
                  <Metric label="未结算U" value={formatNumber(item.unsettledUsdt, 2)} />
                  <Metric label="本轮佣金" value={`${formatNumber(item.unsettledCommissionUsdt, 2)} USDT`} />
                  <Metric label="已结算佣金" value={`${formatNumber(settledCommission, 2)} USDT`} />
                  <Metric label="总佣金1%" value={`${formatNumber(item.commissionUsdt, 2)} USDT`} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="admin-card full">
        <h2>推荐链接</h2>
        <div className="link-list">
          {referrals.map((item) => (
            <div className="link-row" key={item.id}>
              <div><strong>{item.referrerWallet ? shortAddress(item.referrerWallet) : item.name}</strong><span>{item.url}</span></div>
              <button className="icon-only" onClick={() => navigator.clipboard.writeText(item.url)} title="复制"><Copy size={18} /></button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function openDetail(code: string, auth: string) {
  window.location.href = `/admin/ref/${encodeURIComponent(code)}`;
}

async function copyText(value: string) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
}

function AdminDetailPage({ code }: { code: string }) {
  const [detail, setDetail] = useState<ReferralDetail | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    localStorage.removeItem('swap.adminPassword');
  }, []);

  async function loadDetail() {
    setStatus('');
    setDetail(await apiJson<ReferralDetail>(`/api/referrals/${encodeURIComponent(code)}/detail`));
  }

  useEffect(() => {
    loadDetail().catch((error) => setStatus(error.message));
  }, [code]);

  async function settleSelected() {
    if (!detail) return;
    const password = window.prompt('请输入管理员密码进行结算');
    if (!password) return;
    try {
      setStatus('');
      await apiJson(`/api/referrals/${encodeURIComponent(detail.referral.code)}/settlements`, { method: 'POST', body: JSON.stringify({}) }, password.trim());
      await loadDetail();
      setStatus('本轮已结算，新交易会进入下一轮未结算统计。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '结算失败');
    }
  }

  async function syncMissingBuys() {
    if (!detail) return;
    const password = window.prompt('请输入管理员密码补扫链上漏单');
    if (!password) return;
    try {
      setStatus('正在补扫链上买入记录，请稍等...');
      const result = await apiJson<{ sync?: { added?: number } }>(
        `/api/referrals/${encodeURIComponent(detail.referral.code)}/sync`,
        { method: 'POST', body: JSON.stringify({}) },
        password.trim()
      );
      await loadDetail();
      setStatus(`补扫完成，新增 ${result.sync?.added || 0} 笔买入记录。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '补扫失败');
    }
  }

  const summary = detail?.summary;

  return (
    <main className="admin-shell">
      <section className="admin-head">
        <div>
          <p className="eyebrow">Referral detail</p>
          <h1>推荐链接详情</h1>
        </div>
        <div className="head-actions">
          <button className="icon-text" onClick={() => { window.location.href = '/admin'; }}>返回后台</button>
          <button className="icon-text" onClick={loadDetail}><RefreshCcw size={18} />刷新</button>
        </div>
      </section>

      <section className="admin-card full compact-card">
        <div className="detail-head">
          <div>
            <h2>当前推荐链接</h2>
            <p>推荐人地址: {detail?.referral.referrerWallet || detail?.referral.name || '-'}</p>
            <p>推荐码: {code}</p>
          </div>
        </div>
        {status && <div className="status">{status}</div>}
      </section>

      {summary && (
        <section className="admin-card full compact-card">
          <div className="detail-head">
            <h2>统计分类</h2>
            <div className="head-actions">
              <button className="icon-text" onClick={syncMissingBuys}>补扫漏单</button>
              <button className="icon-text" onClick={settleSelected}>结算本轮 1%</button>
            </div>
          </div>
          <div className="metric-grid">
            <Metric label="推荐人数" value={`${summary.wallets}`} />
            <Metric label="买入次数" value={`${summary.tradeCount}`} />
            <Metric label="买入总USDT" value={formatNumber(summary.totalUsdt, 2)} />
            <Metric label="未结算USDT" value={formatNumber(summary.unsettledUsdt, 2)} />
            <Metric label="总佣金1%" value={`${formatNumber(summary.commissionUsdt, 2)} USDT`} />
            <Metric label="本轮可结算" value={`${formatNumber(summary.unsettledCommissionUsdt, 2)} USDT`} />
          </div>
        </section>
      )}

      {detail && (
        <section className="detail-two-col">
          <div className="admin-card">
            <h2>钱包明细</h2>
            <div className="table wallet-table compact-table">
              <div className="row header"><span>钱包地址</span><span>买入次数</span><span>买入U</span><span>未结算U</span><span>本轮佣金</span></div>
              {detail.wallets.map((item) => (
                <div className="row" key={item.wallet}>
                  <span title={item.wallet}>{shortAddress(item.wallet)}<small>{item.boundAt ? new Date(item.boundAt).toLocaleString() : '交易记录'}</small></span>
                  <span>{item.tradeCount}</span>
                  <span>{formatNumber(item.buyUsdt, 2)}</span>
                  <span>{formatNumber(item.unsettledUsdt, 2)}</span>
                  <span>{formatNumber(item.unsettledCommissionUsdt, 2)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-card">
            <h2>结算记录</h2>
            <div className="table settlement-table">
              <div className="row header"><span>结算时间</span><span>买入次数</span><span>结算U</span><span>佣金1%</span></div>
              {detail.settlements.map((item) => (
                <div className="row" key={item.id}>
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <span>{item.tradeCount}</span>
                  <span>{formatNumber(item.totalUsdt, 2)}</span>
                  <span>{formatNumber(item.commissionUsdt, 2)} USDT</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {detail && (
        <section className="admin-card full compact-card">
          <h2>买入明细</h2>
          <div className="table trades">
            <div className="row header"><span>时间</span><span>钱包</span><span>类型</span><span>USDT</span><span>代币数量</span><span>Tx</span></div>
            {detail.trades.map((trade) => (
              <div className="row" key={trade.id}>
                <span>{new Date(trade.createdAt).toLocaleString()}</span>
                <span title={trade.wallet}>{shortAddress(trade.wallet)}</span>
                <span>买入</span>
                <span>{formatNumber(trade.usdtAmount, 2)}</span>
                <span>{formatNumber(Number(trade.tokenAmount), 4)}</span>
                <span title={trade.txHash}>{shortAddress(trade.txHash)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
