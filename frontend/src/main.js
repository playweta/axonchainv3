import { ethers } from "ethers";
import {
  API_BASE,
  CHAINS,
  CONTRACT_ABI,
  CONTRACT_ADDRESS,
  DEFAULT_KEEPER_URL,
  ERC20_ABI,
  getReadProvider,
  ORDER_CREATED_TOPIC,
  STATUS_LABELS,
  TOKENS,
} from "./config";
import "./styles.css";

const THEME_STORAGE_KEY = "axon-otc-theme";
const HIDDEN_CHAIN_IDS = new Set([42161]);
const DEFAULT_MARKET_SORT = { sortKey: "priceUsdRaw", sortDirection: "asc" };
const SORTABLE_MARKET_FIELDS = {
  amountAxon: "数量",
  priceUsdRaw: "单价",
  totalPayment: "总价",
};
const MARKET_SORT_API_FIELDS = {
  amountAxon: "amount_axon",
  priceUsdRaw: "price_usd",
  totalPayment: "total_payment",
};
const NETWORK_HISTORY_SORT_FIELDS = {
  id: "订单",
  amountAxon: "数量",
  totalPayment: "总价",
  createdAt: "创建时间",
};
const NETWORK_HISTORY_SORT_API_FIELDS = {
  id: "id",
  amountAxon: "amount_axon",
  totalPayment: "total_payment",
  createdAt: "created_at",
};
const CHART_INTERVALS = {
  hour: { label: "1小时", bucketSeconds: 3600 },
  sixHour: { label: "6小时", bucketSeconds: 21600 },
  day: { label: "1天", bucketSeconds: 86400 },
};
const REPEAT_CLICK_LOCK_MS = 5000;

const appState = {
  account: null,
  currentChainId: null,
  activeOrders: [],
  myOrders: [],
  networkHistoryOrders: [],
  balances: [],
  settings: {
    keeperUrl: DEFAULT_KEEPER_URL,
    paymentPath: "",
  },
  metrics: {
    feeRateBps: null,
    cancelCooldown: null,
    nextOrderId: null,
    activeTotal: 0,
  },
  market: {
    page: 1,
    pageSize: 10,
    total: 0,
    sortKey: DEFAULT_MARKET_SORT.sortKey,
    sortDirection: DEFAULT_MARKET_SORT.sortDirection,
    query: "",
  },
  history: {
    pageSize: 20,
    total: 0,
  },
  priceChart: {
    interval: "hour",
    candles: [],
    tradeCount: 0,
  },
  orderDetail: {
    open: false,
    loading: false,
    error: "",
    order: null,
  },
  networkHistory: {
    page: 1,
    pageSize: 20,
    total: 0,
    sortKey: "createdAt",
    sortDirection: "desc",
    query: "",
  },
  loading: {
    market: false,
    history: false,
    priceChart: false,
    networkHistory: false,
    balances: false,
  },
    errors: {
      market: "",
      history: "",
      priceChart: "",
      orderDetail: "",
      networkHistory: "",
      balances: "",
  },
  requests: {
    market: 0,
    history: 0,
    priceChart: 0,
    networkHistory: 0,
    balances: 0,
  },
  interactionLocks: {
    createOrderUntil: 0,
    buyOrderUntilById: {},
    queryUntilByKey: {},
  },
  status: {
    kind: "info",
    text: "正在同步链上订单数据...",
  },
  theme: window.localStorage.getItem(THEME_STORAGE_KEY) || "light",
};

const root = document.querySelector("#app");
root.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Axon OTC V7 Marketplace</p>
        <div class="hero-actions">
          <button id="connectButton" class="button button-primary">连接 OKX Wallet</button>
          <button id="themeButton" class="button button-ghost">夜间模式</button>
          <button id="refreshButton" class="button button-ghost">刷新市场</button>
        </div>
        <div class="wallet-strip">
          <span>账户</span>
          <strong id="walletAddress">未连接</strong>
          <span>网络</span>
          <strong id="walletChain">-</strong>
        </div>
        <section class="wallet-balance-panel">
          <div class="panel-head wallet-balance-head">
            <div>
              <p class="panel-kicker">Trades</p>
              <h2>成交价 K 线</h2>
            </div>
            <div class="trade-chart-actions">
              <select id="priceChartInterval">
                <option value="hour">1小时</option>
                <option value="sixHour">6小时</option>
                <option value="day">1天</option>
              </select>
            </div>
          </div>
          <div class="trade-chart-meta" id="priceChartMeta">按已成交订单聚合</div>
          <div class="trade-chart-frame" id="priceChart"></div>
        </section>
      </div>

      <div class="hero-card">
        <div class="social-links social-links-right">
          <a
            class="social-link"
            href="https://github.com/playweta/axonchainv3"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a
            class="social-link"
            href="https://x.com/atom82457"
            target="_blank"
            rel="noreferrer"
          >
            X / Twitter
          </a>
          <a
            class="social-link"
            href="https://t.me/maycode"
            target="_blank"
            rel="noreferrer"
          >
            Telegram
          </a>
        </div>
        <div class="stat-grid" id="metricCards"></div>
        <div class="notice" id="statusBanner"></div>
      </div>
    </section>

    <section class="board">
      <div class="stack orders-stack">
        <section class="panel panel-wide orders-panel">
        <div class="panel-head">
          <div>
            <p class="panel-kicker">Market</p>
            <h2>活跃订单</h2>
          </div>
          <div class="inline-meta">
            <button id="refreshOrdersButton" class="button button-mini button-ghost">刷新订单</button>
            <span id="activeCount">0 笔</span>
            <span id="bestPrice">最优价 -</span>
          </div>
        </div>
        <form id="marketSearchForm" class="toolbar-form">
          <input id="marketSearchInput" type="text" placeholder="搜索订单号 / 卖方地址 / 状态 / 代币 / 链" />
          <button type="submit" class="button button-mini button-primary toolbar-submit">查询</button>
          <button type="button" id="marketSearchReset" class="button button-mini button-ghost toolbar-reset">清空</button>
        </form>
        <div class="table-wrap orders-table-wrap">
          <table>
            <thead>
              <tr>
                <th>订单</th>
                <th>卖方</th>
                <th><button type="button" class="sort-button" data-sort-field="amountAxon">数量</button></th>
                <th><button type="button" class="sort-button" data-sort-field="priceUsdRaw">单价</button></th>
                <th><button type="button" class="sort-button" data-sort-field="totalPayment">总价</button></th>
                <th>支付链</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="activeOrdersBody"></tbody>
          </table>
        </div>
        <div class="pager" id="activeOrdersPager"></div>
        </section>

        <section class="panel panel-wide history-panel">
          <div class="panel-head">
            <div>
              <p class="panel-kicker">History</p>
              <h2>我的订单</h2>
            </div>
            <div class="inline-meta">
              <span>本地后端 API 聚合的我的卖单与买单</span>
            </div>
          </div>
          <div class="table-wrap history-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>订单</th>
                  <th>角色</th>
                  <th>数量</th>
                  <th>总价</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="myOrdersBody"></tbody>
            </table>
          </div>
        </section>

        <section class="panel panel-wide network-history-panel">
          <div class="panel-head">
            <div>
              <p class="panel-kicker">Network History</p>
              <h2>全网历史订单</h2>
            </div>
            <div class="inline-meta">
              <span id="networkHistoryCount">全网最近历史订单</span>
            </div>
          </div>
          <form id="networkHistorySearchForm" class="toolbar-form">
            <input id="networkHistorySearchInput" type="text" placeholder="搜索订单号 / 买卖方地址 / 状态 / 代币 / 链" />
            <button type="submit" class="button button-mini button-primary toolbar-submit">查询</button>
            <button type="button" id="networkHistorySearchReset" class="button button-mini button-ghost toolbar-reset">清空</button>
          </form>
          <div class="table-wrap history-table-wrap">
            <table>
              <thead>
                <tr>
                  <th><button type="button" class="sort-button" data-network-sort-field="id">订单</button></th>
                  <th>卖方</th>
                  <th>买方</th>
                  <th><button type="button" class="sort-button" data-network-sort-field="amountAxon">数量</button></th>
                  <th><button type="button" class="sort-button" data-network-sort-field="totalPayment">总价</button></th>
                  <th>状态</th>
                  <th><button type="button" class="sort-button" data-network-sort-field="createdAt">创建时间</button></th>
                </tr>
              </thead>
              <tbody id="networkHistoryBody"></tbody>
            </table>
          </div>
          <div class="pager" id="networkHistoryPager"></div>
        </section>
      </div>

      <div class="stack">
        <section class="panel">
          <div class="panel-head wallet-balance-head">
            <div>
              <p class="panel-kicker">Wallet</p>
              <h2>钱包余额</h2>
            </div>
          </div>
          <div id="balances" class="balance-grid"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <p class="panel-kicker">Create</p>
              <h2>创建卖单</h2>
            </div>
          </div>
          <form id="createOrderForm" class="form">
            <label>
              <span>AXON 数量</span>
              <input name="amountAxon" type="number" min="0" step="0.0001" placeholder="100" required />
            </label>
            <label>
              <span>单价（USD）</span>
              <input name="priceUsd" type="number" min="0" step="0.000001" placeholder="0.02" required />
            </label>
            <label>
              <span>付款链</span>
              <select name="paymentChainId">
                <option value="56">BSC</option>
              </select>
            </label>
            <label>
              <span>稳定币</span>
              <select name="paymentToken">
                <option value="USDT">USDT</option>
                <option value="USDC">USDC</option>
              </select>
            </label>
            <label>
              <span>收款地址</span>
              <input name="sellerPaymentAddr" type="text" placeholder="默认使用当前钱包地址" />
            </label>
            <button type="submit" class="button button-primary">在 Axon 上创建卖单</button>
          </form>
        </section>

        <section class="panel hidden-prototype">
          <div class="panel-head">
            <div>
              <p class="panel-kicker">Prototype</p>
              <h2>挂买单</h2>
            </div>
          </div>
          <form id="createBuyOrderForm" class="form">
            <label>
              <span>期望购买 AXON 数量</span>
              <input name="amountAxon" type="number" min="0" step="0.0001" placeholder="100" required />
            </label>
            <label>
              <span>目标单价（USD）</span>
              <input name="priceUsd" type="number" min="0" step="0.000001" placeholder="0.02" required />
            </label>
            <label>
              <span>付款链</span>
              <select name="paymentChainId">
                <option value="56">BSC</option>
              </select>
            </label>
            <label>
              <span>稳定币</span>
              <select name="paymentToken">
                <option value="USDT">USDT</option>
                <option value="USDC">USDC</option>
              </select>
            </label>
            <label>
              <span>付款地址</span>
              <input name="buyerPaymentAddr" type="text" placeholder="默认使用当前钱包地址" />
            </label>
            <button type="submit" class="button button-ghost">提交挂买单原型</button>
          </form>
          <div class="prototype-note">
            当前仅为前端原型入口。现网合约未开放 createBuyOrder，后续接入时可复用这套表单字段。
          </div>
        </section>

      </div>
    </section>

    <div id="orderDetailModal" class="modal-shell hidden" aria-hidden="true">
      <div id="orderDetailBackdrop" class="modal-backdrop"></div>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="orderDetailTitle">
        <div class="modal-head">
          <div>
            <p class="panel-kicker">Order Detail</p>
            <h2 id="orderDetailTitle">订单详情</h2>
          </div>
          <button id="orderDetailClose" class="button button-mini button-ghost" type="button">关闭</button>
        </div>
        <div id="orderDetailBody" class="modal-body"></div>
      </section>
    </div>

  </main>
