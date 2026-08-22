// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {MockERC20} from "../src/MockERC20.sol";
import {PasskeyCLOB} from "../src/PasskeyCLOB.sol";

contract Deploy is Script {
    error UnsupportedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 11155111 && block.chainid != 10143) {
            revert UnsupportedChain(block.chainid);
        }

        vm.startBroadcast();

        MockERC20 base = new MockERC20("Benchmark Base", "BASE");
        MockERC20 quote = new MockERC20("Benchmark Quote", "QUOTE");
        PasskeyCLOB clob = new PasskeyCLOB(address(base), address(quote));

        vm.stopBroadcast();

        console2.log("CHAIN_ID", block.chainid);
        console2.log("DEPLOYER", tx.origin);
        console2.log("BASE", address(base));
        console2.log("QUOTE", address(quote));
        console2.log("CLOB", address(clob));
    }
}
