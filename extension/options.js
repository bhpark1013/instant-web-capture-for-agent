const $ = (id) => document.getElementById(id)

chrome.storage.local.get(['bridgeUrl', 'token']).then(({ bridgeUrl, token }) => {
  $('url').value = bridgeUrl ?? 'http://127.0.0.1:4778'
  $('token').value = token ?? ''
})

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeUrl: $('url').value.trim(), token: $('token').value.trim() })
  $('status').textContent = 'Testing…'
  const r = await chrome.runtime.sendMessage({ type: 'sessions' })
  $('status').textContent = r.ok
    ? `Connected — ${r.sessions.length} live session(s).`
    : `Failed: ${r.error}`
  $('status').style.color = r.ok ? '#137333' : '#c5221f'
})
