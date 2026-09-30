# cdp.js

Low-level Chromium DevTools Protocol library. Node.js 22.19+, Chrome/Chromium/Edge,
and no npm dependencies. The original reference implementations and unused
`x.js` utilities are in `extra/`.

## Calls

Each call sends one operation. Native methods use `{method, params}`; small local
helpers use the reserved `_.` namespace. Results are native CDP `result` objects;
protocol errors reject with the raw response in `error.cdp` and request/response
in `error.cause`. JavaScript exceptions from `Runtime.evaluate` retain their
native `exceptionDetails` representation.

```js
import { CDP } from './cdp.js'

const cdp = new CDP({
  base_path: './profiles',
  headless: true,
})
try {
  await cdp.call({
    method: 'Page.navigate',
    params: {
      browser: 'main',
      target: 'page',
      url: 'https://example.com',
    },
  })
  const found = await cdp.call({
    method: '_.find',
    params: {
      target: 'page',
      xpath: '//a',
      limit: 10,
    },
  })
  console.log(found.result.value)
} finally {
  await cdp.close()
}
```

`params.browser` and `params.target` select routing; they are extracted before
the remaining parameters are sent to Chrome. The caller's object is not mutated.
Browser defaults to `main`; omitting `target` sends a browser-level command. Named browsers/pages are created
on first use and reused. Concurrent calls share connection and page creation.
Await dependent commands yourself, including any navigation readiness you need.

| Custom method | Parameters | Native Runtime result |
| --- | --- | --- |
| `_.click` | `xpath`, `attempts` (1–20, default 5), `interval_ms` (0–5000, default 300) | Remote boolean in `result.value` |
| `_.find` | `xpath`, `limit` (1–100, default 20) | `{count, items}` in `result.value`; element/text metadata and rectangles |

Both require a page target and translate to `Runtime.evaluate`. XPath accepts
the original `ends-with()` and `icontains()` rewrites, with ASCII case folding on
both `icontains()` operands. These simple rewrites are not a full XPath 2 parser.

`cdp.custom_methods` and `page.custom_methods` are ordinary public objects keyed
by the full method name. Assign, replace or delete entries directly:

```js
cdp.custom_methods['_.title'] = function (params) {
  return this.call({
    method: 'Runtime.evaluate',
    params: {
      ...params,
      expression: 'document.title',
      returnByValue: true,
    },
  })

cdp.custom_methods['_.find'] = async function (params) {
  return { xpath: params.xpath }
}

delete cdp.custom_methods['_.click']
```

Handlers receive the original `params` and have `this` bound to the caller
(`CDP` or page). Their return value or promise becomes the call result; thrown
errors propagate unchanged. Custom handlers can run local code or call native
CDP methods, and do not need a target unless their own implementation requires
one. Dispatch happens before browser launch or page creation.

Each instance starts with its own shallow copy of the exported `custom_methods`
object containing `_.click` and `_.find`. The object can also be replaced
entirely. Changing the exported defaults affects subsequently created instances.

## Explicit browser/page API

The lower-level API exposes browser and page sessions directly, with the same
operation shape and return semantics:

```js
import { launch, connect } from './cdp.js'

const [process, browser] = await launch({
  user_data_dir: './profile',
  headless: true,
})
try {
  const page = await browser.createTarget({ runtime: true })
  await page.call({
    method: 'Page.navigate',
    params: { url: 'https://example.com' },
  })
  const value = await page.call({
    method: 'Runtime.evaluate',
    params: {
      expression: 'document.title',
      returnByValue: true,
    },
  })
  console.log(value.result.value)
} finally {
  await browser.call({ method: 'Browser.close' })
  browser.close()
}

// Attach without launching a process:
const existing = await connect({
  port: 9222,
  host: '127.0.0.1',
})
existing.close() // Disconnects the WebSocket.
```

`connect()` also accepts a browser-level WebSocket URL, an HTTP(S) discovery base
URL or exact `/json/version` URL. `attachTarget(targetId, options)` attaches to an
existing page. `wscdp` and `wsjrpc` remain available for raw session requests.
`wsjrpc.req({method, params, sessionId})` returns the protocol result.

The default export retains `launch`, `connect`, `wscdp`, `wsjrpc`, `CDP`, and
`custom_methods`.
`launch(profile, executable)` still returns `[process, browser]`. Migrate old
`call(method, params)` to `call({method, params})`, and `page.click()` to
`page.call({method:'_.click', params:{xpath:...}})`.

