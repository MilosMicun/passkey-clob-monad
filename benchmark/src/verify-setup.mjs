import { readFile } from 'node:fs/promises'

import { createPublicClient, getAddress, http } from 'viem'

import { PASSKEY_CLOB_ABI } from './abi.mjs'
import { MONAD_TESTNET, SEPOLIA } from './chains.mjs'
import { INITIAL_BASE_PER_MAKER, INITIAL_QUOTE_PER_MAKER, MAKER_COUNT } from './config.mjs'
import { MONAD_DEPLOYMENT, SEPOLIA_DEPLOYMENT } from './deployments.mjs'

const REQUEST_DELAY_MS = 175

const networks = {
  sepolia: {
    chain: SEPOLIA,
    deployment: SEPOLIA_DEPLOYMENT,
    rpcEnv: 'SEPOLIA_RPC_URL',
  },
  monad: {
    chain: MONAD_TESTNET,
    deployment: MONAD_DEPLOYMENT,
    rpcEnv: 'MONAD_RPC_URL',
  },
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function loadMakers() {
  const walletFile = new URL('../.wallets.json', import.meta.url)
  const walletData = JSON.parse(await readFile(walletFile, 'utf8'))

  if (!Array.isArray(walletData.makers) || walletData.makers.length !== MAKER_COUNT) {
    throw new Error(`Expected exactly ${MAKER_COUNT} makers in benchmark/.wallets.json`)
  }

  return walletData.makers.map((maker) => getAddress(maker.address))
}

function verifyBalance(maker, balance) {
  const fields = ['availableBase', 'reservedBase', 'availableQuote', 'reservedQuote']
  const expected = [INITIAL_BASE_PER_MAKER, 0n, INITIAL_QUOTE_PER_MAKER, 0n]

  for (let index = 0; index < fields.length; index += 1) {
    if (balance[index] !== expected[index]) {
      throw new Error(
        `Setup mismatch for ${maker}: ${fields[index]} expected ${expected[index]}, received ${balance[index]}`,
      )
    }
  }
}

async function main() {
  const network = process.argv[2]
  const config = networks[network]
  if (!config) {
    throw new Error('Usage: node src/verify-setup.mjs <sepolia|monad>')
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
  if (rpcChainId !== config.deployment.chainId) {
    throw new Error(
      `RPC chain ID mismatch: configured ${config.deployment.chainId}, received ${rpcChainId}`,
    )
  }

  const makers = await loadMakers()
  await sleep(REQUEST_DELAY_MS)

  for (let index = 0; index < makers.length; index += 1) {
    const maker = makers[index]
    const balance = await client.readContract({
      address: config.deployment.clob,
      abi: PASSKEY_CLOB_ABI,
      functionName: 'balances',
      args: [maker],
    })
    verifyBalance(maker, balance)

    await sleep(REQUEST_DELAY_MS)

    const nonce = await client.readContract({
      address: config.deployment.clob,
      abi: PASSKEY_CLOB_ABI,
      functionName: 'makerNonce',
      args: [maker],
    })
    if (nonce !== 0n) {
      throw new Error(`Setup mismatch for ${maker}: makerNonce expected 0, received ${nonce}`)
    }

    console.log(`verified: ${maker}`)

    if (index + 1 < makers.length) {
      await sleep(REQUEST_DELAY_MS)
    }
  }

  console.log(`setup verified: ${makers.length} makers`)
}

main().catch((error) => {
  console.error(`Setup verification failed: ${error.message}`)
  process.exitCode = 1
})
