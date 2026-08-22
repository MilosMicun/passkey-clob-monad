import { readFile } from 'node:fs/promises'

import { createPublicClient, createWalletClient, formatEther, getAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { MOCK_ERC20_ABI, PASSKEY_CLOB_ABI } from './abi.mjs'
import { MONAD_TESTNET, SEPOLIA } from './chains.mjs'
import { INITIAL_BASE_PER_MAKER, INITIAL_QUOTE_PER_MAKER, MAKER_COUNT } from './config.mjs'
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

async function sendAndWait(publicClient, walletClient, request, label) {
  const hash = await walletClient.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`${label} reverted in transaction ${hash}`)
  }
}

async function main() {
  const network = process.argv[2]
  const config = networks[network]
  if (!config) {
    throw new Error('Usage: node src/setup.mjs <sepolia|monad>')
  }

  const rpcUrl = process.env[config.rpcEnv]
  if (!rpcUrl) {
    throw new Error(`Missing required environment variable: ${config.rpcEnv}`)
  }

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(rpcUrl),
  })
  const rpcChainId = await publicClient.getChainId()
  if (rpcChainId !== config.deployment.chainId) {
    throw new Error(
      `RPC chain ID mismatch: configured ${config.deployment.chainId}, received ${rpcChainId}`,
    )
  }

  const makers = await loadMakers()
  const walletClients = makers.map((account) =>
    createWalletClient({
      account,
      chain: config.chain,
      transport: http(rpcUrl),
    }),
  )

  const nativeBalances = await Promise.all(
    makers.map((maker) => publicClient.getBalance({ address: maker.address })),
  )
  const makersWithoutGas = makers.filter((_, index) => nativeBalances[index] === 0n)

  if (makersWithoutGas.length > 0) {
    for (const maker of makersWithoutGas) {
      const index = makers.findIndex((candidate) => candidate.address === maker.address)
      console.error(
        `${maker.address}: ${formatEther(nativeBalances[index])} ${config.chain.nativeCurrency.symbol}`,
      )
    }
    throw new Error(`${makersWithoutGas.length} makers have zero native balance; no transactions sent`)
  }

  for (let index = 0; index < makers.length; index += 1) {
    const maker = makers[index]
    const walletClient = walletClients[index]

    await sendAndWait(
      publicClient,
      walletClient,
      {
        address: config.deployment.base,
        abi: MOCK_ERC20_ABI,
        functionName: 'mint',
        args: [maker.address, INITIAL_BASE_PER_MAKER],
      },
      'BASE mint',
    )
    await sendAndWait(
      publicClient,
      walletClient,
      {
        address: config.deployment.quote,
        abi: MOCK_ERC20_ABI,
        functionName: 'mint',
        args: [maker.address, INITIAL_QUOTE_PER_MAKER],
      },
      'QUOTE mint',
    )
    await sendAndWait(
      publicClient,
      walletClient,
      {
        address: config.deployment.base,
        abi: MOCK_ERC20_ABI,
        functionName: 'approve',
        args: [config.deployment.clob, INITIAL_BASE_PER_MAKER],
      },
      'BASE approval',
    )
    await sendAndWait(
      publicClient,
      walletClient,
      {
        address: config.deployment.quote,
        abi: MOCK_ERC20_ABI,
        functionName: 'approve',
        args: [config.deployment.clob, INITIAL_QUOTE_PER_MAKER],
      },
      'QUOTE approval',
    )
    await sendAndWait(
      publicClient,
      walletClient,
      {
        address: config.deployment.clob,
        abi: PASSKEY_CLOB_ABI,
        functionName: 'depositBase',
        args: [INITIAL_BASE_PER_MAKER],
      },
      'BASE deposit',
    )
    await sendAndWait(
      publicClient,
      walletClient,
      {
        address: config.deployment.clob,
        abi: PASSKEY_CLOB_ABI,
        functionName: 'depositQuote',
        args: [INITIAL_QUOTE_PER_MAKER],
      },
      'QUOTE deposit',
    )

    console.log(`setup complete: ${maker.address}`)
  }

  for (const maker of makers) {
    const [balance, nonce] = await Promise.all([
      publicClient.readContract({
        address: config.deployment.clob,
        abi: PASSKEY_CLOB_ABI,
        functionName: 'balances',
        args: [maker.address],
      }),
      publicClient.readContract({
        address: config.deployment.clob,
        abi: PASSKEY_CLOB_ABI,
        functionName: 'makerNonce',
        args: [maker.address],
      }),
    ])

    const [availableBase, reservedBase, availableQuote, reservedQuote] = balance
    if (
      availableBase !== INITIAL_BASE_PER_MAKER ||
      reservedBase !== 0n ||
      availableQuote !== INITIAL_QUOTE_PER_MAKER ||
      reservedQuote !== 0n
    ) {
      throw new Error(`Unexpected CLOB balance for ${maker.address}`)
    }
    if (nonce !== 0n) {
      throw new Error(`Expected makerNonce 0 for ${maker.address}, received ${nonce}`)
    }
  }

  console.log(`setup verified: ${makers.length} makers`)
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`)
  process.exitCode = 1
})
