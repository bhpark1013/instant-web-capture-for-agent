// The content script runs in the page's origin, so it must not hold the bridge
// token or reach the bridge directly. Everything crosses through here.

const DEFAULTS = { bridgeUrl: 'http://127.0.0.1:4778', token: '' }

async function config() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }
}

async function call(path, init = {}) {
  const { bridgeUrl, token } = await config()
  if (!token) throw new Error('No bridge token set. Open the webdbg options page.')
  const res = await fetch(bridgeUrl + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `bridge ${res.status}`)
  return body
}

// The content script cannot capture a tab, so it hides its own overlay, asks
// here, and gets back a saved file path to name in the payload.
async function shot(tab, rect, viewport) {
  // captureVisibleTab grabs whichever tab is visible, not the one that asked —
  // capturing from a background tab would silently return the wrong page.
  if (!tab?.active) throw new Error('tab is not the active tab')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())

  // The capture is the viewport at some scale; derive it from the bitmap rather
  // than trusting devicePixelRatio, which is not always the factor actually used
  // (browser zoom, and a capture that is already downscaled, both break it).
  const scale = bitmap.width / viewport.w
  const sx = Math.max(0, Math.round(rect.x * scale))
  const sy = Math.max(0, Math.round(rect.y * scale))
  const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scale))
  const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scale))
  if (sw <= 0 || sh <= 0) throw new Error('element is off screen')

  const canvas = new OffscreenCanvas(sw, sh)
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  const blob = await canvas.convertToBlob({ type: 'image/png' })

  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))

  const r = await call('/shot', { method: 'POST', body: JSON.stringify({ png: btoa(bin) }) })
  return { path: r.path, clipped: sh < Math.round(rect.h * scale) }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  ;(async () => {
    try {
      if (msg.type === 'sessions') return reply({ ok: true, ...(await call('/sessions')) })
      if (msg.type === 'shot')
        return reply({ ok: true, ...(await shot(sender.tab, msg.rect, msg.viewport)) })
      if (msg.type === 'send')
        return reply({
          ok: true,
          ...(await call('/send', {
            method: 'POST',
            body: JSON.stringify({ id: msg.id, text: msg.text }),
          })),
        })
      reply({ ok: false, error: 'unknown message' })
    } catch (e) {
      reply({ ok: false, error: String(e.message ?? e) })
    }
  })()
  return true // keep the channel open for the async reply
})

async function toggle(tab) {
  if (!tab?.id) return
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' })
  } catch {
    // No content script on chrome:// pages and the web store; nothing to toggle.
  }
}

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-picker') return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  toggle(tab)
})

chrome.action.onClicked.addListener(toggle)
