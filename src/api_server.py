from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, wait
from decimal import Decimal
from threading import Lock
import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import requests
from web3 import Web3
import uvicorn

from otc_client import (
    CHAIN_CONFIG,
    DEFAULT_CONTRACT_ADDRESS,
    DEFAULT_KEEPER_URL,
    STATUS_LABELS,
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
DEFAULT_AXON_RPC_FALLBACK = "http://127.0.0.1:8545"
DEFAULT_BSC_RPC_FALLBACK = "https://bsc-dataseed.binance.org/"
DEFAULT_ARBITRUM_RPC_FALLBACK = "https://arb1.arbitrum.io/rpc"
BALANCE_FETCH_TIMEOUT_SECONDS = 6
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("API_RATE_LIMIT_WINDOW_SECONDS", "60"))
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("API_RATE_LIMIT_MAX_REQUESTS", "120"))
RATE_LIMIT_WRITE_MAX_REQUESTS = int(os.getenv("API_RATE_LIMIT_WRITE_MAX_REQUESTS", "20"))
MAX_REQUEST_BODY_BYTES = int(os.getenv("API_MAX_REQUEST_BODY_BYTES", str(64 * 1024)))
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv("API_ALLOWED_HOSTS", "*").split(",")
    if host.strip()
]
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("API_ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]


class PaymentInfoOverride(BaseModel):
    keeper_url: str | None = None
    payment_path: str | None = None
    buyer_address: str | None = None


def get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def check_rate_limit(client_ip: str, scope: str, max_requests: int) -> bool:
    now = time.time()
    bucket_key = f"{scope}:{client_ip}"
    with _rate_limit_lock:
        bucket = _rate_limit_buckets[bucket_key]
        while bucket and now - bucket[0] > RATE_LIMIT_WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= max_requests:
            return False
        bucket.append(now)
        return True


app = FastAPI(title=APP_TITLE, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if "*" not in ALLOWED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS or ["*"])

_rate_limit_buckets: dict[str, deque[float]] = defaultdict(deque)
_rate_limit_lock = Lock()


@app.middleware("http")
async def security_middleware(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BODY_BYTES:
                return JSONResponse(status_code=413, content={"detail": "request body too large"})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "invalid content-length"})

    client_ip = get_client_ip(request)
    is_write = request.method.upper() not in {"GET", "HEAD", "OPTIONS"}
    allowed = check_rate_limit(
        client_ip,
        "write" if is_write else "read",
        RATE_LIMIT_WRITE_MAX_REQUESTS if is_write else RATE_LIMIT_MAX_REQUESTS,
    )
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={"detail": "rate limit exceeded"},
            headers={"Retry-After": str(RATE_LIMIT_WINDOW_SECONDS)},
        )

    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Resource-Policy"] = "same-site"
    return response


def resolve_axon_rpc_url() -> str:
    return os.getenv("AXON_RPC_URL", DEFAULT_AXON_RPC_FALLBACK)


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
        request_timeout=int(os.getenv("OTC_RPC_REQUEST_TIMEOUT", "60")),
        keeper_total_timeout=int(os.getenv("OTC_KEEPER_TOTAL_TIMEOUT", "30")),
    )


def serialize_error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=502, detail=str(exc))


def serialize_order(order: Any) -> dict[str, Any]:
    return order.to_dict() if hasattr(order, "to_dict") else order


