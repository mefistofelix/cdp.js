import * as child_process from 'node:child_process'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { once, setMaxListeners } from 'node:events'

export class util {
  static emit(target, name, detail) {
    return target.dispatchEvent(new CustomEvent(name, { detail }))
  }

  static async on_first(target, names, timeout_ms = 30000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Timed out waiting for ' + names)), timeout_ms)
    try {
      return await Promise.race(names.split(' ').map(type =>
        once(target, type, { signal: controller.signal }).then(args => ({
          type,
          args,
        })),
      ))
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  static normalize_xpath(xpath) {
    return xpath
      .replace(/ends-with\(([^,]+),([^\)]+)\)/g, '(substring($1, string-length($1)-string-length($2)+1) = $2)')
      .replace(/icontains\(([^,]+),([^\)]+)\)/g,
        "contains(translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),translate($2,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))")
  }

  static args_to_strings(args) {
    const result = []
    for (const [name, value] of Object.entries(args)) {
      if (value === false || value == null) continue
      const text = Array.isArray(value) ? value.join(',') : value
      result.push('--' + name + (value === true ? '' : '=' + text))
    }
    return result
  }
}

export class jsrpc extends WebSocket {
  constructor(url, options = {}) {
    super(url)
    setMaxListeners(0, this)
    this.id = 0
    this.pending = {}
    this.timeout_ms = options.request_timeout_ms ?? 30000
    this.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      util.emit(this, message.id === undefined ? 'notify' : 'rpc_' + message.id, message)
    })
  }

  async req(request, timeout_ms = this.timeout_ms) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open')
    const id = ++this.id
    const data = JSON.stringify({
      ...request,
      id,
    })
    this.pending[id] = util.on_first(this, 'rpc_' + id + ' close error', timeout_ms)
    try {
      this.send(data)
      const event = await this.pending[id]
      if (event.type !== 'rpc_' + id) throw new Error('WebSocket connection closed')
      const response = event.args[0].detail
      if (response.error) {
        const error = new Error(response.error.message, {
          cause: {
            req: request,
            ret: response,
          },
        })
        error.cdp = response
        throw error
      }
      return response.result
    } finally {
      delete this.pending[id]
    }
  }

  notify(request) {
    this.send(JSON.stringify(request))
  }
}