`;

const ui = {
  connectButton: document.querySelector("#connectButton"),
  themeButton: document.querySelector("#themeButton"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshOrdersButton: document.querySelector("#refreshOrdersButton"),
  walletAddress: document.querySelector("#walletAddress"),
  walletChain: document.querySelector("#walletChain"),
  metricCards: document.querySelector("#metricCards"),
  statusBanner: document.querySelector("#statusBanner"),
  activeOrdersBody: document.querySelector("#activeOrdersBody"),
  activeOrdersPager: document.querySelector("#activeOrdersPager"),
  activeCount: document.querySelector("#activeCount"),
  bestPrice: document.querySelector("#bestPrice"),
  marketSearchForm: document.querySelector("#marketSearchForm"),
  marketSearchInput: document.querySelector("#marketSearchInput"),
  marketSearchReset: document.querySelector("#marketSearchReset"),
  balances: document.querySelector("#balances"),
  createOrderForm: document.querySelector("#createOrderForm"),
  createBuyOrderForm: document.querySelector("#createBuyOrderForm"),
  keeperUrlInput: document.querySelector("#keeperUrlInput"),
  paymentPathInput: document.querySelector("#paymentPathInput"),
  myOrdersBody: document.querySelector("#myOrdersBody"),
  myOrdersCount:
    document.querySelector("#myOrdersCount") ||
    document.querySelector(".history-panel .inline-meta span"),
  priceChart: document.querySelector("#priceChart"),
  priceChartMeta: document.querySelector("#priceChartMeta"),
  priceChartInterval: document.querySelector("#priceChartInterval"),
  orderDetailModal: document.querySelector("#orderDetailModal"),
  orderDetailBackdrop: document.querySelector("#orderDetailBackdrop"),
  orderDetailClose: document.querySelector("#orderDetailClose"),
  orderDetailBody: document.querySelector("#orderDetailBody"),
  networkHistoryBody: document.querySelector("#networkHistoryBody"),
  networkHistoryCount: document.querySelector("#networkHistoryCount"),
  networkHistoryPager: document.querySelector("#networkHistoryPager"),
  networkHistorySearchForm: document.querySelector("#networkHistorySearchForm"),
  networkHistorySearchInput: document.querySelector("#networkHistorySearchInput"),
  networkHistorySearchReset: document.querySelector("#networkHistorySearchReset"),
};

const formatAddress = (value) => (value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "-");
const shortTx = (hash) => `${hash.slice(0, 10)}...${hash.slice(-8)}`;
const formatUsd = (value) =>
  Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const formatPrice = (raw) =>
  Number.parseFloat(ethers.formatUnits(raw, 6)).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
const formatDate = (timestamp) => {
  if (!timestamp) return "-";
  return new Date(Number(timestamp) * 1000).toLocaleString("zh-CN", { hour12: false });
};
const formatDetailAddress = (value) => safeText(value, "-");
const formatBucketLabel = (timestamp, bucketSeconds) => {
  const date = new Date(Number(timestamp) * 1000);
  if (bucketSeconds >= 86400) {
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }
  if (bucketSeconds >= 21600) {
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
  }
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
};
const safeText = (value, fallback = "-") => {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    if (typeof value.label === "string") return value.label;
    if (typeof value.name === "string") return value.name;
    if (typeof value.value === "string" || typeof value.value === "number") {
      return String(value.value);
    }
  }
  return fallback;
};

const getRemainingLockSeconds = (lockedUntil) =>
  Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));

const withTemporaryButtonLock = (button) => {
  if (!button) return;
  button.disabled = true;
  window.setTimeout(() => {
    button.disabled = false;
  }, REPEAT_CLICK_LOCK_MS);
};

const getQueryLockRemainingSeconds = (key) => {
  const lockedUntil = appState.interactionLocks.queryUntilByKey[key] || 0;
  if (lockedUntil <= Date.now()) return 0;
  return getRemainingLockSeconds(lockedUntil);
};

const remindQueryCooldown = (label, remaining) => {
  setStatus("error", `${label}冷却中，请 ${remaining} 秒后再试`);
  window.alert(appState.status.text);
};

const lockQueryAction = (key) => {
  appState.interactionLocks.queryUntilByKey[key] = Date.now() + REPEAT_CLICK_LOCK_MS;
};

const beginQueryAction = (key, label, button = null) => {
  const remaining = getQueryLockRemainingSeconds(key);
  if (remaining > 0) {
    remindQueryCooldown(label, remaining);
    return false;
  }
  lockQueryAction(key);
  withTemporaryButtonLock(button);
  return true;
};

const buildApiQuery = (params) =>
  new URLSearchParams(
    Object.entries(params).reduce((acc, [key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        acc[key] = String(value);
      }
      return acc;
    }, {})
  ).toString();

const setStatus = (kind, text) => {
  appState.status = { kind, text };
  ui.statusBanner.className = `notice notice-${kind}`;
  ui.statusBanner.textContent = text;
};

const applyTheme = () => {
  document.documentElement.dataset.theme = appState.theme;
  ui.themeButton.textContent = appState.theme === "dark" ? "浅色模式" : "夜间模式";
};

const getWalletProvider = () => {
  if (window.okxwallet?.request) return window.okxwallet;
  if (window.okxwallet?.ethereum?.request) return window.okxwallet.ethereum;
  if (window.ethereum?.isOkxWallet) return window.ethereum;
  return null;
};

const normalizeApiOrder = (order) => ({
  ...order,
  id: Number(order.id),
  seller: safeText(order.seller, ""),
  buyer: safeText(order.buyer, ""),
  amountAxon: Number(order.amount_axon),
  amountAxonWei: String(order.amount_axon_wei),
  priceUsd: Number(order.price_usd),
  priceUsdRaw: String(order.price_usd_raw),
  totalPayment: Number(order.total_payment),
  paymentChainId: Number(order.payment_chain_id),
  paymentChainName: safeText(order.payment_chain_name),
  paymentToken: safeText(order.payment_token),
  sellerPaymentAddr: safeText(order.seller_payment_addr, ""),
  status: Number(order.status),
  statusLabel: safeText(order.status_label, STATUS_LABELS[Number(order.status)] || "Unknown"),
  createdAt: Number(order.created_at),
  cancelRequestedAt: Number(order.cancel_requested_at),
  role: safeText(order.role, ""),
});

const fetchApiJson = async (path) => {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail || `HTTP ${response.status}`);
  }
  return response.json();
};

const fetchApiJsonWithTimeout = async (path, timeoutMs = 60000) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail || `HTTP ${response.status}`);
    }
    return response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("请求超时");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const renderWallet = () => {
  ui.walletAddress.textContent = appState.account ? appState.account : "未连接";
  ui.walletChain.textContent = appState.currentChainId
    ? CHAINS[appState.currentChainId]?.label ?? `Chain ${appState.currentChainId}`
    : "-";
  ui.connectButton.textContent = appState.account ? "断开连接" : "连接钱包";
};

const renderMetrics = () => {
  const best = [...appState.activeOrders].sort(
    (left, right) => Number(left.priceUsdRaw) - Number(right.priceUsdRaw)
  )[0];
  ui.metricCards.innerHTML = [
    {
      label: "活跃卖单",
      value: `${appState.market.total || appState.metrics.activeTotal || 0}`,
      hint: "本地后端实时拉取",
    },
    {
      label: "最优单价",
      value: best ? `$${formatPrice(best.priceUsdRaw)}` : "-",
      hint: best ? `订单 #${best.id}` : "暂无订单",
    },
    {
      label: "手续费",
      value:
        appState.metrics.feeRateBps === null
          ? "-"
          : `${(Number(appState.metrics.feeRateBps) / 100).toFixed(2)}%`,
      hint: "成交时从 AXON 中扣除",
    },
    {
      label: "取消冷却",
      value:
        appState.metrics.cancelCooldown === null
          ? "-"
          : `${Math.round(Number(appState.metrics.cancelCooldown) / 60)} min`,
      hint: "卖方请求取消后生效",
    },
  ]
    .map(
      (item) => `
        <article class="metric-card">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
          <small>${item.hint}</small>
        </article>
      `
    )
    .join("");

  ui.activeCount.textContent = `${appState.market.total || 0} 笔`;
  ui.bestPrice.textContent = best ? `最优价 $${formatPrice(best.priceUsdRaw)}` : "最优价 -";
};

