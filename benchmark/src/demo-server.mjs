import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http as viemHttp,
  keccak256,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { MONAD_TESTNET, SEPOLIA } from './chains.mjs'
import { INITIAL_BASE_PER_MAKER, INITIAL_QUOTE_PER_MAKER, MAKER_COUNT } from './config.mjs'
import { MONAD_DEPLOYMENT, SEPOLIA_DEPLOYMENT } from './deployments.mjs'

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'
const MAX_BODY_BYTES = 64 * 1024
const UINT256_MAX = 2n ** 256n - 1n
const PREFLIGHT_DELAY_MS = 175
const READ_RETRY_ATTEMPTS = 5
const MAX_BENCHMARK_OUTPUT_BYTES = 8 * 1024 * 1024
const BENCHMARK_CHILD_TIMEOUT_MS = 5 * 60 * 1_000
const BENCHMARK_FORCE_KILL_DELAY_MS = 2_000
const BENCHMARK_CLOSE_GRACE_MS = 1_000
const LIVE_DEMO_MAKER_COUNT = 4
const LIVE_BENCHMARK_COOLDOWN_MS = 60_000
const DEMO_MAKER_INDEX = 15
const RELAYER_MAKER_INDEX = 14
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/
const demoRoot = fileURLToPath(new URL('../../demo/', import.meta.url))
const benchmarkRoot = fileURLToPath(new URL('../', import.meta.url))
const resultsRoot = fileURLToPath(new URL('../results/', import.meta.url))
const ORDER_ID_PARAMETERS = [{ type: 'address' }, { type: 'uint256' }]
const runningBenchmarks = new Set()
let benchmarkComparisonRunning = false
let lastBenchmarkComparisonFinishedAt = 0

const PASSKEY_ABI = parseAbi([
  'function registerPasskey(bytes32 qx, bytes32 qy)',
  'function placeOrderChallenge(address maker, uint8 side, uint256 price, uint256 amount, uint256 deadline) view returns (bytes32)',
  'function placeOrderWithPasskey(address maker, uint8 side, uint256 price, uint256 amount, uint256 deadline, (bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON) auth) returns (bytes32 orderId)',
  'function cancelOrderChallenge(address maker, bytes32 orderId, uint256 deadline) view returns (bytes32)',
  'function cancelOrderWithPasskey(address maker, bytes32 orderId, uint256 deadline, (bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON) auth)',
  'function passkeys(address maker) view returns (bytes32 qx, bytes32 qy, bool registered)',
  'function authNonce(address maker) view returns (uint256)',
  'function makerNonce(address maker) view returns (uint256)',
  'function balances(address maker) view returns (uint256 availableBase, uint256 reservedBase, uint256 availableQuote, uint256 reservedQuote)',
  'function orders(bytes32 orderId) view returns (address maker, uint8 side, uint256 price, uint256 amount, uint256 remaining, bool active)',
])

const benchmarkNetworks = {
  monad: {
    chain: MONAD_TESTNET,
    deployment: MONAD_DEPLOYMENT,
    rpcEnv: 'MONAD_RPC_URL',
    label: 'Monad',
  },
  sepolia: {
    chain: SEPOLIA,
    deployment: SEPOLIA_DEPLOYMENT,
    rpcEnv: 'SEPOLIA_RPC_URL',
    label: 'Sepolia',
  },
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deriveOrderId(maker, nonce) {
  return keccak256(encodeAbiParameters(ORDER_ID_PARAMETERS, [maker, nonce]))
}

async function readContract(publicClient, parameters) {
  let lastError
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await publicClient.readContract(parameters)
    } catch (error) {
      lastError = error
      if (attempt + 1 < READ_RETRY_ATTEMPTS) await sleep(750 * (attempt + 1))
    }
  }
  throw lastError
}

function sendJson(response, statusCode, body) {
  if (response.writableEnded) return
  const encoded = JSON.stringify(body)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(encoded)
}

function parseSide(value) {
  if (value !== 0 && value !== 1) throw new Error('side must be 0 (BUY) or 1 (SELL)')
  return value
}