export class browser {
  static find_executable_path() {
    if (process.env.CDP_BROWSER) return process.env.CDP_BROWSER
    const candidates = process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
        .filter(Boolean).flatMap(root => [
          path.join(root, 'Google/Chrome/Application/chrome.exe'),
          path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
        ])
      : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ]
    const executable = candidates.find(existsSync)
    if (!executable) throw new Error('Set executable_path or CDP_BROWSER to a Chromium executable')
    return executable
  }

  static build_args(options = {}) {
    const args = {
      'enable-automation': true,
      'mute-audio': true,
      'disable-blink-features': 'AutomationControlled',
      'hide-crash-restore-bubble': true,
      'disable-field-trial-config': true,
      'disable-background-networking': true,
      'enable-features': ['NetworkService', 'NetworkServiceInProcess'],
      'disable-background-timer-throttling': true,
      'disable-backgrounding-occluded-windows': true,
      'disable-renderer-backgrounding': true,
      'disable-back-forward-cache': true,
      'disable-breakpad': true,
      'disable-client-side-phishing-detection': true,
      'disable-component-update': true,
      'no-default-browser-check': true,
      'disable-default-apps': true,
      'disable-dev-shm-usage': true,
      'allow-pre-commit-input': true,
      'disable-hang-monitor': true,
      'disable-ipc-flooding-protection': true,
      'disable-popup-blocking': true,
      'disable-prompt-on-repost': true,
      'force-color-profile': 'srgb',
      'metrics-recording-only': true,
      'no-first-run': true,
      'password-store': 'basic',
      'use-mock-keychain': true,
      'no-service-autorun': true,
      'export-tagged-pdf': true,
      'disable-search-engine-choice-screen': true,
      'disable-features': [
        'InfiniteSessionRestore',
        'ImprovedCookieControls',
        'LazyFrameLoading',
        'GlobalMediaControls',
        'DestroyProfileOnBrowserClose',
        'MediaRouter',
        'DialMediaRouteProvider',
        'AcceptCHFrame',
        'AutoExpandDetailsElement',
        'CertificateTransparencyComponentUpdater',
        'AvoidUnnecessaryBeforeUnloadCheckSync',
        'HttpsUpgrades',
        'PaintHolding',
      ],
      'user-data-dir': options.user_data_dir,
      'remote-debugging-port': 0,
    }
    if (options.headless) {
      args.headless = 'new'
      args['window-size'] = '1440,900'
    }
    if (options.extensions !== true) {
      args['disable-extensions'] = true
      args['disable-component-extensions-with-background-pages'] = true
    }
    if (options.images === false) args['blink-settings'] = 'imagesEnabled=false'
    if (options.translations !== true) {
      args['disable-features'].push('Translate', 'TranslateToast', 'EnableTranslatePdf')
    }
    if (options.login !== true) {
      args['disable-signin-promo-on-avatar-pill-for-testing'] = true
      args['disable-sync'] = true
      args['disable-features'].push('DiceWebSigninInterception', 'SigninPromoOnAvatarPill')
    }
    return Object.assign(args, options.args)
  }

  static async update_profile_preferences(filename, preferences) {
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const content = await fs.readFile(filename, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return '{}'
    })
    const prefs = JSON.parse(content)
    for (const [key, value] of Object.entries(preferences)) {
      const parts = key.split('.')
      let object = prefs
      for (const part of parts.slice(0, -1)) object = object[part] ??= {}
      object[parts.at(-1)] = value
    }
    await fs.writeFile(filename, JSON.stringify(prefs))
  }

  static async launch(options) {
    const args = browser.build_args(options)
    const filename = path.join(args['user-data-dir'], args['profile-directory'] || 'Default', 'Preferences')
    await browser.update_profile_preferences(filename, {
      'translate.enabled': options.translations === true,
      'signin.allowed': options.login === true,
      'signin.allowed_on_next_startup': options.login === true,
      ...options.preferences,
    })
    const proc = child_process.spawn(options.executable_path || browser.find_executable_path(), [...util.args_to_strings(args), 'about:blank'], {
      windowsHide: options.windowsHide ?? (args.headless != null && args.headless !== false),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let diagnostic = ''
    const ready = util.on_first(proc, 'ready exit', options.connect_timeout_ms ?? 15000)
    const data = chunk => {
      diagnostic = (diagnostic + chunk).slice(-8192)
      const match = diagnostic.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) proc.emit('ready', match[1])
    }
    proc.stderr.on('data', data)
    try {
      const event = await ready
      if (event.type === 'exit') throw new Error('Browser exited: ' + diagnostic)
      return {
        proc,
        url: event.args[0],
      }
    } catch (error) {
      proc.kill()
      throw error
    } finally {
      proc.stderr.removeListener('data', data)
      proc.stderr.resume()
    }
  }
}

const custom_methods = {
  '_.click'(params) {
    const options = {
      attempts: params.attempts ?? 5,
      interval_ms: params.interval_ms ?? 300,
    }
    return this.evaluate_xpath(params, async (xpath, options) => {
      for (let i = 0; i < options.attempts; i++) {
        const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        if (node) {
          if (typeof node.click !== 'function') return false
          node.click()
          return true
        }
        if (i + 1 < options.attempts) await new Promise(resolve => setTimeout(resolve, options.interval_ms))
      }
      return false
    }, options)
  },
  '_.find'(params) {
    const limit = params.limit ?? 20
    return this.evaluate_xpath(params, (xpath, limit) => {
      const nodes = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
      const items = []
      for (let i = 0; i < Math.min(nodes.snapshotLength, limit); i++) {
        const node = nodes.snapshotItem(i)
        const text = String(node.innerText ?? node.textContent ?? '').trim().slice(0, 2000)
        items.push({
          node_type: node.nodeType,
          node_name: node.nodeName,
          text,
          tag: node.tagName?.toLowerCase(),
          id: node.id,
          class: node.className == null ? undefined : String(node.className),
          href: node.href,
          value: node.value,
          rect: node.getBoundingClientRect?.().toJSON(),
        })
      }
      return {
        count: nodes.snapshotLength,
        items,
      }
    }, limit)
  },
}

