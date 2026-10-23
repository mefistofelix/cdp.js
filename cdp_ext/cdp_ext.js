const config = {
  reconnect_ms: chrome.runtime.getManifest().cdp?.reconnect_ms ?? 5000,
}
const configured = chrome.storage.session.get('cdp_bootstrap').then(value => Object.assign(config, value.cdp_bootstrap))
const sessions = {}
const attached = {}
const attaching = {}
let socket
let disconnecting
let discovering = false
let auto_attach = {}
let bootstrapping
let checking = false
let connection_message
const debug_commands = []
const debug_ports = []

function debug_update() {
  const state = {
    status: connection_message ?? (config.browser ? 'Connecting to server' : 'Waiting for trigger'),
    connected: socket?.readyState === WebSocket.OPEN,
    browser: config.browser ?? '',
    endpoint: config.websocket_url ?? '',
    extension_id: chrome.runtime.id,
    sessions: Object.keys(sessions).length,
    debugger_tabs: Object.keys(attached).length,
    commands: debug_commands,
  }
  for (const port of debug_ports) {
    try {
      port.postMessage(state)
    } catch {}
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'cdp_debug') return
  debug_ports.push(port)
  port.onDisconnect.addListener(() => debug_ports.splice(debug_ports.indexOf(port), 1))
  port.onMessage.addListener(message => {
    if (message !== 'clear') return
    debug_commands.length = 0
    debug_update()
  })
  configured.then(debug_update)
})
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

function report_connection(message) {
  if (connection_message === message) return
  connection_message = message
  console.info('[cdp_ext] ' + message)
  debug_update()
}

async function bootstrap(tab) {
  const text = tab.pendingUrl ?? tab.url ?? ''
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/cdp_ext\?/.test(text)) return
  const url = new URL(text)
  const settings = {
    browser: url.searchParams.get('browser'),
    websocket_url: url.searchParams.get('websocket_url'),
    token: url.searchParams.get('token'),
  }
  if (!settings.browser || !settings.websocket_url || !settings.token) return
  const endpoint = new URL(settings.websocket_url)
  if (endpoint.protocol !== 'ws:' || endpoint.host !== url.host) return
  await configured
  while (bootstrapping) await bootstrapping
  return bootstrapping = (async () => {
    const changed = ['browser', 'websocket_url', 'token'].some(key => settings[key] !== config[key])
    if (changed && config.browser && socket?.readyState < WebSocket.CLOSING) {
      const probe = new WebSocket(settings.websocket_url)
      probe.onopen = () => probe.send(JSON.stringify({
        browser: settings.browser,
        extension_id: chrome.runtime.id,
        token: settings.token,
        error: 'This Chrome profile is already connected as ' + config.browser,
      }))
      return
    }
    if (changed) {
      Object.assign(config, settings)
      connection_message = undefined
      debug_update()
      await chrome.storage.session.set({ cdp_bootstrap: settings })
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise(resolve => {
          socket.addEventListener('close', resolve, { once: true })
          socket.close()
        })
      }
      await disconnecting
    }
    await connect()
  })().finally(() => {
    bootstrapping = null
  })
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function target_info(tab) {
  return {
    targetId: String(tab.id),
    type: 'page',
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    attached: !!attached[tab.id],
    incognito: tab.incognito,
    groupId: tab.groupId,
  }
}

function detached(source) {
  if (!sessions[String(source.tabId)]) return
  delete attached[source.tabId]
  for (const [id, session] of Object.entries(sessions)) {
    if (session.tabId === source.tabId) delete sessions[id]
  }
  send({
    method: 'Target.detachedFromTarget',
    params: {
      sessionId: String(source.tabId),
      targetId: String(source.tabId),
    },
  })
  debug_update()
}

async function attach_tab(tabId) {
  const source = { tabId }
  await chrome.debugger.attach(source, '1.3')
  if (socket.readyState !== WebSocket.OPEN) {
    await chrome.debugger.detach(source)
    throw new Error('Reverse connection closed during attachment')
  }
  const sessionId = String(tabId)
  sessions[sessionId] = source
  attached[tabId] = true
  await chrome.debugger.sendCommand(source, 'Target.setAutoAttach', auto_attach)
  send({
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      targetInfo: target_info(await chrome.tabs.get(tabId)),
      waitingForDebugger: false,
    },
  })
  return { sessionId }
}

