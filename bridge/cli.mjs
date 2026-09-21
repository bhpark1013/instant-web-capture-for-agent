#!/usr/bin/env node
// `npx webdbg` exists so the bridge can be started without cloning anything.
// The extension needs a process on this machine no matter what — it cannot open
// a Unix socket or read ~/.claude — so the goal here is only to make that
// process one command instead of a checkout.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const cmd = process.argv[2] ?? 'bridge'

const help = `webdbg — hand part of a local page to a coding agent

  npx webdbg install      register the native helper (once; then nothing
                          needs to stay running and no token is needed)
  npx webdbg uninstall    remove that registration
  npx webdbg              start the HTTP bridge instead (leave it running)
  npx webdbg demo         serve the demo page at http://localhost:4779
  npx webdbg token        print the HTTP bridge token
  npx webdbg extension    print where to point "Load unpacked"

  install --id <extension id>   also allow an unpacked copy of the extension

Chrome Web Store listing and source:
https://github.com/bhpark1013/instant-web-capture-for-agent
`

switch (cmd) {
  case 'install': {
    const { install } = await import('./install.mjs')
    const extra = process.argv.filter((a, i) => process.argv[i - 1] === '--id')
    const r = install({ ids: extra })
    if (!r.browsers.length) {
      console.error('No Chromium-based browser profile found; nothing registered.')
      process.exit(1)
    }
    console.log(`Registered the webdbg helper for: ${r.browsers.join(', ')}`)
    console.log(`Allowed extension ids: ${r.manifest.allowed_origins.map((o) => o.split('/')[2]).join(', ')}`)
    console.log('Restart the browser once, then the extension needs nothing else.')
    break
  }
  case 'uninstall': {
    const { uninstall } = await import('./install.mjs')
    const r = uninstall()
    console.log(r.browsers.length ? `Removed from: ${r.browsers.join(', ')}` : 'Nothing was registered.')
    break
  }
  case 'bridge':
  case 'start':
    await import('./server.mjs')
    break
  case 'demo':
    await import('../demo/serve.mjs')
    break
  case 'token': {
    const f = join(homedir(), '.webdbg', 'token')
    try {
      process.stdout.write(readFileSync(f, 'utf8').trim() + '\n')
    } catch {
      console.error(`No token yet — run \`npx webdbg\` once to create ${f}.`)
      process.exit(1)
    }
    break
  }
  case 'extension':
    console.log(join(here, '..', 'extension'))
    break
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(help)
    break
  default:
    console.error(`unknown command: ${cmd}\n`)
    process.stdout.write(help)
    process.exit(1)
}
