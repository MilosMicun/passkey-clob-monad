// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

contract FundMakers is Script {
    error UnsupportedChain(uint256 chainId);
    error InvalidMakerCount(uint256 count);
    error NativeTransferFailed(address maker, uint256 amount);

    uint256 private constant MAKER_COUNT = 16;

    function run() external {
        uint256 amountPerMaker;
        if (block.chainid == 10143) {
            amountPerMaker = 1 ether;
        } else if (block.chainid == 11155111) {
            amountPerMaker = 0.02 ether;
        } else {
            revert UnsupportedChain(block.chainid);
        }

        string memory makerJson = vm.readFile(string.concat(vm.projectRoot(), "/benchmark/makers.json"));
        address[] memory makers = vm.parseJsonAddressArray(makerJson, ".makers");
        if (makers.length != MAKER_COUNT) revert InvalidMakerCount(makers.length);

        vm.startBroadcast();

        for (uint256 index = 0; index < makers.length; index++) {
            (bool success,) = payable(makers[index]).call{value: amountPerMaker}("");
            if (!success) revert NativeTransferFailed(makers[index], amountPerMaker);
        }

        vm.stopBroadcast();

        console2.log("CHAIN_ID", block.chainid);
        console2.log("FUNDER", tx.origin);
        console2.log("MAKER_COUNT", makers.length);
        console2.log("AMOUNT_PER_MAKER", amountPerMaker);
        console2.log("TOTAL_NATIVE_SENT", amountPerMaker * makers.length);
    }
}