function parseUint256(value, field, { allowZero = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${field} must be a decimal string or number`)
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${field} number is not a safe non-negative integer`)
  }

  const text = String(value)
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`${field} must be an unsigned decimal integer`)
  const parsed = BigInt(text)
  if ((!allowZero && parsed === 0n) || parsed > UINT256_MAX) {
    throw new Error(`${field} is outside the allowed uint256 range`)
  }
  return parsed
}

function parseBytes32(value, field) {
  if (typeof value !== 'string' || !BYTES32_PATTERN.test(value)) {
    throw new Error(`${field} must be 0x-prefixed bytes32 hex`)
  }
  return value
}

function parseHexBytes(value, field) {
  if (typeof value !== 'string' || !HEX_BYTES_PATTERN.test(value) || value === '0x') {
    throw new Error(`${field} must be non-empty 0x-prefixed byte hex`)
  }
  return value
}

function parseAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('auth must be an object')
  }
  if (typeof value.clientDataJSON !== 'string' || value.clientDataJSON.length === 0) {
    throw new Error('auth.clientDataJSON must be a non-empty string')
  }

  return {
    r: parseBytes32(value.r, 'auth.r'),
    s: parseBytes32(value.s, 'auth.s'),
    challengeIndex: parseUint256(value.challengeIndex, 'auth.challengeIndex', { allowZero: true }),
    typeIndex: parseUint256(value.typeIndex, 'auth.typeIndex', { allowZero: true }),
    authenticatorData: parseHexBytes(value.authenticatorData, 'auth.authenticatorData'),
    clientDataJSON: value.clientDataJSON,
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 64 KiB')
    chunks.push(chunk)
  }

  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON')
  }
}

function serializeBalances(balance) {
  return {
    availableBase: balance[0].toString(),
    reservedBase: balance[1].toString(),
    availableQuote: balance[2].toString(),
    reservedQuote: balance[3].toString(),
  }
}

async function waitForSuccessfulReceipt(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
  if (receipt.status !== 'success') throw new Error(`${label} reverted in transaction ${hash}`)
  return receipt
}

async function createContext() {
  for (const config of Object.values(benchmarkNetworks)) {
    if (!process.env[config.rpcEnv]) {
      throw new Error(`Missing required environment variable: ${config.rpcEnv}`)
    }
  }

  const walletFile = process.env.WALLETS_FILE ?? new URL('../.wallets.json', import.meta.url)
  if (process.env.WALLETS_FILE && !path.isAbsolute(process.env.WALLETS_FILE)) {
    throw new Error('WALLETS_FILE must be an absolute path')
  }
  const walletData = JSON.parse(await readFile(walletFile, 'utf8'))
  if (!Array.isArray(walletData.makers) || walletData.makers.length !== MAKER_COUNT) {
    throw new Error(`Wallet file must contain exactly ${MAKER_COUNT} makers`)
  }

  const maker = privateKeyToAccount(walletData.makers[DEMO_MAKER_INDEX].privateKey)
  const relayer = privateKeyToAccount(walletData.makers[RELAYER_MAKER_INDEX].privateKey)
  if (maker.address !== getAddress(walletData.makers[DEMO_MAKER_INDEX].address)) {
    throw new Error(`Demo maker address does not match wallet index ${DEMO_MAKER_INDEX}`)
  }
  if (relayer.address !== getAddress(walletData.makers[RELAYER_MAKER_INDEX].address)) {
    throw new Error(`Relayer address does not match wallet index ${RELAYER_MAKER_INDEX}`)
  }

  const networks = {}
  for (const [network, config] of Object.entries(benchmarkNetworks)) {
    const publicClient = createPublicClient({
      chain: config.chain,
      transport: viemHttp(process.env[config.rpcEnv]),
    })
    const rpcChainId = await publicClient.getChainId()
    if (rpcChainId !== config.deployment.chainId) {
      throw new Error(
        `${config.label} RPC chain ID mismatch: expected ${config.deployment.chainId}, received ${rpcChainId}`,
      )
    }
    networks[network] = { ...config, publicClient }
  }

  const makerAddresses = walletData.makers.map(({ address }) => getAddress(address))
  const monadRpcUrl = process.env.MONAD_RPC_URL

  return {
    maker,
    relayer,
    makerAddresses,
    networks,
    publicClient: networks.monad.publicClient,
    makerClient: createWalletClient({
      account: maker,
      chain: MONAD_TESTNET,
      transport: viemHttp(monadRpcUrl),
    }),
    relayerClient: createWalletClient({
      account: relayer,
      chain: MONAD_TESTNET,
      transport: viemHttp(monadRpcUrl),
    }),
  }
}

