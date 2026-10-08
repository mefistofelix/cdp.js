import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import api, { jsrpc, cdp, util, browser } from '../cdp.js'

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
  const client = new cdp({
    base_path,
    headless: true,
    ...options,
  })
  t.after(() => client.close())
  return client
}

test('public exports contain jsrpc, cdp and static utilities', async () => {
  assert.deepEqual(Object.keys(api).sort(), ['browser', 'cdp', 'jsrpc', 'util'])
  assert.equal(api.cdp, cdp)
  assert.equal(api.jsrpc, jsrpc)
  assert.deepEqual(Object.keys(await import('../cdp.js')).sort(), ['browser', 'cdp', 'default', 'jsrpc', 'util'])
})

test('custom methods are ordinary mutable handlers and return their own results', async t => {
  const client = new cdp()
  const other = new cdp()
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
  assert.equal(Object.keys(client.browsers).length, 0, 'local handlers should not launch a browser')
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
  const attached = []
  client.addEventListener('Target.attachedToTarget', event => attached.push(event.detail))
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
  const record = client.browsers.main
  assert.equal(Object.keys(client.browsers).length, 1)
  assert.equal(Object.keys(record.targets).length, 1)
  const tid = record.targets.page.targetId
  assert.equal(attached.find(event => event.targetInfo.targetId === tid).waitingForDebugger, false)
  assert.equal(record.targets.page.binding, '_send_to_cdp')
  assert.deepEqual(record.targets.page.setup_errors, [])
  const pages = (await call(client, 'Target.getTargets', {}, null)).targetInfos.filter(value => value.type === 'page')
  assert.equal(pages.length, 2, 'creating a target must preserve the initial tab')
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

  await call(client, 'Target.detachFromTarget', { sessionId: record.targets.page.sessionId }, null)
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: '42',
    returnByValue: true,
  })).result.value, 42)
  await call(client, 'Target.closeTarget', { targetId: tid }, null)
  await call(client, 'Runtime.evaluate', { expression: '1' })
  assert.notEqual(record.targets.page.targetId, tid)

  const socket = record.socket
  const listeners = getEventListeners(socket, 'close').length
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, value) => call(client, 'Runtime.evaluate', {
    expression: String(value),
    returnByValue: true,
  })))
  assert.deepEqual(concurrent.map(response => response.result.value), Array.from({ length: 20 }, (_, value) => value))
  assert.equal(getEventListeners(socket, 'close').length, listeners)
})

test('browser pause option resumes targets before navigation and allows browser overrides', { timeout: 60000 }, async t => {
  const client = await fixture(t, { waitForDebuggerOnStart: true })
  const attached = []
  const consoleEvents = []
  client.addEventListener('Target.attachedToTarget', event => attached.push(event.detail))
  client.addEventListener('Runtime.consoleAPICalled', event => consoleEvents.push(event.detail))
  const loaded = util.on_first(client, 'Page.loadEventFired')
  await call(client, 'Page.navigate', {
    url: 'data:text/html,<script>window.started = true; console.log("startup")</script>',
  })
  await loaded
  const target = client.browsers.main.targets.page
  assert.equal(attached.find(event => event.targetInfo.targetId === target.targetId).waitingForDebugger, true)
  assert.deepEqual(target.setup_errors, [])
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'window.started',
    returnByValue: true,
  })).result.value, true, 'page scripts must run after setup resumes the target')
  assert.deepEqual(consoleEvents, [], 'bootstrap must disable Runtime before page scripts run')

  const reported = util.on_first(client, 'Runtime.consoleAPICalled')
  await call(client, 'Page.navigate', {
    url: 'data:text/html,<script>console.log("startup")</script>',
  }, {
    name: 'reporting',
    runtime: true,
  })
  assert.equal((await reported).args[0].detail.args[0].value, 'startup')

  await call(client, 'Runtime.evaluate', { expression: '1' }, 'page', {
    name: 'unpaused',
    waitForDebuggerOnStart: false,
  })
  const unpaused = client.browsers.unpaused.targets.page
  assert.equal(attached.find(event => event.targetInfo.targetId === unpaused.targetId).waitingForDebugger, false)
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
  const record = client.browsers.main
  const tid = record.targets.page.targetId
  assert.equal(record.targets.page.binding, 'send_to_host')
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'typeof _send_to_cdp',
    returnByValue: true,
  })).result.value, 'undefined')
  const closed = util.on_first(record.socket, 'close')
  const disconnected = util.on_first(client, 'close')
  record.socket.close()
  await closed
  assert.equal((await disconnected).args[0].detail.browser, 'main')
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: '21 * 2',
    returnByValue: true,
  })).result.value, 42)
  assert.equal(record.targets.page.targetId, tid)
  await call(client, 'Runtime.evaluate', { expression: 'send_to_host("reconnected")' })
  assert.equal(bindings.at(-1).payload, 'reconnected')
  assert.equal(bindings.at(-1).name, record.targets.page.binding)
  const sessionId = record.targets.page.sessionId
  record.socket.close()
  await call(client, 'Runtime.evaluate', { expression: 'send_to_host("immediate reconnect")' })
  assert.equal(bindings.at(-1).payload, 'immediate reconnect')
  assert.equal(record.targets.page.targetId, tid)
  assert.notEqual(record.targets.page.sessionId, sessionId)
  await call(client, 'Target.closeTarget', { targetId: tid }, null)
  await call(client, 'Runtime.evaluate', { expression: 'send_to_host("recreated")' })
  assert.equal(bindings.at(-1).payload, 'recreated')
  assert.equal(bindings.at(-1).name, 'send_to_host')
})

