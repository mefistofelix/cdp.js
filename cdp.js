import * as child_process from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const page_defaults = {
  create_params: {},
  initialize: true,
  runtime: 'bootstrap',
  page: true,
  network: true,
  service_worker: true,
  focus_emulation: true,
  binding: true,
  background_service: true,
}
const emit = (target, name, detail) => target.dispatchEvent(new CustomEvent(name, { detail }))

function wait_event(target, names, timeout_ms) {
  return new Promise((resolve, reject) => {
    const events = names.split(/\s+/)
    const cleanup = () => {
      clearTimeout(timer)
      for (const name of events) target.removeEventListener(name, receive)
    }
    const receive = event => {
      cleanup()
      resolve(event)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${names}`))
    }, timeout_ms)
    for (const name of events) target.addEventListener(name, receive)
  })
}

function protocol_error(request, response) {
  const error = new Error(`${request.method}: ${response.error.message}`, {
    cause: {
      req: request,
      ret: response,
    },
  })
  error.cdp = response
  return error
}

export class wsjrpc extends WebSocket {
  constructor(url, options = {}) {
    super(url)
    this.jrpc_id = 0
    this.pending = new Map()
    this.timeout_ms = options.request_timeout_ms ?? 30000
    this.addEventListener('message', event => this._onmessage(event))
    this.addEventListener('close', () => this._reject_pending(new Error('CDP connection closed')))
    this.addEventListener('error', event => this._reject_pending(event.error || new Error('CDP WebSocket failed')))
  }

  _reject_pending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject?.(error)
      if (!pending.reject) {
        emit(this, 'request_error', {
          id: pending.request.id,
          error,
        })
      }
    }
    this.pending.clear()
  }

  _onmessage(event) {
    const response = JSON.parse(event.data)
    if (response.id !== undefined) {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      this._onresponse?.(pending.request, response)
      emit(this, 'response', {
        request: pending.request,
        response,
        options: pending.options,
      })
      emit(this, `rpc_${response.id}`, response)
      pending.resolve?.(response)
    } else if (response.method) emit(this, 'notify', response)
  }

  on_first(names, timeout_ms = this.timeout_ms) {
    return wait_event(this, names, timeout_ms)
  }

  request(request, options = {}) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('CDP WebSocket is not open')
    const id = request.id ?? ++this.jrpc_id
    if (this.pending.has(id)) throw new Error(`Duplicate pending RPC id: ${id}`)
    if (Number.isInteger(id)) this.jrpc_id = Math.max(this.jrpc_id, id)
    request = {
      ...request,
      id,
    }
    const pending = {
      request,
      options,
    }
    const promise = options.wait === false ? null : new Promise((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    pending.timer = setTimeout(() => {
      this.pending.delete(id)
      const error = new Error(`${request.method} timed out; its execution outcome is unknown`)
      pending.reject?.(error)
      if (!pending.reject) {
        emit(this, 'request_error', {
          id,
          error,
        })
      }
    }, options.timeout_ms ?? this.timeout_ms)
    this.pending.set(id, pending)
    try {
      this.send(JSON.stringify(request))
    } catch (error) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (!promise) throw error
      pending.reject(error)
    }
    return {
      id,
      promise,
    }
  }

  async req(request) {
    const response = await this.request(request).promise
    if (response.error) throw protocol_error(request, response)
    return response.result
  }

  notify(request) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('CDP WebSocket is not open')
    this.send(JSON.stringify(request))
  }
}

export class wscdp extends wsjrpc {
  constructor(url, options = {}) {
    super(url, options)
    this.options = options
    this.targets = Object.create(null)
    this.sid_to_page = Object.create(null)
    this.session_targets = new Map()
    this.pages = new Map()
    this.live_targets = new Map()
    this.creating = 0
    this.deferred = new Map()
    this.startup_targets = []
    this.addEventListener('notify', event => this._onnotify(event.detail))
    this.addEventListener('close', () => {
      for (const page of this.pages.values()) {
        page.sid = null
        emit(page, 'close', null)
      }
      this.targets = Object.create(null)
      this.sid_to_page = Object.create(null)
      this.session_targets.clear()
      this.deferred.clear()
      this.live_targets.clear()
    })
  }

  _background(promise) {
    promise.catch(error => emit(this, 'setup_error', error))
  }

  _forget_session(sid, tid = this.session_targets.get(sid)) {
    const page = this.sid_to_page[sid]
    delete this.sid_to_page[sid]
    this.session_targets.delete(sid)
    if (this.targets[tid]?.sessionId === sid) delete this.targets[tid]
    if (page?.sid === sid) {
      page.sid = null
      page.initializations.delete(sid)
    }
  }

  _forget_target(tid) {
    const page = this.pages.get(tid)
    for (const [sid, targetId] of this.session_targets) {
      if (targetId === tid) this._forget_session(sid, tid)
    }
    delete this.targets[tid]
    this.live_targets.delete(tid)
    this.pages.delete(tid)
    this.deferred.delete(tid)
    if (page) {
      page.sid = null
      page.closed = true
      emit(page, 'close', { targetId: tid })
    }
  }

  _onresponse(request, response) {
    if (response.error) return
    if (request.method === 'Target.closeTarget' && response.result?.success) {
      this._forget_target(request.params.targetId)
    }
    if (request.method === 'Target.detachFromTarget') {
      this._forget_session(request.params.sessionId)
    }
  }

  _onnotify(message) {
    const params = message.params || {}
    const sid = params.sessionId || message.sessionId
    const tid = params.targetInfo?.targetId || params.targetId || this.session_targets.get(sid)
    let page = this.pages.get(tid) || this.sid_to_page[sid]
    if (message.method === 'Target.attachedToTarget') {
      this.targets[tid] = params
      this.session_targets.set(sid, tid)
      this.live_targets.set(tid, params.targetInfo)
      if (page?.sid && page.sid !== sid) this._forget_session(page.sid, tid)
      if (params.targetInfo.type === 'page') {
        if (!page && this.creating) this.deferred.set(tid, sid)
        else {
          page ??= new cdp_page(this, tid, this.options.page_options)
          this.pages.set(tid, page)
          page.sid = sid
          this.sid_to_page[sid] = page
          this._background(page.init())
        }
      } else if (params.waitingForDebugger) {
        this._background(this.req({
          method: 'Runtime.runIfWaitingForDebugger',
          sessionId: sid,
        }))
      }
      emit(this, `attached_${tid}`, params)
    }
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
      this.live_targets.set(tid, params.targetInfo)
    }
    // Preserve routing metadata until detach/destroy notifications have been delivered.
    if (page) {
      emit(page, 'notify', message)
      emit(page, message.method, params)
    }
    emit(this, 'cdp_event', {
      message,
      page,
      target_id: tid || null,
      session_id: sid || null,
    })
    emit(this, message.method, params)
    if (message.method === 'Target.detachedFromTarget') {
      this._forget_session(sid, tid)
    }
    if (message.method === 'Target.targetDestroyed' || message.method === 'Target.targetCrashed') {
      this._forget_target(tid)
    }
  }

  async init() {
    if (this.readyState === WebSocket.CONNECTING) {
      const event = await this.on_first('open error close', this.options.connect_timeout_ms ?? 15000)
      if (event.type !== 'open') throw new Error('Unable to open CDP WebSocket')
    }
    await this.call({
      method: 'Target.setAutoAttach',
      params: {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: true,
      },
    })
    await this.call({
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    })
    const result = await this.call({ method: 'Target.getTargets' })
    for (const info of result.targetInfos) this.live_targets.set(info.targetId, info)
    return this
  }

  call(operation) {
    return this.req(operation)
  }

  async attachTarget(tid, options) {
    let page = this.pages.get(tid)
    if (!page) {
      page = new cdp_page(this, tid, options || this.options.page_options)
      this.pages.set(tid, page)
    }
    if (!page.sid) {
      page.attaching ??= (async () => {
        const result = this.targets[tid] || await this.call({
          method: 'Target.attachToTarget',
          params: {
            targetId: tid,
            flatten: true,
          },
        })
        page.sid = result.sessionId
        this.sid_to_page[page.sid] = page
        this.session_targets.set(page.sid, tid)
      })().finally(() => {
        page.attaching = null
      })
      await page.attaching
    }
    await page.init()
    return page
  }

  async createTarget(options = {}) {
    const params = {
      url: 'about:blank',
      background: true,
      ...options.create_params,
    }
    if (params.forTab) throw new Error('forTab=true is unsupported for page targets')
    this.creating++
    try {
      const { targetId } = await this.call({
        method: 'Target.createTarget',
        params,
      })
      const page = new cdp_page(this, targetId, {
        ...this.options.page_options,
        ...options,
      })
      page.label = options.name || null
      this.pages.set(targetId, page)
      this.deferred.delete(targetId)
      await this.attachTarget(targetId)
      for (const tid of this.startup_targets.splice(0)) {
        if (tid !== targetId && this.live_targets.has(tid)) {
          await this.call({
            method: 'Target.closeTarget',
            params: { targetId: tid },
          })
        }
      }
      return page
    } finally {
      this.creating--
      if (!this.creating) {
        for (const [tid] of this.deferred) this._background(this.attachTarget(tid))
        this.deferred.clear()
      }
    }
  }
}

export function xpx(xpath) {
  return xpath
    .replace(
      /ends-with\(([^,]+),([^\)]+)\)/gm,
      '(substring($1, string-length($1)- string-length($2) + 1) = $2)',
    )
    .replace(
      /icontains\(([^,]+),([^\)]+)\)/gm,
      "contains(translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),translate($2,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))",
    )
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function extension_request(method, params) {
  if (!['_.click', '_.find'].includes(method)) throw new Error(`Unknown CDP extension: ${method}`)
  if (!params.xpath) throw new Error(`${method} requires xpath`)
  const quoted = JSON.stringify(xpx(params.xpath))
  let expression
  if (method === '_.click') {
    const attempts = integer(params.attempts ?? 5, 1, 20, 'attempts')
    const interval = integer(params.interval_ms ?? 300, 0, 5000, 'interval_ms')
    expression = `(async () => {
      for (let i = 0; i < ${attempts}; i++) {
        const node = document.evaluate(
          ${quoted}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (node) {
          if (typeof node.click !== 'function') return false;
          node.click();
          return true;
        }
        if (i + 1 < ${attempts}) {
          await new Promise(resolve => setTimeout(resolve, ${interval}));
        }
      }
      return false;
    })()`
  } else {
    const limit = integer(params.limit ?? 20, 1, 100, 'limit')
    expression = `(() => {
      const snapshot = document.evaluate(
        ${quoted}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      );
      const items = [];
      for (let i = 0; i < Math.min(snapshot.snapshotLength, ${limit}); i++) {
        const node = snapshot.snapshotItem(i);
        const text = String(node.innerText ?? node.textContent ?? '').trim().slice(0, 2000);
        if (node.nodeType === 1) {
          const rect = node.getBoundingClientRect();
          items.push({
            tag: node.tagName.toLowerCase(),
            text,
            id: node.id,
            class: String(node.className),
            href: String(node.href || ''),
            value: node.value == null ? null : String(node.value),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          });
        } else {
          items.push({
            node_type: node.nodeType,
            node_name: node.nodeName,
            text,
          });
        }
      }
      return {
        count: snapshot.snapshotLength,
        items,
      };
    })()`
  }
  return {
    method: 'Runtime.evaluate',
    params: {
      expression,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
      userGesture: method === '_.click',
    },
  }
}

export class cdp_page extends EventTarget {
  constructor(browser, tid, options = {}) {
    super()
    this.wscdp = browser
    this.tid = tid
    this.sid = null
    this.options = {
      ...page_defaults,
      ...options,
    }
    this.closed = false
    this.setup_errors = []
    this.initializations = new Map()
  }

  init() {
    const sid = this.sid
    if (this.initializations.has(sid)) return this.initializations.get(sid)
    const promise = (async () => {
      const options = this.options
      const steps = []
      if (options.initialize) {
        if (options.runtime) steps.push(['Runtime.enable', {}])
        if (options.page) steps.push(['Page.enable', {}])
        if (options.network) steps.push(['Network.enable', {}])
        if (options.service_worker) steps.push(['ServiceWorker.enable', {}])
        if (options.focus_emulation) steps.push(['Emulation.setFocusEmulationEnabled', { enabled: true }])
        if (options.binding) steps.push(['Runtime.addBinding', { name: '_send_to_cdp' }])
        if (options.background_service) {
          steps.push(
            ['BackgroundService.clearEvents', { service: 'pushMessaging' }],
            ['BackgroundService.startObserving', { service: 'pushMessaging' }],
            ['BackgroundService.setRecording', {
              service: 'pushMessaging',
              shouldRecord: true,
            }],
          )
        }
        if (options.runtime === 'bootstrap') steps.push(['Runtime.disable', {}])
      }
      steps.push(['Runtime.runIfWaitingForDebugger', {}])
      const errors = []
      for (const [method, params] of steps) {
        try {
          await this.wscdp.req({
            method,
            params,
            sessionId: sid,
          })
        } catch (error) {
          if (!error.cdp) throw error
          errors.push(error.message)
        }
      }
      this.setup_errors = errors
      return this
    })()
    this.initializations.set(sid, promise)
    return promise
  }

  async call({ method, params = {} }) {
    if (this.closed) throw new Error('CDP target is closed')
    await this.wscdp.attachTarget(this.tid)
    const operation = method.startsWith('_.') ? extension_request(method, params) : {
      method,
      params,
    }
    return this.wscdp.req({
      ...operation,
      sessionId: this.sid,
    })
  }
}

const launch_args = [
  '--enable-automation',
  '--mute-audio',
  '--disable-blink-features=AutomationControlled',
  '--hide-crash-restore-bubble',
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--allow-browser-signin=false',
  '--disable-signin-promo-on-avatar-pill-for-testing',
  '--disable-sync',
  '--disable-features=InfiniteSessionRestore,ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,TranslateToast,EnableTranslatePdf,HttpsUpgrades,PaintHolding,DiceWebSigninInterception,SigninPromoOnAvatarPill',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--export-tagged-pdf',
  '--disable-search-engine-choice-screen',
]

export async function browser_executable() {
  const home = os.homedir()
  let candidates
  const override = process.env.CDP_BROWSER || process.env.MRMCP_CDP_BROWSER
  if (override) candidates = [override]
  else if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles || 'C:/Program Files',
      process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
      process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'),
    ]
    candidates = roots.flatMap(root => [
      path.join(root, 'Google/Chrome/Application/chrome.exe'),
      path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
    ])
  } else if (process.platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    ]
  }
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('No Chromium browser found; set executable_path or CDP_BROWSER')
}

function endpoint(value, protocols) {
  const url = new URL(value)
  if (!protocols.includes(url.protocol)) throw new Error(`Expected ${protocols.join(' or ')} endpoint`)
  return url
}

export async function connect(input, options = {}) {
  if (typeof input === 'string') {
    options = {
      ...options,
      [input.startsWith('ws') ? 'websocket_url' : 'http_url']: input,
    }
  } else {
    options = {
      ...input,
      ...options,
    }
  }
  let url = options.websocket_url
  if (!url) {
    let host = options.host || '127.0.0.1'
    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
    const discovery = endpoint(options.http_url || `http://${host}:${options.port}`, ['http:', 'https:'])
    if (!/\/json\/version\/?$/.test(discovery.pathname)) {
      discovery.pathname = discovery.pathname.replace(/\/$/, '') + '/json/version'
    }
    const response = await fetch(discovery, { signal: AbortSignal.timeout(options.connect_timeout_ms ?? 15000) })
    if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`)
    url = (await response.json()).webSocketDebuggerUrl
  }
  const browser = new wscdp(endpoint(url, ['ws:', 'wss:']).href, options)
  options.onconnect?.(browser)
  try {
    return await browser.init()
  } catch (error) {
    browser.close()
    throw error
  }
}

async function stop_process(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.kill()
  })
}

export async function launch(user_data_dir, chrome_path, options = {}) {
  if (user_data_dir && typeof user_data_dir === 'object') {
    options = user_data_dir
    user_data_dir = options.user_data_dir
    chrome_path = options.executable_path || options.chrome_path
  }
  user_data_dir = path.resolve(user_data_dir || '.cdp/main')
  chrome_path ||= await browser_executable()
  const extra = options.args || []
  const switch_name = arg => arg.match(/^(?:--?|\/)([^=]+)/)?.[1].toLowerCase()
  for (const arg of extra) {
    if (arg === '--' || /^(headless|user-data-dir|remote-debugging(?:-.*)?)$/.test(switch_name(arg) || '')) {
      throw new Error('args cannot override managed headless, user-data-dir or remote-debugging switches')
    }
  }
  const defaults = [...launch_args, `--blink-settings=imagesEnabled=${options.images !== false}`]
  if (options.extensions !== true) defaults.push('--disable-extensions')
  if (options.headless) defaults.push('--headless=new', '--window-size=1440,900')
  const overrides = new Set(extra.map(switch_name))
  const args = [
    ...defaults.filter(arg => !overrides.has(switch_name(arg))),
    ...extra,
    `--user-data-dir=${user_data_dir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ]
  await fs.mkdir(user_data_dir, { recursive: true })
  const proc = child_process.spawn(chrome_path, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let diagnostic = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Browser did not expose CDP before the launch timeout')),
      options.connect_timeout_ms ?? 15000,
    )
    const finish = (error, url) => {
      clearTimeout(timer)
      proc.removeListener('error', failed)
      proc.removeListener('exit', exited)
      proc.stderr.removeListener('data', data)
      error ? reject(error) : resolve(url)
    }
    const failed = error => finish(error)
    const exited = code => finish(new Error(`Browser exited before CDP became ready (${code}): ${diagnostic}`))
    const data = chunk => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192)
      const match = diagnostic.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) finish(null, match[1])
    }
    proc.once('error', failed)
    proc.once('exit', exited)
    proc.stderr.on('data', data)
  })
  proc.stderr.resume()
  try {
    const browser = await connect(await ready, options)
    browser.proc = proc
    browser.user_data_dir = user_data_dir
    browser.startup_targets = [...browser.live_targets.values()]
      .filter(info => info.type === 'page' && ['about:blank', 'chrome://newtab/'].includes(info.url))
      .map(info => info.targetId)
    return [proc, browser]
  } catch (error) {
    await stop_process(proc)
    throw error
  }
}