async function readDemoOrder(context, makerNonce) {
  if (makerNonce === 0n) return null

  const orderId = deriveOrderId(context.maker.address, makerNonce - 1n)
  const order = await readContract(context.publicClient, {
    address: MONAD_DEPLOYMENT.clob,
    abi: PASSKEY_ABI,
    functionName: 'orders',
    args: [orderId],
  })

  if (getAddress(order[0]) !== context.maker.address || !order[5]) return null
  return {
    orderId,
    active: order[5],
    side: order[1],
    price: order[2].toString(),
    amount: order[3].toString(),
    remaining: order[4].toString(),
  }
}

async function statusResponse(context) {
  const passkey = await readContract(context.publicClient, {
    address: MONAD_DEPLOYMENT.clob,
    abi: PASSKEY_ABI,
    functionName: 'passkeys',
    args: [context.maker.address],
  })
  await sleep(PREFLIGHT_DELAY_MS)
  const authNonce = await readContract(context.publicClient, {
    address: MONAD_DEPLOYMENT.clob,
    abi: PASSKEY_ABI,
    functionName: 'authNonce',
    args: [context.maker.address],
  })
  await sleep(PREFLIGHT_DELAY_MS)
  const makerNonce = await readContract(context.publicClient, {
    address: MONAD_DEPLOYMENT.clob,
    abi: PASSKEY_ABI,
    functionName: 'makerNonce',
    args: [context.maker.address],
  })
  await sleep(PREFLIGHT_DELAY_MS)
  const balance = await readContract(context.publicClient, {
    address: MONAD_DEPLOYMENT.clob,
    abi: PASSKEY_ABI,
    functionName: 'balances',
    args: [context.maker.address],
  })

  await sleep(PREFLIGHT_DELAY_MS)
  const demoOrder = await readDemoOrder(context, makerNonce)

  return {
    maker: context.maker.address,
    relayer: context.relayer.address,
    registered: passkey[2],
    authNonce: authNonce.toString(),
    makerNonce: makerNonce.toString(),
    availableBase: balance[0].toString(),
    availableQuote: balance[2].toString(),
    demoOrder,
  }
}

async function readUpdatedMakerState(context) {
  const [authNonce, makerNonce, balance] = await Promise.all([
    readContract(context.publicClient, {
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'authNonce',
      args: [context.maker.address],
    }),
    readContract(context.publicClient, {
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'makerNonce',
      args: [context.maker.address],
    }),
    readContract(context.publicClient, {
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'balances',
      args: [context.maker.address],
    }),
  ])

  return {
    authNonce: authNonce.toString(),
    makerNonce: makerNonce.toString(),
    balances: serializeBalances(balance),
  }
}

async function verifyCleanBenchmarkState(context, network) {
  const config = context.networks[network]
  const liveMakerAddresses = context.makerAddresses.slice(0, LIVE_DEMO_MAKER_COUNT)
  for (let index = 0; index < liveMakerAddresses.length; index += 1) {
    const maker = liveMakerAddresses[index]
    const balance = await readContract(config.publicClient, {
      address: config.deployment.clob,
      abi: PASSKEY_ABI,
      functionName: 'balances',
      args: [maker],
    })
    if (
      balance[0] !== INITIAL_BASE_PER_MAKER ||
      balance[1] !== 0n ||
      balance[2] !== INITIAL_QUOTE_PER_MAKER ||
      balance[3] !== 0n
    ) {
      throw new HttpError(
        409,
        `${config.label} benchmark state is not clean for ${maker}: expected full available balances and zero reserves.`,
      )
    }
    if (index + 1 < liveMakerAddresses.length) await sleep(PREFLIGHT_DELAY_MS)
  }
}

