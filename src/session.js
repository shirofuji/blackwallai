// A headless Chrome session logged into Foundry as one user, driven over the DevTools protocol.
// The browser starts on the first tool call and closes after an idle period, so the user is only
// shown as connected in Foundry while it is actually working.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

// Common Chrome / Chromium locations on Linux, macOS and Windows; CHROME_PATH overrides.
export const findChrome = () => [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p)) ?? 'google-chrome'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BROWSER_HELPERS = readFileSync(new URL('./browser.js', import.meta.url), 'utf8')

export class FoundrySession {
  constructor({ url, user, getPassword, chrome, idleMs, log }) {
    Object.assign(this, { url: url.replace(/\/$/, ''), user, getPassword, chromePath: chrome, idleMs, log })
    this.proc = null
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.idleTimer = null
    this.connecting = null
  }

  // Runs a helper from browser.js in the logged-in page and returns its result.
  async call(fn, args = {}) {
    await this.ensure()
    this.touch()
    this.consoleErrors = []
    return this.evaluate(`window.__mcp.${fn}(${JSON.stringify(args)})`)
  }

  // Runs an async function body in the page as the logged-in user.
  async run(body) {
    await this.ensure()
    this.touch()
    this.consoleErrors = []
    return this.evaluate(`(async () => { ${body}\n})()`)
  }

  touch() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.log('idle, logging out'); this.close() }, this.idleMs)
    this.idleTimer.unref()
  }

  async ensure() {
    if (this.ws && (await this.isReady())) return
    this.connecting ??= this.connect()
      .catch(async (e) => { await this.close(); throw e })
      .finally(() => { this.connecting = null })
    await this.connecting
  }

  async isReady() {
    try {
      return await this.evaluate(`typeof game !== 'undefined' && game.ready === true && game.socket?.connected === true
        && game.user?.name === ${JSON.stringify(this.user)} && !!window.__mcp`)
    } catch { return false }
  }

  async connect() {
    const password = this.getPassword()
    if (!this.ws) await this.launch()
    this.log(`logging in to ${this.url} as ${this.user}`)
    await this.send('Page.navigate', { url: `${this.url}/join` })
    let form
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      form = await this.evaluate(`(() => {
        if (location.pathname !== '/join') return { page: location.pathname };
        const sel = document.querySelector('select[name=userid]');
        if (!sel || !sel.options.length) return null;
        const opt = [...sel.options].find((o) => o.textContent.trim() === ${JSON.stringify(this.user)});
        return { page: '/join', found: !!opt, disabled: !!opt?.disabled, users: [...sel.options].map((o) => o.textContent.trim()).filter(Boolean) };
      })()`).catch(() => null)
      if (form) break
    }
    if (!form) throw new Error(`Foundry's join page at ${this.url}/join did not load.`)
    if (form.page !== '/join') throw new Error(`No world is running in Foundry (${this.url} went to ${form.page}). Launch the world first.`)
    if (!form.found) throw new Error(`Foundry has no user named "${this.user}". Users: ${form.users.join(', ')}. See the README for creating it.`)
    if (form.disabled) throw new Error(`"${this.user}" is already connected to Foundry from somewhere else.`)

    await this.evaluate(`(() => {
      const sel = document.querySelector('select[name=userid]');
      sel.value = [...sel.options].find((o) => o.textContent.trim() === ${JSON.stringify(this.user)}).value;
      document.querySelector('input[name=password]').value = ${JSON.stringify(password)};
      document.querySelector('button[name=join]').click();
    })()`)
    for (let i = 0; i < 180; i++) {
      await sleep(500)
      const state = await this.evaluate(`(() => {
        if (location.pathname === '/join') {
          const msg = [...document.querySelectorAll('#notifications li.error')].map((n) => n.innerText).join(' ');
          return msg ? { error: msg } : null;
        }
        return typeof game !== 'undefined' && game.ready === true ? { ready: true } : null;
      })()`).catch(() => null)
      if (state?.error) throw new Error(`Foundry refused the login: ${state.error}`)
      if (state?.ready) {
        await this.evaluate(BROWSER_HELPERS)
        // Nobody watches this canvas: stop it redrawing every frame in software. Thumbnails render on demand.
        await this.evaluate(`canvas.app?.ticker.stop(); Hooks.on('canvasReady', () => canvas.app.ticker.stop())`)
        const who = await this.evaluate(`({ name: game.user.name, role: game.user.role, isGM: game.user.isGM })`)
        if (!who.isGM) throw new Error(`"${this.user}" needs the Assistant GM role (it has role ${who.role}).`)
        this.log(`logged in as ${who.name}`)
        return
      }
    }
    throw new Error('Timed out waiting for the Foundry world to load.')
  }

  async launch() {
    this.profile = mkdtempSync(join(tmpdir(), 'foundry-mcp-'))
    this.proc = spawn(this.chromePath, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio', '--remote-debugging-port=0',
      `--user-data-dir=${this.profile}`, '--window-size=1600,1000', 'about:blank',
    ], { stdio: 'ignore' })
    this.proc.on('exit', () => { this.proc = null; this.ws = null })
    const portFile = join(this.profile, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100)
    if (!existsSync(portFile)) throw new Error(`Chrome did not start (${this.chromePath}). Install Chrome or Chromium, or set CHROME_PATH.`)
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
    let page
    for (let i = 0; i < 50 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
      if (!page) await sleep(100)
    }
    this.ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 })
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject) })
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id) }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 500))
      if (msg.method === 'Runtime.exceptionThrown')
        this.consoleErrors.push(String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 500))
    })
    this.ws.on('close', () => { this.ws = null; for (const r of this.pending.values()) r({ error: { message: 'browser closed' } }); this.pending.clear() })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  send(method, params = {}) {
    if (!this.ws) return Promise.reject(new Error('browser not running'))
    return new Promise((resolve) => {
      const id = ++this.seq
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.error) throw new Error(r.error.message)
    const ex = r.result?.exceptionDetails
    if (ex) throw new Error((ex.exception?.description ?? ex.text ?? 'error in page').split('\n    at ')[0])
    return r.result?.result?.value
  }

  async close() {
    clearTimeout(this.idleTimer)
    const proc = this.proc
    const exited = proc ? new Promise((r) => proc.once('exit', r)) : null
    if (this.ws) await Promise.race([this.send('Browser.close'), sleep(1000)])
    try { this.ws?.close() } catch {}
    this.ws = null
    if (proc && !(await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]))) {
      proc.kill('SIGKILL')
      await Promise.race([exited, sleep(1000)])
    }
    if (this.profile) try { rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
    this.profile = null
  }
}
