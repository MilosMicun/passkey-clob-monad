import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { MAKER_COUNT } from './config.mjs'

const walletFile = new URL('../.wallets.json', import.meta.url)

async function main() {
  if (existsSync(walletFile)) {
    throw new Error('benchmark/.wallets.json already exists; refusing to overwrite')
  }

  const makers = Array.from({ length: MAKER_COUNT }, () => {
    const privateKey = generatePrivateKey()
    const account = privateKeyToAccount(privateKey)

    return {
      address: account.address,
      privateKey,
    }
  })

  try {
    await writeFile(walletFile, `${JSON.stringify({ makers }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('benchmark/.wallets.json already exists; refusing to overwrite')
    }
    throw error
  }

  console.log(`wallets generated: ${makers.length}`)
  for (const maker of makers) {
    console.log(maker.address)
  }
}

main().catch((error) => {
  console.error(`Wallet generation failed: ${error.message}`)
  process.exitCode = 1
})