const getSortIndicator = (field) => {
  if (appState.market.sortKey !== field) return "";
  return appState.market.sortDirection === "asc" ? " ↑" : " ↓";
};

const getNetworkHistorySortIndicator = (field) => {
  if (appState.networkHistory.sortKey !== field) return "";
  return appState.networkHistory.sortDirection === "asc" ? " ↑" : " ↓";
};

const renderActiveOrders = () => {
  if (ui.marketSearchInput && ui.marketSearchInput.value !== appState.market.query) {
    ui.marketSearchInput.value = appState.market.query;
  }
  document.querySelectorAll("[data-sort-field]").forEach((button) => {
    const field = button.dataset.sortField;
    button.textContent = `${SORTABLE_MARKET_FIELDS[field]}${getSortIndicator(field)}`;
    button.classList.toggle("is-active", appState.market.sortKey === field);
  });

  if (appState.loading.market && !appState.activeOrders.length) {
    ui.activeOrdersBody.innerHTML =
      '<tr><td colspan="8" class="empty">正在加载活跃订单...</td></tr>';
    return;
  }
  if (appState.errors.market && !appState.activeOrders.length) {
    ui.activeOrdersBody.innerHTML = `<tr><td colspan="8" class="empty">${appState.errors.market}</td></tr>`;
    return;
  }
  if (!appState.activeOrders.length) {
    ui.activeOrdersBody.innerHTML =
      '<tr><td colspan="8" class="empty">当前没有活跃订单。</td></tr>';
    return;
  }

  ui.activeOrdersBody.innerHTML = appState.activeOrders
    .map(
      (order) => `
        <tr data-order-row="${order.id}">
          <td>#${order.id}</td>
          <td class="address-cell" title="${order.seller}">${order.seller}</td>
          <td>${formatUsd(order.amountAxon)} AXON</td>
          <td>$${formatPrice(order.priceUsdRaw)}</td>
          <td>${formatUsd(order.totalPayment)} ${order.paymentToken}</td>
          <td>${CHAINS[order.paymentChainId]?.label ?? order.paymentChainId}</td>
          <td><span class="pill">${order.statusLabel}</span></td>
          <td class="action-cell">
            <button class="button button-mini button-primary" data-buy="${order.id}">买入</button>
          </td>
        </tr>
      `
    )
    .join("");
};

