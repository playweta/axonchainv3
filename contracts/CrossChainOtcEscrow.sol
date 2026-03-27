// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

library SafeTransferLib {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(token.transfer.selector, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TOKEN_TRANSFER_FAILED");
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TOKEN_TRANSFER_FROM_FAILED");
    }
}

abstract contract Ownable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor(address initialOwner) {
        require(initialOwner != address(0), "ZERO_OWNER");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

contract AxonCrossChainEscrow is Ownable {
    enum OrderStatus {
        Active,
        Completed,
        CancelPending,
        Cancelled
    }

    struct Order {
        address seller;
        address buyer;
        address sellerPaymentAddr;
        uint256 amountAxon;
        uint256 priceUsd;
        uint256 paymentChainId;
        string paymentToken;
        OrderStatus status;
        uint256 cancelRequestedAt;
        uint256 createdAt;
        uint256 completedAt;
        bytes32 paymentRef;
    }

    uint256 public nextOrderId = 1;
    uint256 public cancelCooldown = 15 minutes;
    address public keeper;

    mapping(uint256 => Order) private _orders;
    mapping(uint256 => uint256) private _activeOrderIndexPlusOne;
    uint256[] private _activeOrderIds;
    mapping(address => uint256[]) private _sellerOrders;
    mapping(address => uint256[]) private _buyerOrders;

    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event CancelCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event SellOrderCreated(
        uint256 indexed orderId,
        address indexed seller,
        uint256 amountAxon,
        uint256 priceUsd,
        uint256 paymentChainId,
        string paymentToken,
        address sellerPaymentAddr
    );
    event CancelRequested(uint256 indexed orderId, uint256 requestedAt);
    event CancelAborted(uint256 indexed orderId);
    event OrderCancelled(uint256 indexed orderId);
    event OrderCompleted(
        uint256 indexed orderId,
        address indexed seller,
        address indexed buyer,
        uint256 amountAxon,
        bytes32 paymentRef
    );

    modifier onlyKeeper() {
        require(msg.sender == keeper, "ONLY_KEEPER");
        _;
    }

    modifier orderExists(uint256 orderId) {
        require(_orders[orderId].seller != address(0), "ORDER_NOT_FOUND");
        _;
    }

    constructor(address initialOwner, address initialKeeper) Ownable(initialOwner) {
        require(initialKeeper != address(0), "ZERO_KEEPER");
        keeper = initialKeeper;
        emit KeeperUpdated(address(0), initialKeeper);
    }

    function setKeeper(address newKeeper) external onlyOwner {
        require(newKeeper != address(0), "ZERO_KEEPER");
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setCancelCooldown(uint256 newCooldown) external onlyOwner {
        uint256 oldCooldown = cancelCooldown;
        cancelCooldown = newCooldown;
        emit CancelCooldownUpdated(oldCooldown, newCooldown);
    }

    function getOrderCount() external view returns (uint256) {
        return nextOrderId - 1;
    }

    function getOrder(uint256 orderId) external view orderExists(orderId) returns (Order memory) {
        return _orders[orderId];
    }

    function getActiveOrders(uint256 offset, uint256 limit)
        external
        view
        returns (Order[] memory orders, uint256[] memory orderIds)
    {
        if (offset >= _activeOrderIds.length) {
            return (new Order[](0), new uint256[](0));
        }

        uint256 end = offset + limit;
        if (end > _activeOrderIds.length) {
            end = _activeOrderIds.length;
        }

        uint256 size = end - offset;
        orders = new Order[](size);
        orderIds = new uint256[](size);

        for (uint256 i = 0; i < size; i++) {
            uint256 orderId = _activeOrderIds[offset + i];
            orders[i] = _orders[orderId];
            orderIds[i] = orderId;
        }
    }

    function getOrdersByAddress(address user)
        external
        view
        returns (uint256[] memory asSeller, uint256[] memory asBuyer)
    {
        return (_sellerOrders[user], _buyerOrders[user]);
    }

    function createSellOrder(
        uint256 priceUsd,
        uint256 paymentChainId,
        address sellerPaymentAddr,
        string calldata paymentToken
    ) external payable returns (uint256 orderId) {
        require(msg.value > 0, "ZERO_AXON");
        require(priceUsd > 0, "ZERO_PRICE");
        require(paymentChainId > 0, "ZERO_CHAIN");
        require(sellerPaymentAddr != address(0), "ZERO_RECEIVER");
        require(bytes(paymentToken).length > 0, "EMPTY_TOKEN");

        orderId = nextOrderId++;
        Order storage order = _orders[orderId];
        order.seller = msg.sender;
        order.sellerPaymentAddr = sellerPaymentAddr;
        order.amountAxon = msg.value;
        order.priceUsd = priceUsd;
        order.paymentChainId = paymentChainId;
        order.paymentToken = paymentToken;
        order.status = OrderStatus.Active;
        order.createdAt = block.timestamp;

        _sellerOrders[msg.sender].push(orderId);
        _addActiveOrder(orderId);

        emit SellOrderCreated(
            orderId,
            msg.sender,
            msg.value,
            priceUsd,
            paymentChainId,
            paymentToken,
            sellerPaymentAddr
        );
    }

    function requestCancelOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = _orders[orderId];
        require(msg.sender == order.seller, "ONLY_SELLER");
        require(order.status == OrderStatus.Active, "ORDER_NOT_ACTIVE");

        order.status = OrderStatus.CancelPending;
        order.cancelRequestedAt = block.timestamp;

        emit CancelRequested(orderId, block.timestamp);
    }

    function finalizeCancelOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = _orders[orderId];
        require(msg.sender == order.seller, "ONLY_SELLER");
        require(order.status == OrderStatus.CancelPending, "ORDER_NOT_CANCEL_PENDING");
        require(block.timestamp >= order.cancelRequestedAt + cancelCooldown, "COOLDOWN_NOT_REACHED");

        order.status = OrderStatus.Cancelled;
        _removeActiveOrder(orderId);

        uint256 amount = order.amountAxon;
        order.amountAxon = 0;

        (bool ok,) = payable(order.seller).call{value: amount}("");
        require(ok, "AXON_REFUND_FAILED");

        emit OrderCancelled(orderId);
    }

    function abortCancel(uint256 orderId) external orderExists(orderId) {
        Order storage order = _orders[orderId];
        require(msg.sender == order.seller || msg.sender == keeper, "NOT_AUTHORIZED");
        require(order.status == OrderStatus.CancelPending, "ORDER_NOT_CANCEL_PENDING");

        order.status = OrderStatus.Active;
        order.cancelRequestedAt = 0;

        emit CancelAborted(orderId);
    }

    function sellerRelease(uint256 orderId, address buyer) external orderExists(orderId) {
        Order storage order = _orders[orderId];
        require(msg.sender == order.seller, "ONLY_SELLER");
        _completeOrder(orderId, order, buyer, bytes32(0));
    }

    function keeperRelease(uint256 orderId, address buyer, bytes32 paymentRef)
        external
        onlyKeeper
        orderExists(orderId)
    {
        _completeOrder(orderId, _orders[orderId], buyer, paymentRef);
    }

    function _completeOrder(uint256 orderId, Order storage order, address buyer, bytes32 paymentRef) internal {
        require(order.status == OrderStatus.Active || order.status == OrderStatus.CancelPending, "ORDER_NOT_OPEN");
        require(buyer != address(0), "ZERO_BUYER");

        order.status = OrderStatus.Completed;
        order.buyer = buyer;
        order.completedAt = block.timestamp;
        order.paymentRef = paymentRef;
        order.cancelRequestedAt = 0;

        _buyerOrders[buyer].push(orderId);
        _removeActiveOrder(orderId);

        uint256 amount = order.amountAxon;
        order.amountAxon = 0;

        (bool ok,) = payable(buyer).call{value: amount}("");
        require(ok, "AXON_RELEASE_FAILED");

        emit OrderCompleted(orderId, order.seller, buyer, amount, paymentRef);
    }

    function _addActiveOrder(uint256 orderId) private {
        _activeOrderIds.push(orderId);
        _activeOrderIndexPlusOne[orderId] = _activeOrderIds.length;
    }

    function _removeActiveOrder(uint256 orderId) private {
        uint256 indexPlusOne = _activeOrderIndexPlusOne[orderId];
        if (indexPlusOne == 0) {
            return;
        }

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _activeOrderIds.length - 1;
        if (index != lastIndex) {
            uint256 lastOrderId = _activeOrderIds[lastIndex];
            _activeOrderIds[index] = lastOrderId;
            _activeOrderIndexPlusOne[lastOrderId] = index + 1;
        }

        _activeOrderIds.pop();
        delete _activeOrderIndexPlusOne[orderId];
    }
}