function redactRpcUrls(output) {
  let redacted = output
  for (const config of Object.values(benchmarkNetworks)) {
    const rpcUrl = process.env[config.rpcEnv]
    if (rpcUrl) redacted = redacted.replaceAll(rpcUrl, '[RPC URL REDACTED]')
  }
  return redacted
}

function executeBenchmark(network) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['src/benchmark.mjs', network, '--maker-count', String(LIVE_DEMO_MAKER_COUNT)],
      {
        cwd: benchmarkRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const stdoutChunks = []
    const stderrChunks = []
    let outputBytes = 0
    let settled = false
    let timeout
    let closeFallback

    function bufferedOutput(chunks) {
      return Buffer.concat(chunks).toString('utf8')
    }

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(closeFallback)
      resolve({
        stdout: bufferedOutput(stdoutChunks),
        stderr: bufferedOutput(stderrChunks),
        ...result,
      })
    }

    function terminateChild() {
      child.kill('SIGTERM')
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, BENCHMARK_FORCE_KILL_DELAY_MS)
      forceKill.unref()
    }

    function capture(chunks, chunk) {
      if (settled) return
      outputBytes += chunk.length
      if (outputBytes > MAX_BENCHMARK_OUTPUT_BYTES) {
        terminateChild()
        finish({
          error: new Error('Benchmark output exceeded the 8 MiB safety limit.'),
          exitCode: null,
          signal: null,
          timedOut: false,
        })
        return
      }
      chunks.push(chunk)
    }

    child.stdout.on('data', (chunk) => capture(stdoutChunks, chunk))
    child.stderr.on('data', (chunk) => capture(stderrChunks, chunk))
    child.once('error', (error) => {
      finish({ error, exitCode: null, signal: null, timedOut: false })
    })
    child.once('exit', (exitCode, signal) => {
      if (settled) return
      clearTimeout(timeout)
      closeFallback = setTimeout(() => {
        finish({ error: null, exitCode, signal, timedOut: false })
      }, BENCHMARK_CLOSE_GRACE_MS)
    })
    child.once('close', (exitCode, signal) => {
      finish({ error: null, exitCode, signal, timedOut: false })
    })

    timeout = setTimeout(() => {
      terminateChild()
      finish({
        error: new Error('Benchmark child exceeded the five-minute safety timeout.'),
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
      })
    }, BENCHMARK_CHILD_TIMEOUT_MS)
  })
}

async function runBenchmark(context, network, { skipPreflight = false } = {}) {
  if (runningBenchmarks.has(network)) {
    throw new HttpError(409, `${benchmarkNetworks[network].label} benchmark is already running.`)
  }

  runningBenchmarks.add(network)
  try {
    if (!skipPreflight) await verifyCleanBenchmarkState(context, network)
    const execution = await executeBenchmark(network)
    if (execution.timedOut) {
      throw new HttpError(
        504,
        `${benchmarkNetworks[network].label} benchmark timed out after five minutes.`,
      )
    }
    if (execution.error || execution.exitCode !== 0) {
      const captured = redactRpcUrls(`${execution.stdout}\n${execution.stderr}`).trim()
      if (captured) console.error(`${benchmarkNetworks[network].label} benchmark output:\n${captured}`)
      const exitDescription =
        execution.exitCode ?? execution.signal ?? execution.error?.code ?? 'unknown'
      throw new HttpError(
        500,
        `${benchmarkNetworks[network].label} benchmark failed with exit status ${exitDescription}.`,
      )
    }

    const resultMatch = execution.stdout.match(/^RESULT FILE:\s*(.+)$/m)
    if (!resultMatch) throw new HttpError(500, 'Benchmark completed without reporting a result file.')
    const resultPath = path.resolve(benchmarkRoot, resultMatch[1].trim())
    const pathFromResults = path.relative(resultsRoot, resultPath)
    if (pathFromResults.startsWith('..') || path.isAbsolute(pathFromResults)) {
      throw new HttpError(500, 'Benchmark reported a result outside benchmark/results/.')
    }

    return JSON.parse(await readFile(resultPath, 'utf8'))
  } finally {
    runningBenchmarks.delete(network)
  }
}

