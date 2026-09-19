// Codex sessions.
//
// Unlike Claude Code, Codex exposes a supported CLI for both halves of this:
// `~/.codex/session_index.jsonl` names every thread, and `codex queue` delivers
// a message to one. No socket reverse-engineering, and a queued message waits
// for a thread that is not currently open instead of being dropped.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const INDEX = join(homedir(), '.codex', 'session_index.jsonl')
const ARCHIVED = join(homedir(), '.codex', 'archived_sessions')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_THREADS = 25

let cache = { mtimeMs: 0, threads: [] }

export function listCodexThreads() {
  if (!existsSync(INDEX)) return []

  const { mtimeMs } = statSync(INDEX)
  if (mtimeMs === cache.mtimeMs) return cache.threads

  // The index is append-only, so a thread appears once per rename; the last
  // entry for an id is the current one.
  const byId = new Map()
  for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (!d.id) continue
    byId.set(d.id, d)
  }

  const cutoff = Date.now() - MAX_AGE_MS
  const threads = [...byId.values()]
    .map((d) => ({ ...d, ts: Date.parse(d.updated_at ?? '') || 0 }))
    .filter((d) => d.ts >= cutoff)
    .filter((d) => !existsSync(join(ARCHIVED, `${d.id}.jsonl`)))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_THREADS)
    .map((d) => ({
      agent: 'codex',
      id: `codex:${d.id}`,
      threadId: d.id,
      label: d.thread_name?.trim() || d.id.slice(0, 8),
      status: '',
      startedAt: d.ts,
    }))

  cache = { mtimeMs, threads }
  return threads
}

export async function sendToCodex(threadId, text) {
  const { stdout } = await execFileAsync(
    'codex',
    ['queue', '--thread', threadId, '--message', text],
    { timeout: 20_000, maxBuffer: 1 << 20 },
  )
  return { ok: true, detail: stdout.trim() }
}
