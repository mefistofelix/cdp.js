# cdp.js

Low-level Chromium DevTools Protocol library for Node.js 22.19+.
No npm packages, `package.json`, database or utility dependencies.
Exports: `util`, `jsrpc`, `browser`, `cdp`, also grouped in the default export.

## Calls

```js
import { cdp, util, browser } from './cdp.js'

const client = new cdp({
  base_path: './profiles',
  headless: true,
  extensions: false,
  images: false,
  translations: false,
  login: false,
  args: {
    'window-size': '1280,800',
  },
  preferences: {
    'download.prompt_for_download': false,
  },
})

try {
  await client.call({
    method: 'Page.navigate',
    params: {
      browser: 'main',
      target: {
        name: 'example',
        binding: 'send_to_host',
        runtime: true,
      },
      url: 'https://example.com',
    },
  })
  console.log(client.browsers.main.targets.example.binding)
} finally {
  await client.close()
}
```

`browser` and `target` are routing fields inside `params`, removed before the
native request is sent. The caller's object is not mutated. Browser defaults to
`main`; omitting `target` sends a browser-level command. Strings are shorthand
for `{name: 'label'}`. Configuration is stored on first use; records are public
and can be edited directly. Browser names are directory labels under `base_path`.

Named browsers and targets are created on demand. Concurrent requests share
connection and initialization. Creating a target does not close other tabs.
Closed or crashed targets are recreated on their next use; reconnecting reuses
surviving targets and reapplies their initialization. Commands are never replayed.
Await navigation readiness and other dependent operations yourself.

Results are native CDP `result` objects. Protocol errors reject with the response
in `error.cdp` and the request/response in `error.cause`. JavaScript exceptions
from `Runtime.evaluate` retain native `exceptionDetails`.

## Browser options

Constructor options supply defaults; a `params.browser` object configures a
particular browser. Launch settings apply when starting a local browser.

| Option | Default / meaning |
| --- | --- |
| `headless` | false |
| `extensions` | false; true allows browser extensions |
| `images` | true; false disables image loading |
| `translations` | false; controls translation preferences and feature flags |
| `login` | false; controls browser sign-in preferences, prompts and sync flags |
| `executable_path` | Automatic Chrome/Chromium/Edge discovery; `CDP_BROWSER` overrides discovery |
| `user_data_dir` | `<base_path>/<name>`; `base_path` defaults to `.cdp` |
| `args` | Object of command-line switches, merged over generated defaults |
| `preferences` | Object of dotted preference keys, merged over generated defaults |
| `connect_timeout_ms` | 15000; discovery, launch readiness and WebSocket handshake |
| `request_timeout_ms` | 30000; each protocol request |
| `websocket_url` | Attach directly to an existing browser WebSocket |
| `http_url` | Attach via HTTP(S) base URL or exact `/json/version` URL |
| `port`, `host` | Attach via a debugging port; host defaults to `127.0.0.1` |

Use one attachment endpoint. For example:

```js
await client.call({
  method: 'Browser.getVersion',
  params: {
    browser: {
      name: 'remote',
      port: 9222,
    },
  },
})
```

CLI keys omit `--`. `browser.build_args(options)` returns a mutable object. `util.args_to_strings()`
materializes it only when launching: true emits a flag; false/null/undefined omit
it; other values emit `--key=value`; arrays are joined with commas.

```js
const args = browser.build_args({
  user_data_dir: './profiles/example',
  args: {
    'mute-audio': false,
    'enable-features': ['FeatureOne', 'FeatureTwo'],
  },
})
args['window-size'] = '800,600'
delete args['hide-crash-restore-bubble']
console.log(util.args_to_strings(args))
```

Local launch merges translation/sign-in defaults with `options.preferences`.
`browser.update_profile_preferences(filename, preferences)` reads the JSON file, sets the dotted
keys and preserves other values. It creates missing directories/files; malformed
JSON and filesystem errors propagate. Local launch applies this to the selected
profile's `Preferences` before starting Chrome. `args['profile-directory']`
selects the profile directory, otherwise `Default` is used.

```js
await browser.update_profile_preferences('./profiles/example/Default/Preferences', {
  'translate.enabled': false,
  'download.prompt_for_download': false,
})
```