export class cdp extends EventTarget {
  constructor({ base_path = '.cdp', ...options } = {}) {
    super()
    this.base_path = path.resolve(base_path)
    this.options = options
    this.browsers = Object.create(null)
    this.custom_methods = { ...custom_methods }
  }

  evaluate_xpath(params, fn, options) {
    if (params.target == null) throw new Error('Custom method requires target')
    const xpath = util.normalize_xpath(params.xpath)
    return this.call({
      method: 'Runtime.evaluate',
      params: {
        browser: params.browser,
        target: params.target,
        expression: '(' + fn + ')(...' + JSON.stringify([xpath, options]) + ')',
        returnByValue: true,
        awaitPromise: true,
        silent: true,
        userGesture: true,
      },
    })
  }

  _detach(browser, sessionId) {
    const targetId = browser.session_targets[sessionId]
    delete browser.session_targets[sessionId]
    const info = browser.target_info[targetId]
    if (info && info.sessionId === sessionId) delete info.sessionId
    for (const target of Object.values(browser.targets)) {
      if (target.sessionId === sessionId) target.sessionId = null
    }
  }

  _notify(browser, message) {
    const params = {
      ...message.params,
      browser: browser.name,
    }
    const sessionId = params.sessionId || message.sessionId
    const targetId = params.targetInfo?.targetId || params.targetId || browser.session_targets[sessionId]
    const target = Object.values(browser.targets).find(value => value.targetId === targetId)
    if (params.targetInfo) {
      Object.assign(browser.target_info[targetId] ??= {}, params.targetInfo)
    }
    const info = browser.target_info[targetId]
    if (message.method === 'Target.attachedToTarget') {
      this._detach(browser, info?.sessionId)
      info.sessionId = sessionId
      browser.session_targets[sessionId] = targetId
    }
    if (target) params.target = target.name
    util.emit(this, 'notify', {
      ...message,
      params,
    })
    util.emit(this, message.method, params)
    if (message.method === 'Target.detachedFromTarget') this._detach(browser, sessionId)
    if (['Target.targetDestroyed', 'Target.targetCrashed'].includes(message.method)) {
      this._detach(browser, info?.sessionId)
      delete browser.target_info[targetId]
    }
  }

  async _connect(record) {
    let url = record.websocket_url
    if (!url && (record.http_url || record.port)) {
      const discovery = new URL(record.http_url || 'http://' + (record.host || '127.0.0.1') + ':' + record.port)
      if (!discovery.pathname.endsWith('/json/version')) discovery.pathname = discovery.pathname.replace(/\/$/, '') + '/json/version'
      const response = await fetch(discovery, { signal: AbortSignal.timeout(record.connect_timeout_ms ?? 15000) })
      if (!response.ok) throw new Error('CDP discovery: HTTP ' + response.status)
      url = (await response.json()).webSocketDebuggerUrl
    }
    if (!url) {
      if (record.proc?.exitCode === null && record.proc.signalCode === null) url = record.socket.url
      else {
        const launched = await browser.launch(record)
        record.proc = launched.proc
        url = launched.url
      }
    }
    const socket = record.socket = new jsrpc(url, record)
    record.target_info = {}
    record.session_targets = {}
    for (const target of Object.values(record.targets)) target.sessionId = null
    socket.addEventListener('notify', event => this._notify(record, event.detail))
    socket.addEventListener('close', event => {
      if (record.socket !== socket) return
      for (const sessionId of Object.keys(record.session_targets)) this._detach(record, sessionId)
      util.emit(this, 'close', {
        browser: record.name,
        code: event.code,
      })
    })
    await util.on_first(socket, 'open error close', record.connect_timeout_ms ?? 15000)
    await socket.req({
      method: 'Target.setAutoAttach',
      params: {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: record.waitForDebuggerOnStart ?? false,
      },
    })
    await socket.req({
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    })
  }

