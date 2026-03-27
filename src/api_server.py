from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
from web3 import Web3
import uvicorn

from .otc_client import (
    CHAIN_CONFIG,
    DEFAULT_CONTRACT_ADDRESS,
    DEFAULT_KEEPER_URL,
    OTCClient,
)


APP_TITLE = "Axon OTC API"
API_PREFIX = "/api"
MARKET_VISIBLE_STATUSES = {0, 2}
HISTORY_VISIBLE_STATUSES = {1, 3, 4}
MARKET_SORT_FIELDS = {
    "amount_axon": "amount_axon_wei",
    "price_usd": "price_usd_raw",
    "total_payment": "total_payment",
    "created_at": "created_at",
    "id": "id",
}
DEFAULT_AXON_RPC_FALLBACK = "https://mainnet-rpc.axonchain.ai/"
DEFAULT_BSC_RPC_FALLBACK = "https://bsc-dataseed.binance.org/"
DEFAULT_ARBITRUM_RPC_FALLBACK = "https://arb1.arbitrum.io/rpc"
LOCAL_AXON_RPC_CANDIDATES = ("http://127.0.0.1:8545", "http://localhost:8545")


class PaymentInfoOverride(BaseModel):
    keeper_url: str | None = None
    payment_path: str | None = None
    buyer_address: str | None = None