function named_spec(value, browser = false) {
  const { name, ...options } = typeof value === 'string' ? { name: value } : value
  if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f]/.test(name)) throw new Error('A non-empty name is required')
  if (browser && (
    /[<>:"/\\|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )) {
    throw new Error('Browser name must be a safe directory label')
  }
  return {
    name,
    options,
  }
}

export class CDP extends EventTarget {
  constructor({ base_path = '.cdp', ...options } = {}) {
    super()
    this.base_path = path.resolve(base_path)
    this.options = options
    this.browsers = new Map()
    this.closing = false
  }

  _configure(input = 'main') {
    if (this.closing) throw new Error('CDP manager is closed')
    const spec = named_spec(input, true)
    let record = this.browsers.get(spec.name)
    const options = {
      ...this.options,
      user_data_dir: path.join(this.base_path, spec.name),
      ...record?.options,
    }
    const endpoints = ['websocket_url', 'http_url', 'port'].filter(key => Object.hasOwn(spec.options, key))
    if (endpoints.length > 1) throw new Error('Specify only one endpoint: websocket_url, http_url or port')
    if (endpoints.length) {
      Object.assign(options, {
        websocket_url: '',
        http_url: '',
        port: null,
      })
    }
    Object.assign(options, spec.options)
    const remote = !!(options.websocket_url || options.http_url || options.port)
    if (remote && [
      'headless',
      'executable_path',
      'user_data_dir',
      'args',
      'images',
      'extensions',
    ].some(key => Object.hasOwn(spec.options, key))) {
      throw new Error('Browser attachment cannot be combined with local launch options')
    }
    if (options.port != null) integer(options.port, 1, 65535, 'port')
    if (spec.options.host && !options.port) throw new Error('host requires port')
    if (options.websocket_url) endpoint(options.websocket_url, ['ws:', 'wss:'])
    if (options.http_url) endpoint(options.http_url, ['http:', 'https:'])
    if (options.user_data_dir) options.user_data_dir = path.resolve(options.user_data_dir)
    if (!record) {
      record = {
        name: spec.name,
        options,
        targets: new Map(),
        socket: null,
        proc: null,
        connecting: null,
      }
      this.browsers.set(spec.name, record)
    } else if (!isDeepStrictEqual(record.options, options)) {
      if (
        record.connecting ||
        record.socket?.readyState === WebSocket.OPEN ||
        record.proc && record.proc.exitCode === null && record.proc.signalCode === null
      ) {
        throw new Error(`Browser '${spec.name}' is already connected or running with different options`)
      }
      record.options = options
    }
    if (!remote) {
      for (const other of this.browsers.values()) {
        if (other === record || !(other.connecting || other.socket?.readyState === WebSocket.OPEN)) continue
        const normalize = value => process.platform === 'win32' ? value?.toLowerCase() : value
        if (normalize(other.options.user_data_dir) === normalize(options.user_data_dir)) {
          throw new Error('Browser profile is already in use by another label')
        }
      }
    }
    return record
  }

  _configure_target(record, input) {
    const spec = named_spec(input)
    let target = record.targets.get(spec.name)
    const options = {
      ...page_defaults,
      ...target?.options,
      ...spec.options,
    }
    if (options.create_params.forTab) throw new Error('forTab=true is unsupported for logical pages')
    if (![true, false, 'bootstrap'].includes(options.runtime)) throw new Error('runtime must be true, false or bootstrap')
    if (
      target && !isDeepStrictEqual(options, target.options) &&
      (target.promise || target.reservations || record.socket?.live_targets.has(target.tid))
    ) {
      throw new Error(`Target '${spec.name}' is already open or opening with different options`)
    }
    if (!target) {
      target = {
        name: spec.name,
        tid: null,
        promise: null,
        reservations: 0,
      }
      record.targets.set(spec.name, target)
    }
    target.options = options
    return target
  }

  _bind(record, socket) {
    record.socket = socket
    for (const target of record.targets.values()) {
      if (!target.tid) continue
      const page = new cdp_page(socket, target.tid, target.options)
      page.label = target.name
      socket.pages.set(target.tid, page)
    }
    socket.addEventListener('cdp_event', event => {
      const { message, page, target_id } = event.detail
      const target = page?.label || [...record.targets.values()].find(value => value.tid === target_id)?.name
      const params = {
        ...message.params,
        browser: record.name,
        ...(target ? { target } : {}),
      }
      emit(this, 'notify', {
        ...message,
        params,
      })
      emit(this, message.method, params)
    })
    socket.addEventListener('close', event => emit(this, 'close', {
      browser: record.name,
      code: event.code,
    }))
    socket.addEventListener('setup_error', event => emit(this, 'setup_error', {
      browser: record.name,
      error: event.detail,
    }))
    socket.addEventListener('request_error', event => emit(this, 'request_error', {
      browser: record.name,
      ...event.detail,
    }))
  }

  async _browser(record) {
    if (record.connecting) return record.connecting
    if (record.socket?.readyState === WebSocket.OPEN) return record.socket
    record.connecting = (async () => {
      const options = {
        ...record.options,
        onconnect: socket => this._bind(record, socket),
      }
      if (options.websocket_url || options.http_url || options.port) return connect(options)
      if (record.proc && record.proc.exitCode === null && record.proc.signalCode === null) {
        return connect(record.socket.url, options)
      }
      const [proc, socket] = await launch(options)
      record.proc = proc
      return socket
    })()
    try {
      return await record.connecting
    } finally {
      record.connecting = null
    }
  }

  async _target(record, target) {
    if (target.promise) return target.promise
    target.promise = (async () => {
      const socket = await this._browser(record)
      let page
      if (target.tid && socket.live_targets.get(target.tid)?.type === 'page') {
        page = await socket.attachTarget(target.tid, target.options)
      } else {
        page = await socket.createTarget({
          ...target.options,
          name: target.name,
        })
      }
      target.tid = page.tid
      page.label = target.name
      return page
    })()
    try {
      return await target.promise
    } finally {
      target.promise = null
    }
  }

  async call({ method, params = {} }) {
    if (typeof method !== 'string' || !method) throw new Error('call.method is required')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('call.params must be an object')
    const { browser = 'main', target: target_input, ...native_params } = params
    const custom = method.startsWith('_.')
    if (custom && target_input == null) throw new Error(method + ' requires target')
    const operation = custom ? extension_request(method, native_params) : {
      method,
      params: native_params,
    }
    const record = this._configure(browser)
    const target = target_input == null ? null : this._configure_target(record, target_input)
    if (target) target.reservations++
    try {
      const socket = await this._browser(record)
      const page = target ? await this._target(record, target) : null
      const request = {
        ...operation,
        ...(page ? { sessionId: page.sid } : {}),
      }
      try {
        return await socket.req(request)
      } catch (error) {
        if (
          page && error.cdp &&
          /no session|session.*not found|target closed|target with given id/i.test(error.message)
        ) {
          socket._forget_session(page.sid, page.tid)
          if (/target closed|target with given id/i.test(error.message)) socket._forget_target(page.tid)
        }
        // Do not replay a command whose side effects may already have happened.
        throw error
      }
    } finally {
      if (target) target.reservations--
    }
  }

  async close() {
    this.closing = true
    const results = await Promise.allSettled([...this.browsers.values()].map(async record => {
      try {
        await record.connecting
      } catch {
        // A failed connection still needs process cleanup.
      }
      const socket = record.socket
      try {
        if (record.proc && socket?.readyState === WebSocket.OPEN) {
          await socket.call({ method: 'Browser.close' })
        }
      } finally {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const closed = wait_event(socket, 'close', 3000)
          socket.close()
          await closed.catch(() => {})
        }
        await stop_process(record.proc)
      }
    }))
    this.browsers.clear()
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Failed to close CDP browsers')
  }
}

export default {
  CDP,
  wsjrpc,
  wscdp,
  cdp_page,
  launch,
  connect,
  xpx,
}