test('browser labels isolate profiles; target initialization flags and public records', { timeout: 60000 }, async t => {
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
  assert.notEqual(client.browsers.main.socket.url, client.browsers.other.socket.url)
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: 'typeof _send_to_cdp',
    returnByValue: true,
  })).result.value, 'undefined')
  client.browsers.main.targets.page.binding = 'changed_binding'
  assert.equal(client.browsers.main.targets.page.binding, 'changed_binding')

})

test('raw jsrpc and existing browser attachment via WS, HTTP and port', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  const disabled = await call(client, 'Runtime.evaluate', {
    expression: 'typeof _send_to_cdp',
    returnByValue: true,
  }, {
    name: 'page',
    runtime: false,
    binding: false,
  })
  assert.equal(disabled.result.value, 'undefined')
  const record = client.browsers.main
  const target = record.targets.page
  assert.equal(target.binding, false)
  assert.equal(Object.getPrototypeOf(target), Object.prototype)
  assert.equal(target.call, undefined)
  assert.equal(record.session_targets[target.sessionId], target.targetId)
  assert.equal(record.target_info[target.targetId].sessionId, target.sessionId)
  assert.equal((await call(client, 'Runtime.evaluate', {
    expression: '6 * 7',
    returnByValue: true,
  })).result.value, 42)

  const owner = record.socket
  const url = new URL(owner.url)
  for (const options of [
    { websocket_url: owner.url },
    { http_url: 'http://127.0.0.1:' + url.port },
    { http_url: 'http://127.0.0.1:' + url.port + '/json/version' },
    { port: Number(url.port) },
  ]) {
    const attached = new cdp()
    t.after(() => attached.close())
    const result = await call(attached, 'Browser.getVersion', {}, null, {
      name: 'remote',
      ...options,
    })
    assert.ok(result.product)
    await attached.close()
    assert.ok((await owner.req({ method: 'Browser.getVersion' })).product, 'disconnecting must preserve the browser')
  }
  const raw = new jsrpc(owner.url)
  t.after(() => raw.close())
  await util.on_first(raw, 'open')
  assert.ok((await raw.req({ method: 'Browser.getVersion' })).product)
  const closed = util.on_first(raw, 'close')
  raw.close()
  await closed
})

test('timeouts, disconnects and launch failures reject without hanging or replay', { timeout: 60000 }, async t => {
  const client = await fixture(t)
  await call(client, 'Runtime.evaluate', { expression: '1' })
  const socket = client.browsers.main.socket
  const closeListeners = getEventListeners(socket, 'close').length
  const errorListeners = getEventListeners(socket, 'error').length
  const target = client.browsers.main.targets.page
  const sessionId = target.sessionId
  const timed = socket.req({
    method: 'Runtime.evaluate',
    params: {
      expression: 'new Promise(() => {})',
      awaitPromise: true,
    },
    sessionId,
  }, 40)
  await assert.rejects(timed, { name: 'AbortError' })
  assert.equal(Object.keys(socket.pending).length, 0)
  assert.equal(getEventListeners(socket, 'close').length, closeListeners)
  assert.equal(getEventListeners(socket, 'error').length, errorListeners)
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
  assert.equal(Object.keys(socket.pending).length, 0)
  assert.equal(getEventListeners(socket, 'close').length, closeListeners)
  assert.equal(getEventListeners(socket, 'error').length, errorListeners)
  await assert.rejects(call(client, 'Browser.getVersion', {}, null, {
    name: 'missing',
    executable_path: path.join(build, 'missing-browser'),
    user_data_dir: path.join(build, 'invalid'),
  }), /ENOENT/)

})