app = FastAPI(title=APP_TITLE, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@lru_cache(maxsize=8)
def rpc_responds(rpc_url: str, expected_chain_id: int | None = None) -> bool:
    try:
        response = requests.post(
            rpc_url,
            json={"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []},
            timeout=1.5,
        )
        payload = response.json()
        if "result" not in payload:
            return False
        if expected_chain_id is None:
            return True
        return int(payload["result"], 16) == expected_chain_id
    except Exception:
        return False


def resolve_axon_rpc_url() -> str:
    configured = os.getenv("AXON_RPC_URL")
    if configured:
        return configured
    for candidate in LOCAL_AXON_RPC_CANDIDATES:
        if rpc_responds(candidate, expected_chain_id=8210):
            return candidate
    return DEFAULT_AXON_RPC_FALLBACK


def build_client(*, payment_path: str | None = None, keeper_url: str | None = None) -> OTCClient:
    return OTCClient(
        private_key=None,
        read_only=True,
        contract_address=os.getenv("OTC_CONTRACT_ADDRESS", DEFAULT_CONTRACT_ADDRESS),
        keeper_url=keeper_url or os.getenv("KEEPER_URL", DEFAULT_KEEPER_URL),
        payment_info_path_template=payment_path or os.getenv("OTC_KEEPER_PAYMENT_PATH"),
        axon_rpc_url=resolve_axon_rpc_url(),
        bsc_rpc_url=os.getenv("BSC_RPC_URL", DEFAULT_BSC_RPC_FALLBACK),
        arbitrum_rpc_url=os.getenv("ARBITRUM_RPC_URL", DEFAULT_ARBITRUM_RPC_FALLBACK),
        keeper_total_timeout=int(os.getenv("OTC_KEEPER_TOTAL_TIMEOUT", "30")),
    )


def serialize_error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=502, detail=str(exc))


def serialize_order(order: Any) -> dict[str, Any]:
    return order.to_dict() if hasattr(order, "to_dict") else order


def fetch_all_orders(client: OTCClient) -> list[Any]:
    total_orders = client.get_order_count()
    if total_orders <= 0:
        return []

    order_ids = list(range(total_orders))
    with ThreadPoolExecutor(max_workers=12) as executor:
        return list(executor.map(client.get_order, order_ids))


def fetch_payment_info_with_retries(
    order_id: int,
    *,
    payment_path: str | None = None,
    keeper_url: str | None = None,
    buyer_address: str | None = None,
    attempts: int = 3,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        client = build_client(payment_path=payment_path, keeper_url=keeper_url)
        try:
            return client.get_payment_info(order_id, buyer_address=buyer_address)
        except Exception as exc:
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(0.5)
    if last_error:
        raise last_error
    raise RuntimeError("payment info request failed without an explicit error")


@app.get(f"{API_PREFIX}/health")
def health() -> dict[str, Any]:
    client = build_client()
    try:
        return {
            "status": "ok",
            "contract_address": client.contract_address,
            "keeper_url": client.keeper_url,
            "next_order_id": client.get_order_count(),
            "fee_rate_bps": client.fee_rate_bps(),
            "cancel_cooldown": client.cancel_cooldown(),
        }
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/market/summary")
def market_summary() -> dict[str, Any]:
    client = build_client()
    try:
        orders = [
            order
            for order in client._get_active_orders_page(0, 500)
            if order.status in MARKET_VISIBLE_STATUSES
        ]
        best_order = min(orders, key=lambda item: item.price_usd_raw) if orders else None
        return {
            "active_total": len(orders),
            "next_order_id": client.get_order_count(),
            "fee_rate_bps": client.fee_rate_bps(),
            "cancel_cooldown": client.cancel_cooldown(),
            "best_order": serialize_order(best_order) if best_order else None,
        }
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/orders/active")
def active_orders(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    sort_by: str | None = Query(default=None),
    sort_dir: str = Query(default="desc"),
) -> dict[str, Any]:
    client = build_client()
    try:
        all_orders = [
            order
            for order in client._get_active_orders_page(0, 500)
            if order.status in MARKET_VISIBLE_STATUSES
        ]
        sort_key = (sort_by or "").strip().lower()
        if sort_key:
            attr_name = MARKET_SORT_FIELDS.get(sort_key)
            if not attr_name:
                raise HTTPException(status_code=400, detail="invalid sort_by")
            reverse = sort_dir.lower() != "asc"
            all_orders.sort(
                key=lambda order: (getattr(order, attr_name), order.id),
                reverse=reverse,
            )
        orders = all_orders[offset : offset + limit]
        return {
            "offset": offset,
            "limit": limit,
            "total": len(all_orders),
            "sort_by": sort_key or None,
            "sort_dir": sort_dir.lower(),
            "items": [serialize_order(order) for order in orders],
        }
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/orders/history")
def history_orders(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    sort_by: str | None = Query(default="created_at"),
    sort_dir: str = Query(default="desc"),
) -> dict[str, Any]:
    client = build_client()
    try:
        all_orders = [
            order for order in fetch_all_orders(client) if order.status in HISTORY_VISIBLE_STATUSES
        ]
        sort_key = (sort_by or "").strip().lower()
        if sort_key:
            attr_name = MARKET_SORT_FIELDS.get(sort_key)
            if not attr_name:
                raise HTTPException(status_code=400, detail="invalid sort_by")
            reverse = sort_dir.lower() != "asc"
            all_orders.sort(
                key=lambda order: (getattr(order, attr_name), order.id),
                reverse=reverse,
            )

        orders = all_orders[offset : offset + limit]
        return {
            "offset": offset,
            "limit": limit,
            "total": len(all_orders),
            "sort_by": sort_key or None,
            "sort_dir": sort_dir.lower(),
            "items": [serialize_order(order) for order in orders],
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/addresses/{{address}}/orders")
def address_orders(address: str) -> dict[str, Any]:
    client = build_client()
    try:
        address = Web3.to_checksum_address(address)
        ids = client.get_orders_by_address(address)
        unique_ids = list(dict.fromkeys(ids["as_seller"] + ids["as_buyer"]))
        with ThreadPoolExecutor(max_workers=8) as executor:
            orders = list(executor.map(client.get_order, unique_ids))
        return {
            "address": address,
            "as_seller": ids["as_seller"],
            "as_buyer": ids["as_buyer"],
            "items": [
                {
                    **serialize_order(order),
                    "role": "Seller" if order.id in ids["as_seller"] else "Buyer",
                }
                for order in orders
            ],
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid address") from exc
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/orders/{{order_id}}")
def order_detail(order_id: int) -> dict[str, Any]:
    client = build_client()
    try:
        return serialize_order(client.get_order(order_id))
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/addresses/{{address}}/balances")
def address_balances(address: str, include_arbitrum: bool = Query(default=False)) -> dict[str, Any]:
    client = build_client()
    try:
        address = Web3.to_checksum_address(address)
        chain_ids = [8210, 56]
        if include_arbitrum:
            chain_ids.append(42161)

        tasks: list[tuple[int, str]] = [(8210, CHAIN_CONFIG[8210]["native_symbol"])]
        for chain_id in chain_ids:
            if chain_id != 8210:
                tasks.append((chain_id, CHAIN_CONFIG[chain_id]["native_symbol"]))
                for token_symbol in CHAIN_CONFIG[chain_id].get("tokens", {}):
                    tasks.append((chain_id, token_symbol))

        def fetch_balance(task: tuple[int, str]) -> dict[str, Any]:
            chain_id, asset = task
            chain_name = CHAIN_CONFIG[chain_id]["name"]
            if chain_id == 8210 and asset == CHAIN_CONFIG[8210]["native_symbol"]:
                balance = client.axon_balance_of(address)
            elif asset == CHAIN_CONFIG[chain_id]["native_symbol"]:
                web3 = client._get_web3(chain_id, required=True)
                balance = float(web3.from_wei(web3.eth.get_balance(address), "ether"))
            else:
                balance = client.stablecoin_balance_of(address, chain_id, asset)
            return {
                "chain_id": chain_id,
                "chain_name": chain_name,
                "asset": asset,
                "balance": balance,
            }

        with ThreadPoolExecutor(max_workers=min(8, len(tasks) or 1)) as executor:
            balances = list(executor.map(fetch_balance, tasks))

        balances.sort(key=lambda item: (0 if item["chain_id"] == 8210 else item["chain_id"], item["asset"]))
        return {"address": address, "items": balances}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid address") from exc
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/orders/{{order_id}}/payment-info")
def order_payment_info(
    order_id: int,
    keeper_url: str | None = None,
    payment_path: str | None = None,
) -> dict[str, Any]:
    try:
        return fetch_payment_info_with_retries(
            order_id,
            payment_path=payment_path,
            keeper_url=keeper_url,
        )
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.post(f"{API_PREFIX}/orders/{{order_id}}/payment-info")
def order_payment_info_post(order_id: int, body: PaymentInfoOverride) -> dict[str, Any]:
    try:
        return fetch_payment_info_with_retries(
            order_id,
            payment_path=body.payment_path,
            keeper_url=body.keeper_url,
            buyer_address=body.buyer_address,
        )
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get("/")
def root() -> dict[str, str]:
    return {"name": APP_TITLE, "docs": "/docs", "health": f"{API_PREFIX}/health"}


if __name__ == "__main__":
    uvicorn.run("src.api_server:app", host="0.0.0.0", port=8000, reload=False)
