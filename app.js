const DATA_URL = './data/benchmark.json'
const CREDENTIAL_STORAGE_KEY = 'passkeyClobCredentialId'
const MONADSCAN_TX_URL = 'https://testnet.monadscan.com/tx/'
const DEMO_ORDER = Object.freeze({
  side: 1,
  price: '100000000000000000000',
  amount: '1000000000000000000',
})
const LIVE_DEMO_MAKER_COUNT = 4
const LIVE_DEMO_ACTIONS_PER_MAKER = 4
const LIVE_DEMO_TOTAL_TRANSACTIONS = 16
const IS_LOCAL_RUNTIME = location.hostname === 'localhost' || location.hostname === '127.0.0.1'

function initializeRuntimeMode() {
  document.body.dataset.runtimeMode = IS_LOCAL_RUNTIME ? 'local' : 'public'
  const runButton = document.querySelector('#run-live-comparison')
  const showcaseBanner = document.querySelector('#public-showcase-banner')

  if (IS_LOCAL_RUNTIME) {
    showcaseBanner.hidden = true
    runButton.disabled = false
    return
  }

  showcaseBanner.hidden = false
  document.querySelector('#runtime-status-label').textContent = 'PUBLIC SHOWCASE'
  document.querySelector('#live-run-state').textContent = 'LOCAL DEMO'
  document.querySelector('#live-run-message').textContent =
    'LIVE DURING PRESENTATION — verified full-benchmark results remain available below.'
  document.querySelectorAll('[data-live-status]').forEach((status) => {
    status.textContent = 'PRESENTATION ONLY'
  })

  runButton.disabled = true
  document.querySelector('#passkey-registration-status').textContent = 'PUBLIC SHOWCASE'
  document.querySelector('#passkey-registration-status').dataset.state = 'showcase'
  document.querySelector('#passkey-progress').textContent =
    'DEVICE PASSKEY DEMO RUNS LOCALLY — no browser credential or backend connection is requested here.'
  document.querySelector('#create-passkey-button').disabled = true
  document.querySelector('#place-passkey-button').disabled = true
  document.querySelector('#cancel-passkey-button').disabled = true
}

function valueAtPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object)
}

function compactNumber(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value)
}

function formatMetric(value, format, element) {
  switch (format) {
    case 'seconds':
      return `${(value / 1000).toFixed(2)}s`
    case 'secondsLabel':
      return `${(value / 1000).toFixed(2)} sec`
    case 'txRate':
      return `${compactNumber(value)} tx/s`
    case 'multiple':
      return `${element.classList.contains('speedup-value') ? '~' : ''}${value.toFixed(1)}×`
    default:
      return compactNumber(value)
  }
}

function animateMetric(element, target) {
  const format = element.dataset.format
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reducedMotion) {
    element.textContent = formatMetric(target, format, element)
    return
  }

  const startedAt = performance.now()
  const duration = 850

  function tick(now) {
    const progress = Math.min((now - startedAt) / duration, 1)
    const eased = 1 - (1 - progress) ** 3
    element.textContent = formatMetric(target * eased, format, element)
    if (progress < 1) requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

function renderMetrics(data) {
  document.querySelectorAll('[data-metric]').forEach((element) => {
    const value = valueAtPath(data, element.dataset.metric)
    if (typeof value === 'number') animateMetric(element, value)
  })
}

function renderBars(data) {
  const completionValues = [
    data.chains.monad.completionDurationMs,
    data.chains.sepolia.completionDurationMs,
  ]
  const completionMaximum = Math.max(...completionValues)

  document.querySelectorAll('[data-bar="completion"]').forEach((bar) => {
    const value = Number(bar.dataset.value)
    bar.style.setProperty('--bar-width', `${Math.max(2, (value / completionMaximum) * 100)}%`)
  })

  document.querySelectorAll('[data-comparison]').forEach((row) => {
    const bars = [...row.querySelectorAll('[data-compare-bar]')]
    const values = bars.map((bar) => valueAtPath(data, bar.dataset.compareBar))
    const maximum = Math.max(...values)

    bars.forEach((bar, index) => {
      bar.style.setProperty('--bar-width', `${Math.max(2, (values[index] / maximum) * 100)}%`)
    })
  })

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll('.race-fill, .metric-track i').forEach((bar) => {
        bar.classList.add('animate')
      })
    })
  })
}

