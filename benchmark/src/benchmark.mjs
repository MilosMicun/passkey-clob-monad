import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { PASSKEY_CLOB_ABI } from './abi.mjs'
import { MONAD_TESTNET, SEPOLIA } from './chains.mjs'
import {
  INITIAL_BASE_PER_MAKER,
  INITIAL_PRICE,
  INITIAL_QUOTE_PER_MAKER,
  MAKER_COUNT,
  ORDER_AMOUNT,
  REPLACE_PRICES,
  TOTAL_WORKLOAD_TX,
} from './config.mjs'
import { MONAD_DEPLOYMENT, SEPOLIA_DEPLOYMENT } from './deployments.mjs'

const BUY = 0
const SELL = 1
const GAS_LIMIT = 500_000n
const REQUEST_DELAY_MS = 175
const RECEIPT_POLLING_INTERVAL_MS = 1_000
const RECEIPT_TIMEOUT_MS = 600_000
const ACTIONS_PER_MAKER = 4
const ORDER_ID_PARAMETERS = [{ type: 'address' }, { type: 'uint256' }]

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

function round(value) {
  return Math.round(value * 100) / 100
}

function percentile(values, percent) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)
  return sorted[index]
}

function deriveOrderId(maker, nonce) {
  return keccak256(encodeAbiParameters(ORDER_ID_PARAMETERS, [maker, nonce]))
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

function buildActions(maker, side, clobStartNonce) {
  const placedOrderId = deriveOrderId(maker, clobStartNonce)
  const firstReplacementOrderId = deriveOrderId(maker, clobStartNonce + 1n)
  const secondReplacementOrderId = deriveOrderId(maker, clobStartNonce + 2n)

  return [
    {
      action: 'place',
      functionName: 'placeOrder',
      args: [side, INITIAL_PRICE, ORDER_AMOUNT],
    },
    {
      action: 'replace-1',
      functionName: 'replaceOrder',
      args: [placedOrderId, side, REPLACE_PRICES[0], ORDER_AMOUNT],
    },
    {
      action: 'replace-2',
      functionName: 'replaceOrder',
      args: [firstReplacementOrderId, side, REPLACE_PRICES[1], ORDER_AMOUNT],
    },
    {
      action: 'cancel',
      functionName: 'cancelOrder',
      args: [secondReplacementOrderId],
    },
  ]
}

async function prepareMakers(publicClient, makers, clobAddress) {
  const preparations = []

  for (let index = 0; index < makers.length; index += 1) {
    const account = makers[index]
    const eoaStartNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    })

    await sleep(REQUEST_DELAY_MS)

    const clobStartNonce = await publicClient.readContract({
      address: clobAddress,
      abi: PASSKEY_CLOB_ABI,
      functionName: 'makerNonce',
      args: [account.address],
    })

    preparations.push({ account, eoaStartNonce, clobStartNonce, makerIndex: index })
    await sleep(REQUEST_DELAY_MS)
  }

  return preparations
}

async function submitLane(config, rpcUrl, gasPrice, preparation, benchmarkStart) {
  const walletClient = createWalletClient({
    account: preparation.account,
    chain: config.chain,
    transport: http(rpcUrl),
  })
  const side = preparation.makerIndex % 2 === 0 ? SELL : BUY
  const actions = buildActions(preparation.account.address, side, preparation.clobStartNonce)
  const transactions = []

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    const action = actions[actionIndex]
    const submissionStartedAt = performance.now()
    const hash = await walletClient.writeContract({
      address: config.deployment.clob,
      abi: PASSKEY_CLOB_ABI,
      functionName: action.functionName,
      args: action.args,
      nonce: preparation.eoaStartNonce + actionIndex,
      gas: GAS_LIMIT,
      gasPrice,
      type: 'legacy',
    })
    const submittedAt = performance.now()

    transactions.push({
      maker: preparation.account.address,
      makerIndex: preparation.makerIndex,
      action: action.action,
      actionIndex,
      hash,
      submissionStartedAt,
      submittedAt,
      submittedOffsetMs: submittedAt - benchmarkStart,
    })
  }

  return transactions
}

async function fetchInvolvedBlocks(publicClient, completedTransactions) {
  const blockNumbers = [
    ...new Set(completedTransactions.map(({ receipt }) => receipt.blockNumber.toString())),
  ]
    .map((blockNumber) => BigInt(blockNumber))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const blocks = []

  for (let index = 0; index < blockNumbers.length; index += 1) {
    blocks.push(await publicClient.getBlock({ blockNumber: blockNumbers[index] }))
    if (index + 1 < blockNumbers.length) {
      await sleep(REQUEST_DELAY_MS)
    }
  }

  return { blockNumbers, blocks }
}