const renderActiveOrdersPager = () => {
  const total = Number(appState.market.total || 0);
  const pageSize = Number(appState.market.pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(appState.market.page, totalPages);
  const start = total ? (currentPage - 1) * pageSize + 1 : 0;
  const end = total ? Math.min(currentPage * pageSize, total) : 0;

  ui.activeOrdersPager.innerHTML = `
    <div class="pager-meta">显示 ${start}-${end} / ${total}</div>
    <div class="pager-actions">
      <button class="button button-mini button-ghost" data-market-page="prev" ${currentPage <= 1 ? "disabled" : ""}>上一页</button>
      <span class="pager-current">第 ${currentPage} / ${totalPages} 页</span>
      <button class="button button-mini button-ghost" data-market-page="next" ${currentPage >= totalPages ? "disabled" : ""}>下一页</button>
    </div>
  `;
};

const renderMyOrders = () => {
  if (ui.myOrdersCount) ui.myOrdersCount.textContent = `历史订单 ${appState.history.total || 0} 笔`;
  if (!appState.account) {
    ui.myOrdersBody.innerHTML =
      '<tr><td colspan="7" class="empty">连接钱包后显示你的历史订单。</td></tr>';
    return;
  }
  if (appState.loading.history && !appState.myOrders.length) {
    ui.myOrdersBody.innerHTML =
      '<tr><td colspan="7" class="empty">正在加载历史订单...</td></tr>';
    return;
  }
  if (appState.errors.history && !appState.myOrders.length) {
    ui.myOrdersBody.innerHTML = `<tr><td colspan="7" class="empty">${appState.errors.history}</td></tr>`;
    return;
  }
  if (!appState.myOrders.length) {
    ui.myOrdersBody.innerHTML =
      '<tr><td colspan="7" class="empty">当前地址还没有订单历史。</td></tr>';
    return;
  }

  ui.myOrdersBody.innerHTML = appState.myOrders
    .map((order) => {
      const actions = [];
      if (order.role === "Seller" && order.status === 0) {
        actions.push(
          `<button class="button button-mini button-ghost" data-cancel-request="${order.id}">请求取消</button>`
        );
      }
      if (order.role === "Seller" && order.status === 2) {
        actions.push(
          `<button class="button button-mini button-ghost" data-cancel-finalize="${order.id}">完成取消</button>`
        );
        actions.push(
          `<button class="button button-mini button-ghost" data-abort-cancel="${order.id}">撤销取消</button>`
        );
      }
      return `
        <tr data-order-row="${order.id}">
          <td>#${order.id}</td>
          <td>${order.role || "-"}</td>
          <td>${formatUsd(order.amountAxon)} AXON</td>
          <td>${formatUsd(order.totalPayment)} ${order.paymentToken}</td>
          <td><span class="pill">${order.statusLabel}</span></td>
          <td>${formatDate(order.createdAt)}</td>
          <td class="action-cell">${actions.join("") || "<span class='muted'>-</span>"}</td>
        </tr>
      `;
    })
    .join("");
};

const renderNetworkHistoryOrders = () => {
  if (ui.priceChartInterval && ui.priceChartInterval.value !== appState.priceChart.interval) {
    ui.priceChartInterval.value = appState.priceChart.interval;
  }
  if (
    ui.networkHistorySearchInput &&
    ui.networkHistorySearchInput.value !== appState.networkHistory.query
  ) {
    ui.networkHistorySearchInput.value = appState.networkHistory.query;
  }
  document.querySelectorAll("[data-network-sort-field]").forEach((button) => {
    const field = button.dataset.networkSortField;
    button.textContent = `${NETWORK_HISTORY_SORT_FIELDS[field]}${getNetworkHistorySortIndicator(field)}`;
    button.classList.toggle("is-active", appState.networkHistory.sortKey === field);
  });

  ui.networkHistoryCount.textContent = `全网历史 ${appState.networkHistory.total || 0} 笔`;
  if (appState.loading.networkHistory && !appState.networkHistoryOrders.length) {
    ui.networkHistoryBody.innerHTML =
      '<tr><td colspan="7" class="empty">正在加载全网历史订单...</td></tr>';
    return;
  }
  if (appState.errors.networkHistory && !appState.networkHistoryOrders.length) {
    ui.networkHistoryBody.innerHTML =
      `<tr><td colspan="7" class="empty">${appState.errors.networkHistory}</td></tr>`;
    return;
  }
  if (!appState.networkHistoryOrders.length) {
    ui.networkHistoryBody.innerHTML =
      '<tr><td colspan="7" class="empty">当前还没有全网历史订单。</td></tr>';
    return;
  }

  ui.networkHistoryBody.innerHTML = appState.networkHistoryOrders
    .map(
      (order) => `
        <tr data-order-row="${order.id}">
          <td>#${order.id}</td>
          <td class="address-cell" title="${order.seller}">${order.seller}</td>
          <td class="address-cell" title="${order.buyer}">${order.buyer}</td>
          <td>${formatUsd(order.amountAxon)} AXON</td>
          <td>${formatUsd(order.totalPayment)} ${order.paymentToken}</td>
          <td><span class="pill">${order.statusLabel}</span></td>
          <td>${formatDate(order.createdAt)}</td>
        </tr>
      `
    )
    .join("");
};

const renderOrderDetailModal = () => {
  const isOpen = appState.orderDetail.open;
  ui.orderDetailModal?.classList.toggle("hidden", !isOpen);
  ui.orderDetailModal?.setAttribute("aria-hidden", String(!isOpen));
  if (!ui.orderDetailBody) return;

  if (appState.orderDetail.loading) {
    ui.orderDetailBody.innerHTML = '<div class="empty-card">正在加载订单详情...</div>';
    return;
  }

  if (appState.orderDetail.error) {
    ui.orderDetailBody.innerHTML = `<div class="empty-card">${appState.orderDetail.error}</div>`;
    return;
  }

  const order = appState.orderDetail.order;
  if (!order) {
    ui.orderDetailBody.innerHTML = '<div class="empty-card">暂无订单详情。</div>';
    return;
  }

  ui.orderDetailBody.innerHTML = `
    <div class="detail-grid">
      <article class="detail-item"><span>订单号</span><strong>#${order.id}</strong></article>
      <article class="detail-item"><span>状态</span><strong>${order.statusLabel}</strong></article>
      <article class="detail-item"><span>AXON 数量</span><strong>${formatUsd(order.amountAxon)} AXON</strong></article>
      <article class="detail-item"><span>单价</span><strong>$${formatPrice(order.priceUsdRaw)}</strong></article>
      <article class="detail-item"><span>总价</span><strong>${formatUsd(order.totalPayment)} ${order.paymentToken}</strong></article>
      <article class="detail-item"><span>支付链</span><strong>${CHAINS[order.paymentChainId]?.label ?? order.paymentChainId}</strong></article>
      <article class="detail-item detail-item-wide"><span>卖方地址</span><strong class="detail-address">${formatDetailAddress(order.seller)}</strong></article>
      <article class="detail-item detail-item-wide"><span>买方地址</span><strong class="detail-address">${formatDetailAddress(order.buyer)}</strong></article>
      <article class="detail-item detail-item-wide"><span>卖方收款地址</span><strong class="detail-address">${formatDetailAddress(order.sellerPaymentAddr)}</strong></article>
      <article class="detail-item"><span>创建时间</span><strong>${formatDate(order.createdAt)}</strong></article>
      <article class="detail-item"><span>取消请求时间</span><strong>${formatDate(order.cancelRequestedAt)}</strong></article>
      <article class="detail-item"><span>角色</span><strong>${safeText(order.role, "-")}</strong></article>
    </div>
    ${
      Number(order.status) === 0
        ? `
          <div class="modal-actions">
            <button class="button button-primary" data-detail-buy="${order.id}">买入该订单</button>
          </div>
        `
        : ""
    }
  `;
};

const renderPriceChart = () => {
  const intervalMeta = CHART_INTERVALS[appState.priceChart.interval] || CHART_INTERVALS.hour;
  ui.priceChartMeta.textContent = `按已成交订单聚合 | ${intervalMeta.label} | ${appState.priceChart.tradeCount} 笔成交`;

  if (appState.loading.priceChart && !appState.priceChart.candles.length) {
    ui.priceChart.innerHTML = '<div class="empty-card">正在生成成交价 K 线...</div>';
    return;
  }
  if (appState.errors.priceChart && !appState.priceChart.candles.length) {
    ui.priceChart.innerHTML = `<div class="empty-card">${appState.errors.priceChart}</div>`;
    return;
  }
  if (!appState.priceChart.candles.length) {
    ui.priceChart.innerHTML = '<div class="empty-card">成交数据不足，暂时无法绘制 K 线。</div>';
    return;
  }

  const candles = appState.priceChart.candles;
  const width = 920;
  const height = 320;
  const pad = { top: 24, right: 16, bottom: 34, left: 60 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const low = Math.min(...candles.map((item) => item.low));
  const high = Math.max(...candles.map((item) => item.high));
  const range = Math.max(high - low, 0.000001);
  const candleSlot = plotWidth / Math.max(candles.length, 1);
  const candleWidth = Math.max(6, Math.min(22, candleSlot * 0.55));
  const priceToY = (price) => pad.top + ((high - price) / range) * plotHeight;
  const xForIndex = (index) => pad.left + candleSlot * index + candleSlot / 2;

  const gridValues = Array.from({ length: 5 }, (_, index) => low + (range * index) / 4);
  const yLabels = gridValues
    .map((value) => {
      const y = priceToY(value);
      return `
        <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="chart-grid-line" />
        <text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" class="chart-axis-label">$${value.toFixed(4)}</text>
      `;
    })
    .join("");

  const xLabels = candles
    .filter((_, index) => index === 0 || index === candles.length - 1 || index % Math.ceil(candles.length / 4) === 0)
    .map((candle) => `
      <text x="${xForIndex(candle.index)}" y="${height - 10}" text-anchor="middle" class="chart-axis-label">
        ${formatBucketLabel(candle.timestamp, intervalMeta.bucketSeconds)}
      </text>
    `)
    .join("");

  const candleNodes = candles
    .map((candle, index) => {
      const x = xForIndex(index);
      const openY = priceToY(candle.open);
      const closeY = priceToY(candle.close);
      const highY = priceToY(candle.high);
      const lowY = priceToY(candle.low);
      const top = Math.min(openY, closeY);
      const bodyHeight = Math.max(Math.abs(closeY - openY), 2);
      const rising = candle.close >= candle.open;
      const bodyClass = rising ? "chart-candle-up" : "chart-candle-down";

      return `
        <g class="chart-candle-group">
          <line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" class="chart-wick ${bodyClass}" />
          <rect
            x="${x - candleWidth / 2}"
            y="${top}"
            width="${candleWidth}"
            height="${bodyHeight}"
            rx="3"
            class="chart-body ${bodyClass}"
          />
          <title>${formatBucketLabel(candle.timestamp, intervalMeta.bucketSeconds)} | O ${candle.open.toFixed(4)} H ${candle.high.toFixed(4)} L ${candle.low.toFixed(4)} C ${candle.close.toFixed(4)}</title>
        </g>
      `;
    })
    .join("");

  const latest = candles[candles.length - 1];
  ui.priceChart.innerHTML = `
    <div class="trade-chart-summary">
      <span>最新收盘</span>
      <strong>$${latest.close.toFixed(4)}</strong>
      <small>区间最高 $${high.toFixed(4)} / 最低 $${low.toFixed(4)}</small>
    </div>
    <div class="trade-chart-stage">
      <svg viewBox="0 0 ${width} ${height}" class="trade-chart-svg" role="img" aria-label="成交价 K 线图">
        ${yLabels}
        ${candleNodes}
        ${xLabels}
      </svg>
      <div class="trade-chart-crosshair" hidden>
        <div class="trade-chart-crosshair-x"></div>
        <div class="trade-chart-crosshair-y"></div>
        <div class="trade-chart-tooltip"></div>
        <div class="trade-chart-price-tag"></div>
      </div>
    </div>
  `;

  const stage = ui.priceChart.querySelector(".trade-chart-stage");
  const crosshair = ui.priceChart.querySelector(".trade-chart-crosshair");
  const crosshairX = ui.priceChart.querySelector(".trade-chart-crosshair-x");
  const crosshairY = ui.priceChart.querySelector(".trade-chart-crosshair-y");
  const tooltip = ui.priceChart.querySelector(".trade-chart-tooltip");
  const priceTag = ui.priceChart.querySelector(".trade-chart-price-tag");

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const yToPrice = (y) => high - ((y - pad.top) / plotHeight) * range;

  const updateCrosshair = (clientX, clientY) => {
    const rect = stage.getBoundingClientRect();
    const localX = ((clientX - rect.left) / rect.width) * width;
    const localY = ((clientY - rect.top) / rect.height) * height;
    const boundedX = clamp(localX, pad.left, width - pad.right);
    const boundedY = clamp(localY, pad.top, height - pad.bottom);
    const candleIndex = clamp(Math.floor((boundedX - pad.left) / candleSlot), 0, candles.length - 1);
    const candle = candles[candleIndex];
    const candleX = xForIndex(candleIndex);
    const price = yToPrice(boundedY);

    crosshair.hidden = false;
    crosshairX.style.left = `${(candleX / width) * 100}%`;
    crosshairY.style.top = `${(boundedY / height) * 100}%`;
    priceTag.style.top = `${(boundedY / height) * 100}%`;
    priceTag.textContent = `$${price.toFixed(4)}`;

    const tooltipLeft = candleX / width > 0.72 ? "auto" : `${(candleX / width) * 100}%`;
    const tooltipRight = candleX / width > 0.72 ? `${((width - candleX) / width) * 100}%` : "auto";
    tooltip.style.left = tooltipLeft;
    tooltip.style.right = tooltipRight;
    tooltip.innerHTML = `
      <strong>${formatBucketLabel(candle.timestamp, intervalMeta.bucketSeconds)}</strong>
      <span>价格 $${price.toFixed(4)}</span>
    `;
  };

  stage.addEventListener("mousemove", (event) => {
    updateCrosshair(event.clientX, event.clientY);
  });
  stage.addEventListener("mouseenter", (event) => {
    updateCrosshair(event.clientX, event.clientY);
  });
  stage.addEventListener("mouseleave", () => {
    crosshair.hidden = true;
  });
};

const renderNetworkHistoryPager = () => {
  const total = Number(appState.networkHistory.total || 0);
  const pageSize = Number(appState.networkHistory.pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(appState.networkHistory.page, totalPages);
  const start = total ? (currentPage - 1) * pageSize + 1 : 0;
  const end = total ? Math.min(currentPage * pageSize, total) : 0;

  ui.networkHistoryPager.innerHTML = `
    <div class="pager-meta">显示 ${start}-${end} / ${total}</div>
    <div class="pager-actions">
      <button class="button button-mini button-ghost" data-network-history-page="prev" ${currentPage <= 1 ? "disabled" : ""}>上一页</button>
      <span class="pager-current">第 ${currentPage} / ${totalPages} 页</span>
      <button class="button button-mini button-ghost" data-network-history-page="next" ${currentPage >= totalPages ? "disabled" : ""}>下一页</button>
    </div>
  `;
};

const renderBalances = () => {
  if (!appState.account) {
    ui.balances.innerHTML = '<div class="empty-card">连接钱包后查看 Axon 与 BSC 余额。</div>';
    return;
  }
  if (appState.loading.balances && !appState.balances.length) {
    ui.balances.innerHTML = '<div class="empty-card">正在加载钱包余额...</div>';
    return;
  }
  if (appState.errors.balances && !appState.balances.length) {
    ui.balances.innerHTML = `<div class="empty-card">${appState.errors.balances}</div>`;
    return;
  }

  const grouped = appState.balances
    .filter((item) => !HIDDEN_CHAIN_IDS.has(Number(item.chainId)))
    .reduce((acc, item) => {
      if (!acc[item.chainId]) {
        acc[item.chainId] = {
          chainId: item.chainId,
          chainName: item.chainName,
          items: [],
        };
      }
      acc[item.chainId].items.push(item);
      return acc;
    }, {});

  const chainCards = Object.values(grouped).sort((left, right) => {
    if (left.chainName === "Axon") return -1;
    if (right.chainName === "Axon") return 1;
    return Number(left.chainId) - Number(right.chainId);
  });

  ui.balances.innerHTML = chainCards
    .map(
      (group) => `
        <section class="balance-chain-card ${group.chainName === "Axon" ? "balance-chain-card-axon" : ""}">
          <header class="balance-chain-head">
            <div>
              <span class="balance-chain-kicker">Chain</span>
              <strong>${group.chainName}</strong>
            </div>
          </header>
          <div class="balance-chain-assets">
            ${group.items
              .map(
                (item) => `
                  <article class="balance-asset-row">
                    <div>
                      <span>${item.asset}</span>
                      <small>${item.hint}</small>
                    </div>
                    <strong>${item.balanceText}</strong>
                  </article>
                `
              )
              .join("")}
          </div>
        </section>
      `
    )
    .join("");

  if (appState.errors.balances) {
    ui.balances.innerHTML += `<div class="empty-card">${appState.errors.balances}</div>`;
  }
};

const renderAll = () => {
  applyTheme();
  renderWallet();
  renderMetrics();
  renderActiveOrders();
  renderActiveOrdersPager();
  renderMyOrders();
  renderPriceChart();
  renderNetworkHistoryOrders();
  renderNetworkHistoryPager();
  renderBalances();
  renderOrderDetailModal();
  setStatus(appState.status.kind, appState.status.text);
};

const bindProviderEvents = (() => {
  let bound = false;
  return (provider) => {
    if (!provider || bound || typeof provider.on !== "function") return;
    provider.on("accountsChanged", async (accounts) => {
      appState.account = accounts?.[0] ?? null;
      renderWallet();
      await refreshDataAjax("账户已切换，正在刷新数据...");
    });
    provider.on("chainChanged", async (chainIdHex) => {
      appState.currentChainId = Number.parseInt(chainIdHex, 16);
      renderWallet();
    });
    bound = true;
  };
})();

const ensureWalletChain = async (chainId) => {
  const provider = getWalletProvider();
  if (!provider) throw new Error("没有检测到 OKX Wallet。");
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`不支持的链: ${chainId}`);

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chain.chainIdHex }],
    });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chain.chainIdHex,
          chainName: chain.chainName,
          rpcUrls: chain.rpcUrls,
          nativeCurrency: chain.nativeCurrency,
          blockExplorerUrls: chain.blockExplorerUrls,
        },
      ],
    });
  }

  const browserProvider = new ethers.BrowserProvider(provider);
  const network = await browserProvider.getNetwork();
  appState.currentChainId = Number(network.chainId);
  renderWallet();
  return browserProvider;
};

