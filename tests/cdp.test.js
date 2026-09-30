import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { CDP, connect, launch, xpx } from '../cdp.js'

const build = path.resolve('build/tests')
await fs.mkdir(build, { recursive: true })

function call(client, method, params = {}, target = 'page', browser = 'main') {
  return client.call({
    method,
    params: {
      ...params,
      target,
      browser,
    },
  })
}

async function fixture(t, options = {}) {
  const base_path = await fs.mkdtemp(path.join(build, 'run-'))
  const client = new CDP({
    base_path,
    headless: true,
    ...options,
  })
  t.after(() => client.close())
  return client
}

test('XPath extensions quote strings and compare case-insensitively', () => {
  assert.match(xpx('//a[ends-with(@href,".pdf")]'), /substring/)
  assert.match(xpx('//a[icontains(@title,"HELLO")]'), /translate\("HELLO"/)
})

test('custom methods are ordinary mutable handlers and return their own results', async t => {
  const client = new CDP()
  const other = new CDP()
  t.after(() => client.close())
  t.after(() => other.close())
  const params = Object.freeze({ value: 21 })
  client.custom_methods['_.double'] = function (received) {
    assert.equal(this, client)
    assert.equal(received, params)
    return received.value * 2
  }
  assert.equal(await client.call({
    method: '_.double',
    params,
  }), 42)
  assert.equal(client.browsers.size, 0, 'local handlers should not launch a browser')
  await assert.rejects(other.call({ method: '_.double' }), /Unknown CDP extension/)

  client.custom_methods['_.find'] = async function (received) {
    return { custom: received.value }
  }
  assert.deepEqual(await client.call({
    method: '_.find',
    params,
  }), { custom: 21 })
  assert.notEqual(client.custom_methods['_.find'], other.custom_methods['_.find'])
  delete client.custom_methods['_.find']
  await assert.rejects(client.call({ method: '_.find' }), /Unknown CDP extension/)

  const failure = new Error('custom handler failed')
  client.custom_methods = {
    '_.fail'() {
      throw failure
    },
  }
  await assert.rejects(client.call({ method: '_.fail' }), error => error === failure)
  await assert.rejects(client.call({ method: '_.double' }), /Unknown CDP extension/)
})

test('structured calls return native results; concurrent calls reuse one page', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  const target = {
    name: 'page',
    runtime: true,
  }
  const results = await Promise.all([
    call(client, 'Runtime.evaluate', {
      expression: '1 + 1',
      returnByValue: true,
    }, target),
    call(client, 'Runtime.evaluate', {
      expression: '2 + 2',
      returnByValue: true,
    }),
  ])
  assert.deepEqual(results.map(value => value.result.value), [2, 4])
  const record = client.browsers.get('main')
  assert.equal(client.browsers.size, 1)
  assert.equal(record.targets.size, 1)
  const tid = record.targets.get('page').tid
  assert.equal(record.targets.get('page').options.binding, '_send_to_cdp')
  assert.deepEqual(record.socket.pages.get(tid).setup_errors, [])
  const pages = (await call(client, 'Target.getTargets', {}, null)).targetInfos.filter(value => value.type === 'page')
  assert.equal(pages.length, 1, 'owned startup blank should close')
  await assert.rejects(call(client, 'NoSuchDomain.noSuchMethod'), error => {
    assert.ok(error.cdp.error.code)
    assert.equal(error.cause.req.method, 'NoSuchDomain.noSuchMethod')
    return true
  })
  const inputs = Object.freeze({
    browser: 'main',
    target: 'page',
    expression: '7',
    returnByValue: true,
  })
  assert.equal((await client.call({
    method: 'Runtime.evaluate',
    params: inputs,
  })).result.value, 7)
  assert.equal(inputs.browser, 'main')
  assert.equal(inputs.target, 'page')
  assert.ok((await call(client, 'Runtime.evaluate', { expression: 'throw new Error("page error")' })).exceptionDetails)

  await call(client, 'Target.detachFromTarget', { sessionId: record.socket.pages.get(tid).sid }, null)
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: '42',
    returnByValue: true,
  })).result.value, 42)
  await call(client, 'Target.closeTarget', { targetId: tid }, null)
  await call(client, 'Runtime.evaluate', { expression: '1' })
  assert.notEqual(record.targets.get('page').tid, tid)
})