contract BscPaymentVaultFactory is Ownable {
    using SafeTransferLib for IERC20;

    enum PaymentStatus {
        None,
        AwaitingPayment,
        Paid,
        Cancelled
    }

    struct PaymentOrder {
        uint256 axonOrderId;
        address buyer;
        address seller;
        address sellerPaymentAddr;
        address token;
        address vault;
        uint256 amount;
        uint256 createdAt;
        PaymentStatus status;
        bytes32 paymentRef;
    }

    address public keeper;
    mapping(uint256 => PaymentOrder) public paymentOrders;
    mapping(address => bool) public isVault;

    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event PaymentOrderPrepared(
        uint256 indexed axonOrderId,
        address indexed buyer,
        address indexed vault,
        address token,
        uint256 amount,
        address sellerPaymentAddr,
        bytes32 paymentRef
    );
    event PaymentReceived(
        uint256 indexed axonOrderId,
        address indexed buyer,
        address indexed payer,
        address vault,
        address token,
        uint256 amount,
        bytes32 paymentRef
    );
    event PaymentOrderCancelled(uint256 indexed axonOrderId);

    modifier onlyKeeper() {
        require(msg.sender == keeper, "ONLY_KEEPER");
        _;
    }

    modifier onlyVault() {
        require(isVault[msg.sender], "ONLY_VAULT");
        _;
    }

    constructor(address initialOwner, address initialKeeper) Ownable(initialOwner) {
        require(initialKeeper != address(0), "ZERO_KEEPER");
        keeper = initialKeeper;
        emit KeeperUpdated(address(0), initialKeeper);
    }

    function setKeeper(address newKeeper) external onlyOwner {
        require(newKeeper != address(0), "ZERO_KEEPER");
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function preparePaymentOrder(
        uint256 axonOrderId,
        address buyer,
        address seller,
        address sellerPaymentAddr,
        address token,
        uint256 amount
    ) external onlyKeeper returns (address vault, bytes32 paymentRef) {
        require(paymentOrders[axonOrderId].status == PaymentStatus.None, "ORDER_EXISTS");
        require(buyer != address(0), "ZERO_BUYER");
        require(seller != address(0), "ZERO_SELLER");
        require(sellerPaymentAddr != address(0), "ZERO_SELLER_PAYMENT_ADDR");
        require(token != address(0), "ZERO_TOKEN");
        require(amount > 0, "ZERO_AMOUNT");

        paymentRef = keccak256(
            abi.encodePacked(block.chainid, axonOrderId, buyer, seller, sellerPaymentAddr, token, amount)
        );
        bytes32 salt = keccak256(abi.encodePacked(axonOrderId, buyer, token, amount, paymentRef));
        vault = address(
            new BscPaymentVault{salt: salt}(address(this), axonOrderId, buyer, token, sellerPaymentAddr, amount)
        );

        paymentOrders[axonOrderId] = PaymentOrder({
            axonOrderId: axonOrderId,
            buyer: buyer,
            seller: seller,
            sellerPaymentAddr: sellerPaymentAddr,
            token: token,
            vault: vault,
            amount: amount,
            createdAt: block.timestamp,
            status: PaymentStatus.AwaitingPayment,
            paymentRef: paymentRef
        });
        isVault[vault] = true;

        emit PaymentOrderPrepared(axonOrderId, buyer, vault, token, amount, sellerPaymentAddr, paymentRef);
    }

    function cancelPaymentOrder(uint256 axonOrderId) external onlyKeeper {
        PaymentOrder storage order = paymentOrders[axonOrderId];
        require(order.status == PaymentStatus.AwaitingPayment, "ORDER_NOT_AWAITING");
        order.status = PaymentStatus.Cancelled;
        emit PaymentOrderCancelled(axonOrderId);
    }

    function markPaid(uint256 axonOrderId, address payer) external onlyVault {
        PaymentOrder storage order = paymentOrders[axonOrderId];
        require(order.status == PaymentStatus.AwaitingPayment, "ORDER_NOT_AWAITING");

        order.status = PaymentStatus.Paid;

        emit PaymentReceived(
            axonOrderId,
            order.buyer,
            payer,
            msg.sender,
            order.token,
            order.amount,
            order.paymentRef
        );
    }
}

contract BscPaymentVault {
    using SafeTransferLib for IERC20;

    BscPaymentVaultFactory public immutable factory;
    uint256 public immutable axonOrderId;
    address public immutable buyer;
    IERC20 public immutable token;
    address public immutable sellerPaymentAddr;
    uint256 public immutable amount;
    bool public paid;

    constructor(
        address factory_,
        uint256 axonOrderId_,
        address buyer_,
        address token_,
        address sellerPaymentAddr_,
        uint256 amount_
    ) {
        require(factory_ != address(0), "ZERO_FACTORY");
        require(buyer_ != address(0), "ZERO_BUYER");
        require(token_ != address(0), "ZERO_TOKEN");
        require(sellerPaymentAddr_ != address(0), "ZERO_RECEIVER");
        require(amount_ > 0, "ZERO_AMOUNT");

        factory = BscPaymentVaultFactory(factory_);
        axonOrderId = axonOrderId_;
        buyer = buyer_;
        token = IERC20(token_);
        sellerPaymentAddr = sellerPaymentAddr_;
        amount = amount_;
    }

    function pay() external {
        require(!paid, "ALREADY_PAID");
        require(msg.sender == buyer, "ONLY_BUYER");
        paid = true;

        token.safeTransferFrom(msg.sender, address(this), amount);
        token.safeTransfer(sellerPaymentAddr, amount);

        factory.markPaid(axonOrderId, msg.sender);
    }
}
