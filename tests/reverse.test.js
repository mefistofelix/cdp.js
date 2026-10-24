import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { once, getEventListeners } from 'node:events'
import { createServer } from 'node:http'
import { browser, cdp, util } from '../cdp.js'

const test = globalThis.Deno ? Deno.test : (await import('bun:test')).test

test('reverse targets and XPath default to browser APIs, with explicit debugger execution', async () => {
  await fs.mkdir(path.resolve('build/tests'), { recursive: true })
  const directory = await fs.mkdtemp(path.resolve('build/tests/execution-mode-'))
  const page_server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html',
      ...(request.url === '/csp' ? { 'content-security-policy': "script-src 'none'" } : {}),
    })
    response.end('<h1>API test</h1><button>Click</button><input id="value" value="before"><details><summary>Toggle</summary></details>')
  })
  page_server.listen(0, '127.0.0.1')
  await once(page_server, 'listening')
  const client = new cdp({
    base_path: directory,
    cdp_ext: true,
    user_data_dir: path.join(directory, 'profile'),
    headless: true,
    reverse_server: { port: 0 },
    connect_timeout_ms: 20000,
  })
  const call = (method, params = {}, target = 'api') => client.call({
    method,
    params: { ...params, target },
  })
  try {
    await call('Browser.getVersion', {}, null)
    assert.deepEqual(await call('chrome.userScripts.getScripts', {}, null), [], 'managed custom profiles enable user-script access automatically')
    let startup_tabs
    for (let i = 0; i < 100; i++) {
      startup_tabs = await call('chrome.tabs.query', { args: [{}] }, null)
      if (startup_tabs[0]?.title === 'CDP.js connection') break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal(startup_tabs.length, 1)
    assert.equal(startup_tabs[0].url, 'chrome-extension://' + client.browsers.main.extension_id + '/sidebar.html?connection', 'the sole trigger becomes the connection status page')
    assert.equal(startup_tabs[0].title, 'CDP.js connection')
    await call('chrome.tabs.query', { args: [{}] }, Object.freeze({
      name: 'api',
      group: { name: 'API tabs', color: 'green' },
      create_params: { url: 'http://127.0.0.1:' + page_server.address().port + '/csp' },
    }))
    const record = client.browsers.main
    assert.equal(record.cdp_ext_user_scripts, true)
    assert.ok(record.proc.spawnargs.includes('--extensions-on-chrome-urls'))
    assert.ok(record.proc.spawnargs.some(arg => arg.startsWith('--disable-features=') && arg.includes('DisableExtensionsOnChromeUrlsSwitch')))
    const entry = record.targets.api
    const tabId = Number(entry.targetId)
    const is_attached = async () => (await call('chrome.debugger.getTargets', {}, null)).find(target => target.tabId === tabId).attached
    for (let i = 0; i < 100; i++) {
      if ((await call('chrome.tabs.get', { args: [tabId] })).status === 'complete') break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal(entry.sessionId, entry.targetId)
    assert.deepEqual(entry.setup_errors, [])
    assert.equal(await is_attached(), false, 'selection, creation and grouping do not attach a debugger')
    assert.equal((await call('_.find', { xpath: '//h1' })).result.value.items[0].text, 'API test')
    assert.equal((await call('_.click', { xpath: '//button' })).result.value, true)
    assert.equal((await call('_.click', { xpath: '//summary' })).result.value, true)
    assert.equal((await call('_.find', { xpath: '//details[@open]' })).result.value.count, 1, 'native DOM click changes page state under CSP')
    assert.equal((await call('_.click', { xpath: '//missing', attempts: 1 })).result.value, false)
    assert.equal((await call('_.find', { xpath: '//*[@id="value"]' })).result.value.items[0].value, 'before')
    assert.equal(await is_attached(), false, 'fixed XPath functions work under CSP without debugger or eval')
    const execute = code => call('chrome.userScripts.execute', {
      args: [{
        target: { tabId },
        world: 'MAIN',
        js: [{ code }],
      }],
    }, null)
    assert.equal((await execute('window.clientSourceValue = 42; document.querySelector("h1").dataset.source = "client"; Promise.resolve(window.clientSourceValue)'))[0].result, 42)
    assert.deepEqual((await execute('({ value: window.clientSourceValue, dom: document.querySelector("h1").dataset.source })'))[0].result, {
      value: 42,
      dom: 'client',
    })
    const dynamic = (await execute('(()=>{const result={};try{eval("42")}catch(error){result.eval=error.message};try{new Function("return 42")()}catch(error){result.function=error.message};return result})()'))[0].result
    assert.match(dynamic.eval, /unsafe-eval/)
    assert.match(dynamic.function, /unsafe-eval/)
    assert.equal(await is_attached(), false, 'native MAIN source injection does not attach a debugger or disable page CSP')
    const disconnected = util.on_first(client, 'close')
    record.socket.close()
    await disconnected
    assert.equal((await call('_.find', { xpath: '//h1' })).result.value.count, 1)
    assert.equal(await is_attached(), false, 'API routing reconnects without debugger attachment')
    assert.equal((await client.evaluate_xpath({ target: 'api', xpath: '//h1' }, xpath => document.evaluate(xpath, document, null, 9, null).singleNodeValue.textContent)).result.value, 'API test')
    await client.call({
      method: 'Browser.getVersion',
      params: {
        browser: {
          name: 'manual',
          user_data_dir: path.join(directory, 'manual'),
          cdp_ext_user_scripts: false,
        },
      },
    })
    const manual = (method, params = {}, target = null) => client.call({
      method,
      params: {
        browser: 'manual',
        target,
        ...params,
      },
    })
    await assert.rejects(manual('chrome.userScripts.getScripts'), error => !!error.cdp)
    assert.equal(client.browsers.manual.proc.spawnargs.includes('--extensions-on-chrome-urls'), false)
    assert.equal(JSON.parse(await fs.readFile(path.join(client.browsers.manual.extension_path, 'manifest.json'), 'utf8')).host_permissions.includes('chrome://extensions/*'), false)
    await manual('chrome.tabs.query', { args: [{}] }, {
      name: 'page',
      create_params: { url: 'http://127.0.0.1:' + page_server.address().port + '/csp' },
    })
    const manual_tab = Number(client.browsers.manual.targets.page.targetId)
    for (let i = 0; i < 100; i++) {
      if ((await manual('chrome.tabs.get', { args: [manual_tab] })).status === 'complete') break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal((await manual('_.find', { xpath: '//h1' }, 'page')).result.value.count, 1, 'fixed XPath needs no user-script consent')
    await assert.rejects(client.call({
      method: 'Browser.getVersion',
      params: {
        browser: {
          name: 'blocked-setup',
          user_data_dir: path.join(directory, 'blocked-setup'),
          args: { 'extensions-on-chrome-urls': false },
        },
      },
    }), /Extension setup failed:.*Cannot access/)
    assert.equal((await client.evaluate_xpath({ target: 'api', xpath: '//h1' }, () => undefined)).result.type, 'undefined')
    await assert.rejects(client.evaluate_xpath({ target: 'api', xpath: '//h1' }, () => { throw new Error('XPath callback failed') }), /XPath callback failed/)
    assert.equal(await is_attached(), false, 'arbitrary API code has no debugger fallback')
    await assert.rejects(call('_.find', { xpath: '//h1', execution_mode: 'invalid' }), /execution_mode/)
    let attachments = 0
    client.addEventListener('Target.attachedToTarget', event => {
      if (event.detail.targetInfo.targetId === entry.targetId) attachments++
    })
    const results = await Promise.all([
      call('Runtime.evaluate', { expression: '21 * 2' }),
      call('Runtime.evaluate', { expression: 'typeof _send_to_cdp' }),
    ])
    assert.equal(results[0].result.value, 42)
    assert.equal(results[1].result.value, 'undefined', 'explicit CDP does not enable optional target setup')
    assert.equal(attachments, 1, 'concurrent explicit CDP commands share debugger attachment')
    assert.equal(entry.sessionId, entry.targetId, 'lazy attachment preserves logical target readiness')
    assert.equal(await is_attached(), true)
    await call('Target.detachFromTarget', { sessionId: entry.sessionId }, null)
    assert.equal((await call('_.find', { xpath: '//h1' })).result.value.count, 1)
    assert.equal(await is_attached(), false, 'API target selection stays API after explicit detach')
    const api_found = await call('_.find', { xpath: '//h1' })
    const debugger_found = await call('_.find', { xpath: '//h1', execution_mode: 'debugger' })
    assert.deepEqual(debugger_found.result.value, api_found.result.value, 'both modes return the same node data')
    assert.equal(await is_attached(), true, 'per-call mode selects debugger without changing target configuration')
    assert.equal(entry.execution_mode, undefined)
    await assert.rejects(record.socket.req({ method: 'Runtime.evaluate', params: { expression: '42' }, sessionId: 'missing' }), /Unknown debugger session/)
    await call('chrome.tabs.query', { args: [{}] }, {
      name: 'debug',
      execution_mode: 'debugger',
      runtime: true,
    })
    assert.equal((await call('Runtime.evaluate', { expression: 'typeof _send_to_cdp' }, 'debug')).result.value, 'function')
    await call('chrome.tabs.query', { args: [{}] }, {
      name: 'no-setup',
      execution_mode: 'debugger',
      initialize: false,
    })
    assert.equal((await call('Runtime.evaluate', { expression: 'typeof _send_to_cdp' }, 'no-setup')).result.value, 'undefined')
    await call('chrome.tabs.update', { args: [tabId, { url: 'http://127.0.0.1:' + page_server.address().port }] }, null)
    for (let i = 0; i < 100; i++) {
      if ((await call('chrome.tabs.get', { args: [tabId] })).status === 'complete') break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal((await client.evaluate_xpath({ target: 'api', xpath: '//h1' }, xpath => document.evaluate(xpath, document, null, 9, null).singleNodeValue.textContent)).result.value, 'API test')
  } finally {
    const exited = Object.values(client.browsers).filter(record => record.proc?.exitCode === null).map(record => once(record.proc, 'exit'))
    await client.close()
    await Promise.all(exited)
    page_server.closeAllConnections()
    await new Promise(resolve => page_server.close(resolve))
  }
})

test('reverse extension controls real Chrome without remote-debugging arguments', async () => {
  const build = path.resolve('build/tests')
  await fs.mkdir(build, { recursive: true })
  const directory = await fs.mkdtemp(path.join(build, 'reverse-'))
  const extension = path.join(directory, 'extension')
  await fs.mkdir(extension)
  const client = new cdp({
    reverse: true,
    extension_id: browser.extension_id(extension),
    connect_timeout_ms: 20000,
  })
  const server = client.listen_reverse({ port: 0 })
  const bootstrap_url = id => 'http://127.0.0.1:' + server.addr.port + '/cdp_ext?' + new URLSearchParams({
    browser: id,
    websocket_url: 'ws://127.0.0.1:' + server.addr.port,
    token: 'fixture',
  })
  const manifest = JSON.parse(await fs.readFile('cdp_ext/manifest.json', 'utf8'))
  manifest.cdp = { reconnect_ms: 200 }
  await fs.cp('cdp_ext', extension, { recursive: true })
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest))
  await fs.appendFile(path.join(extension, 'cdp_ext.js'), `
chrome.cdp_probe = {
  debug_commands() {
    return debug_commands
  },
  execute_native(injection) {
    return chrome.scripting.executeScript(injection)
  },
  evaluate_source(target, source, world, kind) {
    return chrome.scripting.executeScript({
      target,
      world,
      args: [source, kind],
      func: (source, kind) => {
        try {
          return {
            value: kind === 'eval' ? eval(source) : new Function('return (' + source + ')')(),
          }
        } catch (error) {
          return { error: error.message }
        }
      },
    })
  },
  async function_source(target, source, mode) {
    let conversions = 0
    const replacement = () => {
      conversions++
      return source
    }
    const func = function () { return 'original' }
    const original_toString = Function.prototype.toString
    if (mode === 'own') func.toString = replacement
    if (mode === 'primitive') func[Symbol.toPrimitive] = replacement
    if (mode === 'prototype') Function.prototype.toString = replacement
    try {
      const results = await chrome.scripting.executeScript({
        target,
        func,
      })
      return {
        results,
        conversions,
      }
    } finally {
      Function.prototype.toString = original_toString
    }
  },
}
`)
  await fs.writeFile(path.join(extension, 'probe.js'), 'document.querySelector("h1").dataset.injected = "yes"; 42')
  const args = util.args_to_strings(browser.build_args({
    headless: true,
    user_data_dir: path.join(directory, 'profile'),
    extensions: [extension],
    args: {
      'remote-debugging-port': false,
    },
  }))
  assert.equal(args.some(value => value.startsWith('--remote-debugging')), false)
  const proc = spawn(browser.find_executable_path(), [...args, bootstrap_url(browser.extension_id(extension))], {
    windowsHide: true,
    stdio: 'ignore',
  })
  const exited = once(proc, 'exit')
  let other_proc
  let other_exited
  const page_server = createServer((request, response) => {
    const headers = { 'content-type': 'text/html' }
    if (request.url === '/csp') headers['content-security-policy'] = "script-src 'none'"
    response.writeHead(200, headers)
    response.end('<h1>Reverse test</h1><button onclick="this.textContent=\'clicked\'">Click</button>')
  })
  page_server.listen(0, '127.0.0.1')
  await once(page_server, 'listening')
  const call = (method, params = {}, target = 'page') => client.call({
    method,
    params: {
      ...params,
      target,
    },
  })
  try {
    assert.equal((await fetch('http://127.0.0.1:' + server.addr.port)).status, 403)
    const [first, second] = await Promise.all([
      call('Runtime.evaluate', { expression: '21 * 2' }, {
        name: 'page',
        execution_mode: 'debugger',
        runtime: true,
      }),
      call('Runtime.evaluate', { expression: '3 + 4' }),
    ])
    assert.deepEqual([first.result.value, second.result.value], [42, 7])
    const record = client.browsers.main
    assert.equal(record.proc, undefined)
    assert.equal(Object.keys(record.targets).length, 1)
    const targetId = record.targets.page.targetId
    const oldSession = record.targets.page.sessionId
    assert.equal(oldSession, targetId, 'root routing uses the stable tab ID directly')
    const completed = []
    const [slow, fast] = await Promise.all([
      call('Runtime.evaluate', {
        expression: 'new Promise(resolve => setTimeout(() => resolve("slow"), 200))',
        awaitPromise: true,
      }).then(result => {
        completed.push(result.result.value)
        return result
      }),
      call('Runtime.evaluate', { expression: '"fast"' }).then(result => {
        completed.push(result.result.value)
        return result
      }),
    ])
    assert.deepEqual(completed, ['fast', 'slow'], 'responses can arrive out of request order')
    assert.deepEqual([slow.result.value, fast.result.value], ['slow', 'fast'])
    const late = util.on_first(record.socket, 'rpc_' + (record.socket.id + 1))
    await assert.rejects(record.socket.req({
      method: 'Runtime.evaluate',
      params: {
        expression: 'new Promise(resolve => setTimeout(() => resolve("expired"), 150))',
        awaitPromise: true,
      },
      sessionId: oldSession,
    }, 30), /abort/i)
    const fresh = call('Runtime.evaluate', {
      expression: 'new Promise(resolve => setTimeout(() => resolve("fresh"), 300))',
      awaitPromise: true,
    })
    assert.equal((await late).args[0].detail.result.result.value, 'expired')
    assert.equal((await fresh).result.value, 'fresh', 'a late reply cannot complete a newer request')
    assert.deepEqual(Object.keys(record.socket.pending), [])
    const targets = await call('Target.getTargets', {}, null)
    assert.equal(targets.targetInfos.some(info => info.targetId === targetId), true)
    assert.equal(targets.targetInfos.some(info => info.url.includes('/cdp_ext?')), false, 'the trigger URL is removed after binding')
    const version = await call('Browser.getVersion', {}, null)
    assert.match(version.product, /Chrome/)
    assert.deepEqual(await call('chrome.sidePanel.getPanelBehavior', {}, null), { openPanelOnActionClick: true })
    assert.equal((await call('chrome.sidePanel.getOptions', { args: [{}] }, null)).path, 'sidebar.html')
    await assert.rejects(call('Browser.debugFailure', {}, null), /Unsupported reverse browser command/)
    const history = await call('chrome.cdp_probe.debug_commands', {}, null)
    const failure = history.find(command => command.method === 'Browser.debugFailure')
    assert.equal(failure.status, 'error')
    assert.match(failure.error, /Unsupported reverse browser command/)
    const evaluated = history.find(command => command.method === 'Runtime.evaluate')
    assert.equal(evaluated.sessionId, oldSession)
    assert.equal(evaluated.status, 'done')
    assert.ok(evaluated.duration_ms >= 0)
    assert.ok(history.every(command => !('params' in command) && !('result' in command) && !('token' in command)))
    await Promise.all(Array.from({ length: 55 }, () => call('Browser.getVersion', {}, null)))
    assert.equal((await call('chrome.cdp_probe.debug_commands', {}, null)).length, 50)
    assert.equal((await call('Runtime.evaluate', { expression: '43' }, {
      name: '__proto__',
      initialize: false,
    })).result.value, 43)
    assert.equal(record.targets.__proto__.sessionId, record.targets.__proto__.targetId)
    assert.equal(record.session_targets[record.targets.__proto__.sessionId], record.targets.__proto__.targetId)

    const network = util.on_first(client, 'Network.requestWillBeSent')
    const loaded = util.on_first(client, 'Page.loadEventFired')
    await call('Page.navigate', { url: 'http://127.0.0.1:' + page_server.address().port })
    assert.equal((await network).args[0].detail.target, 'page')
    await loaded
    const found = await call('_.find', { xpath: '//h1' })
    assert.equal(found.result.value.items[0].text, 'Reverse test')
    assert.equal((await call('_.click', { xpath: '//button' })).result.value, true)
    assert.equal((await call('Runtime.evaluate', {
      expression: 'document.querySelector("button").textContent',
    })).result.value, 'clicked')

    const tabId = Number(targetId)
    const granted = await call('chrome.permissions.getAll', {}, null)
    assert.deepEqual(granted.permissions.toSorted(), manifest.permissions.toSorted())
    assert.ok(granted.origins.includes('<all_urls>'))
    assert.ok((await call('chrome.tabs.query', { args: [{}] }, null)).some(tab => tab.id === tabId))
    assert.equal((await call('chrome.tabs.get', { args: [tabId] })).id, tabId)
    assert.equal((await call('chrome.tabs.update', {
      args: [tabId, { muted: true }],
    })).mutedInfo.muted, true)
    assert.equal(await call('chrome.runtime.getURL', { args: ['probe.js'] }, null),
      'chrome-extension://' + record.extension_id + '/probe.js')
    assert.deepEqual(await call('chrome.scripting.getRegisteredContentScripts', {}, null), [])
    const injection = {
      target: { tabId },
      css: 'h1 { color: rgb(1, 2, 3) !important; }',
    }
    assert.deepEqual(await call('chrome.scripting.insertCSS', { args: [injection] }), {})
    assert.equal((await call('Runtime.evaluate', {
      expression: 'getComputedStyle(document.querySelector("h1")).color',
    })).result.value, 'rgb(1, 2, 3)')
    await call('chrome.scripting.removeCSS', { args: [injection] })
    assert.notEqual((await call('Runtime.evaluate', {
      expression: 'getComputedStyle(document.querySelector("h1")).color',
    })).result.value, 'rgb(1, 2, 3)')
    const injected = await call('chrome.scripting.executeScript', {
      args: [{
        target: { tabId },
        files: ['probe.js'],
      }],
    })
    assert.equal(injected[0].frameId, 0)
    assert.equal(injected[0].result, 42)
    for (const world of ['ISOLATED', 'MAIN']) {
      for (const kind of ['eval', 'function']) {
        const result = await call('chrome.cdp_probe.evaluate_source', {
          args: [{ tabId }, '21 * 2', world, kind],
        }, null)
        if (world === 'MAIN') assert.equal(result[0].result.value, 42)
        else assert.match(result[0].result.error, /unsafe-eval/)
      }
    }
    assert.equal((await call('chrome.scripting.executeScript', {
      args: [{
        target: { tabId },
        world: 'MAIN',
        func: '(first, second) => first + second',
        args: [19, 23],
      }],
    }, null))[0].result, 42)
    assert.equal((await call('chrome.scripting.executeScript', {
      args: [{
        target: { tabId },
        world: 'MAIN',
        func: 'async value => Promise.resolve(value * 2)',
        args: [21],
      }],
    }, null))[0].result, 42)
    const cspId = (await call('Target.createTarget', {
      url: 'http://127.0.0.1:' + page_server.address().port + '/csp',
    }, null)).targetId
    for (const world of ['ISOLATED', 'MAIN']) {
      const result = await call('chrome.cdp_probe.evaluate_source', {
        args: [{ tabId: Number(cspId) }, '21 * 2', world, 'eval'],
      }, null)
      assert.match(result[0].result.error, /unsafe-eval/)
    }
    const cspSession = (await call('Target.attachToTarget', { targetId: cspId }, null)).sessionId
    await record.socket.req({
      method: 'Page.setBypassCSP',
      params: { enabled: true },
      sessionId: cspSession,
    })
    await record.socket.req({
      method: 'Page.enable',
      sessionId: cspSession,
    })
    const cspReloaded = util.on_first(client, 'Page.loadEventFired')
    await record.socket.req({
      method: 'Page.reload',
      sessionId: cspSession,
    })
    await cspReloaded
    for (const kind of ['eval', 'function']) {
      const result = await call('chrome.cdp_probe.evaluate_source', {
        args: [{ tabId: Number(cspId) }, 'document.querySelector("h1").textContent', 'MAIN', kind],
      }, null)
      assert.equal(result[0].result.value, 'Reverse test')
    }
    assert.equal((await call('chrome.scripting.executeScript', {
      args: [{
        target: { tabId: Number(cspId) },
        world: 'MAIN',
        func: 'source => (0, eval)(source)',
        args: ['document.querySelector("h1").dataset.executed = "yes"; Promise.resolve(42)'],
      }],
    }, null))[0].result, 42)
    await record.socket.req({
      method: 'Page.setBypassCSP',
      params: { enabled: false },
      sessionId: cspSession,
    })
    await call('chrome.declarativeNetRequest.updateSessionRules', {
      args: [{
        addRules: [{
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{
              header: 'content-security-policy',
              operation: 'remove',
            }],
          },
          condition: {
            tabIds: [Number(cspId)],
            resourceTypes: ['main_frame'],
          },
        }],
      }],
    }, null)
    const cspRemoved = util.on_first(client, 'Page.loadEventFired')
    await call('chrome.tabs.reload', { args: [Number(cspId)] }, null)
    await cspRemoved
    await call('Target.detachFromTarget', { sessionId: cspSession }, null)
    for (const kind of ['eval', 'function']) {
      const result = await call('chrome.cdp_probe.evaluate_source', {
        args: [{ tabId: Number(cspId) }, 'document.querySelector("h1").textContent', 'MAIN', kind],
      }, null)
      assert.equal(result[0].result.value, 'Reverse test')
    }
    await call('chrome.declarativeNetRequest.updateSessionRules', {
      args: [{ removeRuleIds: [1] }],
    }, null)
    await call('Target.closeTarget', { targetId: cspId }, null)
    for (const mode of ['own', 'primitive', 'prototype']) {
      const result = await call('chrome.cdp_probe.function_source', {
        args: [{ tabId }, 'function () { return "replacement" }', mode],
      }, null)
      assert.equal(result.results[0].result, 'original', mode + ' cannot replace injected source')
      assert.equal(result.conversions, 0, mode + ' conversion is never called')
    }
    for (const func of ['() => 42', 'function () { return 42 }', 'return 42']) {
      await assert.rejects(call('chrome.cdp_probe.execute_native', {
        args: [{
          target: { tabId },
          func,
        }],
      }), error => {
        assert.match(error.cdp.error.message, /expected function, found string/)
        assert.equal(error.cause.req.params.args[0].func, func)
        return true
      })
    }
    await assert.rejects(call('chrome.userScripts.execute', {
      args: [{
        target: { tabId },
        js: [{ code: '42' }],
      }],
    }, null), error => !!error.cdp)
    assert.equal((await call('Runtime.evaluate', {
      expression: 'document.querySelector("h1").dataset.injected',
    })).result.value, 'yes')
    assert.deepEqual(await call('chrome.storage.session.set', { args: [{ answer: 42 }] }, null), {})
    assert.deepEqual(await call('chrome.storage.session.get', { args: ['answer'] }, null), { answer: 42 })
    assert.deepEqual(await call('chrome.storage.session.get', {
      args: ['answer'],
      callback: true,
    }, null), { answer: 42 })
    assert.equal(typeof (await call('chrome.privacy.websites.referrersEnabled.get', {
      args: [{}],
    }, null)).value, 'boolean')
    assert.ok((await call('chrome.management.getAll', {}, null)).some(extension => extension.id === record.extension_id))
    assert.equal(await call('chrome.extension.isAllowedIncognitoAccess', {}, null), false)
    assert.equal(await call('chrome.cookies.get', {
      args: [{
        url: 'http://127.0.0.1:' + page_server.address().port,
        name: 'missing-cookie',
      }],
    }, null), null)
    await assert.rejects(call('chrome.tabs.get', { args: [-1] }, null), error => {
      assert.match(error.cdp.error.message, /tab/i)
      assert.equal(error.cause.req.method, 'chrome.tabs.get')
      return true
    })
    await assert.rejects(call('chrome.missing.method', {}, null), error => !!error.cdp)
    await assert.rejects(call('chrome.tabs.get', {
      args: [-1],
      callback: true,
    }, null), error => /tab/i.test(error.cdp.error.message))

    await assert.rejects(call('Runtime.evaluate', { expression: '1' }, {
      name: 'named-context',
      context: 'isolated',
    }), /Named browser contexts.*reverse/)
    await assert.rejects(call('Runtime.evaluate', { expression: '1' }, {
      name: 'private',
      incognito: true,
    }), error => /Allow in incognito/.test(error.cdp.error.message))
    assert.deepEqual(Object.keys(record.contexts), [])

    await call('Target.detachFromTarget', { sessionId: record.targets.page.sessionId }, null)
    const unobserved = 'http://127.0.0.1:' + page_server.address().port + '/without-debugger'
    const web_request = util.on_first(client, 'test_request_completed')
    const observe = event => {
      if (event.detail.url === unobserved) util.emit(client, 'test_request_completed', event.detail)
    }
    client.addEventListener('chrome.webRequest.onCompleted', observe)
    const before = await call('chrome.debugger.getTargets', {}, null)
    assert.equal(before.find(target => target.tabId === tabId).attached, false)
    await call('chrome.tabs.update', { args: [tabId, { url: unobserved }] }, null)
    const request = (await web_request).args[0].detail
    client.removeEventListener('chrome.webRequest.onCompleted', observe)
    assert.equal(request.target, 'page', 'extension requests retain labels without a debugger session')
    assert.equal(request.tabId, tabId)
    assert.equal(request.statusCode, 200)
    assert.ok(request.responseHeaders.some(header => header.name.toLowerCase() === 'content-type'))
    assert.equal(record.targets.page.sessionId, null, 'webRequest observation does not reattach the debugger')

    await call('Runtime.enable')
    const binding = util.on_first(client, 'Runtime.bindingCalled')
    await call('Runtime.evaluate', { expression: '_send_to_cdp("binding works")' })
    assert.equal((await binding).args[0].detail.payload, 'binding works')
    await assert.rejects(call('Browser.getBrowserCommandLine', {}, null), error => {
      assert.match(error.cdp.error.message, /Unsupported reverse browser command/)
      assert.equal(error.cause.req.method, 'Browser.getBrowserCommandLine')
      return true
    })
    await assert.rejects(call('Runtime.missingCommand'), error => !!error.cdp)
    const childTargets = util.on_first(client, 'Target.attachedToTarget')
    await call('Runtime.evaluate', {
      expression: 'window.worker = new Worker(URL.createObjectURL(new Blob(["self.answer = 42"], {type:"text/javascript"})))',
    })
    const worker = (await childTargets).args[0].detail
    assert.equal(worker.targetInfo.type, 'worker')
    const workerResult = await record.socket.req({
      method: 'Runtime.evaluate',
      params: { expression: 'self.constructor.name' },
      sessionId: worker.sessionId,
    })
    assert.equal(workerResult.result.value, 'DedicatedWorkerGlobalScope')
    const workerDetached = util.on_first(client, 'Target.detachedFromTarget')
    await call('Target.detachFromTarget', { sessionId: worker.sessionId }, null)
    assert.equal((await workerDetached).args[0].detail.sessionId, worker.sessionId)
    assert.equal(record.session_targets[worker.sessionId], undefined)

    const lost = util.on_first(client, 'close')
    record.socket.close()
    await lost
    const resumed = await call('Runtime.evaluate', { expression: '40 + 2' })
    assert.equal(resumed.result.value, 42)
    assert.equal(record.targets.page.targetId, targetId)
    assert.equal(record.targets.page.sessionId, oldSession)
    const reconnectedSession = record.targets.page.sessionId
    record.socket.close()
    assert.equal((await call('Runtime.evaluate', { expression: '42' })).result.value, 42)
    assert.equal(record.targets.page.sessionId, reconnectedSession)
    const issued = util.on_first(client, 'Runtime.consoleAPICalled')
    const interrupted = call('Runtime.evaluate', {
      expression: 'window.executions = (window.executions || 0) + 1; console.log("issued"); new Promise(() => {})',
      awaitPromise: true,
    })
    const rejected = assert.rejects(interrupted, /WebSocket connection closed/)
    await issued
    record.socket.close()
    await rejected
    assert.equal((await call('Runtime.evaluate', { expression: 'window.executions' })).result.value, 1)
    record.waitForDebuggerOnStart = true
    record.socket.close()
    await assert.rejects(call('Runtime.evaluate', { expression: '42' }), /Pausing new browser tabs is unavailable/)
    record.waitForDebuggerOnStart = false
    assert.equal((await call('Runtime.evaluate', { expression: '42' })).result.value, 42)
    assert.deepEqual(Object.keys(record.socket.pending), [])
    assert.equal(getEventListeners(record.socket, 'error').length, 0)
    await call('Target.detachFromTarget', { sessionId: record.targets.page.sessionId }, null)
    assert.equal(record.targets.page.sessionId, null)
    assert.equal((await call('Runtime.evaluate', { expression: '6 * 7' })).result.value, 42)
    await call('Target.closeTarget', { targetId }, null)
    assert.equal(record.targets.page.sessionId, null)
    assert.equal((await call('Runtime.evaluate', { expression: '42' })).result.value, 42)
    assert.notEqual(record.targets.page.targetId, targetId)
    const grouped = [Object.freeze({
      name: 'group-first',
      group: Object.freeze({
        name: '__proto__',
        color: 'blue',
      }),
      initialize: false,
    }), {
      name: 'group-second',
      group: '__proto__',
      targetId: record.targets.page.targetId,
      initialize: false,
    }]
    await Promise.all(grouped.map(target => call('Runtime.evaluate', { expression: '42' }, target)))
    const group = record.groups.__proto__
    assert.equal(Object.getPrototypeOf(record.groups), null)
    const group_tabs = await Promise.all(grouped.map(target => call('chrome.tabs.get', {
      args: [Number(record.targets[target.name].targetId)],
    }, null)))
    const groupId = group_tabs[0].groupId
    assert.notEqual(groupId, -1)
    assert.equal(group_tabs[1].groupId, groupId, 'concurrent first use creates one group')
    assert.equal(group_tabs[1].id, Number(record.targets.page.targetId), 'existing tabs can join a group')
    assert.equal(group.window_groups[group_tabs[0].windowId], groupId)
    assert.equal(record.target_info[record.targets['group-first'].targetId].groupId, groupId)
    const group_info = await call('chrome.tabGroups.get', { args: [groupId] }, null)
    assert.equal(group_info.title, '__proto__')
    assert.equal(group_info.color, 'blue')
    assert.equal(record.targets['group-first'].group, '__proto__')
    assert.equal(grouped[0].group.color, 'blue', 'target/group input objects remain unchanged')
    const group_disconnected = util.on_first(client, 'close')
    record.socket.close()
    await group_disconnected
    await call('Runtime.evaluate', { expression: '42' }, 'group-first')
    assert.equal((await call('chrome.tabs.get', {
      args: [group_tabs[0].id],
    }, null)).groupId, groupId, 'reconnect retains a surviving group')
    for (const tab of group_tabs) await call('Target.closeTarget', { targetId: String(tab.id) }, null)
    await call('Runtime.evaluate', { expression: '42' }, 'group-first')
    const recreated_group = await call('chrome.tabs.get', {
      args: [Number(record.targets['group-first'].targetId)],
    }, null)
    assert.notEqual(recreated_group.groupId, groupId, 'closing the last tab permits fresh group creation')
    assert.equal((await call('chrome.tabGroups.get', { args: [recreated_group.groupId] }, null)).color, 'blue')
    await assert.rejects(call('Runtime.evaluate', { expression: '42' }, {
      name: 'invalid-group',
      group: {
        name: 'invalid',
        color: 'invalid-color',
      },
    }), error => /chrome.tabGroups.update/.test(error.cause.req.method))
    record.groups.invalid.color = 'red'
    await call('Runtime.evaluate', { expression: '42' }, 'invalid-group')
    assert.equal(record.groups.invalid.connecting, null, 'a failed group operation can be retried')
    const invalid_tab = await call('chrome.tabs.get', {
      args: [Number(record.targets['invalid-group'].targetId)],
    }, null)
    assert.equal((await call('chrome.tabGroups.get', { args: [invalid_tab.groupId] }, null)).color, 'red')
    const other_extension = path.join(directory, 'other-extension')
    await fs.mkdir(other_extension)
    await fs.cp('cdp_ext', other_extension, { recursive: true })
    await fs.writeFile(path.join(other_extension, 'manifest.json'), JSON.stringify(manifest))
    const other_args = util.args_to_strings(browser.build_args({
      headless: true,
      user_data_dir: path.join(directory, 'other-profile'),
      extensions: [other_extension],
      args: {
        'remote-debugging-port': false,
      },
    }))
    other_proc = spawn(browser.find_executable_path(), [...other_args, bootstrap_url(browser.extension_id(other_extension))], {
      windowsHide: true,
      stdio: 'ignore',
    })
    other_exited = once(other_proc, 'exit')
    const other = await client.call({
      method: 'Runtime.evaluate',
      params: {
        browser: {
          name: 'other',
          extension_id: browser.extension_id(other_extension),
        },
        target: 'page',
        expression: 'window.marker = "other"',
      },
    })
    assert.equal(other.result.value, 'other')
    assert.notEqual(record.socket, client.browsers.other.socket)
    assert.equal(Object.keys(client.reverse_sockets).length, 2)
    assert.equal((await call('Runtime.evaluate', { expression: 'typeof window.marker' })).result.value, 'undefined')
    const shared = client.server
    const main_closed = util.on_first(client, 'close')
    record.socket.close()
    await main_closed
    assert.equal(client.server, shared, 'another reverse connection still needs the shared listener')
    assert.equal((await client.call({
      method: 'Runtime.evaluate',
      params: {
        browser: 'other',
        target: 'page',
        expression: 'window.marker',
      },
    })).result.value, 'other')
    await client.close()
    assert.equal(proc.exitCode, null, 'manager leaves externally launched Chrome alive')
    assert.equal(other_proc.exitCode, null)
  } finally {
    await client.close()
    page_server.closeAllConnections()
    await new Promise(resolve => page_server.close(resolve))
    proc.kill()
    await exited
    other_proc?.kill()
    await other_exited
  }
})