const methods = {
  'Browser.getVersion'() {
    return {
      protocolVersion: '1.3',
      product: navigator.userAgent.match(/Chrome\/[^ ]+/)?.[0] ?? 'Chrome',
      userAgent: navigator.userAgent,
      revision: '',
      jsVersion: '',
    }
  },
  async 'Target.getTargets'() {
    return { targetInfos: (await chrome.tabs.query({})).map(target_info) }
  },
  async 'Target.getTargetInfo'(params) {
    return { targetInfo: target_info(await chrome.tabs.get(Number(params.targetId))) }
  },
  async 'Target.setDiscoverTargets'(params) {
    discovering = params.discover
    if (discovering) {
      for (const tab of await chrome.tabs.query({})) {
        send({
          method: 'Target.targetCreated',
          params: { targetInfo: target_info(tab) },
        })
      }
    }
  },
  'Target.setAutoAttach'(params) {
    if (params.waitForDebuggerOnStart) throw new Error('Pausing new browser tabs is unavailable through chrome.debugger')
    auto_attach = params
  },
  async 'Target.createTarget'(params) {
    if (Object.keys(params).some(key => !['url', 'background', 'incognito'].includes(key))) {
      throw new Error('Reverse Target.createTarget supports only url, background and incognito')
    }
    const options = {
      url: params.url ?? 'about:blank',
      active: params.background !== true,
    }
    let tab
    if (params.incognito) {
      if (!await chrome.extension.isAllowedIncognitoAccess()) {
        throw new Error('Enable Allow in incognito for cdp_ext in chrome://extensions')
      }
      const window = (await chrome.windows.getAll()).find(window => window.incognito)
      if (window) tab = await chrome.tabs.create({
        ...options,
        windowId: window.id,
      })
      else tab = (await chrome.windows.create({
        incognito: true,
        url: options.url,
        focused: options.active,
      })).tabs[0]
    } else tab = await chrome.tabs.create(options)
    return { targetId: String(tab.id) }
  },
  async 'Target.attachToTarget'(params) {
    const tabId = Number(params.targetId)
    if (params.execution_mode === 'api') {
      await chrome.tabs.get(tabId)
      sessions[String(tabId)] = { tabId }
      debug_update()
      return { sessionId: String(tabId) }
    }
    if (attaching[tabId]) return attaching[tabId]
    if (attached[tabId]) return { sessionId: String(tabId) }
    return attaching[tabId] = attach_tab(tabId).finally(() => delete attaching[tabId])
  },
  async 'Target.detachFromTarget'(params) {
    const source = sessions[params.sessionId]
    if (!source) throw new Error('Unknown debugger session')
    if (source.sessionId) {
      await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: source.sessionId })
    } else {
      if (attached[source.tabId]) await chrome.debugger.detach(source)
      detached(source)
    }
  },
  async 'Target.closeTarget'(params) {
    await chrome.tabs.remove(Number(params.targetId))
    return { success: true }
  },
  async 'Target.activateTarget'(params) {
    const tab = await chrome.tabs.update(Number(params.targetId), { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
  },
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached[source.tabId]) return
  if (method === 'Target.attachedToTarget' || method === 'Target.detachedFromTarget') {
    if (method === 'Target.attachedToTarget') sessions[params.sessionId] = {
      tabId: source.tabId,
      sessionId: params.sessionId,
    }
    else delete sessions[params.sessionId]
    debug_update()
  }
  send({
    method,
    params,
    sessionId: source.sessionId ?? String(source.tabId),
  })
})
chrome.debugger.onDetach.addListener(detached)
chrome.tabs.onCreated.addListener(tab => {
  bootstrap(tab)
  if (discovering) send({
    method: 'Target.targetCreated',
    params: { targetInfo: target_info(tab) },
  })
})
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  bootstrap(tab)
  if (discovering) send({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: target_info(tab) },
  })
})
chrome.tabs.onRemoved.addListener(id => {
  detached({ tabId: id })
  if (discovering) send({
    method: 'Target.targetDestroyed',
    params: { targetId: String(id) },
  })
})

for (const [name, options] of Object.entries({
  onBeforeRequest: [],
  onBeforeSendHeaders: ['requestHeaders'],
  onSendHeaders: ['requestHeaders'],
  onHeadersReceived: ['responseHeaders'],
  onAuthRequired: ['responseHeaders'],
  onResponseStarted: ['responseHeaders'],
  onBeforeRedirect: ['responseHeaders'],
  onCompleted: ['responseHeaders'],
  onErrorOccurred: [],
})) {
  chrome.webRequest[name].addListener(params => send({
    method: 'chrome.webRequest.' + name,
    params,
    sessionId: params.tabId >= 0 ? String(params.tabId) : undefined,
  }), { urls: ['<all_urls>'] }, options)
}