function initializeChainSelector() {
  const tabs = [...document.querySelectorAll('[data-chain-select]')]
  const cards = [...document.querySelectorAll('[data-chain-card]')]

  function selectChain(chain) {
    document.body.dataset.chain = chain
    tabs.forEach((tab) => {
      const selected = tab.dataset.chainSelect === chain
      tab.classList.toggle('active', selected)
      tab.setAttribute('aria-selected', String(selected))
    })
    cards.forEach((card) => {
      card.classList.toggle('is-selected', card.dataset.chainCard === chain)
    })
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => selectChain(tab.dataset.chainSelect)))
  selectChain('monad')
}

function initializeCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const originalLabel = button.textContent
      try {
        await navigator.clipboard.writeText(button.dataset.copy)
        button.textContent = 'COPIED'
      } catch {
        button.textContent = 'COPY FAILED'
      }
      window.setTimeout(() => {
        button.textContent = originalLabel
      }, 1400)
    })
  })
}

async function loadBenchmark() {
  const sourceStatus = document.querySelector('#data-source-status')

  try {
    const response = await fetch(DATA_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()

    data.comparisons = {
      completionSpeedup:
        data.chains.sepolia.completionDurationMs / data.chains.monad.completionDurationMs,
      throughputMultiple:
        data.chains.monad.throughputTxPerSecond / data.chains.sepolia.throughputTxPerSecond,
      p50LatencyMultiple: data.chains.sepolia.p50LatencyMs / data.chains.monad.p50LatencyMs,
    }

    renderMetrics(data)
    renderBars(data)
    sourceStatus.textContent = `PREVIOUS VERIFIED RUN · ${data.source.toUpperCase()}`
  } catch (error) {
    sourceStatus.textContent = 'PREVIOUS VERIFIED RUN · STATIC FALLBACK'
    console.error(`Benchmark data failed to load: ${error.message}`)
  }
}

function bytesToHex(bytes) {
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function hexToBytes(hex, expectedLength) {
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error('Server returned malformed hex data.')
  }
  const bytes = Uint8Array.from(hex.slice(2).match(/../g), (pair) => Number.parseInt(pair, 16))
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes, received ${bytes.length}.`)
  }
  return bytes
}

function bytesToBase64Url(bytes) {
  let binary = ''
  bytes.forEach((value) => {
    binary += String.fromCharCode(value)
  })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Stored passkey credential ID is malformed.')
  }
  if (value.length % 4 === 1) throw new Error('Stored passkey credential ID has invalid length.')
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function readDerElement(bytes, offset, expectedTag) {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('Truncated DER element.')
  if (bytes[offset] !== expectedTag) {
    throw new Error(`Unexpected DER tag 0x${bytes[offset].toString(16)}.`)
  }

  const firstLengthByte = bytes[offset + 1]
  let contentLength
  let lengthBytes = 1
  if ((firstLengthByte & 0x80) === 0) {
    contentLength = firstLengthByte
  } else {
    const count = firstLengthByte & 0x7f
    if (count === 0 || count > 4 || offset + 2 + count > bytes.length) {
      throw new Error('Invalid DER length encoding.')
    }
    if (bytes[offset + 2] === 0) throw new Error('Non-minimal DER length encoding.')
    contentLength = 0
    for (let index = 0; index < count; index += 1) {
      contentLength = contentLength * 256 + bytes[offset + 2 + index]
    }
    if (contentLength < 128) throw new Error('Non-minimal DER length encoding.')
    lengthBytes += count
  }

  const contentStart = offset + 1 + lengthBytes
  const contentEnd = contentStart + contentLength
  if (contentEnd > bytes.length) throw new Error('DER element exceeds its input.')
  return { start: offset, contentStart, contentEnd, next: contentEnd }
}

function extractP256Coordinates(spkiBuffer) {
  const spki = new Uint8Array(spkiBuffer)
  const outer = readDerElement(spki, 0, 0x30)
  if (outer.next !== spki.length) throw new Error('SPKI contains trailing data.')

  const algorithm = readDerElement(spki, outer.contentStart, 0x30)
  const expectedAlgorithm = '301306072a8648ce3d020106082a8648ce3d030107'
  if (bytesToHex(spki.slice(algorithm.start, algorithm.next)).slice(2) !== expectedAlgorithm) {
    throw new Error('Credential public key is not P-256 EC (ES256).')
  }

  const publicKey = readDerElement(spki, algorithm.next, 0x03)
  if (publicKey.next !== outer.contentEnd || publicKey.contentEnd - publicKey.contentStart !== 66) {
    throw new Error('Unexpected P-256 public key length.')
  }
  if (spki[publicKey.contentStart] !== 0 || spki[publicKey.contentStart + 1] !== 0x04) {
    throw new Error('P-256 public key is not an uncompressed point.')
  }

  const pointStart = publicKey.contentStart + 2
  return {
    qx: bytesToHex(spki.slice(pointStart, pointStart + 32)),
    qy: bytesToHex(spki.slice(pointStart + 32, pointStart + 64)),
  }
}

function normalizeDerInteger(bytes) {
  if (bytes.length === 0 || bytes.length > 33) throw new Error('Invalid ECDSA integer length.')
  let value = bytes
  if (value[0] === 0) {
    if (value.length === 1 || (value[1] & 0x80) === 0) {
      throw new Error('ECDSA integer has unnecessary zero padding.')
    }
    value = value.slice(1)
  } else if ((value[0] & 0x80) !== 0) {
    throw new Error('ECDSA integer must be positive.')
  }
  if (value.length > 32 || value.every((byte) => byte === 0)) {
    throw new Error('ECDSA integer is outside the P-256 scalar range.')
  }

  const normalized = new Uint8Array(32)
  normalized.set(value, 32 - value.length)
  return bytesToHex(normalized)
}

function parseEcdsaSignature(signatureBuffer) {
  const signature = new Uint8Array(signatureBuffer)
  const outer = readDerElement(signature, 0, 0x30)
  if (outer.next !== signature.length) throw new Error('ECDSA signature contains trailing data.')
  const r = readDerElement(signature, outer.contentStart, 0x02)
  const s = readDerElement(signature, r.next, 0x02)
  if (s.next !== outer.contentEnd) throw new Error('ECDSA signature has unexpected elements.')
  return {
    r: normalizeDerInteger(signature.slice(r.contentStart, r.contentEnd)),
    s: normalizeDerInteger(signature.slice(s.contentStart, s.contentEnd)),
  }
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  if (!IS_LOCAL_RUNTIME) throw new Error('Interactive APIs are available only on localhost.')
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`Demo server returned HTTP ${response.status} without JSON.`)
  }
  if (!response.ok) throw new Error(payload.error ?? `Demo server returned HTTP ${response.status}.`)
  return payload
}

function initializePasskeyControl() {
  const statusBadge = document.querySelector('#passkey-registration-status')
  const makerLabel = document.querySelector('#demo-maker')
  const authNonceLabel = document.querySelector('#demo-auth-nonce')
  const makerNonceLabel = document.querySelector('#demo-maker-nonce')
  const progress = document.querySelector('#passkey-progress')
  const createButton = document.querySelector('#create-passkey-button')
  const placeButton = document.querySelector('#place-passkey-button')
  const cancelButton = document.querySelector('#cancel-passkey-button')
  const activeOrderPanel = document.querySelector('#active-demo-order')
  const activeOrderId = document.querySelector('#active-demo-order-id')
  const result = document.querySelector('#passkey-result')
  const resultTitle = document.querySelector('#passkey-result-title')
  const resultFlow = document.querySelector('#passkey-result-flow')
  const transactionLink = document.querySelector('#passkey-tx-link')

  if (!statusBadge || !createButton || !placeButton || !cancelButton) return

  let registeredOnChain = false
  let activeDemoOrder = null

  function setProgress(message, isError = false) {
    progress.textContent = message
    progress.classList.toggle('is-error', isError)
  }

  function setBusy(isBusy) {
    const hasLocalCredential = Boolean(localStorage.getItem(CREDENTIAL_STORAGE_KEY))
    createButton.disabled = isBusy
    placeButton.disabled = isBusy || !registeredOnChain || !hasLocalCredential || Boolean(activeDemoOrder)
    cancelButton.disabled = isBusy || !registeredOnChain || !hasLocalCredential || !activeDemoOrder
  }

  function showTransaction(hash, mode) {
    result.hidden = false
    const content = {
      register: {
        title: 'REGISTERED <i>✓</i>',
        flow: 'Windows Hello → P256 → Maker → Monad',
      },
      place: {
        title: 'AUTHORIZED <i>✓</i>',
        flow: 'Windows Hello → WebAuthn → P256 → Relayer → Monad → CLOB',
      },
      cancel: {
        title: 'CANCELLED <i>✓</i>',
        flow: 'Windows Hello → WebAuthn → P256 → Relayer → Monad → collateral released',
      },
    }[mode]
    resultTitle.innerHTML = content.title
    resultFlow.textContent = content.flow
    transactionLink.href = `${MONADSCAN_TX_URL}${hash}`
    transactionLink.textContent = `TX: ${hash}`
  }

  function requireWebAuthn() {
    if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
      throw new Error('WebAuthn is unavailable. Open this demo at http://localhost:8080 in a supported browser.')
    }
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      throw new Error('This demo only supports the localhost WebAuthn relying party.')
    }
  }

  async function refreshStatus() {
    const status = await apiRequest('/api/passkey/status')
    registeredOnChain = status.registered
    activeDemoOrder = status.demoOrder
    makerLabel.textContent = `${status.maker.slice(0, 8)}…${status.maker.slice(-6)}`
    makerLabel.title = status.maker
    authNonceLabel.textContent = status.authNonce
    makerNonceLabel.textContent = status.makerNonce
    statusBadge.textContent = registeredOnChain ? 'REGISTERED ON MONAD' : 'NOT CREATED'
    statusBadge.dataset.state = registeredOnChain ? 'registered' : 'missing'
    cancelButton.hidden = !activeDemoOrder
    activeOrderPanel.hidden = !activeDemoOrder
    if (activeDemoOrder) {
      activeOrderId.textContent = `${activeDemoOrder.orderId.slice(0, 10)}…${activeDemoOrder.orderId.slice(-8)}`
      activeOrderId.title = activeDemoOrder.orderId
    }

    if (activeDemoOrder && localStorage.getItem(CREDENTIAL_STORAGE_KEY)) {
      setProgress('Active passkey demo order detected. Authorize cancellation to restore benchmark state.')
    } else if (registeredOnChain && !localStorage.getItem(CREDENTIAL_STORAGE_KEY)) {
      setProgress('On-chain key found, but this browser has no matching credential ID. Create a new device passkey to replace it.')
    } else if (registeredOnChain) {
      setProgress('Device credential and on-chain registration are ready.')
    } else {
      setProgress('Create a device passkey, then register its P-256 key on Monad.')
    }
    setBusy(false)
    return status
  }

  createButton.addEventListener('click', async () => {
    setBusy(true)
    result.hidden = true
    try {
      requireWebAuthn()
      setProgress('Creating device credential...')
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'Passkey CLOB', id: location.hostname },
          user: {
            id: crypto.getRandomValues(new Uint8Array(32)),
            name: 'demo-maker@passkey-clob.local',
            displayName: 'Passkey CLOB Demo Maker',
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'preferred',
            userVerification: 'required',
          },
          timeout: 120000,
          attestation: 'none',
        },
      })
      if (!credential || credential.type !== 'public-key') throw new Error('No WebAuthn credential was created.')
      if (typeof credential.response.getPublicKey !== 'function') {
        throw new Error('This browser cannot export the credential P-256 public key.')
      }
      if (
        typeof credential.response.getPublicKeyAlgorithm === 'function' &&
        credential.response.getPublicKeyAlgorithm() !== -7
      ) {
        throw new Error('The authenticator did not create an ES256 credential.')
      }
      const publicKey = credential.response.getPublicKey()
      if (!publicKey) throw new Error('The authenticator did not return a public key.')

      setProgress('Windows Hello verified')
      const { qx, qy } = extractP256Coordinates(publicKey)
      const rawCredentialId = bytesToBase64Url(new Uint8Array(credential.rawId))
      setProgress('Registering P256 key on Monad...')
      const registration = await apiRequest('/api/passkey/register', {
        method: 'POST',
        body: { qx, qy },
      })
      localStorage.setItem(CREDENTIAL_STORAGE_KEY, rawCredentialId)
      registeredOnChain = true
      showTransaction(registration.txHash, 'register')
      await refreshStatus()
      setProgress('Registered on-chain ✓')
    } catch (error) {
      setProgress(error.message ?? 'Passkey creation failed.', true)
      statusBadge.dataset.state = 'error'
    } finally {
      setBusy(false)
    }
  })

  async function createPasskeyAuthorization(challengeHex) {
    requireWebAuthn()
    const storedCredentialId = base64UrlToBytes(localStorage.getItem(CREDENTIAL_STORAGE_KEY))
    const challenge = hexToBytes(challengeHex, 32)
    setProgress('Verify with Windows Hello to authorize this action...')
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: storedCredentialId }],
        userVerification: 'required',
        timeout: 120000,
      },
    })
    if (!assertion || assertion.type !== 'public-key') throw new Error('No WebAuthn assertion was returned.')
    if (!equalBytes(new Uint8Array(assertion.rawId), storedCredentialId)) {
      throw new Error('The authenticator returned an unexpected credential.')
    }

    setProgress('Windows Hello verified. Encoding P256 authorization...')
    const clientDataJSON = new TextDecoder('utf-8', { fatal: true }).decode(
      assertion.response.clientDataJSON,
    )
    const challengeNeedle = '"challenge":"'
    const typeNeedle = '"type":"webauthn.get"'
    const challengeIndex = clientDataJSON.indexOf(challengeNeedle)
    const typeIndex = clientDataJSON.indexOf(typeNeedle)
    if (challengeIndex < 0 || typeIndex < 0) {
      throw new Error('WebAuthn clientDataJSON is missing its exact challenge or type field.')
    }

    const parsedClientData = JSON.parse(clientDataJSON)
    if (parsedClientData.type !== 'webauthn.get') throw new Error('Unexpected WebAuthn operation type.')
    if (parsedClientData.challenge !== bytesToBase64Url(challenge)) {
      throw new Error('WebAuthn assertion challenge does not match the server challenge.')
    }
    if (parsedClientData.origin !== location.origin || parsedClientData.crossOrigin === true) {
      throw new Error('WebAuthn assertion origin does not match this demo.')
    }

    const authenticatorData = new Uint8Array(assertion.response.authenticatorData)
    if (authenticatorData.length < 37) throw new Error('WebAuthn authenticator data is truncated.')
    const { r, s } = parseEcdsaSignature(assertion.response.signature)
    return {
      r,
      s,
      challengeIndex,
      typeIndex,
      authenticatorData: bytesToHex(authenticatorData),
      clientDataJSON,
    }
  }

  placeButton.addEventListener('click', async () => {
    setBusy(true)
    result.hidden = true
    try {
      setProgress('Requesting a fresh on-chain order challenge...')
      const challengeResponse = await apiRequest('/api/passkey/place-challenge', {
        method: 'POST',
        body: DEMO_ORDER,
      })
      const auth = await createPasskeyAuthorization(challengeResponse.challenge)
      setProgress('Relayer is submitting the authorized order to Monad...')
      const placement = await apiRequest('/api/passkey/place', {
        method: 'POST',
        body: {
          side: challengeResponse.side,
          price: challengeResponse.price,
          amount: challengeResponse.amount,
          deadline: challengeResponse.deadline,
          auth,
        },
      })
      showTransaction(placement.txHash, 'place')
      authNonceLabel.textContent = placement.authNonce
      makerNonceLabel.textContent = placement.makerNonce
      await refreshStatus()
      setProgress('Passkey order authorized and placed on Monad ✓')
    } catch (error) {
      setProgress(error.message ?? 'Passkey order failed.', true)
    } finally {
      setBusy(false)
    }
  })

  cancelButton.addEventListener('click', async () => {
    setBusy(true)
    result.hidden = true
    try {
      if (!activeDemoOrder) throw new Error('No active demo order is available to cancel.')
      const orderId = activeDemoOrder.orderId
      const previousAuthNonce = BigInt(authNonceLabel.textContent)
      const previousMakerNonce = makerNonceLabel.textContent
      setProgress('Requesting a fresh on-chain cancellation challenge...')
      const challengeResponse = await apiRequest('/api/passkey/cancel-challenge', {
        method: 'POST',
        body: { orderId },
      })
      const auth = await createPasskeyAuthorization(challengeResponse.challenge)
      setProgress('Relayer is submitting the authorized cancellation to Monad...')
      const cancellation = await apiRequest('/api/passkey/cancel', {
        method: 'POST',
        body: {
          orderId: challengeResponse.orderId,
          deadline: challengeResponse.deadline,
          auth,
        },
      })
      if (BigInt(cancellation.authNonce) !== previousAuthNonce + 1n) {
        throw new Error('Cancellation confirmed, but authNonce did not increase exactly once.')
      }
      if (cancellation.makerNonce !== previousMakerNonce) {
        throw new Error('Cancellation confirmed, but makerNonce changed unexpectedly.')
      }
      if (cancellation.balances.reservedBase !== '0' || cancellation.balances.reservedQuote !== '0') {
        throw new Error('Cancellation confirmed, but reserved balances are not zero.')
      }

      activeDemoOrder = null
      showTransaction(cancellation.txHash, 'cancel')
      authNonceLabel.textContent = cancellation.authNonce
      makerNonceLabel.textContent = cancellation.makerNonce
      cancelButton.hidden = true
      activeOrderPanel.hidden = true
      setProgress('Passkey cancellation confirmed. Benchmark state restored ✓')
      setBusy(false)
    } catch (error) {
      setProgress(error.message ?? 'Passkey cancellation failed.', true)
    } finally {
      setBusy(false)
    }
  })

  setBusy(true)
  refreshStatus().catch((error) => {
    registeredOnChain = false
    statusBadge.textContent = 'SERVER UNAVAILABLE'
    statusBadge.dataset.state = 'error'
    setProgress(error.message ?? 'Could not read passkey status.', true)
    setBusy(false)
  })
}

function initializeLiveBenchmarkController() {
  const runButton = document.querySelector('#run-live-comparison')
  const message = document.querySelector('#live-run-message')
  const overallState = document.querySelector('#live-run-state')
  const summary = document.querySelector('#live-result-summary')
  const completionSpeedup = document.querySelector('#live-completion-speedup')
  const throughputMultiple = document.querySelector('#live-throughput-multiple')
  if (!runButton || !message || !overallState) return

  const results = {}

  function setMessage(text, isError = false) {
    message.textContent = text
    message.classList.toggle('is-error', isError)
  }

  function setChainState(network, state, detail) {
    const card = document.querySelector(`[data-live-chain="${network}"]`)
    const status = card.querySelector('[data-live-status]')
    card.dataset.state = state.toLowerCase()
    status.dataset.state = state.toLowerCase()
    status.textContent = detail ?? state
  }

  function renderChainResult(network, result) {
    if (
      result.makerCount !== LIVE_DEMO_MAKER_COUNT ||
      result.actionsPerMaker !== LIVE_DEMO_ACTIONS_PER_MAKER ||
      result.totalTransactions !== LIVE_DEMO_TOTAL_TRANSACTIONS
    ) {
      throw new Error(`${network} returned an unexpected live workload shape.`)
    }
    const card = document.querySelector(`[data-live-chain="${network}"]`)
    card.querySelector('[data-live-metric="completion"]').textContent =
      `${(result.completionDurationMs / 1000).toFixed(2)}s`
    card.querySelector('[data-live-metric="throughput"]').textContent =
      `${compactNumber(result.throughputTxPerSecond)} tx/s`
    card.querySelector('[data-live-metric="latency"]').textContent =
      `${(result.p50LatencyMs / 1000).toFixed(2)}s / ${(result.p95LatencyMs / 1000).toFixed(2)}s`
    card.querySelector('[data-live-metric="success"]').textContent =
      `${result.successfulTx} / ${result.totalTransactions}`
    setChainState(network, 'COMPLETE')
  }

  async function runNetwork(network) {
    setChainState(network, 'RUNNING', 'RUNNING...')
    try {
      const result = await apiRequest(`/api/benchmark/run/${network}`, { method: 'POST' })
      results[network] = result
      renderChainResult(network, result)
      return result
    } catch (error) {
      setChainState(network, 'FAILED')
      throw new Error(`${network === 'monad' ? 'Monad' : 'Sepolia'}: ${error.message}`)
    } finally {
      const card = document.querySelector(`[data-live-chain="${network}"]`)
      if (card.dataset.state === 'running') setChainState(network, 'FAILED')
    }
  }

  runButton.addEventListener('click', async () => {
    runButton.disabled = true
    summary.hidden = true
    delete results.monad
    delete results.sepolia
    message.classList.remove('is-error')
    overallState.textContent = 'CHECKING STATE'
    overallState.dataset.state = 'running'

    try {
      const passkeyStatus = await apiRequest('/api/passkey/status')
      if (passkeyStatus.demoOrder) {
        setMessage('Active passkey demo order detected. Cancel it first to restore benchmark state.', true)
        overallState.textContent = 'BLOCKED'
        overallState.dataset.state = 'failed'
        const passkeySection = document.querySelector('#passkeys')
        passkeySection.querySelector('.passkey-card')?.classList.add('needs-attention')
        passkeySection.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }

      setMessage('Running 4 concurrent maker lanes and 16 real transactions on both testnets...')
      overallState.textContent = 'RUNNING...'
      overallState.dataset.state = 'running'

      const outcomes = await Promise.allSettled([runNetwork('monad'), runNetwork('sepolia')])
      const failures = outcomes.filter(({ status }) => status === 'rejected')
      if (failures.length > 0) {
        overallState.textContent = 'INCOMPLETE'
        overallState.dataset.state = 'failed'
        setMessage(
          `Live run incomplete: ${failures.map(({ reason }) => reason.message).join(' ')}`,
          true,
        )
        return
      }

      const speedup = results.sepolia.completionDurationMs / results.monad.completionDurationMs
      const throughput =
        results.monad.throughputTxPerSecond / results.sepolia.throughputTxPerSecond
      completionSpeedup.textContent = `${speedup.toFixed(1)}×`
      throughputMultiple.textContent = `${throughput.toFixed(1)}× throughput multiple in this live run`
      summary.hidden = false
      overallState.textContent = 'COMPLETE'
      overallState.dataset.state = 'complete'
      setMessage('Both live benchmark runs completed. Results above are calculated from this run.')
    } catch (error) {
      overallState.textContent = 'BLOCKED'
      overallState.dataset.state = 'failed'
      setMessage(error.message ?? 'Could not start the live comparison.', true)
    } finally {
      runButton.disabled = false
    }
  })
}

initializeChainSelector()
initializeCopyButtons()
initializeRuntimeMode()
loadBenchmark()
if (IS_LOCAL_RUNTIME) {
  initializePasskeyControl()
  initializeLiveBenchmarkController()
}
