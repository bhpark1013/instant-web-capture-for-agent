const $ = (id) => document.getElementById(id)

chrome.storage.local.get(['bridgeUrl', 'token']).then(({ bridgeUrl, token }) => {
  $('url').value = bridgeUrl ?? 'http://127.0.0.1:4778'
  $('token').value = token ?? ''
})

async function probe() {
  const r = await chrome.runtime.sendMessage({ type: 'probe' })
  const el = $('conn')
  if (r.native === 'ok') {
    el.textContent = 'Native helper: connected. Nothing needs to stay running.'
    el.style.color = '#137333'
  } else if (r.http === 'ok') {
    el.textContent = 'HTTP bridge: connected. (Native helper not installed — `npx webdbg install` would remove the need to keep the bridge running.)'
    el.style.color = '#137333'
  } else {
    el.textContent = `Not connected. Native helper: ${r.native}. HTTP bridge: ${r.http}.`
    el.style.color = '#c5221f'
  }
}
probe()

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeUrl: $('url').value.trim(), token: $('token').value.trim() })
  $('status').textContent = 'Testing…'
  const r = await chrome.runtime.sendMessage({ type: 'sessions' })
  $('status').textContent = r.ok
    ? `Connected via ${r.via} — ${r.sessions.length} live session(s).`
    : `Failed: ${r.error}`
  $('status').style.color = r.ok ? '#137333' : '#c5221f'
  probe()
})

// Chrome grants captureVisibleTab only under <all_urls> or an activeTab grant,
// and a keyboard command does not actually hand out the activeTab grant, so the
// broad origin is asked for here — from a real click, which is the only context
// chrome.permissions.request accepts.
const SHOTS = { origins: ['<all_urls>'] }

async function paintShots() {
  const has = await chrome.permissions.contains(SHOTS)
  $('shotStatus').textContent = has ? 'Screenshots are on.' : 'Screenshots are off.'
  $('shotStatus').style.color = has ? '#137333' : '#666'
  $('grant').disabled = has
  $('grant').textContent = has ? 'Enabled' : 'Enable screenshots'
}
paintShots()

$('grant').addEventListener('click', async () => {
  const granted = await chrome.permissions.request(SHOTS).catch(() => false)
  await paintShots()
  if (!granted) {
    $('shotStatus').textContent = 'Not granted — selections will be sent without an image.'
    $('shotStatus').style.color = '#c5221f'
  }
})