const connectWallet = async () => {
  const provider = getWalletProvider();
  if (!provider) {
    throw new Error("没有检测到 OKX Wallet，请先安装并解锁浏览器插件。");
  }
  await provider.request({ method: "eth_requestAccounts" });
  const browserProvider = new ethers.BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  const network = await browserProvider.getNetwork();
  appState.account = await signer.getAddress();
  appState.currentChainId = Number(network.chainId);
  renderWallet();
  bindProviderEvents(provider);
  await refreshDataAjax("钱包已连接，正在拉取资产和订单...");
};

const disconnectWallet = () => {
  appState.account = null;
  appState.currentChainId = null;
  appState.myOrders = [];
  appState.balances = [];
  appState.history.total = 0;
  appState.loading.history = false;
  appState.loading.balances = false;
  appState.errors.history = "";
  appState.errors.balances = "";
  setStatus("info", "钱包已断开连接");
  renderAll();
};

const fetchMarket = async () => {
  const offset = (appState.market.page - 1) * appState.market.pageSize;
  const sortBy = MARKET_SORT_API_FIELDS[appState.market.sortKey];
  const sortDir = appState.market.sortDirection;
  const query = buildApiQuery({
    offset,
    limit: appState.market.pageSize,
    sort_by: sortBy,
    sort_dir: sortDir,
    query: appState.market.query.trim(),
  });

  const [summary, marketPayload] = await Promise.all([
    fetchApiJson("/market/summary"),
    fetchApiJson(`/orders/active?${query}`),
  ]);

  appState.metrics.activeTotal = Number(summary.active_total || 0);
  appState.metrics.nextOrderId = Number(summary.next_order_id || 0);
  appState.metrics.feeRateBps = Number(summary.fee_rate_bps || 0);
  appState.metrics.cancelCooldown = Number(summary.cancel_cooldown || 0);
  appState.market.total = Number(marketPayload.total || 0);
  appState.activeOrders = (marketPayload.items || []).map(normalizeApiOrder);
};

const fetchMyOrders = async () => {
  if (!appState.account) {
    appState.myOrders = [];
    return;
  }
  const payload = await fetchApiJson(`/addresses/${appState.account}/orders`);
  appState.history.total = Number(payload.items?.length || 0);
  appState.myOrders = (payload.items || [])
    .map(normalizeApiOrder)
    .sort((left, right) => right.id - left.id);
};

const fetchOrderDetail = async (orderId) => {
  const payload = await fetchApiJson(`/orders/${orderId}`);
  return normalizeApiOrder(payload);
};

const openOrderDetail = async (orderId) => {
  appState.orderDetail.open = true;
  appState.orderDetail.loading = true;
  appState.orderDetail.error = "";
  appState.orderDetail.order = null;
  renderOrderDetailModal();
  try {
    appState.orderDetail.order = await fetchOrderDetail(orderId);
  } catch (error) {
    appState.orderDetail.error = error.message || "订单详情加载失败";
  } finally {
    appState.orderDetail.loading = false;
    renderOrderDetailModal();
  }
};

const closeOrderDetail = () => {
  appState.orderDetail.open = false;
  appState.orderDetail.loading = false;
  appState.orderDetail.error = "";
  appState.orderDetail.order = null;
  renderOrderDetailModal();
};

const fetchNetworkHistoryOrders = async () => {
  const offset = (appState.networkHistory.page - 1) * appState.networkHistory.pageSize;
  const sortBy =
    NETWORK_HISTORY_SORT_API_FIELDS[appState.networkHistory.sortKey] || "created_at";
  const sortDir = appState.networkHistory.sortDirection || "desc";
  const query = buildApiQuery({
    offset,
    limit: appState.networkHistory.pageSize,
    sort_by: sortBy,
    sort_dir: sortDir,
    query: appState.networkHistory.query.trim(),
  });
  const payload = await fetchApiJson(`/orders/history?${query}`);
  appState.networkHistory.total = Number(payload.total || 0);
  appState.networkHistoryOrders = (payload.items || []).map(normalizeApiOrder);
};

const buildCandlesFromOrders = (orders, bucketSeconds) => {
  const completedOrders = orders
    .filter((order) => Number(order.status) === 1 && Number(order.priceUsdRaw) > 0 && Number(order.createdAt) > 0)
    .sort((left, right) => left.createdAt - right.createdAt);

  if (!completedOrders.length) {
    return { candles: [], tradeCount: 0 };
  }

  const grouped = new Map();
  for (const order of completedOrders) {
    const timestamp = Math.floor(order.createdAt / bucketSeconds) * bucketSeconds;
    const price = Number(ethers.formatUnits(order.priceUsdRaw, 6));
    if (!grouped.has(timestamp)) {
      grouped.set(timestamp, []);
    }
    grouped.get(timestamp).push(price);
  }

  const candles = Array.from(grouped.entries())
    .sort((left, right) => left[0] - right[0])
    .slice(-48)
    .map(([timestamp, prices], index) => ({
      index,
      timestamp,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
    }));

  return { candles, tradeCount: completedOrders.length };
};

const fetchPriceChart = async () => {
  const bucketSeconds = CHART_INTERVALS[appState.priceChart.interval]?.bucketSeconds || 3600;
  const query = buildApiQuery({
    offset: 0,
    limit: 400,
    sort_by: "created_at",
    sort_dir: "asc",
  });
  const payload = await fetchApiJson(`/orders/history?${query}`);
  const orders = (payload.items || []).map(normalizeApiOrder);
  const { candles, tradeCount } = buildCandlesFromOrders(orders, bucketSeconds);
  appState.priceChart.candles = candles;
  appState.priceChart.tradeCount = tradeCount;
};

