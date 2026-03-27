# Axon OTC V7 Trading System

基于你提供的 V7 文档，从零搭建的 Python 交易市场 SDK 与 CLI。

这个项目覆盖了三类能力：

- Axon 链上挂单、取消、放币、订单查询
- Keeper API 付款地址查询
- 买方在 BSC / Arbitrum 上自动发起 USDT / USDC 转账

## 主网验证状态

这版已经按 Axon 主网真实合约做过只读验证，验证时间是 `2026-03-27`：

- 合约地址 `0x10063340374db851e2628D06F4732d5FF814eB34`
- `nextOrderId() = 133`
- `feeRateBps() = 30`
- `cancelCooldown() = 900`
- `admin() = keeper() = 0x11C7FE5f77d47AA6d553fe7cFF144915Ea1cEc40`
- `getOrder()`、`getActiveOrders()`、`getOrdersByAddress()` 已按主网返回结构接入

卖单创建也已按真实交易输入收紧：

- `create_sell_order()` 发送的 `AXON` 数量走交易 `value`
- 合约参数只编码 `price_usd`、`payment_chain_id`、`seller_payment_addr`、`payment_token`

## 快速开始

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

复制环境变量模板并填写：

```powershell
Copy-Item .env.example .env
```

CLI 会自动读取项目根目录下的 `.env`。

至少需要配置：

- `AXON_PRIVATE_KEY`
- `OTC_CONTRACT_ADDRESS`
- `AXON_RPC_URL`
- `BSC_RPC_URL`
- `ARBITRUM_RPC_URL`

## Python 用法

```python
import os
from src.otc_client import OTCClient

client = OTCClient(
    private_key=os.environ["AXON_PRIVATE_KEY"],
    contract_address=os.environ["OTC_CONTRACT_ADDRESS"],
    keeper_url=os.getenv("KEEPER_URL", "https://axonotc.com"),
)

orders, total = client.list_active_orders(limit=50)
print(f"active={total}")
for order in orders:
    print(order)
```

买方一键买入：

```python
result = client.buy_full(order_id=12)
print(result["payment_address"])
print(result["payment_tx"])
```

卖方创建卖单：

```python
order_id, tx_hash = client.create_sell_order(
    amount_axon=100,
    price_usd=0.02,
    payment_chain_id=56,
    payment_token="USDT",
)
print(order_id, tx_hash)
```

## CLI

```bash
python -m src.cli list --limit 20
python -m src.cli show --order-id 12
python -m src.cli buy --order-id 12
python -m src.cli payment-info --order-id 12
python -m src.cli create --amount 100 --price 0.02 --chain 56 --token USDT
python -m src.cli cancel-request --order-id 12
python -m src.cli cancel-finalize --order-id 12
python -m src.cli abort-cancel --order-id 12
python -m src.cli seller-release --order-id 12 --buyer 0xBuyerAddress
python -m src.cli my-orders
python -m src.cli axon-balance
python -m src.cli stablecoin-balance --chain 56 --token USDT
```

## 前端页面

前端目录在 `frontend/`，提供这些能力：

- 连接 OKX Wallet
- 查看链上活跃订单
- 查看当前钱包的历史订单
- 查看 Axon / BSC / Arbitrum 余额
- 在 Axon 上创建卖单
- 通过 Keeper 获取付款地址并在 BSC / Arbitrum 上完成买单付款

启动方式：

```bash
cd frontend
npm install
npm run dev
```

生产构建：

```bash
cd frontend
npm run build
```

开发服务器默认地址是：

```text
http://localhost:5173
```

如果 Keeper 的 payment-info 路径和默认候选路径不同，可以在页面右侧直接覆盖。

## Backend API

后端 HTTP API 基于 FastAPI，提供市场、订单、余额和 Keeper 代理接口。

启动方式：

```bash
python -m src.api_server
```

默认地址：

```text
http://localhost:8000
```

常用接口：

```text
GET  /api/health
GET  /api/orders/active?offset=0&limit=20
GET  /api/orders/{order_id}
GET  /api/addresses/{address}/orders
GET  /api/addresses/{address}/balances
POST /api/orders/{order_id}/payment-info
```

## 项目说明

- 默认 Keeper 地址是 `https://axonotc.com`
- 默认合约地址是文档里的 `0x10063340374db851e2628D06F4732d5FF814eB34`
- 如果 Keeper 的付款信息路由不是默认候选路径，请设置 `OTC_KEEPER_PAYMENT_PATH`
- `src/abi/otc_v7.json` 仍保留在仓库里做参考，但生产调用已不再依赖它

## 重要假设

由于文档没有给出 Keeper API 的精确路径，这个实现对 Keeper 做了多路径兼容：

- Keeper 侧会自动尝试多条常见 payment-info 路径，并允许通过环境变量覆盖

链上合约侧已经切到主网验证过的真实 selector，不再依赖推断 ABI。
