import { readFile } from 'node:fs/promises'

import { createPublicClient, formatEther, getAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { MONAD_TESTNET, SEPOLIA } from './chains.mjs'
import { MAKER_COUNT } from './config.mjs'
import { MONAD_DEPLOYMENT, SEPOLIA_DEPLOYMENT } from './deployments.mjs'

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

async function loadMakers() {
  const walletFile = new URL('../.wallets.json', import.meta.url)
  const walletData = JSON.parse(await readFile(walletFile, 'utf8'))

  if (!Array.isArray(walletData.makers) || walletData.makers.length !== MAKER_COUNT) {
    throw new Error(`Expected exactly ${MAKER_COUNT} makers in benchmark/.wallets.json`)
  }

  return walletData.makers.map((maker) => {
    const account = privateKeyToAccount(maker.privateKey)
    if (account.address !== getAddress(maker.address)) {
      throw new Error(`Wallet address does not match its private key: ${maker.address}`)
    }
    return account
  })
}

async function main() {
  const network = process.argv[2]
  const config = networks[network]
  if (!config) {
    throw new Error('Usage: node src/preflight.mjs <sepolia|monad>')
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
  const balances = await Promise.all(makers.map((maker) => client.getBalance({ address: maker.address })))

  for (let index = 0; index < makers.length; index += 1) {
    console.log(`${makers[index].address}: ${formatEther(balances[index])} ${config.chain.nativeCurrency.symbol}`)
  }

  const makersWithGas = balances.filter((balance) => balance > 0n).length
  console.log(`makers checked: ${makers.length}`)
  console.log(`makers with gas: ${makersWithGas}`)
  console.log(`makers without gas: ${makers.length - makersWithGas}`)

  const contracts = [
    ['BASE', config.deployment.base],
    ['QUOTE', config.deployment.quote],
    ['CLOB', config.deployment.clob],
  ]
  const bytecodes = await Promise.all(contracts.map(([, address]) => client.getBytecode({ address })))

  for (let index = 0; index < contracts.length; index += 1) {
    if (!bytecodes[index] || bytecodes[index] === '0x') {
      throw new Error(`${contracts[index][0]} has no bytecode at ${contracts[index][1]}`)
    }
  }

  console.log('deployment bytecode: verified')
}

main().catch((error) => {
  console.error(`Preflight failed: ${error.message}`)
  process.exitCode = 1
})
