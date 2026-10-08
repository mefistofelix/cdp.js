const config = chrome.runtime.getManifest().cdp ?? {}
const sessions = {}
const attached = {}
const attaching = {}
let socket
let disconnecting
let discovering = false
let auto_attach = {}

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
  }
}

function detached(source) {
  if (!attached[source.tabId]) return
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
    if (Object.keys(params).some(key => !['url', 'background'].includes(key))) {
      throw new Error('Reverse Target.createTarget supports only url and background')
    }
    const tab = await chrome.tabs.create({
      url: params.url ?? 'about:blank',
      active: params.background !== true,
    })
    return { targetId: String(tab.id) }
  },
  async 'Target.attachToTarget'(params) {
    const tabId = Number(params.targetId)
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
      await chrome.debugger.detach(source)
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
  }
  send({
    method,
    params,
    sessionId: source.sessionId ?? String(source.tabId),
  })
})
chrome.debugger.onDetach.addListener(detached)
chrome.tabs.onCreated.addListener(tab => {
  if (discovering) send({
    method: 'Target.targetCreated',
    params: { targetInfo: target_info(tab) },
  })
})
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (discovering) send({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: target_info(tab) },
  })
})
chrome.tabs.onRemoved.addListener(id => {
  if (discovering) send({
    method: 'Target.targetDestroyed',
    params: { targetId: String(id) },
  })
})

function connect() {
  if (disconnecting) return
  if (socket?.readyState === WebSocket.CONNECTING) return
  if (socket?.readyState === WebSocket.OPEN) return socket.send('')
  const connection = socket = new WebSocket(config.websocket_url ?? 'ws://127.0.0.1:9223')
  connection.onopen = () => connection.send(JSON.stringify({ browser: chrome.runtime.id }))
  connection.onmessage = async event => {
    if (!event.data) return
    const request = JSON.parse(event.data)
    const { method, params = {}, sessionId, id } = request
    let response
    try {
      if (sessionId == null && !methods[method]) throw new Error('Unsupported reverse browser command: ' + method)
      const result = sessionId != null
        ? await chrome.debugger.sendCommand(sessions[sessionId], method, params)
        : await methods[method](params)
      response = {
        id,
        result: result ?? {},
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
    if (id != null && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(response))
  }
  connection.onclose = () => {
    discovering = false
    disconnecting = Promise.all(Object.keys(attached).map(id => {
      const source = { tabId: Number(id) }
      detached(source)
      return chrome.debugger.detach(source).catch(() => {})
    })).finally(() => disconnecting = null)
  }
}

chrome.runtime.onStartup.addListener(connect)
chrome.alarms.onAlarm.addListener(connect)
chrome.alarms.create('cdp-reconnect', { periodInMinutes: 0.5 })
setInterval(connect, config.reconnect_ms ?? 5000)
connect()