test('CLI options remain editable key/value objects until argv materialization', () => {
  const args = browser.build_args({
    user_data_dir: 'profile with spaces',
    headless: true,
    extensions: true,
    images: false,
    translations: true,
    login: true,
    args: {
      'mute-audio': false,
      'window-size': '800,600',
      'custom-switch': 'value with spaces',
      'custom-list': ['first', 'second'],
    },
  })
  assert.equal(args.headless, 'new')
  assert.equal(args['disable-extensions'], undefined)
  assert.equal(args['disable-component-extensions-with-background-pages'], undefined)
  assert.equal(args['disable-sync'], undefined)
  assert.equal(args['blink-settings'], 'imagesEnabled=false')
  assert.ok(!args['disable-features'].includes('Translate'))
  assert.ok(!args['disable-features'].includes('DiceWebSigninInterception'))
  delete args['custom-switch']
  args['new-switch'] = true
  const argv = util.args_to_strings(args)
  assert.ok(argv.includes('--user-data-dir=profile with spaces'))
  assert.ok(argv.includes('--window-size=800,600'))
  assert.ok(argv.includes('--new-switch'))
  assert.ok(argv.includes('--custom-list=first,second'))
  assert.ok(!argv.includes('--mute-audio'))
  assert.ok(!argv.some(arg => arg.startsWith('--custom-switch')))
  assert.equal(argv.filter(arg => arg.startsWith('--window-size=')).length, 1)
  assert.ok(Object.keys(args).every(key => !key.startsWith('--')))
  assert.ok(!util.args_to_strings(browser.build_args({ user_data_dir: null }))
    .some(arg => arg.startsWith('--user-data-dir')))
})

test('manager without a user-data directory skips preference writes', async t => {
  const client = await fixture(t, {
    user_data_dir: null,
    executable_path: path.join(build, 'missing-browser'),
    preferences: {
      'custom.value': true,
    },
    local_state: {
      'devtools.remote_debugging.user-enabled': true,
    },
  })
  await assert.rejects(call(client, 'Browser.getVersion', {}, null), /ENOENT/)
})

test('extension options cascade through raw arguments without mutating inputs', () => {
  const feature = 'DisableDisableExtensionsExceptCommandLineSwitch'
  const extensions = Object.freeze(['*', '/local/dev'])
  const features = Object.freeze(['CustomFeature'])
  const args = browser.build_args({
    extensions,
    args: {
      'disable-features': features,
    },
  })
  assert.deepEqual(args['disable-extensions-except'], extensions)
  assert.deepEqual(args['disable-features'], ['CustomFeature', feature])
  assert.equal(args['disable-extensions'], undefined)
  assert.deepEqual(features, ['CustomFeature'])
  const overridden = browser.build_args({
    extensions,
    args: {
      'disable-extensions-except': false,
    },
  })
  assert.equal(overridden['disable-extensions-except'], false)
  assert.ok(!overridden['disable-features'].includes(feature))
  const raw = browser.build_args({
    extensions: false,
    args: {
      'disable-extensions-except': '*,/other/dev',
      'disable-features': 'CustomFeature,' + feature,
    },
  })
  assert.deepEqual(raw['disable-extensions-except'], ['*', '/other/dev'])
  assert.deepEqual(raw['disable-features'], ['CustomFeature', feature])
  assert.equal(raw['disable-extensions'], true)
})