def _pick_first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _to_decimal(value: Any, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def normalize_keeper_order(item: dict[str, Any]) -> dict[str, Any]:
    payment = item.get("payment") if isinstance(item.get("payment"), dict) else {}
    order_id = int(_pick_first(item, "id") or 0)
    amount_axon = _to_decimal(_pick_first(item, "amount_axon", "amountAxon", "amount"), "0")
    amount_axon_wei = int(
        _pick_first(item, "amount_axon_wei", "amountAxonWei") or amount_axon * Decimal(10**18)
    )
    price_usd = _to_decimal(_pick_first(item, "price_usd", "priceUsd", "price"), "0")
    price_usd_raw = int(
        _pick_first(item, "price_usd_raw", "priceUsdRaw") or price_usd * Decimal(10**6)
    )
    total_payment = _to_decimal(
        _pick_first(item, "total_payment", "totalPayment", "total") or payment.get("amount"),
        "0",
    )
    payment_address = _pick_first(
        item,
        "payment_address",
        "seller_payment_addr",
        "paymentAddress",
        "sellerPaymentAddr",
    ) or payment.get("address")
    status = int(_pick_first(item, "status", "status_code", "state") or 0)
    status_label = (
        _pick_first(item, "status_label", "statusLabel")
        or STATUS_LABELS.get(status)
        or f"Unknown({status})"
    )
    return {
        "id": order_id,
        "seller": str(_pick_first(item, "seller") or ""),
        "buyer": str(_pick_first(item, "buyer") or ""),
        "amount_axon": float(amount_axon),
        "amount_axon_wei": amount_axon_wei,
        "price_usd": float(price_usd),
        "price_usd_raw": price_usd_raw,
        "total_payment": float(total_payment),
        "payment_chain_id": int(
            _pick_first(item, "payment_chain_id", "paymentChainId", "chain_id", "chainId")
            or payment.get("chain_id")
            or 0
        ),
        "payment_chain_name": str(
            _pick_first(item, "payment_chain_name", "paymentChainName", "chain")
            or payment.get("chain_name")
            or ""
        ),
        "payment_token": str(
            _pick_first(item, "payment_token", "paymentToken", "token") or payment.get("token") or ""
        ).upper(),
        "payment_address": str(payment_address or ""),
        "seller_payment_addr": str(payment_address or ""),
        "status": status,
        "status_label": str(status_label),
        "created_at": int(_pick_first(item, "created_at", "createdAt") or 0),
        "cancel_requested_at": int(
            _pick_first(item, "cancel_requested_at", "cancelRequestedAt") or 0
        ),
    }


def extract_keeper_orders(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict) and isinstance(payload.get("items"), list):
        items = payload["items"]
    elif isinstance(payload, dict) and isinstance(payload.get("orders"), list):
        items = payload["orders"]
    elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
        items = payload["data"]
    else:
        raise HTTPException(status_code=502, detail="invalid keeper orders payload")
    return [normalize_keeper_order(item) for item in items if isinstance(item, dict)]


def fetch_keeper_orders(client: OTCClient) -> list[dict[str, Any]]:
    url = f"{client.keeper_url}/orders"
    try:
        response = requests.get(
            url,
            headers={
                "Accept": "application/json",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
            timeout=15,
        )
        if response.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"keeper orders request failed: HTTP {response.status_code}",
            )
        return extract_keeper_orders(response.json())
    except HTTPException:
        raise
    except Exception as exc:
        raise serialize_error(exc) from exc


def matches_order_query(order: Any, query: str | None) -> bool:
    if not query:
        return True

    needle = query.strip().lower()
    if not needle:
        return True

    getter = order.get if isinstance(order, dict) else lambda key, default="": getattr(order, key, default)
    haystacks = [
        str(getter("id", "")),
        str(getter("seller", "")),
        str(getter("buyer", "")),
        str(getter("payment_token", "")),
        str(getter("payment_chain_id", "")),
        str(getter("payment_chain_name", "")),
        str(getter("status", "")),
        str(getter("status_label", "")),
        str(getter("seller_payment_addr", "")),
    ]
    return any(needle in value.lower() for value in haystacks)


def sort_order_key(order: Any, attr_name: str) -> tuple[Any, int]:
    if isinstance(order, dict):
        return order.get(attr_name), int(order.get("id", 0))
    return getattr(order, attr_name), int(getattr(order, "id", 0))


def fetch_all_orders(client: OTCClient) -> list[Any]:
    total_orders = client.get_order_count()
    if total_orders <= 0:
        return []

    orders: list[Any] = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(client.get_order, order_id) for order_id in range(total_orders)]
        for future in futures:
            try:
                orders.append(future.result())
            except Exception:
                # Degrade gracefully: skip broken order reads instead of failing the entire endpoint.
                continue
    return orders


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
            payment = client.get_payment_info(order_id, buyer_address=buyer_address)
            if "payment_address" not in payment and payment.get("seller_payment_addr"):
                payment["payment_address"] = payment["seller_payment_addr"]
            if "seller_payment_addr" not in payment and payment.get("payment_address"):
                payment["seller_payment_addr"] = payment["payment_address"]
            return payment
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
            for order in fetch_keeper_orders(client)
            if int(order["status"]) in MARKET_VISIBLE_STATUSES
        ]
        best_order = min(orders, key=lambda item: item["price_usd_raw"]) if orders else None
        return {
            "active_total": len(orders),
            "next_order_id": client.get_order_count(),
            "fee_rate_bps": client.fee_rate_bps(),
            "cancel_cooldown": client.cancel_cooldown(),
            "best_order": best_order if best_order else None,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/orders/active")
def active_orders(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    sort_by: str | None = Query(default=None),
    sort_dir: str = Query(default="desc"),
    query: str | None = Query(default=None, max_length=200),
) -> dict[str, Any]:
    client = build_client()
    try:
        all_orders = [
            order
            for order in fetch_keeper_orders(client)
            if int(order["status"]) in MARKET_VISIBLE_STATUSES and matches_order_query(order, query)
        ]
        sort_key = (sort_by or "").strip().lower()
        if sort_key:
            attr_name = MARKET_SORT_FIELDS.get(sort_key)
            if not attr_name:
                raise HTTPException(status_code=400, detail="invalid sort_by")
            reverse = sort_dir.lower() != "asc"
            all_orders.sort(key=lambda order: sort_order_key(order, attr_name), reverse=reverse)
        orders = all_orders[offset : offset + limit]
        return {
            "offset": offset,
            "limit": limit,
            "total": len(all_orders),
            "sort_by": sort_key or None,
            "sort_dir": sort_dir.lower(),
            "query": query or "",
            "items": orders,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get(f"{API_PREFIX}/orders/history")
def history_orders(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    sort_by: str | None = Query(default="created_at"),
    sort_dir: str = Query(default="desc"),
    query: str | None = Query(default=None, max_length=200),
) -> dict[str, Any]:
    client = build_client()
    try:
        all_orders = [
            order
            for order in fetch_all_orders(client)
            if order.status in HISTORY_VISIBLE_STATUSES and matches_order_query(order, query)
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
            "query": query or "",
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
        orders: list[Any] = []
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(client.get_order, order_id) for order_id in unique_ids]
            for future in futures:
                try:
                    orders.append(future.result())
                except Exception:
                    continue
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
async def address_balances(
    address: str,
    include_arbitrum: bool = Query(default=False),
    chain_id: int | None = Query(default=None),
) -> dict[str, Any]:
    client = build_client()
    try:
        address = Web3.to_checksum_address(address)
        if chain_id is not None:
            if chain_id not in CHAIN_CONFIG:
                raise HTTPException(status_code=400, detail="unsupported chain_id")
            chain_ids = [chain_id]
        else:
            chain_ids = [8210, 56]
            if include_arbitrum:
                chain_ids.append(42161)

        tasks: list[tuple[int, str]] = []
        for current_chain_id in chain_ids:
            tasks.append((current_chain_id, CHAIN_CONFIG[current_chain_id]["native_symbol"]))
            if current_chain_id != 8210:
                for token_symbol in CHAIN_CONFIG[current_chain_id].get("tokens", {}):
                    tasks.append((current_chain_id, token_symbol))

        def fetch_balance_sync(task: tuple[int, str]) -> dict[str, Any]:
            current_chain_id, asset = task
            chain_name = CHAIN_CONFIG[current_chain_id]["name"]
            if current_chain_id == 8210 and asset == CHAIN_CONFIG[8210]["native_symbol"]:
                balance = client.axon_balance_of(address)
            elif asset == CHAIN_CONFIG[current_chain_id]["native_symbol"]:
                web3 = client._get_web3(current_chain_id, required=True)
                balance = float(web3.from_wei(web3.eth.get_balance(address), "ether"))
            else:
                balance = client.stablecoin_balance_of(address, current_chain_id, asset)
            return {
                "chain_id": current_chain_id,
                "chain_name": chain_name,
                "asset": asset,
                "balance": balance,
            }

        async def fetch_balance(task: tuple[int, str]) -> dict[str, Any]:
            current_chain_id, asset = task
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(fetch_balance_sync, task),
                    timeout=BALANCE_FETCH_TIMEOUT_SECONDS,
                )
            except Exception:
                return {
                    "chain_id": current_chain_id,
                    "chain_name": CHAIN_CONFIG[current_chain_id]["name"],
                    "asset": asset,
                    "balance": 0.0,
                }

        balances = await asyncio.gather(*(fetch_balance(task) for task in tasks))

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
    except HTTPException:
        raise
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
    except HTTPException:
        raise
    except Exception as exc:
        raise serialize_error(exc) from exc


@app.get("/")
def root() -> dict[str, str]:
    return {"name": APP_TITLE, "docs": "/docs", "health": f"{API_PREFIX}/health"}


if __name__ == "__main__":
    uvicorn.run("api_server:app", host="0.0.0.0", port=18000, reload=False)