test('custom click/find route through Runtime.evaluate, with no separate image helpers', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  await call(client, 'Runtime.evaluate', {
    expression: `
      document.body.innerHTML = '<button id="quoted" title="say &quot;Hello&quot;">Click me</button><a href="/test.pdf">PDF</a>';
      document.querySelector('button').onclick = () => window.clicks = (window.clicks || 0) + 1;
    `,
  })
  const find = await call(client, '_.find', { xpath: '//button[@title=\'say "Hello"\']' })
  assert.equal(find.result.value.count, 1)
  assert.equal(find.result.value.items[0].tag, 'button')
  assert.equal((await call(client, '_.click', { xpath: '//button[icontains(@title,\'HELLO\')]' })).result.value, true)
  assert.equal((await call(client, '_.find', { xpath: '//a[ends-with(@href,\'.pdf\')]' })).result.value.count, 1)
  assert.equal((await call(client, '_.click', {
    xpath: '//missing',
    attempts: 1,
    interval_ms: 0,
  })).result.value, false)
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'window.clicks',
    returnByValue: true,
  })).result.value, 1)
  assert.equal((await call(client, '_.find', { xpath: '//button/text()' })).result.value.items[0].node_type, 3)
  await assert.rejects(call(client, '_.find', { xpath: '//button' }, null), /requires target/)
  await assert.rejects(call(client, '_.screenshot'), /Unknown CDP extension/)
  await assert.rejects(call(client, '_.click', {
    xpath: '//button',
    attempts: 0,
  }), /attempts/)

  client.custom_methods['_.answer'] = function (params) {
    return this.call({
      method: 'Runtime.evaluate',
      params: {
        ...params,
        expression: '6 * 7',
        returnByValue: true,
      },
    })
  }
  assert.equal((await call(client, '_.answer')).result.value, 42)

  const record = client.browsers.get('main')
  const page = record.socket.pages.get(record.targets.get('page').tid)
  assert.equal((await page.call({
    method: '_.find',
    params: { xpath: '//button' },
  })).result.value.count, 1)
  page.custom_methods['_.find'] = function (params) {
    assert.equal(this, page)
    return params.xpath
  }
  assert.equal(await page.call({
    method: '_.find',
    params: { xpath: '//custom' },
  }), '//custom')
  delete page.custom_methods['_.find']
  await assert.rejects(page.call({ method: '_.find' }), /Unknown CDP extension/)
  assert.equal((await call(client, '_.find', { xpath: '//button' })).result.value.count, 1)
})

test('direct events carry labels; reconnect retains only in-memory target routing', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  await call(client, 'Runtime.enable', {}, {
    name: 'page',
    runtime: true,
    binding: 'send_to_host',
  })
  const notifications = []
  const bindings = []
  client.addEventListener('notify', event => notifications.push(event.detail))
  client.addEventListener('Runtime.bindingCalled', event => bindings.push(event.detail))
  await call(client, 'Runtime.evaluate', { expression: 'console.log("first"); console.log("second"); send_to_host("payload")' })
  assert.deepEqual(
    notifications
      .filter(value => value.method === 'Runtime.consoleAPICalled')
      .map(value => value.params.args[0].value),
    ['first', 'second'],
  )
  assert.equal(bindings[0].payload, 'payload')
  assert.equal(bindings[0].name, 'send_to_host')
  assert.equal(bindings[0].browser, 'main')
  assert.equal(bindings[0].target, 'page')
  const record = client.browsers.get('main')
  const tid = record.targets.get('page').tid
  assert.equal(record.targets.get('page').options.binding, 'send_to_host')
  assert.equal(record.socket.pages.get(tid).options.binding, 'send_to_host')
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'typeof _send_to_cdp',
    returnByValue: true,
  })).result.value, 'undefined')
  const closed = record.socket.on_first('close')
  record.socket.close()
  await closed
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: '21 * 2',
    returnByValue: true,
  })).result.value, 42)
  assert.equal(record.targets.get('page').tid, tid)
  await call(client, 'Runtime.evaluate', { expression: 'send_to_host("reconnected")' })
  assert.equal(bindings.at(-1).payload, 'reconnected')
  assert.equal(bindings.at(-1).name, record.targets.get('page').options.binding)
  await call(client, 'Target.closeTarget', { targetId: tid }, null)
  await call(client, 'Runtime.evaluate', { expression: 'send_to_host("recreated")' })
  assert.equal(bindings.at(-1).payload, 'recreated')
  assert.equal(bindings.at(-1).name, 'send_to_host')
})