async function connect() {
  await configured
  if (!config.browser || !config.websocket_url || !config.token) return
  if (disconnecting || checking) return
  if (socket?.readyState === WebSocket.CONNECTING) return
  if (socket?.readyState === WebSocket.OPEN) return socket.send('')
  const endpoint = config.websocket_url
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/cdp_ext'
  url.search = ''
  url.hash = ''
  let available = false
  checking = true
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    available = response.ok && await response.text() === 'CDP.js browser connection'
  } catch (error) {
    if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error
  } finally {
    checking = false
  }
  if (endpoint !== config.websocket_url) return connect()
  if (!available) {
    report_connection('Waiting for CDP.js server at ' + endpoint + '; retrying automatically.')
    return
  }
  const connection = socket = new WebSocket(endpoint)
  connection.onopen = () => {
    report_connection('Connected to CDP.js server at ' + endpoint + '.')
    connection.send(JSON.stringify({
      browser: config.browser,
      extension_id: chrome.runtime.id,
      token: config.token,
    }))
  }
  connection.onmessage = async event => {
    if (!event.data) return
    const request = JSON.parse(event.data)
    const { method, params = {}, sessionId, id } = request
    const command = {
      time: Date.now(),
      id,
      method,
      sessionId,
      execution_mode: params.execution_mode,
      status: 'running',
    }
    debug_commands.unshift(command)
    debug_commands.length = Math.min(debug_commands.length, 50)
    debug_update()
    let response
    try {
      let result
      if (method.startsWith('chrome.')) {
        const names = method.split('.').slice(1)
        const name = names.pop()
        const object = names.reduce((object, name) => object[name], chrome)
        const args = params.args ?? []
        if (method === 'chrome.scripting.executeScript' && typeof args[0]?.func === 'string') {
          const injection = args[0]
          injection.args = [injection.func, ...(injection.args ?? [])]
          injection.func = (source, ...args) => (0, eval)('(' + source + ')')(...args)
        }
        result = params.callback
          ? await new Promise((resolve, reject) => object[name](...args, value => {
            const error = chrome.runtime.lastError
            if (error) reject(new Error(error.message))
            else resolve(value)
          }))
          : await object[name](...args)
      } else if (method === '_.click' || method === '_.find') {
        const source = sessions[sessionId]
        if (!source || source.sessionId) throw new Error('XPath browser API commands require a registered root tab')
        const results = await chrome.scripting.executeScript({
          target: { tabId: source.tabId },
          args: [method, params.xpath, params.options],
          func: async (method, xpath, options) => {
            if (method === '_.click') {
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
            }
            const nodes = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            const items = []
            for (let i = 0; i < Math.min(nodes.snapshotLength, options); i++) {
              const node = nodes.snapshotItem(i)
              items.push({
                node_type: node.nodeType,
                node_name: node.nodeName,
                text: String(node.innerText ?? node.textContent ?? '').trim().slice(0, 2000),
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
          },
        })
        if (!Object.hasOwn(results[0] ?? {}, 'result')) throw new Error('XPath browser API execution failed')
        result = {
          result: {
            type: typeof results[0].result,
            value: results[0].result,
          },
        }
      } else {
        if (sessionId == null && !methods[method]) throw new Error('Unsupported reverse browser command: ' + method)
        if (sessionId != null) {
          const source = sessions[sessionId]
          if (!source) throw new Error('Unknown debugger session: ' + sessionId)
          await methods['Target.attachToTarget']({ targetId: String(source.tabId) })
          result = await chrome.debugger.sendCommand(source, method, params)
        } else result = await methods[method](params)
      }
      response = {
        id,
        result: result === undefined ? {} : result,
      }
    } catch (error) {
      response = {
        id,
        error: {
          code: -32000,
          message: error.message,
        },
      }
    }
    command.status = response.error ? 'error' : 'done'
    command.error = response.error?.message
    command.duration_ms = Date.now() - command.time
    debug_update()
    if (id != null && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(response))
  }
  connection.onclose = () => {
    report_connection('Waiting for CDP.js server at ' + endpoint + '; retrying automatically.')
    discovering = false
    disconnecting = Promise.all(Object.keys(sessions).filter(id => !sessions[id].sessionId).map(id => {
      const source = { tabId: Number(id) }
      const was_attached = attached[id]
      detached(source)
      if (was_attached) return chrome.debugger.detach(source).catch(() => {})
    })).finally(() => disconnecting = null)
  }
}

async function start() {
  await configured
  if (!config.browser) {
    for (const tab of (await chrome.tabs.query({})).reverse()) {
      if (config.browser) break
      await bootstrap(tab)
    }
  }
  await connect()
}

chrome.runtime.onStartup.addListener(start)
chrome.alarms.onAlarm.addListener(connect)
chrome.alarms.create('cdp-reconnect', { periodInMinutes: 0.5 })
setInterval(connect, config.reconnect_ms)
start()
