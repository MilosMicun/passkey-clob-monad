import { parseAbi } from 'viem'

export const MOCK_ERC20_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

export const PASSKEY_CLOB_ABI = parseAbi([
  'function depositBase(uint256 amount)',
  'function depositQuote(uint256 amount)',
  'function placeOrder(uint8 side, uint256 price, uint256 amount) returns (bytes32 orderId)',
  'function replaceOrder(bytes32 oldOrderId, uint8 newSide, uint256 newPrice, uint256 newAmount) returns (bytes32 newOrderId)',
  'function cancelOrder(bytes32 orderId)',
  'function makerNonce(address maker) view returns (uint256)',
  'function balances(address maker) view returns (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote)',
  'function orders(bytes32 orderId) view returns (address maker, uint8 side, uint256 price, uint256 amount, uint256 remaining, bool active)',
])
