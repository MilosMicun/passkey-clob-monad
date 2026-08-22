import { createPublicClient, http } from 'viem'

import { MONAD_TESTNET, SEPOLIA } from './chains.mjs'

const networks = {
  sepolia: {
    chain: SEPOLIA,
    rpcEnv: 'SEPOLIA_RPC_URL',
  },
  monad: {
    chain: MONAD_TESTNET,
    rpcEnv: 'MONAD_RPC_URL',
  },
}

async function main() {
  const network = process.argv[2]
  const config = networks[network]

  if (!config) {
    throw new Error('Usage: node src/probe.mjs <sepolia|monad>')
  }

  const rpcUrl = process.env[config.rpcEnv]
  if (!rpcUrl) {
    throw new Error(`Missing required environment variable: ${config.rpcEnv}`)
  }

  const client = createPublicClient({
    chain: config.chain,
    transport: http(rpcUrl),
  })

  const rpcChainId = await client.getChainId()
  if (rpcChainId !== config.chain.id) {
    throw new Error(`RPC chain ID mismatch: configured ${config.chain.id}, received ${rpcChainId}`)
  }

  const latestBlockNumber = await client.getBlockNumber()
  const latestBlock = await client.getBlock({ blockTag: 'latest' })

  console.log(`network: ${network}`)
  console.log(`configured chain id: ${config.chain.id}`)
  console.log(`rpc chain id: ${rpcChainId}`)
  console.log(`latest block: ${latestBlockNumber}`)
  console.log(`latest block timestamp: ${latestBlock.timestamp}`)
}

main().catch((error) => {
  console.error(`Probe failed: ${error.message}`)
  process.exitCode = 1
})