test('managed reverse launch uses extension identity and keeps a live process through disconnects', async () => {
  const directory = await fs.mkdtemp(path.resolve('build/tests/managed-reverse-'))
  const page_server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': "script-src 'none'",
    })
    response.end('<h1>User script test</h1>')
  })
  page_server.listen(0, '127.0.0.1')
  await once(page_server, 'listening')
  const client = new cdp({
    base_path: directory,
    headless: true,
    connect_timeout_ms: 20000,
    reverse_server: { port: 0 },
  })
  assert.equal(client.server, undefined, 'constructor does not listen')
  let exited
  let direct_exited
  try {
    await client.call({
      method: 'Browser.getVersion',
      params: { browser: 'direct' },
    })
    direct_exited = once(client.browsers.direct.proc, 'exit')
    assert.equal(client.server, undefined, 'direct browsers do not start the reverse listener')
    const spec = {
      name: 'work',
      cdp_ext: true,
      extensions: true,
      args: {
        'user-data-dir': path.join(directory, 'pròfile'),
        'profile-directory': 'Profile 1',
      },
    }
    const call = () => client.call({
      method: 'Runtime.evaluate',
      params: {
        browser: spec,
        target: {
          name: 'page',
          execution_mode: 'debugger',
        },
        expression: '42',
      },
    })
    const extension = path.join(spec.args['user-data-dir'], spec.args['profile-directory'], 'cdp_ext')
    await fs.mkdir(extension, { recursive: true })
    const manifest = JSON.parse(await fs.readFile('cdp_ext/manifest.json', 'utf8'))
    await fs.cp('cdp_ext', extension, { recursive: true })
    await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest))
    const preparation = new cdp({
      headless: true,
      extensions: [extension],
      args: spec.args,
    })
    try {
      const enabled = await preparation.call({
        method: 'Runtime.evaluate',
        params: {
          target: {
            name: 'extensions',
            create_params: { url: 'chrome://extensions/' },
          },
          expression: 'chrome.developerPrivate.updateExtensionConfiguration(' + JSON.stringify({
            extensionId: browser.extension_id(extension),
            incognitoAccess: true,
          }) + ').then(() => true)',
          awaitPromise: true,
        },
      })
      assert.equal(enabled.result.value, true)
      const stopped = once(preparation.browsers.main.proc, 'exit')
      await preparation.call({ method: 'Browser.close' })
      await stopped
    } finally {
      await preparation.close()
    }
    const results = await Promise.all([call(), call()])
    assert.deepEqual(results.map(result => result.result.value), [42, 42])
    const record = client.browsers.work
    const server = client.server
    const original = record.proc
    exited = once(original, 'exit')
    const id = record.extension_id
    assert.equal(record.cdp_ext_install, true, 'custom directory enables bridge installation by default')
    assert.equal(record.extension_path, await fs.realpath(path.join(directory, 'pròfile', 'Profile 1', 'cdp_ext')))
    assert.equal(client.reverse_sockets.work, record.socket, 'URL bootstrap announces the logical name')
    assert.equal(client.reverse_sockets[id], undefined)
    assert.equal(original.spawnargs.some(arg => arg.startsWith('--remote-debugging')), false)
    assert.ok(original.spawnargs.includes('--disable-extensions-except=' + record.extension_path), 'bridge and enabled-profile wildcard share path expansion and deduplication')
    assert.equal((await fs.readFile(path.join(record.extension_path, 'manifest.json'), 'utf8')).includes('"browser"'), false)
    assert.equal(Object.keys(record.targets).length, 1)
    assert.deepEqual(await client.call({
      method: 'chrome.userScripts.getScripts',
      params: { browser: 'work' },
    }), [])
    const loaded = util.on_first(client, 'Page.loadEventFired')
    await client.call({
      method: 'Page.navigate',
      params: {
        browser: 'work',
        target: 'page',
        url: 'http://127.0.0.1:' + page_server.address().port,
      },
    })
    await loaded
    const execute = code => client.call({
      method: 'chrome.userScripts.execute',
      params: {
        browser: 'work',
        args: [{
          target: { tabId: Number(record.targets.page.targetId) },
          js: [{ code }],
        }],
      },
    })
    const executed = await execute('document.querySelector("h1").dataset.injected = "yes"; 21 * 2')
    assert.equal(executed[0].frameId, 0)
    assert.equal(executed[0].result, 42)
    assert.equal((await execute('document.querySelector("h1").dataset.injected'))[0].result, 'yes')
    assert.equal((await execute('Promise.resolve(43)'))[0].result, 43)
    await assert.rejects(client.call({
      method: 'chrome.userScripts.execute',
      params: {
        browser: 'work',
        args: [{
          target: { tabId: -1 },
          js: [{ code: '42' }],
        }],
      },
    }), error => !!error.cdp)
    const private_target = {
      name: 'private',
      incognito: true,
      group: {
        name: 'private-work',
        color: 'green',
      },
    }
    const private_call = (method, params = {}, target = private_target) => client.call({
      method,
      params: {
        ...params,
        browser: 'work',
        target,
      },
    })
    assert.deepEqual((await private_call('Network.getCookies', {
      urls: ['http://127.0.0.1/'],
    })).cookies, [])
    const tab = await client.call({
      method: 'chrome.tabs.get',
      params: {
        browser: 'work',
        args: [Number(record.targets.private.targetId)],
      },
    })
    assert.equal(tab.incognito, true)
    const private_group = tab.groupId
    assert.notEqual(private_group, -1)
    await private_call('Runtime.evaluate', { expression: '42' }, {
      name: 'regular-group',
      group: 'private-work',
    })
    const regular_tab = await client.call({
      method: 'chrome.tabs.get',
      params: {
        browser: 'work',
        args: [Number(record.targets['regular-group'].targetId)],
      },
    })
    assert.equal(regular_tab.incognito, false)
    assert.notEqual(regular_tab.groupId, private_group, 'each window keeps its own physical group')
    assert.equal(Object.keys(record.groups['private-work'].window_groups).length, 2)
    await private_call('Network.setCookie', {
      name: 'private',
      value: 'yes',
      url: 'http://127.0.0.1/',
    })
    assert.equal((await private_call('Network.getCookies', {
      urls: ['http://127.0.0.1/'],
    }, {
      name: 'private-other',
      incognito: true,
      group: 'private-work',
    })).cookies.find(cookie => cookie.name === 'private').value, 'yes')
    assert.equal((await private_call('Network.getCookies', {
      urls: ['http://127.0.0.1/'],
    }, 'page')).cookies.some(cookie => cookie.name === 'private'), false)
    for (const name of ['private', 'private-other']) {
      await client.call({
        method: 'Target.closeTarget',
        params: {
          browser: 'work',
          targetId: record.targets[name].targetId,
        },
      })
    }
    assert.deepEqual((await private_call('Network.getCookies', {
      urls: ['http://127.0.0.1/'],
    })).cookies, [], 'closing all incognito tabs clears their storage')
    const closed = util.on_first(client, 'close')
    record.socket.close()
    await closed
    record.connect_timeout_ms = 1
    await assert.rejects(call(), /abort/i)
    assert.equal(record.proc, original)
    assert.equal(original.exitCode, null, 'a connection timeout must not kill or replace the browser')
    record.connect_timeout_ms = 20000
    assert.equal((await call()).result.value, 42)
    assert.equal(record.proc, original, 'extension reconnect reuses the live process')
    assert.equal(client.server, server, 'a live reverse process still needs the listener')
    const disconnected = util.on_first(client, 'close')
    original.kill()
    await exited
    await disconnected
    await server.finished
    await client.server_closing
    assert.equal(client.server, null, 'last reverse process exit releases the listener')
    assert.equal(client.browsers.direct.proc.exitCode, null, 'a direct browser does not retain the reverse listener')
    assert.match((await client.call({
      method: 'Browser.getVersion',
      params: { browser: 'direct' },
    })).product, /Chrome/)
    assert.equal((await call()).result.value, 42)
    assert.notEqual(client.server, server, 'a later reverse call restarts the listener')
    assert.notEqual(record.proc, original, 'only confirmed process exit permits relaunch')
    assert.equal(record.extension_id, id, 'extension identity survives a browser relaunch')
    exited = once(record.proc, 'exit')
  } finally {
    await client.close()
    await exited
    await direct_exited
    page_server.closeAllConnections()
    await new Promise(resolve => page_server.close(resolve))
  }
})