function verifyBalance(maker, balance) {
  const fields = ['availableBase', 'reservedBase', 'availableQuote', 'reservedQuote']
  const expected = [INITIAL_BASE_PER_MAKER, 0n, INITIAL_QUOTE_PER_MAKER, 0n]

  for (let index = 0; index < fields.length; index += 1) {
    if (balance[index] !== expected[index]) {
      throw new Error(
        `Post-benchmark mismatch for ${maker}: ${fields[index]} expected ${expected[index]}, received ${balance[index]}`,
      )
    }
  }
}

async function verifyPostBenchmark(publicClient, clobAddress, preparations) {
  await sleep(REQUEST_DELAY_MS)

  for (let index = 0; index < preparations.length; index += 1) {
    const preparation = preparations[index]
    const maker = preparation.account.address
    const balance = await publicClient.readContract({
      address: clobAddress,
      abi: PASSKEY_CLOB_ABI,
      functionName: 'balances',
      args: [maker],
    })
    verifyBalance(maker, balance)

    await sleep(REQUEST_DELAY_MS)

    const nonce = await publicClient.readContract({
      address: clobAddress,
      abi: PASSKEY_CLOB_ABI,
      functionName: 'makerNonce',
      args: [maker],
    })
    const expectedNonce = preparation.clobStartNonce + 3n
    if (nonce !== expectedNonce) {
      throw new Error(
        `Post-benchmark mismatch for ${maker}: makerNonce expected ${expectedNonce}, received ${nonce}`,
      )
    }

    if (index + 1 < preparations.length) {
      await sleep(REQUEST_DELAY_MS)
    }
  }
}

async function writeResult(network, result) {
  const resultsDirectory = new URL('../results/', import.meta.url)
  await mkdir(resultsDirectory, { recursive: true })

  const timestamp = result.benchmarkStartIso.replaceAll(':', '-').replaceAll('.', '-')
  const resultFile = new URL(`${network}-${timestamp}.json`, resultsDirectory)
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  return path.relative(process.cwd(), fileURLToPath(resultFile))
}

