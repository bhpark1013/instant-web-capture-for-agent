// Registers native.mjs as a Chrome native-messaging host. Chrome only launches
// a host whose manifest sits in a browser-specific directory, and an extension
// cannot write files, so this one-time step is the user's — that is the whole
// reason `npx webdbg install` exists.
//
// The manifest's allowed_origins is the access control: Chrome refuses to
// connect any extension id not listed, and no web page can reach a host at all.

import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONF_DIR } from './handlers.mjs'

export const HOST_NAME = 'com.webdbg.bridge'
// The Chrome Web Store id, plus the ids of any unpacked copies passed as --id.
export const STORE_ID = 'nnjjhkoknjjbggkiadhkmnkngfljalmg'

const here = dirname(fileURLToPath(import.meta.url))
const home = homedir()

// <user data dir>/NativeMessagingHosts for every Chromium we know of. Only the
// ones whose parent directory exists get a manifest, so this stays quiet on a
// machine with one browser.
function candidates() {
  if (platform() === 'darwin') {
    const as = join(home, 'Library', 'Application Support')
    return {
      'Chrome': join(as, 'Google', 'Chrome'),
      'Chrome Beta': join(as, 'Google', 'Chrome Beta'),
      'Chrome Canary': join(as, 'Google', 'Chrome Canary'),
      'Chromium': join(as, 'Chromium'),
      'Edge': join(as, 'Microsoft Edge'),
      'Brave': join(as, 'BraveSoftware', 'Brave-Browser'),
      'Vivaldi': join(as, 'Vivaldi'),
      'Arc': join(as, 'Arc', 'User Data'),
      'Dia': join(as, 'Dia', 'User Data'),
    }
  }
  if (platform() === 'linux') {
    const cfg = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
    return {
      'Chrome': join(cfg, 'google-chrome'),
      'Chrome Beta': join(cfg, 'google-chrome-beta'),
      'Chromium': join(cfg, 'chromium'),
      'Edge': join(cfg, 'microsoft-edge'),
      'Brave': join(cfg, 'BraveSoftware', 'Brave-Browser'),
      'Vivaldi': join(cfg, 'vivaldi'),
    }
  }
  return null
}

// The host files are copied out of the package rather than referenced in
// place: under npx the package lives in a cache npm is free to evict, and a
// wrapper pointing into it would break silently weeks later. Chrome also runs
// the host with a minimal environment, so node is named by absolute path.
function writeHost() {
  const hostDir = join(CONF_DIR, 'host')
  mkdirSync(hostDir, { recursive: true })
  for (const f of readdirSync(here).filter((f) => f.endsWith('.mjs')))
    copyFileSync(join(here, f), join(hostDir, f))
  const wrapper = join(CONF_DIR, 'native-host.sh')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(hostDir, 'native.mjs')}"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

export function install({ ids = [] } = {}) {
  const dirs = candidates()
  if (!dirs) throw new Error(`${platform()} is not supported yet; use \`npx webdbg\` (the HTTP bridge) instead`)

  const wrapper = writeHost()
  const manifest = {
    name: HOST_NAME,
    description: 'webdbg — hands a selected page element to a local Claude Code session or Codex thread',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [STORE_ID, ...ids].map((id) => `chrome-extension://${id}/`),
  }

  const done = []
  for (const [browser, userData] of Object.entries(dirs)) {
    if (!existsSync(userData)) continue
    const dir = join(userData, 'NativeMessagingHosts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n')
    done.push(browser)
  }
  return { browsers: done, wrapper, manifest }
}

export function uninstall() {
  const dirs = candidates() ?? {}
  const done = []
  for (const [browser, userData] of Object.entries(dirs)) {
    const f = join(userData, 'NativeMessagingHosts', `${HOST_NAME}.json`)
    if (!existsSync(f)) continue
    rmSync(f)
    done.push(browser)
  }
  return { browsers: done }
}