test('URL bootstrap reuses normal Chrome and names profiles sharing one extension', async () => {
  const directory = await fs.mkdtemp(path.resolve('build/tests/bootstrap-'))
  const client = new cdp({
    cdp_ext: true,
    cdp_ext_install: false,
    reverse_server: { port: 0 },
    connect_timeout_ms: 20000,
  })
  client.listen_reverse()
  const extension = path.join(directory, 'extension')
  await fs.mkdir(extension)
  const manifest = JSON.parse(await fs.readFile('cdp_ext/manifest.json', 'utf8'))
  manifest.cdp = { reconnect_ms: 200 }
  await fs.cp('cdp_ext', extension, { recursive: true })
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest))
  await fs.appendFile(path.join(extension, 'cdp_ext.js'), `
chrome.cdp_probe = {
  announce(url, message) {
    return new Promise(resolve => {
      const connection = new WebSocket(url)
      connection.onopen = () => connection.send(JSON.stringify(message))
      connection.onclose = event => resolve(event.code)
    })
  },
}
`)
  const first_profile = path.join(directory, 'first')
  const startup = createServer((request, response) => {
    response.end('Ready')
    startup.emit('ready')
  })
  startup.listen(0, '127.0.0.1')
  await once(startup, 'listening')
  const ready = once(startup, 'ready')
  const first = await browser.launch({
    cdp_ext: true,
    extension_path: extension,
    user_data_dir: first_profile,
    bootstrap_url: 'http://127.0.0.1:' + startup.address().port,
    args: {
      'enable-automation': false,
      'window-position': '-32000,-32000',
    },
  })
  const first_exited = once(first.proc, 'exit')
  const update_profile_preferences = browser.update_profile_preferences
  const updates = []
  browser.update_profile_preferences = async (filename, preferences) => {
    await update_profile_preferences(filename, preferences)
    updates.push({
      filename,
      preferences,
    })
  }
  let second
  let second_exited
  const call = (name, method = 'Runtime.evaluate', params = {}, target = 'page') => client.call({
    method,
    params: {
      ...params,
      browser: name,
      target,
    },
  })
  try {
    await ready
    await client.call({
      method: 'Runtime.evaluate',
      params: {
        browser: {
          name: 'system-one',
          extensions: Object.freeze(['*', extension]),
          preferences: { 'test.bootstrap': true },
          local_state: { 'test.bootstrap': true },
          args: {
            'user-data-dir': first_profile,
          },
        },
        target: 'page',
        expression: 'window.marker = "one"',
      },
    })
    const record = client.browsers['system-one']
    assert.equal(record.user_data_dir, null, 'reverse mode does not generate a profile directory')
    assert.equal(record.proc, undefined, 'opening a bootstrap link does not claim browser ownership')
    assert.equal(record.extension_id, browser.extension_id(extension))
    assert.equal(record.cdp_ext_install, false)
    assert.deepEqual(record.extensions, ['*', extension], 'wildcard expansion preserves caller options')
    assert.ok(record.opener.spawnargs.includes('--disable-extensions-except=' + extension))
    assert.ok(record.opener.spawnargs.includes('--no-first-run'))
    assert.ok(record.opener.spawnargs.includes('--disable-search-engine-choice-screen'))
    for (const filename of [path.join(first_profile, 'Default', 'Preferences'), path.join(first_profile, 'Local State')]) {
      assert.ok(updates.some(update => update.filename === filename && update.preferences['test.bootstrap'] === true), 'profile updates are independent of extension installation')
    }
    assert.equal(client.reverse_sockets['system-one'], record.socket)
    assert.equal(client.reverse_sockets[record.extension_id], undefined)
    assert.ok(!record.opener.spawnargs.some(arg => /^--(enable-automation|headless|remote-debugging)/.test(arg)))
    if (record.opener.exitCode === null) await util.on_first(record.opener, 'exit', 5000)
    assert.equal(record.opener.exitCode, 0, 'Chrome forwarded the URL to the already running instance')
    assert.equal(first.proc.exitCode, null)
    const url = new URL(record.bootstrap_url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.searchParams.get('browser'), 'system-one')
    assert.equal(url.searchParams.get('websocket_url'), record.reverse_url)
    const stored = await call('system-one', 'chrome.storage.session.get', { args: ['cdp_bootstrap'] }, null)
    assert.equal(stored.cdp_bootstrap.browser, 'system-one')
    assert.equal(stored.cdp_bootstrap.token, record.reverse_token)
    assert.deepEqual(await call('system-one', 'chrome.storage.local.get', { args: ['cdp_bootstrap'] }, null), {})
    const rejected = assert.rejects(client.call({
      method: 'Browser.getVersion',
      params: {
        browser: {
          name: 'spoof',
          cdp_ext: false,
          reverse: true,
          connect_timeout_ms: 100,
        },
      },
    }), /abort/i)
    client.browsers.spoof.reverse_token = 'expected-token'
    assert.equal(await call('system-one', 'chrome.cdp_probe.announce', {
      args: [record.reverse_url, {
        browser: 'spoof',
        extension_id: record.extension_id,
        token: 'wrong-token',
      }],
    }, null), 1008, 'an announcement cannot claim a pending logical name without its token')
    await rejected
    await assert.rejects(client.call({
      method: 'Browser.getVersion',
      params: {
        browser: {
          name: 'alias',
          args: {
            'user-data-dir': first_profile,
          },
        },
      },
    }), /already connected as system-one/)
    assert.equal((await call('system-one', 'Runtime.evaluate', { expression: 'window.marker' })).result.value, 'one')
    await client.call({
      method: 'Runtime.evaluate',
      params: {
        browser: {
          name: 'system-two',
          args: {
            'user-data-dir': path.join(directory, 'second'),
            'disable-extensions-except': [extension],
            'disable-features': ['DisableDisableExtensionsExceptCommandLineSwitch'],
            'no-first-run': true,
            'window-position': '-32000,-32000',
          },
        },
        target: 'page',
        expression: 'window.marker = "two"',
      },
    })
    second = client.browsers['system-two'].opener
    second_exited = once(second, 'exit')
    assert.equal(second.exitCode, null, 'the URL opener starts Chrome when that profile is not running')
    assert.ok(second.spawnargs.includes('--no-first-run'))
    assert.ok(second.spawnargs.includes('--disable-search-engine-choice-screen'))
    assert.equal(client.browsers['system-two'].extension_id, record.extension_id, 'both profiles load the same extension directory')
    assert.notEqual(client.browsers['system-two'].socket, record.socket)
    assert.deepEqual(Object.keys(client.reverse_sockets).sort(), ['system-one', 'system-two'])
    assert.equal((await call('system-two', 'Runtime.evaluate', { expression: 'window.marker' })).result.value, 'two')
    assert.equal((await call('system-one', 'Runtime.evaluate', { expression: 'window.marker' })).result.value, 'one')
    await client.close()
    assert.equal(first.proc.exitCode, null, 'manager close preserves reused Chrome')
    assert.equal(second.exitCode, null, 'manager close preserves Chrome opened through the system-profile path')
  } finally {
    browser.update_profile_preferences = update_profile_preferences
    startup.closeAllConnections()
    await new Promise(resolve => startup.close(resolve))
    second ??= client.browsers['system-two']?.opener
    if (second && !second_exited && second.exitCode === null) second_exited = once(second, 'exit')
    await client.close()
    first.proc.kill()
    await first_exited
    second?.kill()
    await second_exited
  }
})