## Options

Browser/target strings are shorthand for `{name: 'label'}`. The manager remembers
options by name. Conflicting changes to a live or opening resource reject;
close it first or select another name.

| Browser option | Behavior |
| --- | --- |
| `headless` | Default false |
| `executable_path` | Explicit Chromium executable; automatic discovery otherwise |
| `user_data_dir` | Profile path; manager default is `<base_path>/<name>`, base path defaults to `.cdp` |
| `extensions`, `images` | Browser loading settings, defaults false and true |
| `args` | Extra argv; matching switches replace defaults |
| `websocket_url` | Attach directly to a browser-level WS(S) endpoint |
| `http_url` | Attach through HTTP(S) discovery |
| `port`, `host` | Attach to an existing debugging port; host defaults to `127.0.0.1` |
| `connect_timeout_ms` | Connection/launch deadline; default 15000 |
| `request_timeout_ms` | Per-command deadline; default 30000 |

Only one endpoint can be supplied. Attachment cannot be combined with explicit
local launch options. Constructor options provide browser defaults.
`CDP_BROWSER` (or `MRMCP_CDP_BROWSER`) overrides executable discovery.
Managed launches use OS-assigned debugging ports; `args` cannot override
headless, profile or remote-debugging switches.

| Target option | Default / behavior |
| --- | --- |
| `create_params` | Native options over `{url:'about:blank', background:true}`; `forTab:true` unsupported |
| `initialize` | true; false skips setup but always resumes the debugger |
| `runtime` | `'bootstrap'`: enable during setup then disable; true keeps reporting, false leaves it untouched |
| `page`, `network`, `service_worker` | true; enable the corresponding domains |
| `focus_emulation` | true |
| `binding` | Binding name, default `'_send_to_cdp'`; false disables it; true retains the default name |
| `background_service` | true; clears, observes and records `pushMessaging` |

Unsupported setup commands are collected in `page.setup_errors`. Target options
survive reconnection/recreation in the same manager. Creation parameters do not
navigate an existing page. Closed/crashed targets are recreated on the next call.
Commands are never replayed automatically after timeout or connection failure.

The binding name belongs to the target and is available in the existing maps:

```js
await cdp.call({
  method: 'Runtime.evaluate',
  params: {
    target: {
      name: 'page',
      binding: 'send_to_host',
      runtime: true,
    },
    expression: 'send_to_host("hello")',
  },
})

const target = cdp.browsers.get('main').targets.get('page')
console.log(target.options.binding) // 'send_to_host'
// For an explicit page session, use page.options.binding.
```

`Runtime.bindingCalled` reports the same name in its `name` field. Configuration
is applied during target initialization and reused on reconnect or recreation;
changing the stored field alone does not rename a binding in a running page.

## Events and lifetime

```js
cdp.addEventListener('notify', event => console.log(event.detail))
cdp.addEventListener('Network.requestWillBeSent', event => {
  console.log(event.detail.browser, event.detail.target, event.detail.request.url)
})
```

Events are delivered directly, with no subscriptions, buffering, polling or
filtering layer. For manager `notify` events, routing labels are in
`event.detail.params`; for method events, in `event.detail`. Enable domains as
needed, e.g. `Runtime.enable` for console and binding notifications. Browser and
page event listeners receive raw CDP messages. `close`, `setup_error` and
`request_error` report lifecycle and asynchronous setup/transport failures.

Browser, target and session maps live only in memory. There is no SQLite or
catalog persistence. The ordinary browser profile persists on disk.
`CDP.close()` shuts down processes it launched and only disconnects externally
attached browsers; the manager cannot be reused afterward. `browser.close()`
only closes its WebSocket; use the native `Browser.close` command to terminate
a browser through the explicit API.

This library has no batch API, image helpers/post-processing, event filters,
MCP server or database. Native CDP methods remain available as protocol calls.

## Verification

Run `node --check cdp.js` and `node --test tests/cdp.test.js`. There is no
`package.json`, dependency installation or import from `x.js`.
Tests use Node's test runner and a local
headless Chromium browser, covering session routing, concurrent requests,
custom methods, direct events, reconnect, profile isolation, attachment,
timeouts and shutdown. Test profiles are disposable under `build/tests/`.

Protocol reference: [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
