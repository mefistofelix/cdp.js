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
    const targets = await call('Target.getTargets', {}, null)
    assert.equal(targets.targetInfos.some(info => info.targetId === targetId), true)
    assert.equal(targets.targetInfos.filter(info => info.type === 'page').length, 2, 'initial blank tab survives')
    const version = await call('Browser.getVersion', {}, null)
    assert.match(version.product, /Chrome/)

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

    const lost = util.on_first(client, 'close')
    record.socket.close()
    await lost
    const resumed = await call('Runtime.evaluate', { expression: '40 + 2' })
    assert.equal(resumed.result.value, 42)
    assert.equal(record.targets.page.targetId, targetId)
    assert.notEqual(record.targets.page.sessionId, oldSession)
    const reconnectedSession = record.targets.page.sessionId
    record.socket.close()
    assert.equal((await call('Runtime.evaluate', { expression: '42' })).result.value, 42)
    assert.notEqual(record.targets.page.sessionId, reconnectedSession)
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
    manifest.cdp.browser = 'other'
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
        browser: 'other',
        target: 'page',
        expression: 'window.marker = "other"',
      },
    })
    assert.equal(other.result.value, 'other')
    assert.notEqual(record.socket, client.browsers.other.socket)
    assert.equal(Object.keys(client.reverse_sockets).length, 2)
    assert.equal((await call('Runtime.evaluate', { expression: 'typeof window.marker' })).result.value, 'undefined')
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
