// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {WebAuthn} from "openzeppelin-contracts/contracts/utils/cryptography/WebAuthn.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {PasskeyCLOB} from "../src/PasskeyCLOB.sol";

contract PasskeyCLOBTest is Test {
    uint256 internal constant PASSKEY_PRIVATE_KEY = 0xA11CE;
    uint256 internal constant WRONG_PRIVATE_KEY = 0xB0B;

    event OrderMatched(bytes32 indexed buyOrderId, bytes32 indexed sellOrderId, uint256 price, uint256 amount);

    MockERC20 internal base;
    MockERC20 internal quote;
    PasskeyCLOB internal clob;

    address internal maker = makeAddr("maker");
    address internal secondMaker = makeAddr("secondMaker");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        base = new MockERC20("Base", "BASE");
        quote = new MockERC20("Quote", "QUOTE");
        clob = new PasskeyCLOB(address(base), address(quote));

        base.mint(maker, 100e18);
        base.mint(secondMaker, 100e18);
        quote.mint(maker, 100e18);
        quote.mint(secondMaker, 100e18);
    }

    function testConstructorRejectsZeroToken() public {
        vm.expectRevert(PasskeyCLOB.ZeroTokenAddress.selector);
        new PasskeyCLOB(address(0), address(quote));
    }

    function testConstructorRejectsIdenticalTokens() public {
        vm.expectRevert(PasskeyCLOB.IdenticalTokenAddresses.selector);
        new PasskeyCLOB(address(base), address(base));
    }

    function testDepositBaseAccounting() public {
        _depositBase(maker, 10e18);

        (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote) =
            clob.balances(maker);
        assertEq(availableBase, 10e18);
        assertEq(reservedBase, 0);
        assertEq(availableQuote, 0);
        assertEq(reservedQuote, 0);
    }

    function testDepositQuoteAccounting() public {
        _depositQuote(maker, 20e18);

        (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote) =
            clob.balances(maker);
        assertEq(availableBase, 0);
        assertEq(reservedBase, 0);
        assertEq(availableQuote, 20e18);
        assertEq(reservedQuote, 0);
    }

    function testSellPlaceOrder() public {
        _depositBase(maker, 10e18);
        bytes32 expectedOrderId = keccak256(abi.encode(maker, uint256(0)));

        vm.prank(maker);
        bytes32 orderId = clob.placeOrder(PasskeyCLOB.Side.SELL, 2e18, 4e18);

        assertEq(orderId, expectedOrderId);
        _assertOrder(orderId, maker, PasskeyCLOB.Side.SELL, 2e18, 4e18);
        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 0);

        (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote) =
            clob.balances(maker);
        assertEq(availableBase, 6e18);
        assertEq(reservedBase, 4e18);
        assertEq(availableQuote, 0);
        assertEq(reservedQuote, 0);
    }

    function testBuyPlaceOrder() public {
        _depositQuote(maker, 30e18);
        bytes32 expectedOrderId = keccak256(abi.encode(maker, uint256(0)));

        vm.prank(maker);
        bytes32 orderId = clob.placeOrder(PasskeyCLOB.Side.BUY, 2e18, 10e18);

        assertEq(orderId, expectedOrderId);
        _assertOrder(orderId, maker, PasskeyCLOB.Side.BUY, 2e18, 10e18);
        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 0);

        (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote) =
            clob.balances(maker);
        assertEq(availableBase, 0);
        assertEq(reservedBase, 0);
        assertEq(availableQuote, 10e18);
        assertEq(reservedQuote, 20e18);
    }

    function testPlaceOrderRevertsForZeroAmount() public {
        vm.expectRevert(PasskeyCLOB.ZeroAmount.selector);
        clob.placeOrder(PasskeyCLOB.Side.SELL, 1e18, 0);
    }

    function testPlaceOrderRevertsForZeroPrice() public {
        vm.expectRevert(PasskeyCLOB.ZeroPrice.selector);
        clob.placeOrder(PasskeyCLOB.Side.SELL, 0, 1e18);
    }

    function testSellPlaceOrderRevertsForInsufficientBase() public {
        vm.expectRevert(PasskeyCLOB.InsufficientAvailableBalance.selector);
        clob.placeOrder(PasskeyCLOB.Side.SELL, 1e18, 1e18);
    }

    function testBuyPlaceOrderRevertsForInsufficientQuote() public {
        vm.expectRevert(PasskeyCLOB.InsufficientAvailableBalance.selector);
        clob.placeOrder(PasskeyCLOB.Side.BUY, 2e18, 1e18);
    }

    function testBuyPlaceOrderRevertsWhenQuoteAmountIsTooSmall() public {
        vm.expectRevert(PasskeyCLOB.QuoteAmountTooSmall.selector);
        clob.placeOrder(PasskeyCLOB.Side.BUY, 1, 1);
    }

    function testDifferentMakersReceiveDifferentNonceZeroOrderIds() public {
        _depositBase(maker, 1e18);
        _depositBase(secondMaker, 1e18);

        vm.prank(maker);
        bytes32 firstOrderId = clob.placeOrder(PasskeyCLOB.Side.SELL, 1e18, 1e18);
        vm.prank(secondMaker);
        bytes32 secondOrderId = clob.placeOrder(PasskeyCLOB.Side.SELL, 1e18, 1e18);

        assertEq(firstOrderId, keccak256(abi.encode(maker, uint256(0))));
        assertEq(secondOrderId, keccak256(abi.encode(secondMaker, uint256(0))));
        assertNotEq(firstOrderId, secondOrderId);
        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 1);
    }

    function testSellCancellation() public {
        _depositBase(maker, 10e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 2e18, 4e18);

        vm.prank(maker);
        clob.cancelOrder(orderId);

        _assertOrderStatus(orderId, 4e18, false);
        _assertBalance(maker, 10e18, 0, 0, 0);
        assertEq(clob.makerNonce(maker), 1);
    }

    function testBuyCancellation() public {
        _depositQuote(maker, 30e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 10e18);

        vm.prank(maker);
        clob.cancelOrder(orderId);

        _assertOrderStatus(orderId, 10e18, false);
        _assertBalance(maker, 0, 0, 30e18, 0);
        assertEq(clob.makerNonce(maker), 1);
    }

    function testNonMakerCannotCancelOrder() public {
        _depositBase(maker, 1e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        vm.prank(secondMaker);
        vm.expectRevert(PasskeyCLOB.NotOrderMaker.selector);
        clob.cancelOrder(orderId);
    }

    function testCannotCancelNonexistentOrder() public {
        vm.expectRevert(PasskeyCLOB.OrderNotFound.selector);
        clob.cancelOrder(bytes32(uint256(1)));
    }

    function testCannotCancelAlreadyCancelledOrder() public {
        _depositBase(maker, 1e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        vm.startPrank(maker);
        clob.cancelOrder(orderId);
        vm.expectRevert(PasskeyCLOB.OrderNotActive.selector);
        clob.cancelOrder(orderId);
        vm.stopPrank();
    }

    function testSellToSellReplacement() public {
        _depositBase(maker, 10e18);
        bytes32 oldOrderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 2e18, 4e18);
        bytes32 expectedNewOrderId = keccak256(abi.encode(maker, uint256(1)));

        vm.prank(maker);
        bytes32 newOrderId = clob.replaceOrder(oldOrderId, PasskeyCLOB.Side.SELL, 3e18, 6e18);

        assertEq(newOrderId, expectedNewOrderId);
        _assertOrderStatus(oldOrderId, 4e18, false);
        _assertOrder(newOrderId, maker, PasskeyCLOB.Side.SELL, 3e18, 6e18);
        _assertBalance(maker, 4e18, 6e18, 0, 0);
        assertEq(clob.makerNonce(maker), 2);
    }

    function testBuyToBuyReplacement() public {
        _depositQuote(maker, 30e18);
        bytes32 oldOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 10e18);

        vm.prank(maker);
        bytes32 newOrderId = clob.replaceOrder(oldOrderId, PasskeyCLOB.Side.BUY, 3e18, 5e18);

        _assertOrderStatus(oldOrderId, 10e18, false);
        _assertOrder(newOrderId, maker, PasskeyCLOB.Side.BUY, 3e18, 5e18);
        _assertBalance(maker, 0, 0, 15e18, 15e18);
        assertEq(clob.makerNonce(maker), 2);
    }

    function testSellToBuyReplacement() public {
        _depositBase(maker, 10e18);
        _depositQuote(maker, 20e18);
        bytes32 oldOrderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 4e18);

        vm.prank(maker);
        bytes32 newOrderId = clob.replaceOrder(oldOrderId, PasskeyCLOB.Side.BUY, 2e18, 5e18);

        _assertOrderStatus(oldOrderId, 4e18, false);
        _assertOrder(newOrderId, maker, PasskeyCLOB.Side.BUY, 2e18, 5e18);
        _assertBalance(maker, 10e18, 0, 10e18, 10e18);
        assertEq(clob.makerNonce(maker), 2);
    }

    function testBuyToSellReplacement() public {
        _depositBase(maker, 10e18);
        _depositQuote(maker, 20e18);
        bytes32 oldOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 5e18);

        vm.prank(maker);
        bytes32 newOrderId = clob.replaceOrder(oldOrderId, PasskeyCLOB.Side.SELL, 1e18, 4e18);

        _assertOrderStatus(oldOrderId, 5e18, false);
        _assertOrder(newOrderId, maker, PasskeyCLOB.Side.SELL, 1e18, 4e18);
        _assertBalance(maker, 6e18, 4e18, 20e18, 0);
        assertEq(clob.makerNonce(maker), 2);
    }

    function testCannotReplaceNonexistentOrder() public {
        vm.expectRevert(PasskeyCLOB.OrderNotFound.selector);
        clob.replaceOrder(bytes32(uint256(1)), PasskeyCLOB.Side.SELL, 1e18, 1e18);
    }

    function testCannotReplaceInactiveOrder() public {
        _depositBase(maker, 1e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        vm.startPrank(maker);
        clob.cancelOrder(orderId);
        vm.expectRevert(PasskeyCLOB.OrderNotActive.selector);
        clob.replaceOrder(orderId, PasskeyCLOB.Side.SELL, 1e18, 1e18);
        vm.stopPrank();
    }

    function testNonMakerCannotReplaceOrder() public {
        _depositBase(maker, 1e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        vm.prank(secondMaker);
        vm.expectRevert(PasskeyCLOB.NotOrderMaker.selector);
        clob.replaceOrder(orderId, PasskeyCLOB.Side.SELL, 1e18, 1e18);
    }

    function testReplacementFailureIsAtomic() public {
        _depositBase(maker, 5e18);
        bytes32 oldOrderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 5e18);
        bytes32 attemptedNewOrderId = keccak256(abi.encode(maker, uint256(1)));

        vm.prank(maker);
        vm.expectRevert(PasskeyCLOB.InsufficientAvailableBalance.selector);
        clob.replaceOrder(oldOrderId, PasskeyCLOB.Side.SELL, 1e18, 6e18);

        _assertOrderStatus(oldOrderId, 5e18, true);
        _assertBalance(maker, 0, 5e18, 0, 0);
        assertEq(clob.makerNonce(maker), 1);

        (
            address newOrderMaker,
            PasskeyCLOB.Side newOrderSide,
            uint256 newOrderPrice,
            uint256 newOrderAmount,
            uint256 newOrderRemaining,
            bool newOrderActive
        ) = clob.orders(attemptedNewOrderId);
        assertEq(newOrderMaker, address(0));
        assertEq(uint256(newOrderSide), uint256(PasskeyCLOB.Side.BUY));
        assertEq(newOrderPrice, 0);
        assertEq(newOrderAmount, 0);
        assertEq(newOrderRemaining, 0);
        assertFalse(newOrderActive);
    }

    function testMakersCancelAndReplaceIndependently() public {
        _depositBase(maker, 10e18);
        _depositBase(secondMaker, 10e18);
        bytes32 makerOrderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 4e18);
        bytes32 secondMakerOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 1e18, 3e18);

        vm.prank(maker);
        clob.cancelOrder(makerOrderId);

        _assertBalance(maker, 10e18, 0, 0, 0);
        _assertBalance(secondMaker, 7e18, 3e18, 0, 0);
        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 1);

        vm.prank(secondMaker);
        bytes32 newOrderId = clob.replaceOrder(secondMakerOrderId, PasskeyCLOB.Side.SELL, 2e18, 5e18);

        _assertOrder(newOrderId, secondMaker, PasskeyCLOB.Side.SELL, 2e18, 5e18);
        _assertBalance(maker, 10e18, 0, 0, 0);
        _assertBalance(secondMaker, 5e18, 5e18, 0, 0);
        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 2);
    }

    function testFullMatchAtEqualPrices() public {
        _depositQuote(maker, 20e18);
        _depositBase(secondMaker, 10e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 10e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 10e18);

        clob.matchOrders(buyOrderId, sellOrderId);

        _assertOrderStatus(buyOrderId, 0, false);
        _assertOrderStatus(sellOrderId, 0, false);
        _assertBalance(maker, 10e18, 0, 0, 0);
        _assertBalance(secondMaker, 0, 0, 20e18, 0);
    }

    function testFullMatchReturnsPriceImprovementToBuyer() public {
        _depositQuote(maker, 30e18);
        _depositBase(secondMaker, 10e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 3e18, 10e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 10e18);

        vm.expectEmit(true, true, false, true, address(clob));
        emit OrderMatched(buyOrderId, sellOrderId, 2e18, 10e18);
        clob.matchOrders(buyOrderId, sellOrderId);

        _assertBalance(maker, 10e18, 0, 10e18, 0);
        _assertBalance(secondMaker, 0, 0, 20e18, 0);
    }

    function testPartialFillWhenBuyIsLarger() public {
        _depositQuote(maker, 20e18);
        _depositBase(secondMaker, 4e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 10e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 4e18);

        clob.matchOrders(buyOrderId, sellOrderId);

        _assertOrderStatus(buyOrderId, 6e18, true);
        _assertOrderStatus(sellOrderId, 0, false);
        _assertBalance(maker, 4e18, 0, 0, 12e18);
        _assertBalance(secondMaker, 0, 0, 8e18, 0);
    }

    function testPartialFillWhenSellIsLarger() public {
        _depositQuote(maker, 8e18);
        _depositBase(secondMaker, 10e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 4e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 10e18);

        clob.matchOrders(buyOrderId, sellOrderId);

        _assertOrderStatus(buyOrderId, 0, false);
        _assertOrderStatus(sellOrderId, 6e18, true);
        _assertBalance(maker, 4e18, 0, 0, 0);
        _assertBalance(secondMaker, 0, 6e18, 8e18, 0);
    }

    function testMatchingRevertsForNonexistentBuyOrder() public {
        _depositBase(secondMaker, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        vm.expectRevert(PasskeyCLOB.OrderNotFound.selector);
        clob.matchOrders(bytes32(uint256(1)), sellOrderId);
    }

    function testMatchingRevertsForNonexistentSellOrder() public {
        _depositQuote(maker, 1e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 1e18, 1e18);

        vm.expectRevert(PasskeyCLOB.OrderNotFound.selector);
        clob.matchOrders(buyOrderId, bytes32(uint256(1)));
    }

    function testMatchingRevertsForInactiveBuyOrder() public {
        _depositQuote(maker, 1e18);
        _depositBase(secondMaker, 1e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 1e18, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 1e18, 1e18);
        vm.prank(maker);
        clob.cancelOrder(buyOrderId);

        vm.expectRevert(PasskeyCLOB.OrderNotActive.selector);
        clob.matchOrders(buyOrderId, sellOrderId);
    }

    function testMatchingRevertsForInactiveSellOrder() public {
        _depositQuote(maker, 1e18);
        _depositBase(secondMaker, 1e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 1e18, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 1e18, 1e18);
        vm.prank(secondMaker);
        clob.cancelOrder(sellOrderId);

        vm.expectRevert(PasskeyCLOB.OrderNotActive.selector);
        clob.matchOrders(buyOrderId, sellOrderId);
    }

    function testMatchingRevertsForWrongSideOrdering() public {
        _depositQuote(maker, 1e18);
        _depositBase(secondMaker, 1e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 1e18, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        vm.expectRevert(PasskeyCLOB.InvalidOrderSide.selector);
        clob.matchOrders(sellOrderId, buyOrderId);
    }

    function testMatchingRevertsWhenOrdersDoNotCross() public {
        _depositQuote(maker, 1e18);
        _depositBase(secondMaker, 1e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 1e18, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 1e18);

        vm.expectRevert(PasskeyCLOB.OrdersDoNotCross.selector);
        clob.matchOrders(buyOrderId, sellOrderId);
    }

    function testMatchingQuoteRoundingToZeroRevertsWithoutMutation() public {
        _depositQuote(maker, 1);
        _depositBase(secondMaker, 1);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 1, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 1, 1);

        vm.expectRevert(PasskeyCLOB.QuoteAmountTooSmall.selector);
        clob.matchOrders(buyOrderId, sellOrderId);

        _assertOrderStatus(buyOrderId, 1e18, true);
        _assertOrderStatus(sellOrderId, 1, true);
        _assertBalance(maker, 0, 0, 0, 1);
        _assertBalance(secondMaker, 0, 1, 0, 0);
        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 1);
    }

    function testMatchingDoesNotChangeMakerNonces() public {
        _depositQuote(maker, 2e18);
        _depositBase(secondMaker, 1e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 1e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 1e18);

        clob.matchOrders(buyOrderId, sellOrderId);

        assertEq(clob.makerNonce(maker), 1);
        assertEq(clob.makerNonce(secondMaker), 1);
    }

    function testCancelAfterPartialBuyFillReleasesAllRemainingQuote() public {
        _depositQuote(maker, 20e18);
        _depositBase(secondMaker, 4e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 10e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 4e18);
        clob.matchOrders(buyOrderId, sellOrderId);

        vm.prank(maker);
        clob.cancelOrder(buyOrderId);

        _assertOrderStatus(buyOrderId, 6e18, false);
        _assertBalance(maker, 4e18, 0, 12e18, 0);
    }

    function testCancelAfterPartialSellFillReleasesAllRemainingBase() public {
        _depositQuote(maker, 8e18);
        _depositBase(secondMaker, 10e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 2e18, 4e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 10e18);
        clob.matchOrders(buyOrderId, sellOrderId);

        vm.prank(secondMaker);
        clob.cancelOrder(sellOrderId);

        _assertOrderStatus(sellOrderId, 6e18, false);
        _assertBalance(secondMaker, 6e18, 0, 8e18, 0);
    }

    function testInternalTokenConservationAcrossMatchAndCancel() public {
        _depositQuote(maker, 30e18);
        _depositBase(secondMaker, 15e18);
        bytes32 buyOrderId = _placeOrder(maker, PasskeyCLOB.Side.BUY, 3e18, 10e18);
        bytes32 sellOrderId = _placeOrder(secondMaker, PasskeyCLOB.Side.SELL, 2e18, 15e18);
        clob.matchOrders(buyOrderId, sellOrderId);

        vm.prank(secondMaker);
        clob.cancelOrder(sellOrderId);

        _assertBalance(maker, 10e18, 0, 10e18, 0);
        _assertBalance(secondMaker, 5e18, 0, 20e18, 0);
        assertEq(base.balanceOf(address(clob)), 15e18);
        assertEq(quote.balanceOf(address(clob)), 30e18);
    }

    function testRegisterPasskeyStoresPublicKey() public {
        (uint256 qx, uint256 qy) = vm.publicKeyP256(PASSKEY_PRIVATE_KEY);

        vm.prank(maker);
        clob.registerPasskey(bytes32(qx), bytes32(qy));

        (bytes32 storedQx, bytes32 storedQy, bool registered) = clob.passkeys(maker);
        assertEq(storedQx, bytes32(qx));
        assertEq(storedQy, bytes32(qy));
        assertTrue(registered);
    }

    function testRegisterPasskeyRejectsZeroCoordinate() public {
        vm.expectRevert(PasskeyCLOB.InvalidPasskey.selector);
        clob.registerPasskey(bytes32(0), bytes32(uint256(1)));

        vm.expectRevert(PasskeyCLOB.InvalidPasskey.selector);
        clob.registerPasskey(bytes32(uint256(1)), bytes32(0));
    }

    function testPlaceOrderWithPasskey() public {
        _depositBase(maker, 10e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 2e18, 4e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.prank(relayer);
        bytes32 orderId = clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 2e18, 4e18, deadline, auth);

        _assertOrder(orderId, maker, PasskeyCLOB.Side.SELL, 2e18, 4e18);
        assertNotEq(relayer, maker);
        assertEq(clob.authNonce(maker), 1);
        assertEq(clob.makerNonce(maker), 1);
    }

    function testCancelOrderWithPasskey() public {
        _depositBase(maker, 5e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 5e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.cancelOrderChallenge(maker, orderId, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.prank(relayer);
        clob.cancelOrderWithPasskey(maker, orderId, deadline, auth);

        _assertOrderStatus(orderId, 5e18, false);
        _assertBalance(maker, 5e18, 0, 0, 0);
        assertNotEq(relayer, maker);
        assertEq(clob.authNonce(maker), 1);
        assertEq(clob.makerNonce(maker), 1);
    }

    function testReplaceOrderWithPasskey() public {
        _depositBase(maker, 10e18);
        bytes32 oldOrderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 4e18);
        bytes32 expectedNewOrderId = keccak256(abi.encode(maker, uint256(1)));
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.replaceOrderChallenge(maker, oldOrderId, PasskeyCLOB.Side.SELL, 2e18, 6e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.prank(relayer);
        bytes32 newOrderId =
            clob.replaceOrderWithPasskey(maker, oldOrderId, PasskeyCLOB.Side.SELL, 2e18, 6e18, deadline, auth);

        assertEq(newOrderId, expectedNewOrderId);
        _assertOrderStatus(oldOrderId, 4e18, false);
        _assertOrder(newOrderId, maker, PasskeyCLOB.Side.SELL, 2e18, 6e18);
        assertNotEq(relayer, maker);
        assertEq(clob.authNonce(maker), 1);
        assertEq(clob.makerNonce(maker), 2);
    }

    function testPasskeyAssertionCannotBeReplayed() public {
        _depositBase(maker, 2e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline, auth);

        vm.expectRevert(PasskeyCLOB.InvalidPasskeySignature.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline, auth);

        assertEq(clob.authNonce(maker), 1);
        assertEq(clob.makerNonce(maker), 1);
        _assertBalance(maker, 1e18, 1e18, 0, 0);
    }

    function testExpiredPasskeyAuthorizationReverts() public {
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        vm.warp(100);
        uint256 deadline = 99;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.AuthorizationExpired.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline, auth);

        assertEq(clob.authNonce(maker), 0);
    }

    function testUnregisteredMakerPasskeyAuthorizationReverts() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.PasskeyNotRegistered.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline, auth);
    }

    function testSignatureFromWrongP256KeyReverts() public {
        _depositBase(maker, 1e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, WRONG_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.InvalidPasskeySignature.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline, auth);

        assertEq(clob.authNonce(maker), 0);
    }

    function testTamperingWithPasskeyOrderPriceReverts() public {
        _depositBase(maker, 1e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 2e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.InvalidPasskeySignature.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 3e18, 1e18, deadline, auth);

        assertEq(clob.authNonce(maker), 0);
    }

    function testTamperingWithPasskeyOrderAmountReverts() public {
        _depositBase(maker, 2e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.InvalidPasskeySignature.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 2e18, deadline, auth);

        assertEq(clob.authNonce(maker), 0);
    }

    function testPlacePasskeySignatureCannotAuthorizeCancellation() public {
        _depositBase(maker, 1e18);
        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 placeChallenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(placeChallenge, PASSKEY_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.InvalidPasskeySignature.selector);
        vm.prank(relayer);
        clob.cancelOrderWithPasskey(maker, orderId, deadline, auth);

        _assertOrderStatus(orderId, 1e18, true);
        assertEq(clob.authNonce(maker), 0);
    }

    function testPasskeyChallengeChangesWithChainId() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 originalChainId = block.chainid;
        bytes32 originalChallenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);

        vm.chainId(originalChainId + 1);
        bytes32 changedChallenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        vm.chainId(originalChainId);

        assertNotEq(originalChallenge, changedChallenge);
    }

    function testUnderlyingOrderFailureRollsBackAuthNonce() public {
        _depositBase(maker, 1e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 2e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.expectRevert(PasskeyCLOB.InsufficientAvailableBalance.selector);
        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 2e18, deadline, auth);

        assertEq(clob.authNonce(maker), 0);
        assertEq(clob.makerNonce(maker), 0);
        _assertBalance(maker, 1e18, 0, 0, 0);
    }

    function testDirectPlaceOrderStillWorksWithoutPasskey() public {
        _depositBase(maker, 1e18);

        bytes32 orderId = _placeOrder(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);

        _assertOrder(orderId, maker, PasskeyCLOB.Side.SELL, 1e18, 1e18);
        assertEq(clob.authNonce(maker), 0);
        assertEq(clob.makerNonce(maker), 1);
    }

    function testPasskeyAuthorizationNonceIsMakerIsolated() public {
        _depositBase(maker, 1e18);
        _depositQuote(secondMaker, 5e18);
        _registerPasskey(maker, PASSKEY_PRIVATE_KEY);
        _registerPasskey(secondMaker, WRONG_PRIVATE_KEY);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 challenge = clob.placeOrderChallenge(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline);
        WebAuthn.WebAuthnAuth memory auth = _createWebAuthnAuth(challenge, PASSKEY_PRIVATE_KEY);

        vm.prank(relayer);
        clob.placeOrderWithPasskey(maker, PasskeyCLOB.Side.SELL, 1e18, 1e18, deadline, auth);

        assertEq(clob.authNonce(maker), 1);
        assertEq(clob.authNonce(secondMaker), 0);
        assertEq(clob.makerNonce(secondMaker), 0);
        _assertBalance(secondMaker, 0, 0, 5e18, 0);
    }

    function _registerPasskey(address account, uint256 privateKey) internal {
        (uint256 qx, uint256 qy) = vm.publicKeyP256(privateKey);
        vm.prank(account);
        clob.registerPasskey(bytes32(qx), bytes32(qy));
    }

    function _createWebAuthnAuth(bytes32 challenge, uint256 privateKey)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes memory authenticatorData = abi.encodePacked(bytes32(uint256(0x1234)), bytes1(0x05), bytes4(uint32(0)));
        string memory clientDataJSON = string.concat(
            "{\"type\":\"webauthn.get\",\"challenge\":\"",
            Base64.encodeURL(abi.encodePacked(challenge)),
            "\",\"origin\":\"https://example.com\"}"
        );
        bytes32 signedDigest = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, signedDigest);

        auth = WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            challengeIndex: 23,
            typeIndex: 1,
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    function _depositBase(address account, uint256 amount) internal {
        vm.startPrank(account);
        base.approve(address(clob), amount);
        clob.depositBase(amount);
        vm.stopPrank();
    }

    function _depositQuote(address account, uint256 amount) internal {
        vm.startPrank(account);
        quote.approve(address(clob), amount);
        clob.depositQuote(amount);
        vm.stopPrank();
    }

    function _placeOrder(address account, PasskeyCLOB.Side side, uint256 price, uint256 amount)
        internal
        returns (bytes32 orderId)
    {
        vm.prank(account);
        return clob.placeOrder(side, price, amount);
    }

    function _assertBalance(
        address account,
        uint256 expectedAvailableBase,
        uint256 expectedReservedBase,
        uint256 expectedAvailableQuote,
        uint256 expectedReservedQuote
    ) internal view {
        (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote) =
            clob.balances(account);

        assertEq(availableBase, expectedAvailableBase);
        assertEq(reservedBase, expectedReservedBase);
        assertEq(availableQuote, expectedAvailableQuote);
        assertEq(reservedQuote, expectedReservedQuote);
    }

    function _assertOrderStatus(bytes32 orderId, uint256 expectedRemaining, bool expectedActive) internal view {
        (,,,, uint256 remaining, bool active) = clob.orders(orderId);

        assertEq(remaining, expectedRemaining);
        assertEq(active, expectedActive);
    }

    function _assertOrder(
        bytes32 orderId,
        address expectedMaker,
        PasskeyCLOB.Side expectedSide,
        uint256 expectedPrice,
        uint256 expectedAmount
    ) internal view {
        (
            address storedMaker,
            PasskeyCLOB.Side storedSide,
            uint256 storedPrice,
            uint256 storedAmount,
            uint256 remaining,
            bool active
        ) = clob.orders(orderId);

        assertEq(storedMaker, expectedMaker);
        assertEq(uint256(storedSide), uint256(expectedSide));
        assertEq(storedPrice, expectedPrice);
        assertEq(storedAmount, expectedAmount);
        assertEq(remaining, expectedAmount);
        assertTrue(active);
    }
}