async function main() {
  const network = process.argv[2]
  const config = networks[network]
  if (!config) {
    throw new Error('Usage: node src/benchmark.mjs <sepolia|monad>')
  }

  const rpcUrl = process.env[config.rpcEnv]
  if (!rpcUrl) {
    throw new Error(`Missing required environment variable: ${config.rpcEnv}`)
  }
  if (config.chain.id !== config.deployment.chainId) {
    throw new Error('Configured chain and deployment chain IDs do not match')
  }
  if (REPLACE_PRICES.length !== 2) {
    throw new Error('Expected exactly two replacement prices')
  }
  if (TOTAL_WORKLOAD_TX !== MAKER_COUNT * ACTIONS_PER_MAKER) {
    throw new Error(`Expected ${MAKER_COUNT * ACTIONS_PER_MAKER} workload transactions`)
  }

  const publicClient = createPublicClient({
    chain: config.chain,
    pollingInterval: RECEIPT_POLLING_INTERVAL_MS,
    transport: http(rpcUrl, {
      batch: {
        batchSize: 100,
        wait: 10,
      },
    }),
  })

  const rpcChainId = await publicClient.getChainId()
  if (rpcChainId !== config.deployment.chainId) {
    throw new Error(
      `RPC chain ID mismatch: configured ${config.deployment.chainId}, received ${rpcChainId}`,
    )
  }

  await sleep(REQUEST_DELAY_MS)
  const makers = await loadMakers()
  const preparations = await prepareMakers(publicClient, makers, config.deployment.clob)
  const gasPrice = await publicClient.getGasPrice()

  const benchmarkStartIso = new Date().toISOString()
  const benchmarkStart = performance.now()

  const laneTransactions = await Promise.all(
    preparations.map((preparation) =>
      submitLane(config, rpcUrl, gasPrice, preparation, benchmarkStart),
    ),
  )
  const submittedTransactions = laneTransactions.flat()
  const lastHashSubmittedAt = Math.max(...submittedTransactions.map(({ submittedAt }) => submittedAt))
  const submissionDurationMs = lastHashSubmittedAt - benchmarkStart

  const completedTransactions = await Promise.all(
    submittedTransactions.map(async (transaction) => {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transaction.hash,
        checkReplacement: false,
        confirmations: 1,
        pollingInterval: RECEIPT_POLLING_INTERVAL_MS,
        timeout: RECEIPT_TIMEOUT_MS,
      })
      const receiptObservedAt = performance.now()

      return {
        ...transaction,
        receipt,
        receiptObservedAt,
        receiptObservedOffsetMs: receiptObservedAt - benchmarkStart,
        latencyMs: receiptObservedAt - transaction.submissionStartedAt,
      }
    }),
  )

  const allReceiptsCompleteAt = Math.max(
    ...completedTransactions.map(({ receiptObservedAt }) => receiptObservedAt),
  )
  const completionDurationMs = allReceiptsCompleteAt - benchmarkStart
  const benchmarkEndIso = new Date().toISOString()
  const successfulTx = completedTransactions.filter(({ receipt }) => receipt.status === 'success').length
  const failedTx = completedTransactions.length - successfulTx
  const throughputTxPerSecond = successfulTx / (completionDurationMs / 1_000)
  const latencies = completedTransactions.map(({ latencyMs }) => latencyMs)
  const p50LatencyMs = percentile(latencies, 50)
  const p95LatencyMs = percentile(latencies, 95)

  const { blockNumbers, blocks } = await fetchInvolvedBlocks(publicClient, completedTransactions)
  const firstBlock = blockNumbers[0]
  const lastBlock = blockNumbers[blockNumbers.length - 1]
  const blockSpan = lastBlock - firstBlock + 1n
  const onChainWindowSeconds = blocks[blocks.length - 1].timestamp - blocks[0].timestamp

  const result = {
    network,
    chainId: config.deployment.chainId,
    clobAddress: config.deployment.clob,
    makerCount: MAKER_COUNT,
    transactionsExpected: TOTAL_WORKLOAD_TX,
    transactionsSubmitted: submittedTransactions.length,
    successfulTx,
    failedTx,
    benchmarkStartIso,
    benchmarkEndIso,
    submissionDurationMs: round(submissionDurationMs),
    completionDurationMs: round(completionDurationMs),
    throughputTxPerSecond: round(throughputTxPerSecond),
    p50LatencyMs: round(p50LatencyMs),
    p95LatencyMs: round(p95LatencyMs),
    firstBlock: firstBlock.toString(),
    lastBlock: lastBlock.toString(),
    blockSpan: blockSpan.toString(),
    onChainWindowSeconds: onChainWindowSeconds.toString(),
    gasPriceUsed: gasPrice.toString(),
    transactions: completedTransactions.map((transaction) => ({
      maker: transaction.maker,
      action: transaction.action,
      hash: transaction.hash,
      submittedOffsetMs: round(transaction.submittedOffsetMs),
      receiptObservedOffsetMs: round(transaction.receiptObservedOffsetMs),
      latencyMs: round(transaction.latencyMs),
      blockNumber: transaction.receipt.blockNumber.toString(),
      gasUsed: transaction.receipt.gasUsed.toString(),
      status: transaction.receipt.status,
    })),
  }

  const resultFile = await writeResult(network, result)
  await verifyPostBenchmark(publicClient, config.deployment.clob, preparations)

  console.log(`NETWORK: ${network}`)
  console.log(`MAKERS: ${MAKER_COUNT}`)
  console.log(`TX: ${submittedTransactions.length}`)
  console.log(`SUCCESS: ${successfulTx}`)
  console.log(`FAILED: ${failedTx}`)
  console.log('')
  console.log(`SUBMISSION: ${round(submissionDurationMs)} ms`)
  console.log(`COMPLETION: ${round(completionDurationMs)} ms`)
  console.log(`THROUGHPUT: ${round(throughputTxPerSecond)} tx/s`)
  console.log(`P50: ${round(p50LatencyMs)} ms`)
  console.log(`P95: ${round(p95LatencyMs)} ms`)
  console.log('')
  console.log(`FIRST BLOCK: ${firstBlock}`)
  console.log(`LAST BLOCK: ${lastBlock}`)
  console.log(`BLOCK SPAN: ${blockSpan}`)
  console.log(`ON-CHAIN WINDOW: ${onChainWindowSeconds} s`)
  console.log('')
  console.log(`RESULT FILE: ${resultFile}`)
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`)
  process.exitCode = 1
})
