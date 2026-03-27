from __future__ import annotations

import json
import os
import socket
import ssl
import time
from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from eth_abi import decode, encode
from eth_account import Account
from web3 import Web3
from web3.contract import Contract


DEFAULT_AXON_CHAIN_ID = 8210
DEFAULT_KEEPER_URL = "https://axonotc.com"
DEFAULT_CONTRACT_ADDRESS = "0x10063340374db851e2628D06F4732d5FF814eB34"
DEFAULT_KEEPER_IP = "76.13.20.77"
READ_ONLY_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945382db6bd9a0bf0f3c4d5e1c5d5b5f5a5f5a"
ORDER_CREATED_TOPIC = (
    "0x4230830dfe20a0ca4dea7c6539ec33d88b3ac7a4bb183602ec80cfb9728ac521"
)
PRICE_SCALE = 10**6

SELECTORS = {
    "next_order_id": "0x2a58b330",
    "get_order": "0xd09ef241",
    "get_active_orders": "0x7c95cdc6",
    "get_orders_by_address": "0x99eeda02",
    "request_cancel_order": "0x0fb05223",
    "finalize_cancel_order": "0x24f9d60b",
    "abort_cancel": "0x02e72266",
    "seller_release": "0x4ae02a64",
    "create_sell_order": "0x41e113aa",
    "cancel_cooldown": "0x7674e44e",
    "fee_rate_bps": "0x88c7fff3",
    "admin": "0xf851a440",
    "keeper": "0xaced1661",
}

STATUS_LABELS = {
    0: "Active",
    1: "Completed",
    2: "CancelPending",
    3: "Cancelled",
    4: "Disputed",
}

CHAIN_CONFIG: dict[int, dict[str, Any]] = {
    8210: {
        "name": "Axon",
        "rpc_env": "AXON_RPC_URL",
        "native_symbol": "AXON",
    },
    56: {
        "name": "BSC",
        "rpc_env": "BSC_RPC_URL",
        "native_symbol": "BNB",
        "tokens": {
            "USDT": {
                "address_env": "BSC_USDT_ADDRESS",
                "default_address": "0x55d398326f99059fF775485246999027B3197955",
                "decimals": 18,
            },
            "USDC": {
                "address_env": "BSC_USDC_ADDRESS",
                "default_address": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
                "decimals": 18,
            },
        },
    },
    42161: {
        "name": "Arbitrum",
        "rpc_env": "ARBITRUM_RPC_URL",
        "native_symbol": "ETH",
        "tokens": {
            "USDT": {
                "address_env": "ARBITRUM_USDT_ADDRESS",
                "default_address": "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9",
                "decimals": 6,
            },
            "USDC": {
                "address_env": "ARBITRUM_USDC_ADDRESS",
                "default_address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
                "decimals": 6,
            },
        },
    },
}

ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "constant": False,
        "inputs": [
            {"name": "recipient", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "stateMutability": "view",
        "type": "function",
    },
]


class OTCClientError(RuntimeError):
    pass


@dataclass(slots=True)
class OTCOrder:
    id: int
    seller: str
    buyer: str
    amount_axon_wei: int
    price_usd_raw: int
    payment_chain_id: int
    payment_token: str
    seller_payment_addr: str
    status: int
    created_at: int
    cancel_requested_at: int

    @property
    def amount_axon(self) -> float:
        return float(Decimal(self.amount_axon_wei) / Decimal(10**18))

    @property
    def price_usd(self) -> float:
        return float(Decimal(self.price_usd_raw) / Decimal(PRICE_SCALE))

    @property
    def total_payment(self) -> float:
        total = (Decimal(self.amount_axon_wei) / Decimal(10**18)) * (
            Decimal(self.price_usd_raw) / Decimal(PRICE_SCALE)
        )
        return float(total)

    @property
    def status_label(self) -> str:
        return STATUS_LABELS.get(self.status, f"Unknown({self.status})")

    @property
    def payment_chain_name(self) -> str:
        return CHAIN_CONFIG.get(self.payment_chain_id, {}).get(
            "name", f"Chain({self.payment_chain_id})"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "seller": self.seller,
            "buyer": self.buyer,
            "amount_axon": self.amount_axon,
            "amount_axon_wei": self.amount_axon_wei,
            "price_usd": self.price_usd,
            "price_usd_raw": self.price_usd_raw,
            "total_payment": self.total_payment,
            "payment_chain_id": self.payment_chain_id,
            "payment_chain_name": self.payment_chain_name,
            "payment_token": self.payment_token,
            "seller_payment_addr": self.seller_payment_addr,
            "status": self.status,
            "status_label": self.status_label,
            "created_at": self.created_at,
            "cancel_requested_at": self.cancel_requested_at,
        }

    def __str__(self) -> str:
        return (
            f"Order#{self.id}  {self.amount_axon:.4f} AXON  @ ${self.price_usd:.4f}/"
            f"{self.payment_token} on {self.payment_chain_name}  total="
            f"{self.total_payment:.4f} {self.payment_token}  [{self.status_label}]"
        )