  async _target(browser, target) {
    const socket = browser.socket
    if (!browser.target_info[target.targetId]) {
      target.targetId = (await socket.req({
        method: 'Target.createTarget',
        params: {
          url: 'about:blank',
          background: true,
          ...target.create_params,
        },
      })).targetId
    }
    const info = browser.target_info[target.targetId] ??= {}
    if (!info.sessionId) {
      info.sessionId = (await socket.req({
        method: 'Target.attachToTarget',
        params: {
          targetId: target.targetId,
          flatten: true,
        },
      })).sessionId
      browser.session_targets[info.sessionId] = target.targetId
    }
    const sessionId = info.sessionId
    const steps = []
    if (target.initialize !== false) {
      for (const [option, domain] of Object.entries({
        runtime: 'Runtime',
        page: 'Page',
        network: 'Network',
        service_worker: 'ServiceWorker',
      })) {
        if (target[option] !== false) steps.push([domain + '.enable'])
      }
      if (target.focus_emulation !== false) steps.push(['Emulation.setFocusEmulationEnabled', { enabled: true }])
      if (target.binding) steps.push(['Runtime.addBinding', { name: target.binding }])
      if (target.background_service !== false) steps.push(
        ['BackgroundService.clearEvents', { service: 'pushMessaging' }],
        ['BackgroundService.startObserving', { service: 'pushMessaging' }],
        ['BackgroundService.setRecording', {
          service: 'pushMessaging',
          shouldRecord: true,
        }],
      )
      if ((target.runtime ?? 'bootstrap') === 'bootstrap') steps.push(['Runtime.disable'])
    }
    steps.push(['Runtime.runIfWaitingForDebugger'])
    target.setup_errors = []
    for (const [method, params] of steps) {
      try {
        await socket.req({
          method,
          params,
          sessionId,
        })
      } catch (error) {
        if (!error.cdp) throw error
        target.setup_errors.push(error.message)
      }
    }
    target.sessionId = sessionId
  }

  async call({ method, params = {} }) {
    if (method.startsWith('_.')) {
      const handler = this.custom_methods[method]
      if (!handler) throw new Error('Unknown CDP extension: ' + method)
      return handler.call(this, params)
    }
    const { browser = 'main', target, ...native } = params
    const spec = typeof browser === 'string' ? { name: browser } : browser
    const record = this.browsers[spec.name] ??= {
      user_data_dir: path.join(this.base_path, spec.name),
      ...this.options,
      ...spec,
      args: {
        ...this.options.args,
        ...spec.args,
      },
      preferences: {
        ...this.options.preferences,
        ...spec.preferences,
      },
      targets: Object.create(null),
    }
    if (!record.connecting && record.socket?.readyState !== WebSocket.OPEN) {
      record.connecting = this._connect(record).catch(error => {
        record.socket?.close()
        record.proc?.kill()
        throw error
      }).finally(() => {
        record.connecting = null
      })
    }
    await record.connecting
    let entry
    if (target != null) {
      const spec = typeof target === 'string' ? { name: target } : target
      entry = record.targets[spec.name] ??= {
        targetId: null,
        sessionId: null,
        binding: '_send_to_cdp',
        ...spec,
      }
      if (entry.binding === true) entry.binding = '_send_to_cdp'
      if (!entry.sessionId) {
        entry.connecting ??= this._target(record, entry).finally(() => {
          entry.connecting = null
        })
        await entry.connecting
      }
    }
    const result = await record.socket.req({
      method,
      params: native,
      sessionId: entry?.sessionId,
    })
    if (method === 'Target.detachFromTarget') this._detach(record, native.sessionId)
    if (method === 'Target.closeTarget' && result.success) {
      this._detach(record, record.target_info[native.targetId]?.sessionId)
      delete record.target_info[native.targetId]
    }
    return result
  }

  async close() {
    await Promise.all(Object.values(this.browsers).map(async browser => {
      try {
        await browser.connecting
        if (browser.proc && browser.socket?.readyState === WebSocket.OPEN) {
          await browser.socket.req({ method: 'Browser.close' })
        }
      } finally {
        browser.socket?.close()
        browser.proc?.kill()
      }
    }))
    this.browsers = Object.create(null)
  }
}

export default {
  util,
  jsrpc,
  browser,
  cdp,
}