const withBalanceTimeout = async (promise, timeoutMs = 60000) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("请求超时")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const formatBalanceItem = (chainId, asset, balance) => ({
  chainId,
  chainName: String(CHAINS[chainId]?.label || chainId),
  asset: String(asset),
  balance: Number(balance),
  balanceText: `${formatUsd(balance)} ${asset}`,
  hint:
    asset === CHAINS[chainId]?.nativeSymbol
      ? `地址 ${formatAddress(appState.account)}`
      : `${CHAINS[chainId]?.label || chainId} 资产`,
});

const fetchBalancesForChainViaApi = async (chainId) => {
  const payload = await fetchApiJsonWithTimeout(
    `/addresses/${appState.account}/balances?chain_id=${encodeURIComponent(chainId)}`,
    60000
  );
  return (payload.items || []).map((item) =>
    formatBalanceItem(Number(item.chain_id), item.asset, Number(item.balance))
  );
};

const fetchBalancesForChain = async (chainId) => {
  if (!appState.account) {
    return [];
  }
  if (chainId === 8210) {
    return fetchBalancesForChainViaApi(chainId);
  }
  try {
    const provider = getReadProvider(chainId);
    if (!provider) {
      throw new Error(`未配置 ${CHAINS[chainId]?.label || chainId} RPC`);
    }

    const nativeSymbol = CHAINS[chainId]?.nativeSymbol;
    const items = [];

    const nativeBalance = await withBalanceTimeout(provider.getBalance(appState.account), 60000);
    items.push(formatBalanceItem(chainId, nativeSymbol, Number(ethers.formatEther(nativeBalance))));

    const tokenMap = TOKENS[chainId] || {};
    for (const [symbol, tokenMeta] of Object.entries(tokenMap)) {
      const contract = new ethers.Contract(tokenMeta.address, ERC20_ABI, provider);
      const rawBalance = await withBalanceTimeout(contract.balanceOf(appState.account), 60000);
      items.push(
        formatBalanceItem(
          chainId,
          symbol,
          Number(ethers.formatUnits(rawBalance, tokenMeta.decimals))
        )
      );
    }

    return items;
  } catch (error) {
    console.warn(`Direct RPC balance read failed for chain ${chainId}, falling back to backend API.`, error);
    return fetchBalancesForChainViaApi(chainId);
  }
};

const loadMarket = async () => {
  const requestId = ++appState.requests.market;
  appState.loading.market = true;
  appState.errors.market = "";
  renderActiveOrders();
  try {
    await fetchMarket();
    if (requestId !== appState.requests.market) return;
  } catch (error) {
    if (requestId !== appState.requests.market) return;
    appState.activeOrders = [];
    appState.market.total = 0;
    appState.errors.market = error.message || "活跃订单加载失败";
    throw error;
  } finally {
    if (requestId === appState.requests.market) {
      appState.loading.market = false;
      renderMetrics();
      renderActiveOrders();
      renderActiveOrdersPager();
    }
  }
};

const loadMyOrders = async () => {
  const requestId = ++appState.requests.history;
  appState.loading.history = true;
  appState.errors.history = "";
  renderMyOrders();
  try {
    await fetchMyOrders();
    if (requestId !== appState.requests.history) return;
  } catch (error) {
    if (requestId !== appState.requests.history) return;
    appState.myOrders = [];
    appState.errors.history = error.message || "历史订单加载失败";
    throw error;
  } finally {
    if (requestId === appState.requests.history) {
      appState.loading.history = false;
      renderMyOrders();
    }
  }
};

const loadPriceChart = async () => {
  const requestId = ++appState.requests.priceChart;
  appState.loading.priceChart = true;
  appState.errors.priceChart = "";
  renderPriceChart();
  try {
    await fetchPriceChart();
    if (requestId !== appState.requests.priceChart) return;
  } catch (error) {
    if (requestId !== appState.requests.priceChart) return;
    appState.priceChart.candles = [];
    appState.priceChart.tradeCount = 0;
    appState.errors.priceChart = error.message || "成交价 K 线加载失败";
    throw error;
  } finally {
    if (requestId === appState.requests.priceChart) {
      appState.loading.priceChart = false;
      renderPriceChart();
    }
  }
};

const loadNetworkHistory = async () => {
  const requestId = ++appState.requests.networkHistory;
  appState.loading.networkHistory = true;
  appState.errors.networkHistory = "";
  renderNetworkHistoryOrders();
  renderNetworkHistoryPager();
  try {
    await fetchNetworkHistoryOrders();
    if (requestId !== appState.requests.networkHistory) return;
  } catch (error) {
    if (requestId !== appState.requests.networkHistory) return;
    appState.networkHistoryOrders = [];
    appState.networkHistory.total = 0;
    appState.errors.networkHistory = error.message || "全网历史订单加载失败";
    throw error;
  } finally {
    if (requestId === appState.requests.networkHistory) {
      appState.loading.networkHistory = false;
      renderNetworkHistoryOrders();
      renderNetworkHistoryPager();
    }
  }
};

const loadBalances = async () => {
  const requestId = ++appState.requests.balances;
  appState.loading.balances = Boolean(appState.account);
  appState.errors.balances = "";
  appState.balances = [];
  renderBalances();
  try {
    if (!appState.account) return;

    const chainIds = [8210, 56];
    const errors = [];

    await Promise.all(
      chainIds.map(async (chainId) => {
        try {
          const items = await fetchBalancesForChain(chainId);
          if (requestId !== appState.requests.balances) return;
          const otherItems = appState.balances.filter((item) => Number(item.chainId) !== chainId);
          appState.balances = [...otherItems, ...items].sort(
            (left, right) =>
              (left.chainId === 8210 ? 0 : left.chainId) - (right.chainId === 8210 ? 0 : right.chainId) ||
              left.asset.localeCompare(right.asset)
          );
          renderBalances();
        } catch (error) {
          if (requestId !== appState.requests.balances) return;
          errors.push(`${CHAINS[chainId]?.label || chainId}: ${error.message || "加载失败"}`);
        }
      })
    );

    if (requestId !== appState.requests.balances) return;
    appState.errors.balances = errors.join(" | ");
  } catch (error) {
    if (requestId !== appState.requests.balances) return;
    appState.balances = [];
    appState.errors.balances = error.message || "余额加载失败";
    throw error;
  } finally {
    if (requestId === appState.requests.balances) {
      appState.loading.balances = false;
      renderBalances();
    }
  }
};

const refreshDataAjax = async (message = "正在刷新市场数据...") => {
  setStatus("info", message);
  const results = await Promise.allSettled([
    loadMarket(),
    loadMyOrders(),
    loadPriceChart(),
    loadNetworkHistory(),
    loadBalances(),
  ]);
  const failed = results.find((item) => item.status === "rejected");
  if (failed) {
    setStatus("error", failed.reason?.message || "部分数据加载失败");
  } else {
    setStatus("success", "链上数据已更新");
  }
};

const refreshOrdersOnly = async (message = "正在刷新活跃订单...") => {
  setStatus("info", message);
  try {
    await loadMarket();
    setStatus("success", "活跃订单已更新");
  } catch (error) {
    setStatus("error", error.message || "活跃订单刷新失败");
  }
};

const normalizePaymentInfo = (orderId, payload, source) => {
  const body = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const paymentAddress =
    body.payment_address ?? body.paymentAddress ?? body.address ?? body.pay_to;
  const paymentChainId =
    body.payment_chain_id ?? body.paymentChainId ?? body.chain_id ?? body.chainId;
  const paymentToken = body.payment_token ?? body.paymentToken ?? body.token ?? body.symbol;
  const paymentAmount =
    body.payment_amount ?? body.paymentAmount ?? body.amount ?? body.amount_decimal;

  if (!paymentAddress || paymentChainId == null || !paymentToken || paymentAmount == null) {
    throw new Error(`Keeper 返回缺少关键字段: ${JSON.stringify(body)}`);
  }

  return {
    orderId,
    paymentAddress,
    paymentChainId: Number(paymentChainId),
    paymentToken: String(paymentToken).toUpperCase(),
    paymentAmount: String(paymentAmount),
    source,
  };
};

