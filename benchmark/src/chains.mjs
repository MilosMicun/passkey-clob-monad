import { defineChain } from 'viem'

export const SEPOLIA = defineChain({
  id: 11155111,
  name: 'Ethereum Sepolia',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [process.env.SEPOLIA_RPC_URL ?? ''],
    },
  },
})

export const MONAD_TESTNET = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: {
    name: 'Monad',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [process.env.MONAD_RPC_URL ?? ''],
    },
  },
})
