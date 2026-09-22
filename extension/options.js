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