const getPaymentInfo = async (orderId) => {
  const response = await fetch(`${API_BASE}/orders/${orderId}/payment-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keeper_url: appState.settings.keeperUrl,
      payment_path: appState.settings.paymentPath.trim() || null,
      buyer_address: appState.account || null,
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(`无法从本地后端获取付款信息: ${payload?.detail || `HTTP ${response.status}`}`);
  }

  return normalizePaymentInfo(
    orderId,
    await response.json(),
    `${API_BASE}/orders/${orderId}/payment-info`
  );
};

const buildKeeperUrl = (path, orderId) => {
  const base = (appState.settings.keeperUrl || DEFAULT_KEEPER_URL).replace(/\/+$/, "");
  if (!path) return `${base}/order/${orderId}/buy`;
  if (/^https?:\/\//i.test(path)) {
    return path.replace("{order_id}", String(orderId));
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath.replace("{order_id}", String(orderId))}`;
};

const normalizeDirectKeeperPaymentInfo = (orderId, payload, source) => {
  const pickOrder = (value) => {
    if (Array.isArray(value)) {
      return value.find((item) => Number(item?.id) === Number(orderId)) ?? null;
    }
    if (Array.isArray(value?.items)) {
      return value.items.find((item) => Number(item?.id) === Number(orderId)) ?? null;
    }
    if (Array.isArray(value?.orders)) {
      return value.orders.find((item) => Number(item?.id) === Number(orderId)) ?? null;
    }
    return value;
  };

  let body = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  body = pickOrder(body);
  if (!body || typeof body !== "object") {
    throw new Error(`Keeper 返回了无效订单数据: ${orderId}`);
  }

  const payment = body.payment && typeof body.payment === "object" ? body.payment : null;
  return normalizePaymentInfo(
    orderId,
    {
      payment_address:
        body.payment_address ?? body.paymentAddress ?? payment?.address ?? body.address,
      payment_chain_id:
        body.payment_chain_id ??
        body.paymentChainId ??
        body.chain_id ??
        body.chainId ??
        payment?.chain_id,
      payment_token:
        body.payment_token ?? body.paymentToken ?? body.token ?? body.symbol ?? payment?.token,
      payment_amount:
        body.payment_amount ??
        body.paymentAmount ??
        payment?.amount ??
        body.total ??
        body.amount ??
        body.amount_decimal,
    },
    source
  );
};

const fetchDirectKeeperPaymentInfo = async (orderId) => {
  const overridePath = appState.settings.paymentPath.trim();
  const candidates = overridePath
    ? [overridePath]
    : [`/order/${orderId}/buy`, `/order/${orderId}`, "/orders"];

  let lastError = null;
  for (const path of candidates) {
    const url = buildKeeperUrl(path, orderId);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return normalizeDirectKeeperPaymentInfo(orderId, await response.json(), url);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || "failed to fetch payment info from keeper");
};

const getPaymentInfoWithFallback = async (orderId) => {
  try {
    return await fetchDirectKeeperPaymentInfo(orderId);
  } catch (keeperError) {
    try {
      return await getPaymentInfo(orderId);
    } catch (backendError) {
      throw new Error(
        `unable to fetch payment info from keeper or local backend: ${keeperError.message}; ${backendError.message}`
      );
    }
  }
};

const toDisplayError = (error, fallback = "操作失败") =>
  error?.shortMessage || error?.message || fallback;

const getOrderInactiveMessage = (order) => {
  if (!order) return null;
  if (Number(order.status) === 3) return `订单 #${order.id} 已取消，不能买入`;
  if (Number(order.status) === 2) return `订单 #${order.id} 正在取消中，暂时不能买入`;
  if (Number(order.status) === 1) return `订单 #${order.id} 已成交，不能重复买入`;
  if (Number(order.status) !== 0) {
    return `订单 #${order.id} 当前状态为 ${order.statusLabel || order.status}，不能买入`;
  }
  return null;
};

const resolveBuyOrderError = async (orderId, error) => {
  try {
    const latestOrder = await fetchOrderDetail(orderId);
    const inactiveMessage = getOrderInactiveMessage(latestOrder);
    if (inactiveMessage) {
      return new Error(inactiveMessage);
    }
  } catch {
    // Ignore status refresh failures and fall back to the original error below.
  }

  const reason = String(toDisplayError(error, "买入失败")).toLowerCase();
  if (reason.includes("user rejected") || reason.includes("rejected action")) {
    return new Error(`订单 #${orderId} 买入未完成，请确认订单仍有效后重试`);
  }
  return error instanceof Error ? error : new Error(toDisplayError(error, "买入失败"));
};

const handleBuyAction = async (orderId, button) => {
  const now = Date.now();
  const lockedUntil = appState.interactionLocks.buyOrderUntilById[orderId] || 0;
  if (lockedUntil > now) {
    const remaining = getRemainingLockSeconds(lockedUntil);
    setStatus("error", `订单 #${orderId} 买入按钮冷却中，请 ${remaining} 秒后再试`);
    window.alert(appState.status.text);
    return;
  }

  appState.interactionLocks.buyOrderUntilById[orderId] = now + REPEAT_CLICK_LOCK_MS;
  withTemporaryButtonLock(button);
  try {
    await buyOrder(orderId);
    await refreshDataAjax("付款完成，正在刷新订单状态...");
    if (appState.orderDetail.open && Number(appState.orderDetail.order?.id) === Number(orderId)) {
      await openOrderDetail(orderId);
    }
  } catch (error) {
    console.error(error);
    const resolvedError = await resolveBuyOrderError(orderId, error);
    setStatus("error", toDisplayError(resolvedError, "买入失败"));
    window.alert(appState.status.text);
  }
};

const createOrder = async (formData) => {
  if (!appState.account) {
    await connectWallet();
  }
  const browserProvider = await ensureWalletChain(8210);
  const signer = await browserProvider.getSigner();
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
  const sellerPaymentAddr = formData.get("sellerPaymentAddr").trim() || appState.account;

  const tx = await contract.createOrder(
    ethers.parseUnits(formData.get("priceUsd"), 6),
    Number(formData.get("paymentChainId")),
    formData.get("paymentToken"),
    sellerPaymentAddr,
    { value: ethers.parseEther(formData.get("amountAxon")) }
  );

  setStatus("info", `卖单已提交，等待 Axon 确认: ${shortTx(tx.hash)}`);
  const receipt = await tx.wait();
  const createdLog = receipt.logs.find(
    (log) => log.topics?.[0]?.toLowerCase() === ORDER_CREATED_TOPIC.toLowerCase()
  );
  const orderId = createdLog ? Number(createdLog.topics[1]) : null;
  setStatus("success", orderId !== null ? `卖单创建成功，订单 #${orderId}` : `卖单创建成功: ${shortTx(tx.hash)}`);
};

const submitBuyOrderPrototype = async (formData) => {
  const amountAxon = Number(formData.get("amountAxon"));
  const priceUsd = Number(formData.get("priceUsd"));
  const paymentChainId = Number(formData.get("paymentChainId"));
  const paymentToken = String(formData.get("paymentToken"));
  const buyerPaymentAddr = formData.get("buyerPaymentAddr").trim() || appState.account || "当前钱包地址";

  if (!Number.isFinite(amountAxon) || amountAxon <= 0) {
    throw new Error("请输入有效的购买数量");
  }
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("请输入有效的目标单价");
  }

  const estimatedTotal = amountAxon * priceUsd;
  setStatus(
    "info",
    `挂买单原型已填写：买入 ${amountAxon} AXON，单价 $${priceUsd.toFixed(6)}，总价约 $${estimatedTotal.toFixed(4)}，付款链 ${CHAINS[paymentChainId]?.label || paymentChainId}，代币 ${paymentToken}，付款地址 ${buyerPaymentAddr}`
  );
  window.alert("当前为挂买单原型界面，现网合约暂未支持 createBuyOrder。表单字段已就位，后续可直接接真实合约。");
};

const buyOrder = async (orderId) => {
  if (!appState.account) {
    await connectWallet();
  }

  const order = await fetchOrderDetail(orderId);
  const inactiveMessage = getOrderInactiveMessage(order);
  if (inactiveMessage) {
    throw new Error(inactiveMessage);
  }

  setStatus("info", `正在获取订单 #${orderId} 的付款信息...`);
  const payment = await getPaymentInfoWithFallback(orderId);
  const tokenMeta = TOKENS[payment.paymentChainId]?.[payment.paymentToken];
  if (!tokenMeta) {
    throw new Error(`不支持 ${payment.paymentChainId} 链上的 ${payment.paymentToken}`);
  }

  const browserProvider = await ensureWalletChain(payment.paymentChainId);
  const signer = await browserProvider.getSigner();
  const token = new ethers.Contract(tokenMeta.address, ERC20_ABI, signer);
  const walletAddress = await signer.getAddress();
  const paymentAmount = ethers.parseUnits(payment.paymentAmount, tokenMeta.decimals);
  const balance = await token.balanceOf(walletAddress);

  if (balance < paymentAmount) {
    throw new Error(
      `${CHAINS[payment.paymentChainId]?.label ?? payment.paymentChainId} ${payment.paymentToken} 余额不足：需要 ${payment.paymentAmount}，当前仅有 ${ethers.formatUnits(balance, tokenMeta.decimals)}`
    );
  }

  let tx;
  try {
    tx = await token.transfer(payment.paymentAddress, paymentAmount);
  } catch (error) {
    const reason = error?.reason || error?.shortMessage || error?.message || "";
    if (String(reason).includes("transfer amount exceeds balance")) {
      throw new Error(
        `${CHAINS[payment.paymentChainId]?.label ?? payment.paymentChainId} ${payment.paymentToken} 余额不足，请先充值后再下单`
      );
    }
    throw error;
  }

  setStatus("info", `付款交易已发出，等待确认: ${shortTx(tx.hash)}`);
  await tx.wait();
  setStatus("success", `订单 #${orderId} 付款已确认，Keeper 将自动释放 AXON。支付交易 ${shortTx(tx.hash)}`);
};

const submitSellerAction = async (method, orderId, label) => {
  if (!appState.account) {
    await connectWallet();
  }
  const browserProvider = await ensureWalletChain(8210);
  const signer = await browserProvider.getSigner();
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
  const tx = await contract[method](orderId);
  setStatus("info", `${label} 已提交: ${shortTx(tx.hash)}`);
  await tx.wait();
  setStatus("success", `${label} 已上链`);
};

ui.connectButton.addEventListener("click", async () => {
  if (appState.account) {
    disconnectWallet();
    return;
  }
  try {
    await connectWallet();
  } catch (error) {
    console.error(error);
    setStatus("error", error.shortMessage || error.message || "连接钱包失败");
  }
});

ui.themeButton.addEventListener("click", () => {
  appState.theme = appState.theme === "dark" ? "light" : "dark";
  window.localStorage.setItem(THEME_STORAGE_KEY, appState.theme);
  applyTheme();
});