These are ordinary browser profile preferences; browser/target/session mappings
remain only in memory. Attachment to an existing browser does not alter its
profile preferences or launch arguments.

## Targets, custom methods and events

| Target option | Default / behavior |
| --- | --- |
| `create_params` | Native creation parameters over `url: 'about:blank'`, `background: true` |
| `initialize` | true; false skips domain setup |
| `runtime` | `'bootstrap'`: enable during setup, then disable; true keeps reporting; false leaves it untouched |
| `page`, `network`, `service_worker` | true; enable the corresponding domains |
| `focus_emulation` | true |
| `binding` | `'_send_to_cdp'`; string changes its name; false disables it |
| `background_service` | true; clear, observe and record `pushMessaging` |

Unsupported setup commands are collected in `target.setup_errors`. The effective
binding name is stored directly in `client.browsers[name].targets[label].binding`.
Changing a stored setting applies on subsequent initialization, not immediately
to an already initialized session.

Built-in custom methods use `Runtime.evaluate` and return its native result:

- `_.click`: `xpath`, `attempts` (default 5), `interval_ms` (default 300).
- `_.find`: `xpath`, `limit` (default 20); returns `{count, items}` in `result.value`,
  including node metadata and element rectangles.

Both require `target`. `util.normalize_xpath(xpath)` rewrites `ends-with()` and
ASCII `icontains()` into XPath 1 expressions; it is not a full XPath parser.
`client.evaluate_xpath(params, fn, options)` runs a serialized function
with the normalized XPath and options in the target.

`custom_methods` is a public object. Assign, replace or delete entries directly.
Each instance has its own copy. Handlers receive `params`, with `this` bound to
that `cdp` instance, and run before any automatic browser/target creation.

```js
client.custom_methods['_.title'] = function (params) {
  return this.call({
    method: 'Runtime.evaluate',
    params: {
      ...params,
      expression: 'document.title',
      returnByValue: true,
    },
  })
}
delete client.custom_methods['_.click']

client.addEventListener('Runtime.bindingCalled', event => {
  console.log(event.detail.browser, event.detail.target, event.detail.payload)
})
```

The manager emits `notify` with a CDP message and emits the native method name
with its parameters. Browser/target labels are added to those parameters.
`close` reports WebSocket closure. Events are delivered directly, without
subscriptions, filtering, buffering or polling.

Public mappings use direct object indexing:

```js
const record = client.browsers.main
const target = record.targets.example
console.log(target.targetId, target.sessionId, target.binding)
console.log(record.target_info[target.targetId]) // Native info plus sessionId
console.log(record.session_targets[target.sessionId]) // targetId
```

## Raw transport and utilities

```js
import { jsrpc, util } from './cdp.js'

const socket = new jsrpc('ws://127.0.0.1:9222/devtools/browser/your-id')
await util.on_first(socket, 'open error close')
try {
  console.log(await socket.req({ method: 'Browser.getVersion' }))
} finally {
  socket.close()
}
```

`jsrpc.req({method, params, sessionId}, timeout_ms)` returns the native result.
`notify(request)` sends a raw message. Socket `notify` events contain unmodified
CDP notifications. Pending requests reject on timeout or disconnection; their
listeners are removed on completion.
The public `pending` object contains their promises, indexed by request ID.

The `browser` class only contains static helpers for local browser launch:
`find_executable_path()`, `build_args(options)`,
`update_profile_preferences(filename, preferences)` and `launch(options)`.
`browser.launch()` returns `{proc, url}`; the caller owns that process.
Connections, targets, sessions and protocol calls belong to `cdp`.

`util.emit(target, name, detail)` dispatches a CustomEvent.
`util.on_first(target, 'event1 event2', timeout_ms)` works with
EventTarget and EventEmitter, returns `{type, args}` and removes losing listeners.

`client.close()` closes the processes it launched and disconnects external
browsers. `socket.close()` only closes that socket.

## Verification

Run `node --check cdp.js` and `node --test tests/cdp.test.js`.
Tests use local headless Chromium and disposable profiles under `build/tests/`.
No batch API, image processing, event filters or database are included.
Unused reference utilities live in `extra/`.

Protocol reference: [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