async function runBenchmarkComparison(context) {
  if (benchmarkComparisonRunning || runningBenchmarks.size > 0) {
    throw new HttpError(409, 'A live benchmark comparison is already running.')
  }

  const now = Date.now()
  const cooldownRemaining = LIVE_BENCHMARK_COOLDOWN_MS - (now - lastBenchmarkComparisonFinishedAt)
  if (lastBenchmarkComparisonFinishedAt !== 0 && cooldownRemaining > 0) {
    throw new HttpError(
      429,
      `Live benchmark cooldown is active. Try again in ${Math.ceil(cooldownRemaining / 1_000)} seconds.`,
    )
  }

  benchmarkComparisonRunning = true
  try {
    const preflightOutcomes = await Promise.allSettled([
      verifyCleanBenchmarkState(context, 'monad'),
      verifyCleanBenchmarkState(context, 'sepolia'),
    ])
    const preflightFailures = preflightOutcomes
      .map((outcome, index) => ({ outcome, network: index === 0 ? 'Monad' : 'Sepolia' }))
      .filter(({ outcome }) => outcome.status === 'rejected')
    if (preflightFailures.length > 0) {
      const statusCode = Math.max(
        ...preflightFailures.map(({ outcome }) => outcome.reason.statusCode ?? 500),
      )
      throw new HttpError(
        statusCode,
        preflightFailures
          .map(({ network, outcome }) => `${network}: ${outcome.reason.message}`)
          .join(' '),
      )
    }

    const outcomes = await Promise.allSettled([
      runBenchmark(context, 'monad', { skipPreflight: true }),
      runBenchmark(context, 'sepolia', { skipPreflight: true }),
    ])
    const failures = outcomes
      .map((outcome, index) => ({ outcome, network: index === 0 ? 'Monad' : 'Sepolia' }))
      .filter(({ outcome }) => outcome.status === 'rejected')
    if (failures.length > 0) {
      const statusCode = Math.max(
        ...failures.map(({ outcome }) => outcome.reason.statusCode ?? 500),
      )
      throw new HttpError(
        statusCode,
        failures
          .map(({ network, outcome }) => `${network}: ${outcome.reason.message}`)
          .join(' '),
      )
    }

    return {
      monad: outcomes[0].value,
      sepolia: outcomes[1].value,
    }
  } finally {
    benchmarkComparisonRunning = false
    lastBenchmarkComparisonFinishedAt = Date.now()
  }
}

