from __future__ import annotations

import argparse
import json
import os
from typing import Any

from .otc_client import OTCClient

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv() -> bool:
        return False


def build_client(args: argparse.Namespace) -> OTCClient:
    return OTCClient(
        private_key=args.private_key or os.environ.get("AXON_PRIVATE_KEY", ""),
        contract_address=args.contract_address or os.environ.get("OTC_CONTRACT_ADDRESS"),
        keeper_url=args.keeper_url or os.environ.get("KEEPER_URL", "https://axonotc.com"),
        abi_path=args.abi_path or os.environ.get("OTC_ABI_PATH"),
        axon_rpc_url=args.axon_rpc_url or os.environ.get("AXON_RPC_URL"),
        bsc_rpc_url=args.bsc_rpc_url or os.environ.get("BSC_RPC_URL"),
        arbitrum_rpc_url=args.arbitrum_rpc_url or os.environ.get("ARBITRUM_RPC_URL"),
        payment_info_path_template=args.payment_info_path
        or os.environ.get("OTC_KEEPER_PAYMENT_PATH"),
    )


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


def add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--private-key")
    parser.add_argument("--contract-address")
    parser.add_argument("--keeper-url")
    parser.add_argument("--abi-path")
    parser.add_argument("--axon-rpc-url")
    parser.add_argument("--bsc-rpc-url")
    parser.add_argument("--arbitrum-rpc-url")
    parser.add_argument("--payment-info-path")


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Axon OTC V7 CLI")
    add_common_options(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)

    sub = subparsers.add_parser("list", help="List active or listable orders")
    sub.add_argument("--offset", type=int, default=0)
    sub.add_argument("--limit", type=int, default=50)

    sub = subparsers.add_parser("show", help="Show order details")
    sub.add_argument("--order-id", type=int, required=True)

    sub = subparsers.add_parser("payment-info", help="Get keeper payment info for an order")
    sub.add_argument("--order-id", type=int, required=True)

    sub = subparsers.add_parser("buy", help="Get payment info and send USDT/USDC")
    sub.add_argument("--order-id", type=int, required=True)

    sub = subparsers.add_parser("create", help="Create a sell order")
    sub.add_argument("--amount", type=float, required=True)
    sub.add_argument("--price", type=float, required=True)
    sub.add_argument("--chain", type=int, required=True)
    sub.add_argument("--token", required=True)
    sub.add_argument("--seller-payment-addr")

    sub = subparsers.add_parser("cancel-request", help="Start order cancellation cooldown")
    sub.add_argument("--order-id", type=int, required=True)

    sub = subparsers.add_parser("cancel-finalize", help="Finalize order cancellation")
    sub.add_argument("--order-id", type=int, required=True)

    sub = subparsers.add_parser("abort-cancel", help="Abort cancellation and resume order")
    sub.add_argument("--order-id", type=int, required=True)

    sub = subparsers.add_parser("seller-release", help="Manual seller release")
    sub.add_argument("--order-id", type=int, required=True)
    sub.add_argument("--buyer", required=True)

    subparsers.add_parser("my-orders", help="List my seller and buyer order ids")
    subparsers.add_parser("axon-balance", help="Show AXON balance")

    sub = subparsers.add_parser("stablecoin-balance", help="Show stablecoin balance")
    sub.add_argument("--chain", type=int, required=True)
    sub.add_argument("--token", required=True)

    args = parser.parse_args()
    client = build_client(args)

    if args.command == "list":
        orders, total = client.list_active_orders(args.offset, args.limit)
        print(f"total={total}")
        for order in orders:
            print(order)
        return

    if args.command == "show":
        print_json(client.get_order(args.order_id).to_dict())
        return

    if args.command == "payment-info":
        print_json(client.get_payment_info(args.order_id))
        return

    if args.command == "buy":
        print_json(client.buy_full(args.order_id))
        return

    if args.command == "create":
        order_id, tx_hash = client.create_sell_order(
            amount_axon=args.amount,
            price_usd=args.price,
            payment_chain_id=args.chain,
            payment_token=args.token,
            seller_payment_addr=args.seller_payment_addr,
        )
        print_json({"order_id": order_id, "tx_hash": tx_hash})
        return

    if args.command == "cancel-request":
        print_json({"tx_hash": client.request_cancel_order(args.order_id)})
        return

    if args.command == "cancel-finalize":
        print_json({"tx_hash": client.finalize_cancel_order(args.order_id)})
        return

    if args.command == "abort-cancel":
        print_json({"tx_hash": client.abort_cancel(args.order_id)})
        return

    if args.command == "seller-release":
        print_json({"tx_hash": client.seller_release(args.order_id, args.buyer)})
        return

    if args.command == "my-orders":
        print_json(client.get_my_orders())
        return

    if args.command == "axon-balance":
        print_json({"address": client.address, "axon_balance": client.axon_balance()})
        return

    if args.command == "stablecoin-balance":
        print_json(
            {
                "address": client.address,
                "chain_id": args.chain,
                "token": args.token.upper(),
                "balance": client.stablecoin_balance(args.chain, args.token),
            }
        )
        return


if __name__ == "__main__":
    main()
