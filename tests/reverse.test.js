import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { once, getEventListeners } from 'node:events'
import { browser, cdp, util } from '../cdp.js'

Deno.test('reverse extension controls real Chrome without remote-debugging arguments', async () => {
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
  const manifest = JSON.parse(await fs.readFile('cdp_ext/manifest.json', 'utf8'))
  manifest.cdp.websocket_url = 'ws://127.0.0.1:' + server.addr.port
  manifest.cdp.reconnect_ms = 200
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest))
  await fs.copyFile('cdp_ext/cdp_ext.js', path.join(extension, 'cdp_ext.js'))
  const args = util.args_to_strings(browser.build_args({
    headless: true,
    user_data_dir: path.join(directory, 'profile'),
    extensions: [extension],
    args: {
      'remote-debugging-port': false,
    },
  }))
  assert.equal(args.some(value => value.startsWith('--remote-debugging')), false)
  const proc = spawn(browser.find_executable_path(), [...args, 'about:blank'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  const exited = once(proc, 'exit')
  let other_proc
  let other_exited
  const page_server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
  }, () => new Response('<h1>Reverse test</h1><button onclick="this.textContent=\'clicked\'">Click</button>', {
    headers: { 'content-type': 'text/html' },
  }))
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
    assert.equal(targets.targetInfos.filter(info => info.type === 'page').length, 2, 'initial blank tab survives')
    const version = await call('Browser.getVersion', {}, null)
    assert.match(version.product, /Chrome/)
    assert.equal((await call('Runtime.evaluate', { expression: '43' }, {
      name: '__proto__',
      initialize: false,
    })).result.value, 43)
    assert.equal(record.targets.__proto__.sessionId, record.targets.__proto__.targetId)
    assert.equal(record.session_targets[record.targets.__proto__.sessionId], record.targets.__proto__.targetId)

    const network = util.on_first(client, 'Network.requestWillBeSent')
    const loaded = util.on_first(client, 'Page.loadEventFired')
    await call('Page.navigate', { url: 'http://127.0.0.1:' + page_server.addr.port })
    assert.equal((await network).args[0].detail.target, 'page')
    await loaded
    const found = await call('_.find', { xpath: '//h1' })
    assert.equal(found.result.value.items[0].text, 'Reverse test')
    assert.equal((await call('_.click', { xpath: '//button' })).result.value, true)
    assert.equal((await call('Runtime.evaluate', {
      expression: 'document.querySelector("button").textContent',
    })).result.value, 'clicked')

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
    const other_extension = path.join(directory, 'other-extension')
    await fs.mkdir(other_extension)
    await fs.writeFile(path.join(other_extension, 'manifest.json'), JSON.stringify(manifest))
    await fs.copyFile('cdp_ext/cdp_ext.js', path.join(other_extension, 'cdp_ext.js'))
    const other_args = util.args_to_strings(browser.build_args({
      headless: true,
      user_data_dir: path.join(directory, 'other-profile'),
      extensions: [other_extension],
      args: {
        'remote-debugging-port': false,
      },
    }))
    other_proc = spawn(browser.find_executable_path(), [...other_args, 'about:blank'], {
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
    await page_server.shutdown()
    proc.kill()
    await exited
    other_proc?.kill()
    await other_exited
  }
})

Deno.test('managed reverse launch uses extension identity and keeps a live process through disconnects', async () => {
  const directory = await fs.mkdtemp(path.resolve('build/tests/managed-reverse-'))
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
      args: {
        'user-data-dir': path.join(directory, 'pròfile'),
        'profile-directory': 'Profile 1',
      },
    }
    const call = () => client.call({
      method: 'Runtime.evaluate',
      params: {
        browser: spec,
        target: 'page',
        expression: '42',
      },
    })
    const results = await Promise.all([call(), call()])
    assert.deepEqual(results.map(result => result.result.value), [42, 42])
    const record = client.browsers.work
    const server = client.server
    const original = record.proc
    exited = once(original, 'exit')
    const id = record.extension_id
    assert.equal(record.extension_path, await fs.realpath(path.join(directory, 'pròfile', 'Profile 1', 'cdp_ext')))
    assert.equal(client.reverse_sockets[id], record.socket)
    assert.equal(client.reverse_sockets.work, undefined, 'logical name stays in the manager')
    assert.equal(original.spawnargs.some(arg => arg.startsWith('--remote-debugging')), false)
    assert.equal((await fs.readFile(path.join(record.extension_path, 'manifest.json'), 'utf8')).includes('"browser"'), false)
    assert.equal(Object.keys(record.targets).length, 1)
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
  }
})

Deno.test('an external reverse wait starts lazily and releases the listener after timeout', async () => {
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
    const probe = Deno.listen({
      hostname: '127.0.0.1',
      port,
    })
    probe.close()
    await assert.rejects(client.call({ method: 'Browser.getVersion' }), /abort/i)
    assert.equal(client.reverse_server.port, port, 'restart keeps the endpoint used by extensions')
    assert.equal(client.server, null)
  } finally {
    await client.close()
  }
})
