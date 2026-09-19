// A page to try the picker on, with no dependencies and nothing personal in it.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.WEBDBG_DEMO_PORT ?? 4779)
const file = join(dirname(fileURLToPath(import.meta.url)), 'index.html')

createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}).listen(PORT, '127.0.0.1', () => console.log(`demo page  http://localhost:${PORT}`))
