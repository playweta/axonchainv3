export const CONTRACT_ADDRESS = "0x10063340374db851e2628D06F4732d5FF814eB34";
export const DEFAULT_KEEPER_URL = "https://axonotc.com";
export const API_BASE = "/api";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ORDER_CREATED_TOPIC =
  "0x4230830dfe20a0ca4dea7c6539ec33d88b3ac7a4bb183602ec80cfb9728ac521";

export const STATUS_LABELS = {
  0: "Active",
  1: "Completed",
  2: "CancelPending",
  3: "Cancelled",
  4: "Disputed",
};

export const CHAINS = {
  8210: {
    chainId: 8210,
    chainIdHex: "0x2012",
    label: "Axon",
    nativeSymbol: "AXON",
    rpcUrl: "https://mainnet-rpc.axonchain.ai/",
    rpcUrls: ["https://mainnet-rpc.axonchain.ai/"],
    chainName: "Axon Mainnet",
    nativeCurrency: { name: "AXON", symbol: "AXON", decimals: 18 },
    blockExplorerUrls: ["https://mainnet-explorer.axonchain.ai"],
  },
  56: {
    chainId: 56,
    chainIdHex: "0x38",
    label: "BSC",
    nativeSymbol: "BNB",
    rpcUrl: "https://bsc-dataseed.binance.org/",
    rpcUrls: ["https://bsc-dataseed.binance.org/"],
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrls: ["https://bscscan.com"],
  },
  42161: {
    chainId: 42161,
    chainIdHex: "0xa4b1",
    label: "Arbitrum",
    nativeSymbol: "ETH",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    chainName: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://arbiscan.io"],
  },
};

export const TOKENS = {
  56: {
    USDT: {
      address: "0x55d398326f99059fF775485246999027B3197955",
      decimals: 18,
    },
    USDC: {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      decimals: 18,
    },
  },
  42161: {
    USDT: {
      address: "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9",
      decimals: 6,
    },
    USDC: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
  },
};

export const CONTRACT_ABI = [
  "function nextOrderId() view returns (uint256)",
  "function feeRateBps() view returns (uint256)",
  "function cancelCooldown() view returns (uint256)",
  "function getOrder(uint256 orderId) view returns (tuple(address seller,address buyer,uint256 amountAxon,uint256 priceUsd,uint256 paymentChainId,string paymentToken,address sellerPaymentAddr,uint8 status,uint256 createdAt,uint256 cancelRequestedAt))",
  "function getActiveOrders(uint256 offset,uint256 limit) view returns (tuple(address seller,address buyer,uint256 amountAxon,uint256 priceUsd,uint256 paymentChainId,string paymentToken,address sellerPaymentAddr,uint8 status,uint256 createdAt,uint256 cancelRequestedAt)[] orders,uint256[] orderIds)",
  "function getOrdersByAddress(address user) view returns (uint256[] asSeller,uint256[] asBuyer)",
  "function createOrder(uint256 priceUsd,uint256 paymentChainId,string paymentToken,address sellerPaymentAddr) payable",
  "function requestCancelOrder(uint256 orderId)",
  "function finalizeCancelOrder(uint256 orderId)",
  "function abortCancel(uint256 orderId)",
  "function sellerRelease(uint256 orderId,address buyer)"
];

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];