test('profile extension discovery uses current records and preserves preference files', async () => {
  const directory = await fs.mkdtemp(path.join(build, 'extension-paths-'))
  const profile = path.join(directory, 'Profile 1')
  const preferences = path.join(profile, 'Preferences')
  const secure = path.join(profile, 'Secure Preferences')
  await browser.update_profile_preferences(preferences, {
    'extensions.settings.installed': {
      location: 1,
      path: 'installed/1.0_0',
    },
  })
  await browser.update_profile_preferences(secure, {
    'extensions.settings.installed': {
      location: 1,
      path: 'installed/2.0_0',
    },
    'extensions.settings.unpacked': {
      location: 4,
      path: directory,
      disable_reasons: [],
    },
    'extensions.settings.disabled': {
      location: 4,
      path: '/disabled',
      disable_reasons: [1],
    },
    'extensions.settings.legacy_disabled': {
      location: 4,
      path: '/legacy-disabled',
      state: 0,
    },
    'extensions.settings.legacy_reasons': {
      location: 4,
      path: '/legacy-reasons',
      disable_reasons: 1,
    },
    'extensions.settings.component': {
      location: 5,
      path: '/internal/component',
    },
  })
  const before = await fs.readFile(secure, 'utf8')
  const args = {
    'user-data-dir': directory,
    'profile-directory': 'Profile 1',
  }
  assert.deepEqual(await browser.profile_extension_paths(args), [
    path.join(profile, 'Extensions', 'installed/2.0_0'),
    directory,
  ])
  assert.equal(await fs.readFile(secure, 'utf8'), before)
  assert.deepEqual(await browser.profile_extension_paths({ 'user-data-dir': directory }), [])
  await assert.rejects(browser.profile_extension_paths({}), /requires user-data-dir/)
  await fs.writeFile(secure, '{invalid')
  await assert.rejects(browser.profile_extension_paths(args), SyntaxError)
})

test('local extensions and profile wildcard load during browser startup', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(build, 'startup-extensions-'))
  const profile = path.join(directory, 'Profile 1')
  const installed = path.join(profile, 'Extensions', 'example', '2.0_0')
  const old_version = path.join(profile, 'Extensions', 'example', '1.0_0')
  const local = path.join(directory, 'local-dev')
  const disabled = path.join(directory, 'disabled')
  for (const [folder, name] of [[installed, 'Installed example'], [old_version, 'Old example'], [local, 'Local example'], [disabled, 'Disabled example']]) {
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name,
      version: '1.0',
    }))
  }
  await browser.update_profile_preferences(path.join(profile, 'Preferences'), {
    'extensions.settings.example': {
      location: 1,
      path: 'example/2.0_0',
    },
    'extensions.settings.disabled': {
      location: 4,
      path: disabled,
      disable_reasons: [1],
    },
  })
  const client = await fixture(t, {
    extensions: Object.freeze(['*', local]),
    args: {
      'user-data-dir': directory,
      'profile-directory': 'Profile 1',
      'enable-unsafe-extension-debugging': true,
      'disable-features': Object.freeze(['CustomFeature']),
    },
  })
  const result = await call(client, 'Extensions.getExtensions', {}, null)
  assert.deepEqual(result.extensions.map(extension => extension.name).sort(), ['Installed example', 'Local example'])
  assert.ok(result.extensions.every(extension => extension.enabled))
  const command = await call(client, 'Browser.getBrowserCommandLine', {}, null)
  assert.ok(command.arguments.includes('--disable-extensions-except=' + [installed, local].join(',')))
  assert.ok(command.arguments.includes('--disable-features=CustomFeature,DisableDisableExtensionsExceptCommandLineSwitch'))
  assert.deepEqual(client.options.extensions, ['*', local])
  for (const selector of [local, false]) {
    const overridden = await fixture(t, {
      extensions: ['*', installed],
      args: {
        'disable-extensions-except': selector,
        'enable-unsafe-extension-debugging': true,
      },
    })
    const loaded = await call(overridden, 'Extensions.getExtensions', {}, null)
    assert.deepEqual(loaded.extensions.map(extension => extension.name), selector ? ['Local example'] : [])
  }
})

test('standalone launch and manager opt-out leave configured preferences unchanged', async t => {
  for (const managed of [false, true]) {
    const directory = await fs.mkdtemp(path.join(build, 'unchanged-'))
    const filename = path.join(directory, 'Default', 'Preferences')
    await browser.update_profile_preferences(filename, {
      'custom.keep': 42,
      'translate.enabled': true,
    })
    const state_filename = path.join(directory, 'Local State')
    await browser.update_profile_preferences(state_filename, {
      'custom.keep': 42,
    })
    const options = {
      user_data_dir: directory,
      headless: true,
      update_preferences: false,
      preferences: {
        'custom.keep': false,
      },
      local_state: {
        'custom.marker': true,
      },
    }
    if (managed) {
      const client = await fixture(t, options)
      await call(client, 'Browser.getVersion', {}, null)
    } else {
      const launched = await browser.launch(options)
      t.after(() => launched.proc.kill())
    }
    const prefs = JSON.parse(await fs.readFile(filename, 'utf8'))
    assert.equal(prefs.custom.keep, 42)
    assert.equal(prefs.translate.enabled, true)
    const state = JSON.parse(await fs.readFile(state_filename, 'utf8'))
    assert.deepEqual(state.custom, { keep: 42 })
  }
})