test('extension installation defaults to the effective directory without opening system Chrome', async () => {
  const directory = await fs.mkdtemp(path.resolve('build/tests/option-combinations-'))
  const launch = browser.launch
  const client = new cdp({
    base_path: directory,
    cdp_ext: true,
    reverse_server: { port: 0 },
    local_state: { 'test.value': 1 },
  })
  let expected_install = false
  let expected_directory = false
  let expected_user_scripts = false
  browser.launch = async options => {
    assert.equal(options.cdp_ext_install, expected_install)
    assert.equal(!!browser.build_args(options)['user-data-dir'], expected_directory)
    assert.equal(options.cdp_ext_user_scripts, expected_user_scripts)
    assert.equal(new URL(options.bootstrap_url).searchParams.has('user_scripts'), options.cdp_ext_user_scripts)
    assert.equal(new URL(options.bootstrap_url).searchParams.get('browser'), options.name)
    throw new Error('Link opening intercepted')
  }
  try {
    await assert.rejects(client.call({ method: 'Browser.getVersion' }), /Link opening intercepted/)
    assert.equal(client.browsers.main.user_data_dir, null)
    assert.equal(client.browsers.main.extension_path, undefined)
    assert.equal(client.server, null)
    await assert.rejects(client.call({
      method: 'Browser.getVersion',
      params: {
        browser: {
          name: 'raw-override',
          user_data_dir: path.resolve('build/tests/not-created'),
          args: { 'user-data-dir': null },
        },
      },
    }), /Link opening intercepted/)
    assert.equal(client.browsers['raw-override'].extension_path, undefined)
    const cases = [
      {
        name: 'custom',
        spec: { user_data_dir: path.join(directory, 'custom') },
        install: true,
      },
      {
        name: 'raw-custom',
        spec: { args: { 'user-data-dir': path.join(directory, 'raw-custom') } },
        install: true,
      },
      {
        name: 'raw-disabled',
        spec: {
          user_data_dir: path.join(directory, 'raw-disabled'),
          args: { 'user-data-dir': false },
        },
        install: false,
      },
      {
        name: 'existing',
        spec: {
          user_data_dir: path.join(directory, 'existing'),
          cdp_ext_install: false,
          update_preferences: true,
        },
        install: false,
      },
      {
        name: 'user-scripts-off',
        spec: {
          user_data_dir: path.join(directory, 'user-scripts-off'),
          cdp_ext_user_scripts: false,
        },
        install: true,
      },
      {
        name: 'no-preferences',
        spec: {
          user_data_dir: path.join(directory, 'no-preferences'),
          cdp_ext_install: true,
          update_preferences: false,
        },
        install: true,
      },
      {
        name: 'system-forced',
        spec: {
          cdp_ext_install: true,
          update_preferences: true,
        },
        install: true,
      },
    ]
    for (const scenario of cases) {
      const user_data_dir = scenario.spec.args?.['user-data-dir'] ?? scenario.spec.user_data_dir
      expected_directory = !!user_data_dir
      expected_install = scenario.install
      expected_user_scripts = expected_install && expected_directory && scenario.spec.cdp_ext_user_scripts !== false
      await assert.rejects(client.call({
        method: 'Browser.getVersion',
        params: {
          browser: {
            name: scenario.name,
            ...scenario.spec,
          },
        },
      }), /Link opening intercepted/)
      const record = client.browsers[scenario.name]
      assert.equal(!!record.extension_path, scenario.install)
      if (record.extension_path) assert.ok(record.extension_path.startsWith(directory))
      if (record.extension_path) {
        const manifest = JSON.parse(await fs.readFile(path.join(record.extension_path, 'manifest.json'), 'utf8'))
        assert.equal(manifest.host_permissions.includes('chrome://extensions/*'), record.cdp_ext_user_scripts)
      }
      const profile = user_data_dir || path.join(directory, scenario.name)
      const preferences = fs.access(path.join(profile, 'Default', 'Preferences'))
      const local_state = fs.access(path.join(profile, 'Local State'))
      if (expected_directory && scenario.spec.update_preferences !== false) await Promise.all([preferences, local_state])
      else await Promise.all([
        assert.rejects(preferences, { code: 'ENOENT' }),
        assert.rejects(local_state, { code: 'ENOENT' }),
      ])
      assert.equal(client.server, null)
    }
    for (const spec of [{ user_data_dir: null }, { user_data_dir: directory, cdp_ext_install: false }]) {
      await assert.rejects(client.call({
        method: 'Browser.getVersion',
        params: {
          browser: {
            name: 'invalid-user-scripts-' + String(spec.cdp_ext_install),
            ...spec,
            cdp_ext_user_scripts: true,
          },
        },
      }), /requires cdp_ext_install and a custom user-data-dir/)
    }
  } finally {
    browser.launch = launch
    await client.close()
  }
})

test('an external reverse wait starts lazily and releases the listener after timeout', async () => {
  const client = new cdp({
    reverse: true,
    reverse_server: { port: 0 },
    connect_timeout_ms: 30,
  })
  assert.equal(client.server, undefined)
  try {
    await assert.rejects(client.call({ method: 'Browser.getVersion' }), /abort/i)
    assert.equal(client.server, null)
    const port = client.reverse_server.port
    assert.ok(port > 0, 'first reverse use allocated a listening port')
    const probe = createServer()
    probe.listen(port, '127.0.0.1')
    await once(probe, 'listening')
    await new Promise(resolve => probe.close(resolve))
    await assert.rejects(client.call({ method: 'Browser.getVersion' }), /abort/i)
    assert.equal(client.reverse_server.port, port, 'restart keeps the endpoint used by extensions')
    assert.equal(client.server, null)
  } finally {
    await client.close()
  }
})
