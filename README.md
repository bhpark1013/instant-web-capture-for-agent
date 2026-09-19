# instant-web-capture-for-agent

Click an element, or drag a region, on a page you are developing — then pick
which **Claude Code session or Codex thread** gets it, with a screenshot and the
source lines attached.

Short name in the code, paths and env vars: `webdbg`.

Existing click-to-edit tools route by project directory, so whichever session is
watching that project picks the request up. This one routes by **session**: the
picker lists your live Claude Code sessions and recent Codex threads, grouped by
agent, and you choose one.

## How it works

### Claude Code

Every live session writes `~/.claude/sessions/<pid>.json`, which names its own
Unix socket, plus a paired `<pid>.<sha256(socketPath)>.key` holding a peer token.
Messaging is two NDJSON lines on that socket:

```
{"type":"auth","token":"<peerToken>"}
{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"..."},"priority":"next","from":"uds:webdbg"}
```

Sessions name themselves `park-ee` and similar, which says nothing about what
they are working on, so the picker shows the `ai-title` from the transcript
instead — the same title `/resume` lists.

### Codex

Codex has a supported CLI for both halves, so nothing here is reverse-engineered:
`~/.codex/session_index.jsonl` names every thread, and `codex queue --thread <id>
--message <text>` delivers. A queued message waits for a thread that is not
currently open rather than being dropped, so Codex targets do not have to be live.

A browser extension cannot open a Unix socket or run a CLI, so a small local
bridge does both.

```
extension (picker UI)  ──http──▶  bridge :4778  ──unix socket──▶  chosen session
```

## Setup

1. Start the bridge and copy the token it prints:

   ```sh
   npm run bridge
   ```

2. Load the extension: `chrome://extensions` → Developer mode → **Load unpacked**
   → select `extension/`.

3. Open the extension's options page, paste the bridge token, **Save and test**.
   It should report how many live sessions it found.

## Use

- **Cmd+Shift+U** (or click the toolbar icon) toggles the picker.
- Hover to highlight, click to lock onto an element.
- Pick the target under **Claude Code** or **Codex**, type what should change,
  **Send** (or Cmd+Enter).
- **Esc** closes.

The last session you used is remembered per site, so a given app keeps going to
the same session until you change it.

## What the session receives (region)

```
region: 596x322
screenshot: /Users/you/.webdbg/shots/1789625849217-e534fd.png

elements (nesting shown; text is each element's own, not its children's):
src/components/Card.tsx:12:5  <div>  948x235
├─ :14:7   <div>  146x24  "파트너 크리에이터 모집"
├─ :18:9   <p>    898x21  "직접 선정하여 브랜드에 적합한 콘텐츠를…"
└─ :22:9   <div>  898x112
   └─ :24:11  <div>  538x88  "…가 무엇인가요?"
```

Four things are deliberate. Nesting is shown, so containment does not have to be
inferred from coordinates. Text is each element's own text nodes, not
`innerText`, so a parent does not repeat everything its children said. The source
location leads each line and the path is repeated only when it changes. Absolute
viewport coordinates are left out — the screenshot already says where things are.

## What the session receives (single element)

Selector, tag, id, classes, text, box, and key computed styles, wrapped in
`<webdbg-request>` with the element data explicitly marked untrusted. If
[claude-design-mode](https://github.com/pokefang/design-mode)'s Vite plugin is
also installed, its `data-claude-source` stamp is included, which names the exact
source line that rendered the node.

## Security model

The bridge can type into every agent session on the machine, so two things hold
it in place.

**The picker only runs on local dev origins** — `localhost`, `127.0.0.1` and
`*.localhost`, at any port. It is not injected into arbitrary sites. This is the
load-bearing restriction: the payload carries the element's own text, so a page
you visit is an input source, and a hostile page could otherwise put
instruction-shaped text where a click would scoop it up.

**Messages are attested, and the body is sanitized.** A receiving session holds
an unattested cross-session message for its user to approve; webdbg attests
`from-mode` so clicks land without a prompt. That attestation is a self-claim the
receiver cannot check — it verifies the sender's pid, not its authority — which
is exactly why the origin restriction above has to stay. The body is neutralized
against closing the wrapper early, so page text cannot open a wrapper of its own.

Set `WEBDBG_ATTEST_MODE` to change the claimed mode; unset it and messages get
held for approval again.

## Screenshots

Submitting also captures the selected element and writes it to
`~/.webdbg/shots/`, and the payload names the file so the agent can open it —
without it the agent gets structure and text but never sees the design.

Capturing needs Chrome's `activeTab` grant, which arrives when you open the
picker with **Cmd+Shift+U** or the toolbar icon. The panel says so if a capture
did not happen; the request is still sent either way. The crop is clipped to the
visible viewport, so an element taller than the window is captured in part and
labelled as clipped.

`<all_urls>` would remove that condition, and is deliberately not requested — it
would undo the origin restriction above.

## Notes

- The bridge binds to `127.0.0.1` and requires a bearer token (`~/.webdbg/token`,
  mode 600). Without it, any page you visit could enumerate your sessions and type
  into your agent.
- The page never receives the token or any session's socket path — the content
  script talks only to the extension's service worker, which holds the token.
- Session records are validated before use: the pid must still be a live `claude`
  process, since a stale record can outlive its session and a recycled pid can
  belong to something else.
- The session socket protocol is private to Claude Code and undocumented. It was
  read off the wire and can change between CLI versions; `sessions.mjs` is the one
  file to revisit if it does. The Codex side uses documented CLI surface and
  should be stable.
- Reloading the unpacked extension reinstalls it, which clears its storage — the
  bridge token has to be pasted into the options page again after every reload.
- Codex threads are listed from the last 7 days, newest first, capped at 25.
