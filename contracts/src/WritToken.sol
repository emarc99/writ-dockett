// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IFreezeOracle {
    function isFrozen(address wallet) external view returns (bool);
}

/// @title WritToken (wUSD)
/// @notice Demo stablecoin that enforces court-ordered freezes published by OrderRegistry.
///         Transfers to or from a wallet revert only while a verified, unexpired order names it.
contract WritToken is ERC20, Ownable {
    IFreezeOracle public immutable registry;

    error WalletFrozen(address wallet);

    constructor(IFreezeOracle registry_) ERC20("Writ USD", "wUSD") Ownable(msg.sender) {
        registry = registry_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Open faucet so judges can try a transfer themselves on Sepolia.
    function faucet() external {
        _mint(msg.sender, 1_000 * 10 ** decimals());
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && registry.isFrozen(from)) revert WalletFrozen(from);
        if (to != address(0) && registry.isFrozen(to)) revert WalletFrozen(to);
        super._update(from, to, value);
    }
}