class OTCClient:
    def __init__(
        self,
        private_key: str | None,
        contract_address: str | None = None,
        *,
        read_only: bool = False,
        keeper_url: str = DEFAULT_KEEPER_URL,
        abi_path: str | None = None,
        axon_rpc_url: str | None = None,
        bsc_rpc_url: str | None = None,
        arbitrum_rpc_url: str | None = None,
        payment_info_path_template: str | None = None,
        request_timeout: int = 15,
        rpc_retries: int = 4,
        keeper_total_timeout: int = 30,
    ) -> None:
        if not private_key and not read_only:
            raise ValueError("private_key is required unless read_only=True")

        self.read_only = read_only
        self.private_key = private_key or READ_ONLY_PRIVATE_KEY
        self.account = Account.from_key(self.private_key)
        self.address = Web3.to_checksum_address(self.account.address)
        self.contract_address = Web3.to_checksum_address(
            contract_address or os.getenv("OTC_CONTRACT_ADDRESS") or DEFAULT_CONTRACT_ADDRESS
        )
        self.abi_path = abi_path
        self.keeper_url = keeper_url.rstrip("/")
        self.payment_info_path_template = payment_info_path_template or os.getenv(
            "OTC_KEEPER_PAYMENT_PATH", ""
        )
        self.request_timeout = request_timeout
        self.rpc_retries = rpc_retries
        self.keeper_total_timeout = keeper_total_timeout

        self._rpc_urls = {
            8210: axon_rpc_url or os.getenv("AXON_RPC_URL"),
            56: bsc_rpc_url or os.getenv("BSC_RPC_URL"),
            42161: arbitrum_rpc_url or os.getenv("ARBITRUM_RPC_URL"),
        }
        self._web3s: dict[int, Web3] = {}
        self._erc20_contracts: dict[tuple[int, str], Contract] = {}

    def list_active_orders(self, offset: int = 0, limit: int = 50) -> tuple[list[OTCOrder], int]:
        if limit <= 0:
            return [], 0
        orders = self._get_active_orders_page(offset, limit)
        return orders, self._get_active_order_count()

    def get_order_count(self) -> int:
        raw = self._eth_call(
            DEFAULT_AXON_CHAIN_ID,
            self.contract_address,
            self._selector("next_order_id"),
        )
        return int(decode(["uint256"], raw)[0])

    def get_order(self, order_id: int) -> OTCOrder:
        call_data = self._selector("get_order") + encode(["uint256"], [int(order_id)])
        raw = self._eth_call(DEFAULT_AXON_CHAIN_ID, self.contract_address, call_data)
        row = decode(
            ["(address,address,uint256,uint256,uint256,string,address,uint8,uint256,uint256)"],
            raw,
        )[0]
        return self._decode_order(order_id, row)

    def get_my_orders(self) -> dict[str, list[int]]:
        return self.get_orders_by_address(self.address)

    def get_orders_by_address(self, address: str) -> dict[str, list[int]]:
        address = Web3.to_checksum_address(address)
        call_data = self._selector("get_orders_by_address") + encode(["address"], [address])
        raw = self._eth_call(DEFAULT_AXON_CHAIN_ID, self.contract_address, call_data)
        as_seller, as_buyer = decode(["uint256[]", "uint256[]"], raw)
        return {
            "as_seller": [int(order_id) for order_id in as_seller],
            "as_buyer": [int(order_id) for order_id in as_buyer],
        }

    def axon_balance(self) -> float:
        return self.axon_balance_of(self.address)

    def axon_balance_of(self, address: str) -> float:
        address = Web3.to_checksum_address(address)
        balance = self._rpc_call(
            DEFAULT_AXON_CHAIN_ID,
            "eth_getBalance",
            [address, "latest"],
        )
        return float(Decimal(int(balance, 16)) / Decimal(10**18))

    def stablecoin_balance(self, chain_id: int, token: str) -> float:
        return self.stablecoin_balance_of(self.address, chain_id, token)

    def stablecoin_balance_of(self, address: str, chain_id: int, token: str) -> float:
        address = Web3.to_checksum_address(address)
        token_contract = self._get_erc20_contract(chain_id, token)
        decimals = self._token_decimals(chain_id, token_contract, token)
        raw_balance = self._with_retries(
            lambda: token_contract.functions.balanceOf(address).call()
        )
        return float(Decimal(raw_balance) / Decimal(10**decimals))

    def cancel_cooldown(self) -> int:
        raw = self._eth_call(
            DEFAULT_AXON_CHAIN_ID,
            self.contract_address,
            self._selector("cancel_cooldown"),
        )
        return int(decode(["uint256"], raw)[0])

    def fee_rate_bps(self) -> int:
        raw = self._eth_call(
            DEFAULT_AXON_CHAIN_ID,
            self.contract_address,
            self._selector("fee_rate_bps"),
        )
        return int(decode(["uint256"], raw)[0])

    def keeper_address(self) -> str:
        raw = self._eth_call(
            DEFAULT_AXON_CHAIN_ID,
            self.contract_address,
            self._selector("keeper"),
        )
        return Web3.to_checksum_address(decode(["address"], raw)[0])

    def admin_address(self) -> str:
        raw = self._eth_call(
            DEFAULT_AXON_CHAIN_ID,
            self.contract_address,
            self._selector("admin"),
        )
        return Web3.to_checksum_address(decode(["address"], raw)[0])

    def create_sell_order(
        self,
        *,
        amount_axon: float | Decimal,
        price_usd: float | Decimal,
        payment_chain_id: int,
        payment_token: str,
        seller_payment_addr: str | None = None,
    ) -> tuple[int | None, str]:
        seller_payment_addr = Web3.to_checksum_address(seller_payment_addr or self.address)
        payload = self._selector("create_sell_order") + encode(
            ["uint256", "uint256", "address", "string"],
            [
                self._to_price_units(price_usd),
                int(payment_chain_id),
                seller_payment_addr,
                payment_token.upper(),
            ],
        )
        receipt = self._send_contract_transaction(
            payload,
            value=self._to_token_units(amount_axon, 18),
        )
        return self._extract_order_id(receipt), receipt.transactionHash.hex()

    def request_cancel_order(self, order_id: int) -> str:
        payload = self._selector("request_cancel_order") + encode(["uint256"], [int(order_id)])
        return self._send_contract_transaction(payload).transactionHash.hex()

    def finalize_cancel_order(self, order_id: int) -> str:
        payload = self._selector("finalize_cancel_order") + encode(["uint256"], [int(order_id)])
        return self._send_contract_transaction(payload).transactionHash.hex()

    def abort_cancel(self, order_id: int) -> str:
        payload = self._selector("abort_cancel") + encode(["uint256"], [int(order_id)])
        return self._send_contract_transaction(payload).transactionHash.hex()

    def seller_release(self, order_id: int, buyer: str) -> str:
        payload = self._selector("seller_release") + encode(
            ["uint256", "address"], [int(order_id), Web3.to_checksum_address(buyer)]
        )
        return self._send_contract_transaction(payload).transactionHash.hex()

    def get_payment_info(self, order_id: int, buyer_address: str | None = None) -> dict[str, Any]:
        last_error: Exception | None = None
        started_at = time.monotonic()
        for candidate in self._keeper_candidates(order_id, buyer_address=buyer_address):
            if time.monotonic() - started_at > self.keeper_total_timeout:
                break
            try:
                return self._request_keeper_candidate(order_id, candidate)
            except Exception as exc:
                last_error = exc

        raise OTCClientError(
            "unable to fetch payment info from keeper. "
            "Set OTC_KEEPER_PAYMENT_PATH to the exact route if your deployment differs "
            "or the gateway is behind a restrictive edge."
        ) from last_error

    def send_payment(self, order_id: int, buyer_address: str | None = None) -> dict[str, Any]:
        payment = self.get_payment_info(order_id, buyer_address=buyer_address)
        tx_hash = self._transfer_stablecoin(
            chain_id=int(payment["payment_chain_id"]),
            token=str(payment["payment_token"]).upper(),
            recipient=Web3.to_checksum_address(payment["payment_address"]),
            amount=Decimal(str(payment["payment_amount"])),
        )
        payment["payment_tx"] = tx_hash
        return payment

    def buy_full(self, order_id: int, buyer_address: str | None = None) -> dict[str, Any]:
        payment = self.send_payment(order_id, buyer_address=buyer_address)
        return {
            "order_id": int(order_id),
            "payment_address": payment["payment_address"],
            "payment_chain_id": payment["payment_chain_id"],
            "payment_token": payment["payment_token"],
            "payment_amount": payment["payment_amount"],
            "payment_tx": payment["payment_tx"],
            "keeper_source": payment["keeper_source"],
        }

    def _decode_order(self, order_id: int, row: tuple[Any, ...]) -> OTCOrder:
        return OTCOrder(
            id=int(order_id),
            seller=Web3.to_checksum_address(row[0]),
            buyer=self._checksum_or_zero(row[1]),
            amount_axon_wei=int(row[2]),
            price_usd_raw=int(row[3]),
            payment_chain_id=int(row[4]),
            payment_token=str(row[5]).upper(),
            seller_payment_addr=Web3.to_checksum_address(row[6]),
            status=int(row[7]),
            created_at=int(row[8]),
            cancel_requested_at=int(row[9]),
        )

    def _get_active_orders_page(self, offset: int, limit: int) -> list[OTCOrder]:
        call_data = self._selector("get_active_orders") + encode(
            ["uint256", "uint256"], [int(offset), int(limit)]
        )
        raw = self._eth_call(DEFAULT_AXON_CHAIN_ID, self.contract_address, call_data)
        order_rows, order_ids = decode(
            ["(address,address,uint256,uint256,uint256,string,address,uint8,uint256,uint256)[]", "uint256[]"],
            raw,
        )
        return [self._decode_order(order_id, row) for order_id, row in zip(order_ids, order_rows)]

    def _get_active_order_count(self) -> int:
        count = 0
        chunk = 200
        offset = 0
        while True:
            page = self._get_active_orders_page(offset, chunk)
            count += len(page)
            if len(page) < chunk:
                return count
            offset += chunk

    def _send_contract_transaction(self, data: bytes, *, value: int = 0) -> Any:
        if self.read_only:
            raise OTCClientError("read-only client cannot send transactions")
        axon_web3 = self._get_web3(DEFAULT_AXON_CHAIN_ID, required=True)
        chain_id = self._with_retries(lambda: axon_web3.eth.chain_id)
        nonce = self._with_retries(
            lambda: axon_web3.eth.get_transaction_count(self.address, "pending")
        )
        tx: dict[str, Any] = {
            "from": self.address,
            "to": self.contract_address,
            "value": int(value),
            "data": Web3.to_hex(data),
            "nonce": nonce,
            "chainId": chain_id,
        }
        try:
            gas = self._with_retries(lambda: axon_web3.eth.estimate_gas(tx))
            tx["gas"] = int(gas * 1.2)
        except Exception:
            tx["gas"] = 400_000

        try:
            tx["gasPrice"] = self._with_retries(lambda: axon_web3.eth.gas_price)
        except Exception as exc:
            raise OTCClientError("failed to fetch gas price for Axon transaction") from exc

        signed = axon_web3.eth.account.sign_transaction(tx, self.private_key)
        tx_hash = self._with_retries(
            lambda: axon_web3.eth.send_raw_transaction(signed.raw_transaction)
        )
        receipt = self._with_retries(
            lambda: axon_web3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        )
        if receipt.status != 1:
            raise OTCClientError(f"contract transaction reverted: {tx_hash.hex()}")
        return receipt

    def _rpc_call(self, chain_id: int, method: str, params: list[Any]) -> Any:
        rpc_url = self._rpc_url(chain_id)
        last_error: Exception | None = None
        for attempt in range(self.rpc_retries):
            try:
                session = requests.Session()
                session.trust_env = False
                session.headers["Connection"] = "close"
                response = session.post(
                    rpc_url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": method,
                        "params": params,
                    },
                    timeout=self.request_timeout,
                )
                payload = response.json()
                if "error" in payload:
                    raise OTCClientError(f"{method} failed: {payload['error']}")
                return payload["result"]
            except Exception as exc:
                last_error = exc
                if attempt < self.rpc_retries - 1:
                    time.sleep(1 + attempt)

        raise OTCClientError(f"RPC call failed for {method} on chain {chain_id}") from last_error

    def _eth_call(self, chain_id: int, to: str, data: bytes) -> bytes:
        result = self._rpc_call(
            chain_id,
            "eth_call",
            [{"to": to, "data": Web3.to_hex(data)}, "latest"],
        )
        return bytes.fromhex(result[2:])

    def _get_web3(self, chain_id: int, *, required: bool = False) -> Web3:
        if chain_id in self._web3s:
            return self._web3s[chain_id]

        rpc_url = self._rpc_urls.get(chain_id)
        if not rpc_url:
            if required:
                env_name = CHAIN_CONFIG.get(chain_id, {}).get("rpc_env", "RPC_URL")
                raise OTCClientError(f"missing RPC URL for chain {chain_id}. Set {env_name}.")
            raise OTCClientError(f"missing RPC URL for chain {chain_id}")

        web3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": self.request_timeout}))
        self._web3s[chain_id] = web3
        return web3

    def _get_erc20_contract(self, chain_id: int, token: str) -> Contract:
        token_address = self._token_address(chain_id, token)
        key = (chain_id, token_address)
        if key not in self._erc20_contracts:
            web3 = self._get_web3(chain_id, required=True)
            self._erc20_contracts[key] = web3.eth.contract(
                address=Web3.to_checksum_address(token_address),
                abi=ERC20_ABI,
            )
        return self._erc20_contracts[key]

    def _transfer_stablecoin(
        self,
        *,
        chain_id: int,
        token: str,
        recipient: str,
        amount: Decimal,
    ) -> str:
        if self.read_only:
            raise OTCClientError("read-only client cannot transfer stablecoins")
        web3 = self._get_web3(chain_id, required=True)
        token_contract = self._get_erc20_contract(chain_id, token)
        decimals = self._token_decimals(chain_id, token_contract, token)
        raw_amount = self._to_token_units(amount, decimals)
        nonce = self._with_retries(
            lambda: web3.eth.get_transaction_count(self.address, "pending")
        )
        function_call = token_contract.functions.transfer(recipient, raw_amount)
        tx: dict[str, Any] = {
            "from": self.address,
            "nonce": nonce,
            "chainId": self._with_retries(lambda: web3.eth.chain_id),
        }
        try:
            gas = self._with_retries(lambda: function_call.estimate_gas({"from": self.address}))
            tx["gas"] = int(gas * 1.2)
        except Exception:
            tx["gas"] = 150_000
        tx["gasPrice"] = self._with_retries(lambda: web3.eth.gas_price)
        built = function_call.build_transaction(tx)
        signed = web3.eth.account.sign_transaction(built, self.private_key)
        tx_hash = self._with_retries(lambda: web3.eth.send_raw_transaction(signed.raw_transaction))
        receipt = self._with_retries(
            lambda: web3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        )
        if receipt.status != 1:
            raise OTCClientError(f"stablecoin transfer reverted: {tx_hash.hex()}")
        return tx_hash.hex()

    def _request_keeper_candidate(self, order_id: int, candidate: dict[str, Any]) -> dict[str, Any]:
        method = candidate["method"]
        kwargs: dict[str, Any] = {
            "timeout": candidate.get("timeout", self.request_timeout),
            "allow_redirects": False,
        }
        if candidate.get("json") is not None:
            kwargs["json"] = candidate["json"]
        if candidate.get("params") is not None:
            kwargs["params"] = candidate["params"]

        last_error: Exception | None = None
        for request_url, extra_headers in self._keeper_request_variants(candidate["path"]):
            try:
                session = requests.Session()
                session.trust_env = False
                session.headers["Connection"] = "close"
                if extra_headers:
                    session.headers.update(extra_headers)
                response = session.request(method, request_url, **kwargs)
                if response.status_code in {404, 405}:
                    raise OTCClientError(f"keeper route mismatch: {method} {request_url}")
                if response.status_code >= 400:
                    raise OTCClientError(
                        f"keeper response {response.status_code} for {method} {request_url}: "
                        f"{response.text[:200]}"
                    )
                return self._normalize_payment_info(
                    order_id,
                    response.json(),
                    f"{method} {request_url}",
                )
            except Exception as exc:
                last_error = exc
                time.sleep(0.3)

        try:
            raw_payload = self._request_keeper_raw_tls(
                candidate["path"],
                timeout=int(candidate.get("timeout", self.request_timeout)),
            )
            return self._normalize_payment_info(
                order_id,
                raw_payload,
                f"RAW_TLS {candidate['path']}",
            )
        except Exception as exc:
            last_error = exc

        raise OTCClientError(
            f"keeper candidate failed: {method} {self.keeper_url}{candidate['path']}"
        ) from last_error

    def _keeper_candidates(
        self, order_id: int, *, buyer_address: str | None = None
    ) -> list[dict[str, Any]]:
        if self.payment_info_path_template:
            return [
                {
                    "method": "GET",
                    "path": self.payment_info_path_template.format(order_id=order_id),
                },
                {
                    "method": "GET",
                    "path": "/orders",
                    "timeout": 6,
                },
            ]

        return [
            {
                "method": "GET",
                "path": "/orders",
                "timeout": 6,
            },
            {
                "method": "GET",
                "path": f"/order/{order_id}/buy",
                "timeout": 4,
            },
            {
                "method": "GET",
                "path": f"/order/{order_id}",
                "timeout": 4,
            },
            {
                "method": "GET",
                "path": f"/api/v1/orders/{order_id}/payment-info",
                "timeout": 4,
            },
            {
                "method": "GET",
                "path": f"/api/orders/{order_id}/payment-info",
                "timeout": 4,
            },
            {
                "method": "GET",
                "path": f"/payment-info/{order_id}",
                "timeout": 4,
            },
            {
                "method": "GET",
                "path": f"/api/v1/orders/payment-info",
                "params": {"order_id": order_id},
                "timeout": 4,
            },
        ]

    def _normalize_payment_info(
        self,
        order_id: int,
        payload: Any,
        source_url: str,
    ) -> dict[str, Any]:
        if isinstance(payload, list):
            payload = self._payment_info_from_orders_list(order_id, payload)

        if "data" in payload and isinstance(payload["data"], dict):
            payload = payload["data"]
        elif "items" in payload and isinstance(payload["items"], list):
            payload = self._payment_info_from_orders_list(order_id, payload["items"])
        elif "orders" in payload and isinstance(payload["orders"], list):
            payload = self._payment_info_from_orders_list(order_id, payload["orders"])

        payment = payload.get("payment") if isinstance(payload.get("payment"), dict) else None
        if payment:
            payload = {
                **payload,
                "payment_address": payment.get("address"),
                "payment_chain_id": payment.get("chain_id"),
                "payment_token": payment.get("token"),
                "payment_amount": payment.get("amount"),
                "payment_chain_name": payment.get("chain_name"),
            }

        address = (
            payload.get("payment_address")
            or payload.get("paymentAddress")
            or payload.get("address")
            or payload.get("pay_to")
        )
        chain_id = (
            payload.get("payment_chain_id")
            or payload.get("paymentChainId")
            or payload.get("chain_id")
            or payload.get("chainId")
        )
        if chain_id is None and payload.get("payment"):
            chain_id = payload["payment"].get("chain_id")
        token = (
            payload.get("payment_token")
            or payload.get("paymentToken")
            or payload.get("token")
            or payload.get("symbol")
        )
        if token is None and payload.get("payment"):
            token = payload["payment"].get("token")
        amount = (
            payload.get("payment_amount")
            or payload.get("paymentAmount")
            or payload.get("amount")
            or payload.get("amount_decimal")
            or payload.get("total")
        )
        if amount is None and payload.get("payment"):
            amount = payload["payment"].get("amount")

        if not address:
            raise OTCClientError(f"keeper response missing payment address for order {order_id}")
        if chain_id is None or token is None or amount is None:
            raise OTCClientError(
                f"keeper response missing chain/token/amount for order {order_id}: {payload}"
            )

        normalized_amount = self._normalize_amount_from_keeper(
            chain_id=int(chain_id),
            token=str(token).upper(),
            amount=amount,
            decimals_hint=payload.get("decimals"),
        )
        return {
            "order_id": int(order_id),
            "payment_address": Web3.to_checksum_address(address),
            "payment_chain_id": int(chain_id),
            "payment_token": str(token).upper(),
            "payment_amount": normalized_amount,
            "keeper_source": source_url,
            "raw": payload,
        }

    def _payment_info_from_orders_list(
        self,
        order_id: int,
        orders: list[Any],
    ) -> dict[str, Any]:
        for item in orders:
            if not isinstance(item, dict):
                continue
            try:
                item_id = int(item.get("id"))
            except (TypeError, ValueError):
                continue
            if item_id != int(order_id):
                continue
            payment = item.get("payment") if isinstance(item.get("payment"), dict) else {}
            return {
                **item,
                "payment_address": (
                    item.get("payment_address")
                    or item.get("paymentAddress")
                    or payment.get("address")
                ),
                "payment_chain_id": (
                    item.get("payment_chain_id")
                    or item.get("paymentChainId")
                    or item.get("chain_id")
                    or item.get("chainId")
                    or payment.get("chain_id")
                ),
                "payment_token": (
                    item.get("payment_token")
                    or item.get("paymentToken")
                    or item.get("token")
                    or payment.get("token")
                ),
                "payment_amount": (
                    item.get("payment_amount")
                    or item.get("paymentAmount")
                    or payment.get("amount")
                    or item.get("total")
                    or item.get("amount")
                ),
                "payment_chain_name": (
                    item.get("payment_chain_name")
                    or item.get("paymentChainName")
                    or item.get("chain_name")
                    or item.get("chain")
                    or payment.get("chain_name")
                ),
            }
        raise OTCClientError(f"order {order_id} not found in keeper /orders response")

    def _keeper_request_variants(self, path: str) -> list[tuple[str, dict[str, str]]]:
        primary = f"{self.keeper_url}{path}"
        variants: list[tuple[str, dict[str, str]]] = [(primary, {})]
        parsed = urlsplit(self.keeper_url)
        host = parsed.hostname
        if not host:
            return variants

        fallback_hosts: list[str] = []
        explicit_host = os.getenv("OTC_KEEPER_HOST_OVERRIDE")
        if explicit_host:
            fallback_hosts.append(explicit_host)
        elif host == "axonotc.com":
            fallback_hosts.extend(self._resolve_keeper_ips(host))

        seen = {primary}
        for ip in fallback_hosts:
            fallback_base = urlunsplit(("http", ip, "", "", ""))
            fallback_url = f"{fallback_base}{path}"
            if fallback_url in seen:
                continue
            seen.add(fallback_url)
            variants.append((fallback_url, {"Host": host}))
        return variants

    def _resolve_keeper_ips(self, host: str) -> list[str]:
        ips: list[str] = []
        try:
            _, _, resolved = socket.gethostbyname_ex(host)
            ips.extend(resolved)
        except OSError:
            pass
        fallback_ip = os.getenv("OTC_KEEPER_FALLBACK_IP", DEFAULT_KEEPER_IP)
        if fallback_ip:
            ips.append(fallback_ip)

        unique: list[str] = []
        for ip in ips:
            if ip and ip not in unique:
                unique.append(ip)
        return unique

    def _request_keeper_raw_tls(self, path: str, *, timeout: int) -> Any:
        parsed = urlsplit(self.keeper_url)
        host = parsed.hostname
        if not host:
            raise OTCClientError("keeper URL is missing a hostname")
        if parsed.scheme != "https":
            raise OTCClientError("raw TLS fallback requires an https keeper URL")

        last_error: Exception | None = None
        for ip in self._resolve_keeper_ips(host):
            for _ in range(2):
                try:
                    raw_response = self._read_https_response_via_ip(
                        ip=ip,
                        host=host,
                        path=path,
                        timeout=timeout,
                    )
                    return self._parse_raw_http_json(raw_response)
                except Exception as exc:
                    last_error = exc
                    time.sleep(0.3)
        raise OTCClientError(f"raw TLS keeper fetch failed for {path}") from last_error

    def _read_https_response_via_ip(
        self,
        *,
        ip: str,
        host: str,
        path: str,
        timeout: int,
    ) -> bytes:
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "User-Agent: axon-otc-client/1.0\r\n"
            "Accept: application/json\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        context = ssl.create_default_context()
        with socket.create_connection((ip, 443), timeout=timeout) as sock:
            with context.wrap_socket(sock, server_hostname=host) as secure_sock:
                secure_sock.settimeout(timeout)
                secure_sock.sendall(request)
                chunks: list[bytes] = []
                total = 0
                while True:
                    chunk = secure_sock.recv(4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > 2_000_000:
                        break
        if not chunks:
            raise OTCClientError(f"empty response from keeper raw TLS for {path}")
        return b"".join(chunks)

    def _parse_raw_http_json(self, raw_response: bytes) -> Any:
        head, _, body = raw_response.partition(b"\r\n\r\n")
        if not head:
            raise OTCClientError("invalid raw HTTP response from keeper")

        header_lines = head.decode("iso-8859-1", errors="replace").split("\r\n")
        status_line = header_lines[0]
        try:
            status_code = int(status_line.split(" ")[1])
        except (IndexError, ValueError) as exc:
            raise OTCClientError(f"invalid HTTP status line from keeper: {status_line}") from exc
        if status_code >= 400:
            text = body.decode("utf-8", errors="replace")
            raise OTCClientError(
                f"keeper raw TLS response {status_code}: {text[:200]}"
            )

        headers: dict[str, str] = {}
        for line in header_lines[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip().lower()

        if headers.get("transfer-encoding") == "chunked":
            body = self._decode_chunked_body(body)

        text = body.decode("utf-8", errors="replace").strip()
        if not text:
            raise OTCClientError("keeper raw TLS response body was empty")
        return json.loads(text)

    def _decode_chunked_body(self, body: bytes) -> bytes:
        decoded = bytearray()
        rest = body
        while rest:
            line, sep, remainder = rest.partition(b"\r\n")
            if not sep:
                break
            size_text = line.split(b";", 1)[0].strip()
            try:
                size = int(size_text, 16)
            except ValueError as exc:
                raise OTCClientError(f"invalid chunk size from keeper: {size_text!r}") from exc
            rest = remainder
            if size == 0:
                break
            decoded.extend(rest[:size])
            rest = rest[size + 2 :]
        return bytes(decoded)

    def _normalize_amount_from_keeper(
        self,
        *,
        chain_id: int,
        token: str,
        amount: Any,
        decimals_hint: Any = None,
    ) -> Decimal:
        if isinstance(amount, (float, Decimal)):
            return Decimal(str(amount))
        if isinstance(amount, int):
            decimals = int(decimals_hint) if decimals_hint is not None else self._token_meta(chain_id, token)["decimals"]
            return Decimal(amount) / Decimal(10**decimals)

        amount_str = str(amount).strip()
        if "." in amount_str:
            return Decimal(amount_str)

        decimals = int(decimals_hint) if decimals_hint is not None else self._token_meta(chain_id, token)["decimals"]
        return Decimal(int(amount_str)) / Decimal(10**decimals)

    def _selector(self, name: str) -> bytes:
        return bytes.fromhex(SELECTORS[name][2:])

    def _token_address(self, chain_id: int, token: str) -> str:
        meta = self._token_meta(chain_id, token)
        return Web3.to_checksum_address(os.getenv(meta["address_env"], meta["default_address"]))

    def _token_meta(self, chain_id: int, token: str) -> dict[str, Any]:
        meta = CHAIN_CONFIG.get(chain_id, {}).get("tokens", {}).get(token.upper())
        if not meta:
            raise OTCClientError(f"unsupported token {token} on chain {chain_id}")
        return meta

    def _token_decimals(self, chain_id: int, token_contract: Contract, token: str) -> int:
        try:
            return int(self._with_retries(lambda: token_contract.functions.decimals().call()))
        except Exception:
            return int(self._token_meta(chain_id, token)["decimals"])

    def _to_token_units(self, amount: float | Decimal, decimals: int) -> int:
        quantized = (Decimal(str(amount)) * Decimal(10**decimals)).quantize(
            Decimal("1"), rounding=ROUND_DOWN
        )
        return int(quantized)

    def _to_price_units(self, price_usd: float | Decimal) -> int:
        scaled = (Decimal(str(price_usd)) * Decimal(PRICE_SCALE)).quantize(
            Decimal("1"), rounding=ROUND_DOWN
        )
        return int(scaled)

    def _checksum_or_zero(self, value: Any) -> str:
        if not value or int(value, 16) == 0:
            return "0x0000000000000000000000000000000000000000"
        return Web3.to_checksum_address(value)

    def _extract_order_id(self, receipt: Any) -> int | None:
        for log in receipt.logs:
            topics = getattr(log, "topics", None) or log.get("topics", [])
            if len(topics) < 2:
                continue
            topic0 = Web3.to_hex(topics[0]).lower()
            if topic0 == ORDER_CREATED_TOPIC.lower():
                return int(Web3.to_hex(topics[1]), 16)
        return None

    def _with_retries(self, fn: Any) -> Any:
        last_error: Exception | None = None
        for attempt in range(self.rpc_retries):
            try:
                return fn()
            except Exception as exc:
                last_error = exc
                if attempt < self.rpc_retries - 1:
                    time.sleep(1 + attempt)
        raise last_error if last_error else OTCClientError("operation failed")

    def _rpc_url(self, chain_id: int) -> str:
        rpc_url = self._rpc_urls.get(chain_id)
        if rpc_url:
            return rpc_url
        env_name = CHAIN_CONFIG.get(chain_id, {}).get("rpc_env", "RPC_URL")
        raise OTCClientError(f"missing RPC URL for chain {chain_id}. Set {env_name}.")