test('browser labels isolate profiles; initialization flags and option conflicts', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  await Promise.all([
    call(client, 'Runtime.evaluate', { expression: 'window.marker = "main"' }, {
      name: 'page',
      initialize: false,
    }),
    call(client, 'Runtime.evaluate', { expression: 'window.marker = "other"' }, 'page', 'other'),
  ])
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'window.marker',
    returnByValue: true,
  })).result.value, 'main')
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'window.marker',
    returnByValue: true,
  }, 'page', 'other')).result.value, 'other')
  assert.notEqual(client.browsers.get('main').socket.url, client.browsers.get('other').socket.url)
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'typeof _send_to_cdp',
    returnByValue: true,
  })).result.value, 'undefined')
  await assert.rejects(call(client, 'Runtime.evaluate', {}, {
    name: 'page',
    initialize: true,
  }), /different options/)
  await assert.rejects(call(client, 'Browser.getVersion', {}, null, {
    name: 'main',
    headless: false,
  }), /different options/)
  await assert.rejects(call(client, 'Browser.getVersion', {}, null, {
    name: 'collision',
    user_data_dir: client.browsers.get('main').options.user_data_dir,
  }), /already in use/)
})

test('low-level API and existing browser attachment via WS, HTTP and port', { timeout: 60000 }, async t => {
  const user_data_dir = await fs.mkdtemp(path.join(build, 'attach-'))
  const [proc, owner] = await launch({
    headless: true,
    user_data_dir,
  })
  t.after(async () => {
    if (owner.readyState === WebSocket.OPEN) await owner.call({ method: 'Browser.close' })
    owner.close()
    if (proc.exitCode === null && proc.signalCode === null) proc.kill()
  })
  const page = await owner.createTarget({
    runtime: false,
    binding: false,
  })
  assert.equal(page.options.binding, false)
  assert.equal((await page.call({
    method: 'Runtime.evaluate',
    params: {
      expression: 'typeof _send_to_cdp',
      returnByValue: true,
    },
  })).result.value, 'undefined')
  assert.equal((await page.call({
    method: 'Runtime.evaluate',
    params: {
      expression: '6 * 7',
      returnByValue: true,
    },
  })).result.value, 42)
  const url = new URL(owner.url)
  for (const options of [{ websocket_url: owner.url }, { http_url: `http://127.0.0.1:${url.port}` }, { port: Number(url.port) }]) {
    const attached = new CDP()
    const result = await call(attached, 'Browser.getVersion', {}, null, {
      name: 'remote',
      ...options,
    })
    assert.ok(result.product)
    await attached.close()
    assert.ok((await owner.call({ method: 'Browser.getVersion' })).product, 'closing an attached client must preserve the browser')
  }
  const attached = await connect(`http://127.0.0.1:${url.port}/json/version`)
  attached.close()
})

test('timeouts, disconnects and launch failures reject without hanging or replay', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  await call(client, 'Runtime.evaluate', { expression: '1' })
  const socket = client.browsers.get('main').socket
  const page = client.browsers.get('main').targets.get('page')
  const sessionId = socket.pages.get(page.tid).sid
  const timed = socket.request({
    method: 'Runtime.evaluate',
    params: {
      expression: 'new Promise(() => {})',
      awaitPromise: true,
    },
    sessionId,
  }, { timeout_ms: 40 })
  await assert.rejects(timed.promise, /execution outcome is unknown/)
  assert.equal(socket.pending.size, 0)
  const slow = socket.req({
    method: 'Runtime.evaluate',
    params: {
      expression: 'new Promise(() => {})',
      awaitPromise: true,
    },
    sessionId,
  })
  const rejected = assert.rejects(slow, /connection closed/)
  socket.close()
  await rejected
  assert.equal(socket.pending.size, 0)
  await assert.rejects(launch({
    executable_path: path.join(build, 'missing-browser'),
    user_data_dir: path.join(build, 'invalid'),
  }), /ENOENT/)
  await assert.rejects(launch({ args: ['--remote-debugging-port=1234'] }), /managed/)
  await assert.rejects(call(client, 'Browser.getVersion', {}, null, '../unsafe'), /directory label/)
})
