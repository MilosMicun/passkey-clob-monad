// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {WebAuthn} from "openzeppelin-contracts/contracts/utils/cryptography/WebAuthn.sol";

contract PasskeyCLOB {
    using SafeERC20 for IERC20;

    enum Side {
        BUY,
        SELL
    }

    struct Order {
        address maker;
        Side side;
        uint256 price;
        uint256 amount;
        uint256 remaining;
        bool active;
    }

    struct Balance {
        uint256 availableBase;
        uint256 reservedBase;
        uint256 availableQuote;
        uint256 reservedQuote;
    }

    struct Passkey {
        bytes32 qx;
        bytes32 qy;
        bool registered;
    }

    error ZeroTokenAddress();
    error IdenticalTokenAddresses();
    error ZeroAmount();
    error InsufficientAvailableBalance();
    error ZeroPrice();
    error QuoteAmountTooSmall();
    error OrderNotFound();
    error NotOrderMaker();
    error OrderNotActive();
    error InvalidOrderSide();
    error OrdersDoNotCross();
    error InvalidPasskey();
    error PasskeyNotRegistered();
    error InvalidPasskeySignature();
    error AuthorizationExpired();

    uint256 public constant PRICE_SCALE = 1e18;

    bytes32 private constant PLACE_ACTION = keccak256("PASSKEY_CLOB_PLACE");
    bytes32 private constant CANCEL_ACTION = keccak256("PASSKEY_CLOB_CANCEL");
    bytes32 private constant REPLACE_ACTION = keccak256("PASSKEY_CLOB_REPLACE");

    IERC20 public immutable BASE;
    IERC20 public immutable QUOTE;

    mapping(address => uint256) public makerNonce;
    mapping(bytes32 => Order) public orders;
    mapping(address => Balance) public balances;
    mapping(address => Passkey) public passkeys;
    mapping(address => uint256) public authNonce;

    event OrderPlaced(bytes32 indexed orderId, address indexed maker, Side side, uint256 price, uint256 amount);
    event OrderCancelled(bytes32 indexed orderId, address indexed maker);
    event OrderReplaced(bytes32 indexed oldOrderId, bytes32 indexed newOrderId, address indexed maker);
    event OrderMatched(bytes32 indexed buyOrderId, bytes32 indexed sellOrderId, uint256 price, uint256 amount);
    event Deposited(address indexed maker, address indexed token, uint256 amount);
    event Withdrawn(address indexed maker, address indexed token, uint256 amount);
    event PasskeyRegistered(address indexed maker, bytes32 qx, bytes32 qy);

    constructor(address base, address quote) {
        if (base == address(0) || quote == address(0)) revert ZeroTokenAddress();
        if (base == quote) revert IdenticalTokenAddresses();

        BASE = IERC20(base);
        QUOTE = IERC20(quote);
    }

    function registerPasskey(bytes32 qx, bytes32 qy) external {
        if (qx == bytes32(0) || qy == bytes32(0)) revert InvalidPasskey();

        passkeys[msg.sender] = Passkey({qx: qx, qy: qy, registered: true});

        emit PasskeyRegistered(msg.sender, qx, qy);
    }

    function depositBase(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        BASE.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender].availableBase += amount;

        emit Deposited(msg.sender, address(BASE), amount);
    }

    function depositQuote(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        QUOTE.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender].availableQuote += amount;

        emit Deposited(msg.sender, address(QUOTE), amount);
    }

    function withdrawBase(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        Balance storage balance = balances[msg.sender];
        if (balance.availableBase < amount) revert InsufficientAvailableBalance();

        balance.availableBase -= amount;
        BASE.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, address(BASE), amount);
    }

    function withdrawQuote(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        Balance storage balance = balances[msg.sender];
        if (balance.availableQuote < amount) revert InsufficientAvailableBalance();

        balance.availableQuote -= amount;
        QUOTE.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, address(QUOTE), amount);
    }

    function placeOrder(Side side, uint256 price, uint256 amount) external returns (bytes32 orderId) {
        return _placeOrder(msg.sender, side, price, amount);
    }

    function cancelOrder(bytes32 orderId) external {
        _cancelOrder(msg.sender, orderId);
    }

    function replaceOrder(bytes32 oldOrderId, Side newSide, uint256 newPrice, uint256 newAmount)
        external
        returns (bytes32 newOrderId)
    {
        return _replaceOrder(msg.sender, oldOrderId, newSide, newPrice, newAmount);
    }

    function matchOrders(bytes32 buyOrderId, bytes32 sellOrderId) external {
        Order storage buyOrder = orders[buyOrderId];
        if (buyOrder.maker == address(0)) revert OrderNotFound();
        if (!buyOrder.active) revert OrderNotActive();

        Order storage sellOrder = orders[sellOrderId];
        if (sellOrder.maker == address(0)) revert OrderNotFound();
        if (!sellOrder.active) revert OrderNotActive();

        if (buyOrder.side != Side.BUY || sellOrder.side != Side.SELL) revert InvalidOrderSide();
        if (buyOrder.price < sellOrder.price) revert OrdersDoNotCross();

        uint256 fillAmount = buyOrder.remaining < sellOrder.remaining ? buyOrder.remaining : sellOrder.remaining;
        uint256 executionPrice = sellOrder.price;

        uint256 oldBuyRemaining = buyOrder.remaining;
        uint256 newBuyRemaining = oldBuyRemaining - fillAmount;
        uint256 reservedBefore = Math.mulDiv(oldBuyRemaining, buyOrder.price, PRICE_SCALE);
        uint256 reservedAfter = Math.mulDiv(newBuyRemaining, buyOrder.price, PRICE_SCALE);
        uint256 buyReserveReduction = reservedBefore - reservedAfter;

        uint256 quotePaid = Math.mulDiv(fillAmount, executionPrice, PRICE_SCALE);
        if (quotePaid == 0) revert QuoteAmountTooSmall();

        Balance storage buyerBalance = balances[buyOrder.maker];
        Balance storage sellerBalance = balances[sellOrder.maker];

        sellerBalance.reservedBase -= fillAmount;
        sellerBalance.availableQuote += quotePaid;

        buyerBalance.reservedQuote -= buyReserveReduction;
        buyerBalance.availableQuote += buyReserveReduction - quotePaid;
        buyerBalance.availableBase += fillAmount;

        buyOrder.remaining = newBuyRemaining;
        sellOrder.remaining -= fillAmount;

        if (buyOrder.remaining == 0) buyOrder.active = false;
        if (sellOrder.remaining == 0) sellOrder.active = false;

        emit OrderMatched(buyOrderId, sellOrderId, executionPrice, fillAmount);
    }

    function placeOrderChallenge(address maker, Side side, uint256 price, uint256 amount, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                block.chainid, address(this), maker, PLACE_ACTION, side, price, amount, authNonce[maker], deadline
            )
        );
    }

    function cancelOrderChallenge(address maker, bytes32 orderId, uint256 deadline) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(block.chainid, address(this), maker, CANCEL_ACTION, orderId, authNonce[maker], deadline)
            );
    }

    function replaceOrderChallenge(
        address maker,
        bytes32 oldOrderId,
        Side newSide,
        uint256 newPrice,
        uint256 newAmount,
        uint256 deadline
    ) public view returns (bytes32) {
        uint256 nonce = authNonce[maker];
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                maker,
                REPLACE_ACTION,
                oldOrderId,
                newSide,
                newPrice,
                newAmount,
                nonce,
                deadline
            )
        );
    }

    function placeOrderWithPasskey(
        address maker,
        Side side,
        uint256 price,
        uint256 amount,
        uint256 deadline,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (bytes32 orderId) {
        if (block.timestamp > deadline) revert AuthorizationExpired();

        bytes32 challenge = placeOrderChallenge(maker, side, price, amount, deadline);
        _authorizePasskey(maker, challenge, auth);

        return _placeOrder(maker, side, price, amount);
    }

    function cancelOrderWithPasskey(
        address maker,
        bytes32 orderId,
        uint256 deadline,
        WebAuthn.WebAuthnAuth calldata auth
    ) external {
        if (block.timestamp > deadline) revert AuthorizationExpired();

        bytes32 challenge = cancelOrderChallenge(maker, orderId, deadline);
        _authorizePasskey(maker, challenge, auth);

        _cancelOrder(maker, orderId);
    }

    function replaceOrderWithPasskey(
        address maker,
        bytes32 oldOrderId,
        Side newSide,
        uint256 newPrice,
        uint256 newAmount,
        uint256 deadline,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (bytes32 newOrderId) {
        if (block.timestamp > deadline) revert AuthorizationExpired();

        bytes32 challenge = replaceOrderChallenge(maker, oldOrderId, newSide, newPrice, newAmount, deadline);
        _authorizePasskey(maker, challenge, auth);

        return _replaceOrder(maker, oldOrderId, newSide, newPrice, newAmount);
    }

    function _authorizePasskey(address maker, bytes32 challenge, WebAuthn.WebAuthnAuth calldata auth) internal {
        Passkey storage passkey = passkeys[maker];
        if (!passkey.registered) revert PasskeyNotRegistered();
        if (!WebAuthn.verify(abi.encodePacked(challenge), auth, passkey.qx, passkey.qy)) {
            revert InvalidPasskeySignature();
        }

        authNonce[maker] += 1;
    }

    function _placeOrder(address maker, Side side, uint256 price, uint256 amount) internal returns (bytes32 orderId) {
        if (amount == 0) revert ZeroAmount();
        if (price == 0) revert ZeroPrice();

        Balance storage balance = balances[maker];
        if (side == Side.SELL) {
            if (balance.availableBase < amount) revert InsufficientAvailableBalance();

            balance.availableBase -= amount;
            balance.reservedBase += amount;
        } else {
            uint256 quoteRequired = Math.mulDiv(amount, price, PRICE_SCALE);
            if (quoteRequired == 0) revert QuoteAmountTooSmall();
            if (balance.availableQuote < quoteRequired) revert InsufficientAvailableBalance();

            balance.availableQuote -= quoteRequired;
            balance.reservedQuote += quoteRequired;
        }

        uint256 nonce = makerNonce[maker];
        orderId = keccak256(abi.encode(maker, nonce));
        makerNonce[maker] = nonce + 1;

        orders[orderId] =
            Order({maker: maker, side: side, price: price, amount: amount, remaining: amount, active: true});

        emit OrderPlaced(orderId, maker, side, price, amount);
    }

    function _cancelOrder(address maker, bytes32 orderId) internal {
        Order storage order = orders[orderId];
        if (order.maker == address(0)) revert OrderNotFound();
        if (order.maker != maker) revert NotOrderMaker();
        if (!order.active) revert OrderNotActive();

        Balance storage balance = balances[maker];
        if (order.side == Side.SELL) {
            balance.reservedBase -= order.remaining;
            balance.availableBase += order.remaining;
        } else {
            uint256 quoteReleased = Math.mulDiv(order.remaining, order.price, PRICE_SCALE);
            balance.reservedQuote -= quoteReleased;
            balance.availableQuote += quoteReleased;
        }

        order.active = false;

        emit OrderCancelled(orderId, maker);
    }

    function _replaceOrder(address maker, bytes32 oldOrderId, Side newSide, uint256 newPrice, uint256 newAmount)
        internal
        returns (bytes32 newOrderId)
    {
        _cancelOrder(maker, oldOrderId);
        newOrderId = _placeOrder(maker, newSide, newPrice, newAmount);

        emit OrderReplaced(oldOrderId, newOrderId, maker);
    }
}