test('generic preferences update nested keys, preserve siblings and accept overrides', async () => {
  const directory = await fs.mkdtemp(path.join(build, 'preferences-'))
  const filename = path.join(directory, 'Default', 'Preferences')
  await browser.update_profile_preferences(filename, {
    'translate.enabled': true,
    'translate.other': 42,
    'custom.keep': 'value',
  })
  const preferences = {
    'translate.enabled': true,
    'signin.allowed': false,
    'signin.allowed_on_next_startup': false,
    'custom.new': ['one', 'two'],
  }
  assert.equal(preferences['translate.enabled'], true)
  assert.equal(preferences['signin.allowed'], false)
  await browser.update_profile_preferences(filename, preferences)
  const result = JSON.parse(await fs.readFile(filename, 'utf8'))
  assert.deepEqual(result.translate, {
    enabled: true,
    other: 42,
  })
  assert.deepEqual(result.custom, {
    keep: 'value',
    new: ['one', 'two'],
  })
  assert.equal(result.signin.allowed, false)
  assert.equal(result.signin.allowed_on_next_startup, false)
})

test('browser options reach actual Chrome arguments and translation/login preferences', { timeout: 60000 }, async t => {
  const client = await fixture(t, {
    extensions: false,
    images: false,
    translations: false,
    login: false,
  })
  for (const enabled of [false, true]) {
    const browser = {
      name: enabled ? 'enabled' : 'disabled',
      extensions: enabled,
      images: enabled,
      translations: enabled,
      login: enabled,
    }
    await call(client, 'Page.navigate', { url: 'chrome://settings/' }, 'settings', browser)
    const command = await call(client, 'Browser.getBrowserCommandLine', {}, null, browser.name)
    assert.ok(command.arguments.includes('--headless=new'))
    assert.equal(command.arguments.includes('--disable-extensions'), !enabled)
    assert.equal(command.arguments.includes('--disable-sync'), !enabled)
    assert.equal(command.arguments.includes('--blink-settings=imagesEnabled=false'), !enabled)
    const result = await call(client, 'Runtime.evaluate', {
      expression: `new Promise(resolve => {
        const timer = setInterval(async () => {
          if (!globalThis.chrome?.settingsPrivate) return
          clearInterval(timer)
          const prefs = await Promise.all(['translate.enabled', 'signin.allowed_on_next_startup'].map(key =>
            new Promise(done => chrome.settingsPrivate.getPref(key, pref => done(pref.value)))
          ))
          resolve(prefs)
        }, 20)
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, 'settings', browser.name)
    assert.deepEqual(result.result.value, [enabled, enabled])
  }
})

test('Local State settings merge, preserve existing values and control the inspect checkbox', { timeout: 60000 }, async t => {
  const client = await fixture(t, {
    local_state: {
      'devtools.remote_debugging.user-enabled': true,
      'custom.from_defaults': 42,
    },
  })
  for (const enabled of [false, true]) {
    const directory = await fs.mkdtemp(path.join(build, 'local-state-'))
    const filename = path.join(directory, 'Local State')
    await browser.update_profile_preferences(filename, {
      'custom.keep': 'existing',
    })
    const spec = {
      name: enabled ? 'enabled' : 'disabled',
      args: {
        'user-data-dir': directory,
        'profile-directory': 'Profile 1',
      },
      local_state: {
        'devtools.remote_debugging.user-enabled': enabled,
        'custom.from_browser': enabled,
      },
    }
    await call(client, 'Page.navigate', { url: 'chrome://inspect/#remote-debugging' }, 'inspect', spec)
    const result = await call(client, 'Runtime.evaluate', {
      expression: `new Promise(resolve => {
        const timer = setInterval(() => {
          const checkbox = document.querySelector('#remote-debugging-enabled')
          if (!checkbox || checkbox.disabled) return
          clearInterval(timer)
          resolve(checkbox.checked)
        }, 20)
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, 'inspect', spec.name)
    assert.equal(result.result.value, enabled)
    const state = JSON.parse(await fs.readFile(filename, 'utf8'))
    assert.equal(state.devtools.remote_debugging['user-enabled'], enabled)
    assert.deepEqual(state.custom, {
      keep: 'existing',
      from_defaults: 42,
      from_browser: enabled,
    })
    await fs.access(path.join(directory, 'Profile 1', 'Preferences'))
  }
})