ui.refreshButton.addEventListener("click", async () => {
  if (!beginQueryAction("refreshAll", "刷新市场按钮")) return;
  await refreshDataAjax("正在刷新市场数据...");
});

ui.refreshOrdersButton.addEventListener("click", async () => {
  if (!beginQueryAction("refreshOrders", "刷新订单按钮", ui.refreshOrdersButton)) return;
  await refreshOrdersOnly("正在刷新活跃订单...");
});

ui.marketSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = ui.marketSearchForm?.querySelector('button[type="submit"]');
  if (!beginQueryAction("marketSearch", "活跃订单查询按钮", submitButton)) return;
  appState.market.query = ui.marketSearchInput?.value?.trim() || "";
  appState.market.page = 1;
  await refreshOrdersOnly("正在查询活跃订单...");
});

ui.marketSearchReset?.addEventListener("click", async () => {
  if (!beginQueryAction("marketSearchReset", "活跃订单清空按钮", ui.marketSearchReset)) return;
  appState.market.query = "";
  if (ui.marketSearchInput) ui.marketSearchInput.value = "";
  appState.market.page = 1;
  await refreshOrdersOnly("正在恢复全部活跃订单...");
});

ui.networkHistorySearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = ui.networkHistorySearchForm?.querySelector('button[type="submit"]');
  if (!beginQueryAction("networkHistorySearch", "全网历史查询按钮", submitButton)) return;
  appState.networkHistory.query = ui.networkHistorySearchInput?.value?.trim() || "";
  appState.networkHistory.page = 1;
  await loadNetworkHistory();
});

ui.networkHistorySearchReset?.addEventListener("click", async () => {
  if (
    !beginQueryAction(
      "networkHistorySearchReset",
      "全网历史清空按钮",
      ui.networkHistorySearchReset
    )
  ) {
    return;
  }
  appState.networkHistory.query = "";
  if (ui.networkHistorySearchInput) ui.networkHistorySearchInput.value = "";
  appState.networkHistory.page = 1;
  await loadNetworkHistory();
});

ui.priceChartInterval?.addEventListener("change", async (event) => {
  appState.priceChart.interval = event.target.value || "hour";
  await loadPriceChart();
});

ui.keeperUrlInput?.addEventListener("change", (event) => {
  appState.settings.keeperUrl = event.target.value.trim() || DEFAULT_KEEPER_URL;
});

ui.paymentPathInput?.addEventListener("change", (event) => {
  appState.settings.paymentPath = event.target.value.trim();
});

ui.createOrderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const now = Date.now();
  if (appState.interactionLocks.createOrderUntil > now) {
    const remaining = getRemainingLockSeconds(appState.interactionLocks.createOrderUntil);
    setStatus("error", `创建卖单按钮冷却中，请 ${remaining} 秒后再试`);
    window.alert(appState.status.text);
    return;
  }

  appState.interactionLocks.createOrderUntil = now + REPEAT_CLICK_LOCK_MS;
  const formData = new FormData(ui.createOrderForm);
  const submitButton = ui.createOrderForm.querySelector('button[type="submit"]');
  withTemporaryButtonLock(submitButton);
  try {
    await createOrder(formData);
    ui.createOrderForm.reset();
    await refreshDataAjax("卖单创建成功，正在重新加载数据...");
  } catch (error) {
    console.error(error);
    setStatus("error", error.shortMessage || error.message || "创建订单失败");
  }
});

ui.createBuyOrderForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = ui.createBuyOrderForm.querySelector('button[type="submit"]');
  withTemporaryButtonLock(submitButton);
  try {
    const formData = new FormData(ui.createBuyOrderForm);
    await submitBuyOrderPrototype(formData);
  } catch (error) {
    console.error(error);
    setStatus("error", toDisplayError(error, "挂买单原型提交失败"));
  }
});

ui.activeOrdersBody.addEventListener("click", async (event) => {
  const buyButton = event.target.closest("[data-buy]");
  if (buyButton) {
    const orderId = Number(buyButton.dataset.buy);
    await handleBuyAction(orderId, buyButton);
    return;
  }

  const row = event.target.closest("[data-order-row]");
  if (!row) return;
  try {
    await openOrderDetail(Number(row.dataset.orderRow));
  } catch (error) {
    console.error(error);
    setStatus("error", error.shortMessage || error.message || "订单详情加载失败");
  }
});

ui.activeOrdersPager.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-market-page]");
  if (!button || appState.loading.market) return;
  if (!beginQueryAction("marketPage", "活跃订单翻页按钮", button)) return;

  const totalPages = Math.max(1, Math.ceil((appState.market.total || 0) / appState.market.pageSize));
  if (button.dataset.marketPage === "prev" && appState.market.page > 1) {
    appState.market.page -= 1;
  }
  if (button.dataset.marketPage === "next" && appState.market.page < totalPages) {
    appState.market.page += 1;
  }

  await refreshOrdersOnly("正在切换活跃订单页...");
});

ui.networkHistoryPager.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-network-history-page]");
  if (!button || appState.loading.networkHistory) return;
  if (!beginQueryAction("networkHistoryPage", "全网历史翻页按钮", button)) return;

  const totalPages = Math.max(
    1,
    Math.ceil((appState.networkHistory.total || 0) / appState.networkHistory.pageSize)
  );
  if (button.dataset.networkHistoryPage === "prev" && appState.networkHistory.page > 1) {
    appState.networkHistory.page -= 1;
  }
  if (
    button.dataset.networkHistoryPage === "next" &&
    appState.networkHistory.page < totalPages
  ) {
    appState.networkHistory.page += 1;
  }

  await loadNetworkHistory();
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-sort-field]");
  if (!button) return;
  if (!beginQueryAction("marketSort", "活跃订单排序按钮", button)) return;

  const field = button.dataset.sortField;
  if (!SORTABLE_MARKET_FIELDS[field]) return;

  if (appState.market.sortKey === field) {
    appState.market.sortDirection = appState.market.sortDirection === "asc" ? "desc" : "asc";
  } else {
    appState.market.sortKey = field;
    appState.market.sortDirection = field === DEFAULT_MARKET_SORT.sortKey ? "asc" : "desc";
  }

  appState.market.page = 1;
  await refreshOrdersOnly("正在按新排序加载活跃订单...");
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-network-sort-field]");
  if (!button) return;
  if (!beginQueryAction("networkHistorySort", "全网历史排序按钮", button)) return;

  const field = button.dataset.networkSortField;
  if (!NETWORK_HISTORY_SORT_FIELDS[field]) return;

  if (appState.networkHistory.sortKey === field) {
    appState.networkHistory.sortDirection =
      appState.networkHistory.sortDirection === "asc" ? "desc" : "asc";
  } else {
    appState.networkHistory.sortKey = field;
    appState.networkHistory.sortDirection = field === "createdAt" ? "desc" : "asc";
  }

  appState.networkHistory.page = 1;
  await loadNetworkHistory();
});

ui.myOrdersBody.addEventListener("click", async (event) => {
  const requestCancel = event.target.closest("[data-cancel-request]");
  const finalizeCancel = event.target.closest("[data-cancel-finalize]");
  const abortCancel = event.target.closest("[data-abort-cancel]");

  try {
    if (requestCancel) {
      await submitSellerAction("requestCancelOrder", Number(requestCancel.dataset.cancelRequest), "请求取消");
    } else if (finalizeCancel) {
      await submitSellerAction("finalizeCancelOrder", Number(finalizeCancel.dataset.cancelFinalize), "完成取消");
    } else if (abortCancel) {
      await submitSellerAction("abortCancel", Number(abortCancel.dataset.abortCancel), "撤销取消");
    } else {
      const row = event.target.closest("[data-order-row]");
      if (!row) return;
      await openOrderDetail(Number(row.dataset.orderRow));
      return;
    }
    await refreshDataAjax("卖方操作成功，正在刷新数据...");
  } catch (error) {
    console.error(error);
    setStatus("error", error.shortMessage || error.message || "卖方操作失败");
  }
});

ui.networkHistoryBody.addEventListener("click", async (event) => {
  const row = event.target.closest("[data-order-row]");
  if (!row) return;
  try {
    await openOrderDetail(Number(row.dataset.orderRow));
  } catch (error) {
    console.error(error);
    setStatus("error", error.shortMessage || error.message || "订单详情加载失败");
  }
});

ui.orderDetailClose?.addEventListener("click", closeOrderDetail);
ui.orderDetailBackdrop?.addEventListener("click", closeOrderDetail);
ui.orderDetailBody?.addEventListener("click", async (event) => {
  const buyButton = event.target.closest("[data-detail-buy]");
  if (!buyButton) return;
  await handleBuyAction(Number(buyButton.dataset.detailBuy), buyButton);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && appState.orderDetail.open) {
    closeOrderDetail();
  }
});

const boot = async () => {
  try {
    const provider = getWalletProvider();
    if (provider) {
      bindProviderEvents(provider);
      const accounts = await provider.request({ method: "eth_accounts" });
      if (accounts?.length) {
        appState.account = accounts[0];
        const browserProvider = new ethers.BrowserProvider(provider);
        const network = await browserProvider.getNetwork();
        appState.currentChainId = Number(network.chainId);
      }
    }
    renderAll();
    await refreshDataAjax();
  } catch (error) {
    console.error(error);
    setStatus("error", error.message || "页面初始化失败");
  }
};

renderAll();
boot();