async function handleApi(request, response, context, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      monadChainId: 10143,
      sepoliaChainId: 11155111,
    })
    return
  }

  if (request.method === 'GET' && pathname === '/api/passkey/status') {
    sendJson(response, 200, await statusResponse(context))
    return
  }

  if (request.method === 'POST' && pathname === '/api/passkey/register') {
    const body = await readJsonBody(request)
    const qx = parseBytes32(body.qx, 'qx')
    const qy = parseBytes32(body.qy, 'qy')
    const hash = await context.makerClient.writeContract({
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'registerPasskey',
      args: [qx, qy],
    })
    const receipt = await waitForSuccessfulReceipt(context.publicClient, hash, 'Passkey registration')

    sendJson(response, 200, {
      success: true,
      txHash: hash,
      maker: context.maker.address,
      blockNumber: receipt.blockNumber.toString(),
    })
    return
  }

  if (request.method === 'POST' && pathname === '/api/passkey/place-challenge') {
    const body = await readJsonBody(request)
    const side = parseSide(body.side)
    const price = parseUint256(body.price, 'price')
    const amount = parseUint256(body.amount, 'amount')
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
    const challenge = await readContract(context.publicClient, {
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'placeOrderChallenge',
      args: [context.maker.address, side, price, amount, deadline],
    })

    sendJson(response, 200, {
      maker: context.maker.address,
      side,
      price: price.toString(),
      amount: amount.toString(),
      deadline: deadline.toString(),
      challenge,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/api/passkey/place') {
    const body = await readJsonBody(request)
    const side = parseSide(body.side)
    const price = parseUint256(body.price, 'price')
    const amount = parseUint256(body.amount, 'amount')
    const deadline = parseUint256(body.deadline, 'deadline')
    const auth = parseAuth(body.auth)

    const hash = await context.relayerClient.writeContract({
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'placeOrderWithPasskey',
      args: [context.maker.address, side, price, amount, deadline, auth],
    })
    const receipt = await waitForSuccessfulReceipt(context.publicClient, hash, 'Passkey order')
    const updated = await readUpdatedMakerState(context)

    sendJson(response, 200, {
      success: true,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      maker: context.maker.address,
      relayer: context.relayer.address,
      ...updated,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/api/passkey/cancel-challenge') {
    const body = await readJsonBody(request)
    const orderId = parseBytes32(body.orderId, 'orderId')
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
    const challenge = await readContract(context.publicClient, {
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'cancelOrderChallenge',
      args: [context.maker.address, orderId, deadline],
    })

    sendJson(response, 200, {
      maker: context.maker.address,
      orderId,
      deadline: deadline.toString(),
      challenge,
    })
    return
  }

  if (request.method === 'POST' && pathname === '/api/passkey/cancel') {
    const body = await readJsonBody(request)
    const orderId = parseBytes32(body.orderId, 'orderId')
    const deadline = parseUint256(body.deadline, 'deadline')
    const auth = parseAuth(body.auth)
    const hash = await context.relayerClient.writeContract({
      address: MONAD_DEPLOYMENT.clob,
      abi: PASSKEY_ABI,
      functionName: 'cancelOrderWithPasskey',
      args: [context.maker.address, orderId, deadline, auth],
    })
    const receipt = await waitForSuccessfulReceipt(context.publicClient, hash, 'Passkey cancellation')
    const updated = await readUpdatedMakerState(context)

    sendJson(response, 200, {
      success: true,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      ...updated,
    })
    return
  }

  if (pathname === '/api/benchmark/run') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Benchmark runs require an explicit POST request.' })
      return
    }
    sendJson(response, 200, await runBenchmarkComparison(context))
    return
  }

  sendJson(response, 404, { error: 'API endpoint not found' })
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }

  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const requestedPath = path.resolve(demoRoot, relativePath)
  const pathFromRoot = path.relative(demoRoot, requestedPath)
  if (pathFromRoot.startsWith('..') || path.isAbsolute(pathFromRoot)) {
    sendJson(response, 403, { error: 'Forbidden path' })
    return
  }

  let fileStats
  try {
    fileStats = await stat(requestedPath)
  } catch {
    sendJson(response, 404, { error: 'Static file not found' })
    return
  }
  if (!fileStats.isFile()) {
    sendJson(response, 404, { error: 'Static file not found' })
    return
  }

  response.writeHead(200, {
    'Content-Type': contentTypes[path.extname(requestedPath)] ?? 'application/octet-stream',
    'Content-Length': fileStats.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(requestedPath).pipe(response)
}

async function main() {
  const context = await createContext()
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, context, url.pathname)
      } else {
        await serveStatic(request, response, url.pathname)
      }
    } catch (error) {
      const message = redactRpcUrls(error.shortMessage ?? error.message ?? 'Unexpected server error')
      console.error(`Request failed: ${message}`)
      if (!response.headersSent && !response.writableEnded) {
        sendJson(response, error.statusCode ?? 400, { error: message })
      } else if (!response.writableEnded) {
        response.end()
      }
    }
  })

  server.listen(PORT, HOST, () => {
    console.log(`Passkey CLOB demo: http://localhost:${PORT}`)
    console.log(`Demo maker: ${context.maker.address}`)
    console.log(`Relayer: ${context.relayer.address}`)
    console.log(`Monad chain ID: ${MONAD_DEPLOYMENT.chainId}`)
    console.log(`Sepolia chain ID: ${SEPOLIA_DEPLOYMENT.chainId}`)
  })
}

main().catch((error) => {
  console.error(`Demo server failed: ${error.shortMessage ?? error.message}`)
  process.exitCode = 1
})
