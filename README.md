# cdp.js

A low-level Chromium DevTools Protocol library for Node.js, with an optional
native Deno server for Chrome extension reverse connections. One ES module,
standard-library imports, no runtime dependencies or root `package.json`.

Use Node.js 22.19+ and an installed Chrome, Chromium or Edge. Import `cdp.js`
directly from an ES module, for example `example.mjs`, and run `node example.mjs`.
Browser discovery covers common Windows, macOS and Linux installation paths;
use `executable_path` or the `CDP_BROWSER` environment variable for other paths.

For a published npm release:

```sh
npm install @mefistofelix/cdp.js
```

```js
import api, { util, jsrpc, browser, cdp } from '@mefistofelix/cdp.js'
```

The npm package exports the same file and API. Direct file imports in the examples
below remain supported. Publication metadata is isolated in `npm/`.

## Features and scope

- Native CDP requests through `call({ method, params })`, with native results.
- Named browsers and targets, created and connected on demand.
- Attachment through WebSocket, HTTP discovery or a debugging port.
- Optional Chrome extension reverse connections through one native Deno server,
  without browser remote-debugging arguments.
- Generic `chrome.x.y` extension API calls on that connection, including scripting,
  tabs/windows, cookies, storage, downloads and browser settings.
- Shared initialization for concurrent calls; reconnection and target recreation
  on subsequent use, without replaying failed commands.
- Public object mappings and directly replaceable custom method handlers.
- Configurable target initialization, JavaScript bindings and direct events.
- XPath `_.click` and `_.find`, including two XPath expression rewrites.
- Configurable browser launch arguments and profile preferences.
- Raw WebSocket JSON-RPC transport and reusable static helpers.

There is no Page class, batch API, image-processing helper, event buffer/filter
API or database. Browser, target and session mappings live in memory. Chromium
profiles and their preferences are ordinary files on disk. Any native CDP method
supported by the connected browser remains available through direct `call`.
The optional extension transport has the command/domain limits documented below.

## Quick start

This complete example uses a local blank target and needs no website:

```js
import { cdp } from './cdp.js'

const client = new cdp({
  base_path: './profiles',
  headless: true,
})

try {
  await client.call({
    method: 'Runtime.evaluate',
    params: {
      browser: 'main',
      target: 'demo',
      expression: `
        document.body.innerHTML = '<button id="hello">Hello</button>';
        window.clicks = 0;
        document.querySelector('button').onclick = () => window.clicks++;
      `,
    },
  })
  const found = await client.call({
    method: '_.find',
    params: {
      target: 'demo',
      xpath: '//button',
    },
  })
  console.log(found.result.value.items)

  const clicked = await client.call({
    method: '_.click',
    params: {
      target: 'demo',
      xpath: '//button[@id="hello"]',
    },
  })
  console.log(clicked.result.value) // true
} finally {
  await client.close()
}
```

The following short examples assume a `client` that has not yet been closed.

## Exports and API

```js
import api, { util, jsrpc, browser, cdp } from './cdp.js'
// api contains the same four classes.
```

| API | Purpose / result |
| --- | --- |
| `new cdp(options = {})` | Create a manager; does not launch a browser yet. |
| `client.call({ method, params = {} })` | Resolve routing and return a promise for the native CDP result, or a custom handler's result. |
| `client.evaluate_xpath(params, fn, options)` | Execute a serialized function with a normalized XPath in a target; return the native `Runtime.evaluate` result. |
| `client.close()` | Close owned processes, disconnect attached/reverse browsers, stop the reverse server and clear browser/socket mappings. Profiles and external browsers remain. |
| `new jsrpc(urlOrSocket, options = {})` | Open a raw WebSocket JSON-RPC connection or equip an accepted native WebSocket with the same RPC methods. |
| `client.listen_reverse(options = {})` | Start the native Deno WebSocket server; returns its `HttpServer`. |
| `socket.req(request, timeout_ms)` | Assign a request ID and await its native result. |
| `socket.notify(request)` | Serialize and send a raw message; no ID allocation or response wait. |
| `socket.close()` | Native WebSocket close; does not terminate the browser. |
| `browser.find_executable_path()` | Synchronously return an executable path from the environment or common locations. |
| `browser.build_args(options = {})` | Return a fresh, editable object of launch switches. |
| `browser.extension_id(directory)` | Compute Chromium's path-derived unpacked extension ID. Use the canonical absolute directory without a manifest `key`. |
| `browser.profile_extension_paths(args)` | Read the effective profile and return a promise for an object keyed by extension ID, with `{ path, enabled }` values for enabled and disabled extensions. |
| `browser.update_profile_preferences(filename, preferences)` | Update dotted keys in a JSON preferences file; return a promise. |
| `browser.launch(options)` | Start a local browser and return a promise for `{ proc, url }`. The caller owns the process. |
| `util.normalize_xpath(xpath)` | Return an XPath string with the supported rewrites. |
| `util.args_to_strings(args)` | Convert a switch object to an array of command-line argument strings. |
| `util.emit(target, name, detail)` | Dispatch a `CustomEvent`; return `dispatchEvent`'s boolean result. |
| `util.on_first(target, names, timeout_ms = 30000)` | Await the first space-separated event name; return `{ type, args }`. |

`cdp` is an `EventTarget`; `jsrpc` extends the native `WebSocket`. The `browser`
and `util` classes contain static helpers only. `browser` does not own CDP
connections or target/session routing.

## Calls and routing

| Field | Meaning |
| --- | --- |
| `method` | Native name such as `Page.navigate`, a custom name beginning with `_.`, or an extension API name such as `chrome.tabs.query` in reverse mode. |
| `params` | Native parameters plus the two routing fields below. Defaults to `{}`. |
| `params.browser` | Browser label or configuration object with `name`. Defaults to `'main'`. |
| `params.target` | Target label or configuration object with `name`. Omitted or `null` means a browser-level request. |

For native requests, the manager removes `browser` and `target` from a copy of
`params` and adds the resolved `sessionId` to the protocol envelope. The caller's
object is not mutated. A string label is shorthand for `{ name: 'label' }`.
Put routing inside `params`, not beside `method`.

```js
const version = await client.call({
  method: 'Browser.getVersion',
  params: {
    browser: 'main',
  },
})
console.log(version.product)

const result = await client.call({
  method: 'Runtime.evaluate',
  params: {
    browser: 'main',
    target: 'demo',
    expression: 'window.clicks',
    returnByValue: true,
  },
})
console.log(result.result.value)
```

`call` unwraps only the outer protocol response. `result.result.value` above is
the remote value inside `Runtime.evaluate`'s own result object. Other methods
have their own result shapes and parameters, defined by the
[CDP reference](https://chromedevtools.github.io/devtools-protocol/).

## Configuration scope and precedence

`new cdp({ base_path, ...options })` sets the profile root and default **browser**
options. `params.browser` overrides them for a particular label. Target options
belong in `params.target` and do not inherit from the constructor.

For a new browser record, configuration is assembled in this order:

1. Default `user_data_dir` derived from `base_path` and the browser name.
2. Constructor browser options.
3. The `params.browser` configuration object.

`args`, `preferences` and `local_state` are shallow-merged separately between
steps 2 and 3.
For duplicate keys, the per-browser value wins. Arrays replace previous arrays;
they are not concatenated during this merge.

At local launch, another two independent merges happen:

- Generated CLI defaults, adjusted by high-level browser options, then raw `args`.
- Generated profile preference defaults, then raw `preferences`.

After the CLI merge, a non-null/non-false `disable-extensions-except` adds
`DisableDisableExtensionsExceptCommandLineSwitch` to the final `disable-features`
list. This requested argument convention also applies to raw feature overrides.

There is no conflict resolver across CLI flags and preferences. Each is passed
to Chromium through its own mechanism. Raw settings can therefore contradict a
high-level option; the library does not silently reconcile them.

Configuration is recorded on the first use of a label. A subsequent configuration
object with the same name does not reconfigure that record. Public records can
be edited directly: launch settings apply at a later launch, target settings at
a later initialization. Direct edits do not immediately send CDP commands. Use
a new browser label, or close the manager and configure it again, for a fresh
local configuration.

## Browser options and defaults

| Option | Type / default | Meaning |
| --- | --- | --- |
| `base_path` | string, `'.cdp'` | Constructor-only profile root, resolved against the working directory. |
| `reverse_server` | object, `{}` | Constructor-only settings for the shared lazy listener: `hostname` defaults to `'127.0.0.1'`, `port` to `9223`. Independent of browser attachment `host`/`port`. |
| `name` | string, `'main'` when routing is omitted | Required in a browser configuration object; dictionary key and default profile directory label. |
| `user_data_dir` | absolute path string or `null`, `<base_path>/<name>` | Chromium user-data directory containing profiles such as `Default`. Explicit paths should be absolute. `null` omits the switch and skips manager preference-file writes; Chromium selects its system directory. |
| `executable_path` | string, automatic discovery | Executable to spawn; takes precedence over `CDP_BROWSER`. |
| `headless` | boolean, `false` | When true, add `headless: 'new'` and default `window-size: '1440,900'`. |
| `windowsHide` | boolean, effective headless mode | Hide the spawned process's console on Windows. Defaults to true when the final arguments include `--headless`, false otherwise; an explicit value wins. Does not hide the parent terminal. |
| `extensions` | boolean or array of directory strings, `false` | True enables normal profile extensions. An array also generates `disable-extensions-except` to load the listed local directories at startup; include `'*'` to retain enabled profile extensions. False adds the two extension-disabling switches. |
| `images` | boolean, `true` | When false, request `blink-settings: 'imagesEnabled=false'`; controls loading, not image processing. |
| `translations` | boolean, `false` | Set translation preferences and, unless true, disable translation feature IDs. |
| `login` | boolean, `false` | Set browser sign-in preferences and, unless true, disable sync and sign-in promotions. Does not prevent website login. |
| `args` | object, `{}` | Raw CLI overrides applied after generated defaults; keys omit `--`. |
| `update_preferences` | boolean, presence of an effective user-data directory | Manager-only switch for writing `Preferences` and `Local State` before launch. `false` skips both files. No files are written without a directory, including when explicitly true. |
| `preferences` | object, `{}` | Dotted JSON preference overrides applied after generated preference defaults. |
| `local_state` | object, `{}` | Dotted JSON overrides for `<user-data-dir>/Local State`, shared by profiles in that directory. No generated defaults. |
| `connect_timeout_ms` | number, `15000` | Timeout for each discovery, launch-readiness or socket-opening wait; not one combined deadline. |
| `request_timeout_ms` | number, `30000` | Default timeout for each protocol request on this browser's socket. |
| `waitForDebuggerOnStart` | boolean, `false` | Ask Chromium to pause newly auto-attached targets. Applied to `Target.setAutoAttach` when connecting; not a CLI argument or target option. |
| `websocket_url` | string, unset | Attach directly to a browser WebSocket endpoint. |
| `cdp_ext` | boolean, `false` | Launch with the reverse extension under Deno. Start one shared server automatically if needed, prepare a profile-specific extension copy and wait for its connection. |
| `reverse` | boolean, `false` | Attach to an externally launched extension instead of launching or discovering a browser. Starts the shared listener on first use under Deno. |
| `extension_id` | string, browser name for external reverse attachment | Incoming extension ID to associate with this logical browser. Set automatically for managed `cdp_ext` launches. |
| `http_url` | string, unset | Discover the endpoint from an HTTP(S) base URL or exact `/json/version` URL. |
| `port` | number, unset | Discover an existing browser at `http://<host>:<port>/json/version`. |
| `host` | string, `'127.0.0.1'` | Host used with `port`. |

### Why these defaults

The preset aims to make local automation predictable while keeping the browser
visible by default. These are practical purposes and tradeoffs of the current
settings, not a claim that every flag is required by every workload:

| Default | Purpose / tradeoff |
| --- | --- |
| Visible browser | Allows direct inspection and manual interaction; use `headless: true` for unattended runs. |
| Images enabled | Preserves normal page content and layout; disabling them can reduce loading work. |
| Extensions disabled | Avoids extension behavior and background pages affecting a run; enable them when the profile needs them. |
| Translations disabled | Avoids browser translation changing page content or presenting translation UI. |
| Browser login/sync disabled | Keeps browser-account integration out of the automation profile; website authentication remains available. |
| Separate named profile directories | Separates browser state by label while retaining normal profile data between launches. |
| Debugging port `0` | Lets Chromium choose an available port; launch reads the actual endpoint from stderr. |
| Bounded connection/request waits | Prevents indefinite local waits; timeout does not cancel execution already sent to Chromium. |
| Raw results and direct events | Keeps native protocol data available without another response or subscription abstraction. |

Automatic discovery checks `CDP_BROWSER` first. On Windows it checks Chrome and
Edge below `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA`. On macOS/Linux
it checks the application paths and `/usr/bin` candidates listed in
`browser.find_executable_path()`. It does not download a browser or search
arbitrary locations in `PATH`.

### Attach to an existing browser

With `reverse: true`, the manager waits for the extension and ignores attachment
endpoints and launch options. With `cdp_ext: true`, it launches through the extension
and ignores attachment endpoints. Otherwise, `websocket_url` takes precedence over
HTTP discovery; `http_url` takes precedence over `host`/`port`. Use one endpoint form:

```js
await client.call({
  method: 'Browser.getVersion',
  params: {
    browser: {
      name: 'existing',
      port: 9222,
    },
  },
})
```

The existing browser must already expose CDP. Launch flags, profile preferences
and Local State overrides are not applied to it. `client.close()` disconnects its
socket and leaves that browser running.

`port: 9222` means **attach**. To **launch** on that port, use
`args: { 'remote-debugging-port': 9222 }` without an attachment endpoint.

## Reverse Chrome extension transport

[cdp_ext/manifest.json](cdp_ext/manifest.json) and
[cdp_ext/cdp_ext.js](cdp_ext/cdp_ext.js) form a Manifest V3 extension for Chrome
125+. The extension connects out to one WebSocket server. The server serves all
browser instances on the same port; each extension announces its native ID
in its first message. No remote-debugging argument is needed.

Run the server under Deno using its native
[WebSocket upgrade](https://docs.deno.com/api/deno/websockets/).
Node's direct CDP mode remains supported; `listen_reverse()` under Node rejects
with an explicit Deno requirement. There is no WebSocket framing implementation,
third-party server dependency or additional build step.

Run `deno run -A examples/reverse.mjs` to launch Chrome with the extension, create
a target and evaluate `21 * 2`. Ctrl+C closes the owned browser and server.
The same mode is available per browser:

```js
const result = await client.call({
  method: 'Runtime.evaluate',
  params: {
    browser: {
      name: 'work',
      cdp_ext: true,
      headless: true,
    },
    target: 'demo',
    expression: '21 * 2',
  },
})
```

The manager copies the two extension files into `cdp_ext/` inside the effective
profile directory, sets the shared server URL in that copy's manifest and loads
it before browser startup. Without an effective user-data directory, the copy
lives under `base_path/<name>/<profile-directory>/` instead (`Default` when unset);
Chromium still uses its system profile. Profile preferences follow the existing
`update_preferences` rules.
The generated launch arguments omit remote debugging and enable this extension.
An `extensions` array also selects those directories; `extensions: true` keeps
normally enabled profile extensions through `'*'`. Raw `args` still win and can
prevent the bridge from loading or connecting, causing a connection timeout.

For external attachment, load unpacked `cdp_ext/` through `chrome://extensions`
or the [local-extension argument options](#local-extensions-at-startup).
Use its ID shown in Chrome, or `browser.extension_id(directory)`, as the
browser option `extension_id`. The logical `name` stays in the manager.

The extension configuration is read from `chrome.runtime.getManifest()`:

| Manifest `cdp` key | Default | Meaning |
| --- | --- | --- |
| `websocket_url` | `ws://127.0.0.1:9223` | The shared server endpoint. Port 9223 avoids the usual direct CDP port 9222. |
| `reconnect_ms` | `5000` | Connection retry interval while the extension worker is awake; also the empty-message heartbeat interval while connected. Use a positive value below 30000. |

The first message uses `chrome.runtime.id`, not a configured logical browser name.
For an unpacked extension without a manifest `key`, Chromium derives this ID from
its directory. Managed launches use a separate directory for each profile, so
the ID is stable across reconnects and restarts, and the manager knows which
browser it belongs to. External instances must likewise use distinct extension
directories. Moving the directory changes the ID. The server rejects duplicate
live IDs and announcements that differ from the WebSocket's `chrome-extension://`
origin. This is routing information, not an authentication credential.

```js
import { browser, cdp } from './cdp.js'

const client = new cdp({
  reverse: true,
  connect_timeout_ms: 60000,
  reverse_server: {
    hostname: '127.0.0.1',
    port: 9223,
  },
})
const result = await client.call({
  method: 'Runtime.evaluate',
  params: {
    browser: {
      name: 'other',
      reverse: true,
      extension_id: browser.extension_id('/absolute/path/to/cdp_ext'),
    },
    target: 'demo',
    expression: 'document.title',
  },
})
console.log(result.result.value)
await client.close()
```

Construction and direct CDP calls do not start a listener. The first browser call
using `reverse: true` or `cdp_ext: true` starts the shared server lazily, with the
constructor's `reverse_server` settings. To mix direct and reverse browsers, leave the
constructor's `reverse` default false and specify `reverse: true` in that browser's
`params.browser` object. Constructor `port` remains a direct attachment option.

The listener closes when no reverse connection, pending reverse initialization
or live owned reverse process needs it. A live owned browser keeps it available
through temporary disconnects. External disconnects can release it when nothing
else needs it; the next reverse call restarts it and waits for the extension's
retry. Direct browsers do not keep this listener alive.

`client.reverse_server` is the public shared configuration object. After startup
it contains the effective listening port, including when `port: 0` originally
requested an available port. Restarts reuse that port so existing extensions can
still reconnect. `client.server` contains the current native Deno `HttpServer`,
or is unset/null while stopped. A call arriving during shutdown waits for it to
finish before starting a replacement server.

`listen_reverse(options = client.reverse_server)` remains available to start the
listener explicitly ahead of a browser call. It returns the native `HttpServer`;
calling it while a server is running rejects. Explicit options replace the stored
settings, with omitted fields taking the hostname/port defaults above.

Reverse calls reuse the normal target setup, custom handlers, mappings, routed
events, request correlation, timeout and error behavior. `reverse: true` alone
attaches externally: the manager neither launches nor updates that browser.
`cdp_ext: true` owns the launched process and applies normal launch preferences.
Closing the manager closes owned processes and the server, while external
browsers and tabs remain open. The extension retries when the server returns;
the next call rebuilds discovery and sessions, preserving surviving target IDs.
Commands interrupted by disconnect are never replayed.

A WebSocket close is not proof that Chrome exited. A managed reverse connection
loss or connection timeout leaves its owned process alive. Subsequent calls wait
for that extension to reconnect; they do not spawn another process. Only the
child process's confirmed exit permits a new launch. Explicit manager `close()`
still terminates owned browsers.

The current reverse registration uses a profile-specific extension copy. It does
not assign a new logical name to an already running Chrome using a shared extension
directory. Unpacked `chrome.runtime.id` identifies the extension path, not the
user-data directory or browser executable. Shared-path registration and URL-based
bootstrap are tracked in [TODO.md](TODO.md), not implemented behavior.

Chrome's [process singleton](https://github.com/chromium/chromium/blob/main/chrome/browser/process_singleton.h)
uses the user-data directory to decide whether to forward a new launch to an
existing instance. `no-default-browser-check` only suppresses the default-browser
prompt. The current Chromium [notification callback](https://github.com/chromium/chromium/blob/main/chrome/browser/chrome_browser_main.cc)
rejects forwarding when either command line enables automation or uses headless
mode. This library generates `enable-automation` by default; a normal browser
started with `args['enable-automation']: false` can behave differently. Do not
infer ownership of the real browser from a short-lived forwarding process.

The [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
allows termination while offline. A 30-second Chrome alarm wakes the worker for
another connection attempt; the configured interval applies while it is awake.
Connected empty-text heartbeats keep an otherwise idle WebSocket worker active.
These are transport messages, not event buffering or polling of browser state.

### Reverse protocol and supported commands

The first extension-to-server message is `{ "browser": "<extension ID>" }`. Subsequent
messages use existing CDP envelopes:

- Request: `{ id, method, params, sessionId? }`.
- Response: `{ id, result }` or `{ id, error: { code, message } }`.
- Notification: `{ method, params, sessionId? }`.
- Empty text: heartbeat, ignored by `jsrpc`.

`jsrpc` assigns increasing request IDs per socket, shared by all its targets and
sessions. The extension echoes each request's ID in its response; IDs internal
to `chrome.debugger` are not exposed. Replies can arrive out of order. A timed-out
request's late reply cannot resolve a newer request. A new socket starts a new
ID sequence; the extension sends replies only on the connection that received
the request, so old completions cannot enter the replacement connection.

Top-level target IDs are stringified Chrome tab IDs, stable while a tab survives.
For root commands, the envelope's `sessionId` is that tab ID: the extension sends
to its registered `{ tabId }` debuggee without a generated UUID.
`Target.attachToTarget` returns the same tab ID in `sessionId`, and root
notifications use it too. This keeps the shared manager and RPC flow unchanged;
it is a reverse routing reference, not a native root CDP session.

Worker and out-of-process iframe commands still use real flattened CDP sessions.
Their native session IDs pass through unchanged, without prefixes. The extension
uses one `sessions` object for both roots and children: a tab ID maps to `{ tabId }`,
and a native child session ID maps to `{ tabId, sessionId }`. Every target command
looks up that object and passes the debuggee directly to `chrome.debugger.sendCommand`;
there is no fallback that interprets unknown session IDs as tab IDs.
Explicit detach takes `params.sessionId` for either a tab or child
session. Logical target labels remain inside the manager. Reconnecting invalidates
attachment/setup state even though a surviving root tab's routing ID stays the same.

The extension adapts browser-level `Target.getTargets`, `getTargetInfo`,
`setDiscoverTargets`, `setAutoAttach`, `createTarget`, `attachToTarget`,
`detachFromTarget`, `closeTarget` and `activateTarget` to Chrome tab/debugger APIs.
Discovery lists tabs; attaching a selected tab exposes its native child target
events and flattened sessions. It does not attach every unselected tab.
`createTarget` accepts only `url` and `background`; `activateTarget` selects the
tab and focuses its window. `Browser.getVersion` returns product/user-agent data;
its protocol version is `1.3`, with empty `revision` and `jsVersion` fields.
Other browser-level commands return explicit unsupported-command errors.

Target/session commands go through
[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger),
which supports a restricted set of CDP domains. Runtime, Page, Network, DOM,
Input and Emulation are available; ServiceWorker and BackgroundService are not.
Their default setup attempts therefore appear in `target.setup_errors`; disable
those setup flags if desired. Chrome restrictions, policies and debugger detach
events remain visible. Opening DevTools on an attached tab can detach this debugger.
Firefox/Camoufox support remains planned.

Browser-level `waitForDebuggerOnStart: true` returns an explicit error in reverse
mode: the extension cannot pause newly created root tabs before attachment.
Keep its default false and create `about:blank`, finish setup, then navigate.
Normal target-side `Target.setAutoAttach` is still native pass-through for children.

### Chrome extension API commands

In reverse mode, `chrome.<namespace>.<method>` calls the corresponding Chrome
extension method directly, including nested objects such as
`chrome.storage.session.get` and `chrome.privacy.websites.referrersEnabled.get`.
There is no method registry or CDP-name translation. A name such as
`Runtime.evaluate` still uses `chrome.debugger`; a name such as
`chrome.debugger.getTargets` calls the extension API with its native signature.
The same connection, request IDs, timeouts and RPC error envelopes handle both.
These names are extension-only; direct CDP connections do not implement them.

| Parameter | Meaning |
| --- | --- |
| `browser` | Usual manager browser label/configuration. |
| `args` | Positional native arguments as a JSON array; defaults to `[]`. One object argument is `[object]`; two arguments are `[first, second]`. |
| `callback` | Default `false`: await a native Promise or return a synchronous result. Set `true` for callback APIs: append a callback, await its first result and reject on `chrome.runtime.lastError`. |
| `target` | Optional manager target selection/setup. It does not supply a native tab ID to the extension API. Put native `target` objects inside `args`. |

```js
const tabs = await client.call({
  method: 'chrome.tabs.query',
  params: {
    browser: 'work',
    args: [{}],
  },
})
await client.call({
  method: 'chrome.scripting.insertCSS',
  params: {
    browser: 'work',
    args: [{
      target: {
        tabId: tabs[0].id,
      },
      css: 'body { background: white; }',
    }],
  },
})
await client.call({
  method: 'chrome.storage.session.set',
  params: {
    browser: 'work',
    args: [{
      example: true,
    }],
  },
})
```

Native arrays, objects, strings, booleans, numbers and `null` are returned directly;
only `undefined` becomes `{}`. The method is called on its owning object, so nested
API objects retain their native receiver. Arguments and results must be JSON data.
Callbacks can only be supplied through `callback: true`; functions, event listeners,
Ports, Blobs and other live/non-JSON objects have no remote representation.
The bridge adds no extension event subscriptions.

`chrome.scripting.executeScript` supports `files` relative to the loaded extension
directory and returns the native array of frame results. JSON serialization drops
JavaScript functions; strings are not converted into functions and the worker does not use
`eval`. Tested on Chrome 154: arrow-function source, function-expression source and
a function body sent as `func` strings all fail native validation with
`Invalid type: expected function, found string.` Chrome serializes an actual
function only after accepting the extension API call. Continue using CDP
`Runtime.evaluate` for source expressions. The separately
exposed `chrome.userScripts` API supports native source-code arguments, but Chrome
requires its user toggle: Developer mode before Chrome 138, or Allow User Scripts
on the extension's details page from Chrome 138 onward.

The manifest grants `<all_urls>` host access and broad desktop extension API
permissions for scripting/debugging, tabs/groups/sessions, bookmarks/history/reading
list/search, cookies/content settings, storage, downloads, management, privacy/proxy,
accessibility/font settings, alarms/idle/power, system information, notifications,
context menus, capture, clipboard/geolocation access, identity, native messaging,
messaging through GCM, offscreen documents, side panels, speech/engines,
navigation/network requests and declarative rules.
Its `action` declaration also enables `chrome.action` methods. The exact permission
list is in [cdp_ext/manifest.json](cdp_ext/manifest.json); managed launches copy it.
There are no per-method permission prompts added by the bridge.

Permissions do not bypass Chrome's native restrictions: platform-specific,
enterprise-only and channel-specific APIs are not enabled by this manifest, and
Manifest V3's policy-only `webRequestBlocking` is not requested. User gestures,
incognito/file-access grants, capture dialogs, native messaging host installations
and required extension resources still apply. Unavailable methods and native errors
reject normally. See the official [extension API reference](https://developer.chrome.com/docs/extensions/reference/api),
[permission list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
and [scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).

## Command-line arguments

The library exposes a JavaScript API, not a command-line program. `args` refers
to the switches passed to the Chromium executable.

`browser.build_args(options)` builds defaults, applies boolean options, then
overwrites keys with `options.args`. The result remains an object until
`util.args_to_strings` materializes it for `child_process.spawn`. No shell command
is assembled; a value containing spaces stays inside one argument.

| Object value | Generated argument |
| --- | --- |
| `true` | `--key` |
| `false`, `null`, `undefined` | Omitted |
| string or number | `--key=value` |
| array | `--key=first,second` |

The array rule applies to every switch. An empty array emits `--key=`. There is
no separate `disabled_features` option. Setting a generated flag to `false`
removes it; it does not automatically emit an opposite flag.

```js
import { browser, util } from './cdp.js'

const args = browser.build_args({
  user_data_dir: './profiles/example',
  headless: true,
  args: {
    'mute-audio': false,
    'window-size': '800,600',
    'enable-features': ['FeatureOne', 'FeatureTwo'],
  },
})
args['disable-features'].push('AnotherFeature')
delete args['hide-crash-restore-bubble']
console.log(util.args_to_strings(args))
```

To launch with a modified object, supply it as `options.args`; defaults are built
again, so suppress a default with `false` in that override object. Deleting a key
from a standalone object suppresses it only when that object itself is
materialized directly.

### Generated switches

These are the library's requested defaults and their intended purpose. The
installed Chromium build determines which switches and feature IDs it honors;
some are platform-specific or retained compatibility switches. The preset does
not guarantee that every browser version implements every entry. Native
reference definitions include Chromium's [Chrome switches](https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/chrome_switches.h)
and [content switches](https://raw.githubusercontent.com/chromium/chromium/main/content/public/common/content_switches.cc).

| Switch key | Value / condition | Purpose |
| --- | --- | --- |
| `user-data-dir` | `user_data_dir` | Select user-data storage. |
| `remote-debugging-port` | `0` | Enable CDP on a port chosen by Chromium. |
| `enable-automation` | `true` | Enable Chromium automation mode. |
| `mute-audio` | `true` | Mute browser audio. |
| `disable-blink-features` | `'AutomationControlled'` | Disable that Blink runtime feature. |
| `hide-crash-restore-bubble` | `true` | Suppress crash-restore UI where supported. |
| `disable-field-trial-config` | `true` | Disable field-trial configuration. |
| `disable-background-networking` | `true` | Reduce subsystem background networking. |
| `enable-features` | array below | Enable named Chromium features. |
| `disable-background-timer-throttling` | `true` | Disable background-page timer throttling. |
| `disable-backgrounding-occluded-windows` | `true` | Avoid backgrounding occluded windows. |
| `disable-renderer-backgrounding` | `true` | Avoid lowering renderer priority in background. |
| `disable-back-forward-cache` | `true` | Disable the back/forward page cache. |
| `disable-breakpad` | `true` | Disable Breakpad crash reporting where supported. |
| `disable-client-side-phishing-detection` | `true` | Disable client-side phishing detection. |
| `disable-component-update` | `true` | Disable browser component updates. |
| `no-default-browser-check` | `true` | Skip the default-browser check. |
| `disable-default-apps` | `true` | Skip default application installation. |
| `disable-dev-shm-usage` | `true` | Avoid `/dev/shm` storage on Linux. |
| `allow-pre-commit-input` | `true` | Allow input before frame commit where supported. |
| `disable-hang-monitor` | `true` | Disable renderer hang monitoring. |
| `disable-ipc-flooding-protection` | `true` | Disable IPC flooding rate limits. |
| `disable-popup-blocking` | `true` | Disable automatic popup blocking. |
| `disable-prompt-on-repost` | `true` | Suppress form-repost confirmation. |
| `force-color-profile` | `'srgb'` | Select the sRGB color profile. |
| `metrics-recording-only` | `true` | Request metrics recording without reporting. |
| `no-first-run` | `true` | Skip the first-run experience. |
| `password-store` | `'basic'` | Select the basic password-store backend. |
| `use-mock-keychain` | `true` | Use the test keychain where supported. |
| `no-service-autorun` | `true` | Suppress service autorun where supported. |
| `export-tagged-pdf` | `true` | Request tagged PDF output where supported. |
| `disable-search-engine-choice-screen` | `true` | Suppress search-engine selection UI. |
| `disable-features` | array below | Disable named Chromium features. |
| `headless` | `'new'` when `headless` is true | Run without a visible browser window. |
| `window-size` | `'1440,900'` when headless | Set initial window dimensions. |
| `disable-extensions` | `true` unless `extensions` is true or an array | Disable browser extensions. |
| `disable-component-extensions-with-background-pages` | same condition | Disable those component extensions. |
| `disable-extensions-except` | the `extensions` array, otherwise unset | Load local directories and exclude other normal extensions. Raw overrides win. |
| `blink-settings` | `'imagesEnabled=false'` when `images` is false | Disable image loading through Blink settings. |
| `disable-signin-promo-on-avatar-pill-for-testing` | `true` unless `login` is true | Suppress the avatar sign-in promotion. |
| `disable-sync` | same condition | Disable browser sync. |

The sign-in promotion switch is defined in Chromium's
[sign-in switches](https://raw.githubusercontent.com/chromium/chromium/main/components/signin/public/base/signin_switches.cc).
`about:blank` is appended as the initial URL. Launching or creating a managed
target does not close other tabs.

The initial `enable-features` array is:

```js
[
  'NetworkService',
  'NetworkServiceInProcess',
]
```

The initial `disable-features` array is:

```js
[
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
]
```

These are native Chromium feature identifiers, not additional library options.
Unless `translations` is true, the library appends `Translate`, `TranslateToast`
and `EnableTranslatePdf`. Unless `login` is true, it appends
`DiceWebSigninInterception` and `SigninPromoOnAvatarPill`. A raw
`args['disable-features']` replaces that generated array; an active
`disable-extensions-except` then appends its required feature ID as described below.

## Local extensions at startup

These conventions operate before Chromium starts, without CDP installation calls
or manual extension registration in preference files:

1. An `extensions` array generates `disable-extensions-except` and omits the two
   normal extension-disabling defaults. `extensions: true` alone keeps normal
   profile loading without generating an exception list.
2. Raw `args` override generated switches. A final non-null/non-false
   `disable-extensions-except` automatically appends
   `DisableDisableExtensionsExceptCommandLineSwitch` to `disable-features`, once.
   Raw feature arrays or comma-separated strings retain their entries.
3. At launch, an exact `'*'` entry expands to enabled extension paths from the
   effective profile; duplicate paths are removed. Explicit paths remain selected.

```js
const client = new cdp({
  extensions: [
    '*',
    '/absolute/path/to/local-extension',
  ],
})
```

The equivalent raw selection is `args['disable-extensions-except']` containing
that array or a comma-separated string. It works independently of `extensions`;
other raw switches remain effective. A null/false selector suppresses the generated
exception list and its automatic feature addition. An empty array selects no
normal extensions. Arrays passed by the caller are not mutated.

`browser.build_args` leaves `'*'` unexpanded. `browser.launch` reads
`<user-data-dir>/<profile-directory or Default>/Preferences` and `Secure Preferences`
before spawning, using the final raw directory arguments. Secure records take
precedence for duplicate IDs. `browser.profile_extension_paths(args)` returns a
plain object keyed by extension ID, containing both enabled and disabled records
as `{ path, enabled }`. Paths refer to the current recorded version, including
absolute unpacked paths. Disable reasons and legacy disabled state set
`enabled: false`; internal component extensions and records without a path are
omitted. Wildcard expansion takes only the entries with `enabled: true`, without
scanning obsolete versions or activating disabled extensions. Missing files contribute no
entries; malformed JSON and other read errors reject launch. `'*'` requires an
explicit effective user-data directory; the system directory is not inferred.
`update_preferences: false` does not disable this read-only expansion.

```js
const extensions = await browser.profile_extension_paths({
  'user-data-dir': '/absolute/path/to/profile-root',
  'profile-directory': 'Default',
})
// extensions[extensionId] contains { path, enabled }.
const disabled = Object.entries(extensions).filter(([, extension]) => !extension.enabled)
```

Explicit directories must contain unpacked extensions with `manifest.json`.
The native argument excludes other normal extensions, so include `'*'` when
preserving enabled profile extensions. Chromium still decides whether an extension
can load. The feature override was verified on Chrome 154; it depends on Chrome
retaining that internal switch, rather than a stable extension-installation API.
See [Chromium's startup loader](https://github.com/chromium/chromium/blob/main/chrome/browser/extensions/extension_service.cc).

## Profile preferences

The `cdp` manager edits the profile's JSON `Preferences` file before spawning
Chromium when the effective `user-data-dir` argument specifies a directory and
`update_preferences` is not false. The path is:

```text
<args['user-data-dir']>/<args['profile-directory'] or Default>/Preferences
```

`profile-directory` is a raw switch, for example `'Profile 1'`. The generated
preference defaults are:

| Dotted key | Value | Meaning |
| --- | --- | --- |
| `translate.enabled` | `translations === true` | Allow browser translation. |
| `signin.allowed` | `login === true` | Allow browser profile sign-in. |
| `signin.allowed_on_next_startup` | `login === true` | Apply sign-in permission at startup. |

`options.preferences` overwrites these defaults by key. Preferences and switches
are separate layers; overriding one does not remove the other.
`update_preferences: false` skips generated and raw preference writes, including
`local_state`. It does not change generated CLI arguments. The default follows
the effective directory, including raw overrides; the manager's generated named
directory counts as a configured directory.

```js
await client.call({
  method: 'Browser.getVersion',
  params: {
    browser: {
      name: 'downloads',
      headless: true,
      translations: true,
      preferences: {
        'download.prompt_for_download': false,
        'download.default_directory': '/absolute/path/to/downloads',
      },
      args: {
        'profile-directory': 'Default',
      },
    },
  },
})
```

The helper is also usable independently, before starting the browser:

```js
await browser.update_profile_preferences('./profiles/example/Default/Preferences', {
  'translate.enabled': false,
  'download.prompt_for_download': false,
})
```

It creates missing directories and a missing JSON file, traverses dotted keys,
assigns JSON-compatible values and preserves unrelated values. An object
assigned at a key replaces that value; this is not a recursive merge of the
supplied object. `null` is stored as JSON null. Malformed JSON, incompatible
existing path values and filesystem errors propagate. It does not coordinate
writes with a running browser, which may overwrite the file itself.

### Local State and the remote-debugging checkbox

Chrome stores settings shared by profiles in the same user-data directory in
`<user-data-dir>/Local State`, outside `Default` or `Profile 1`. `local_state`
instructs the `cdp` manager to update this file before launch using the same
`browser.update_profile_preferences` helper and preservation rules.
The effective raw `args['user-data-dir']` override
selects its location; `profile-directory` does not affect it.

For Chrome's `chrome://inspect/#remote-debugging` checkbox:

```js
const client = new cdp({
  local_state: {
    'devtools.remote_debugging.user-enabled': true,
  },
})
```

Set the key to `false` to disable it. The helper can also edit this file directly,
before starting Chrome:

```js
await browser.update_profile_preferences('/absolute/user-data-dir/Local State', {
  'devtools.remote_debugging.user-enabled': true,
})
```

This is the user-enabled setting, distinct from the administrator policy
`devtools.remote_debugging.allowed`. Chrome's native mode requires approval for
incoming connections; setting the preference does not remove that prompt.
The library's normal launch still uses `--remote-debugging-port`, which takes
precedence over this mode. See the [Chromium implementation](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc).

`user_data_dir: null`, or a raw `args['user-data-dir']: null`/`false`, omits the
directory switch. Direct `browser.launch` also omits it when no directory is
provided. The manager skips both `preferences` and `local_state` writes in that
case; it does not discover or edit the system directory. Chrome 136+ ignores
the debugging-port switch for its system directory, so omitting the directory
does not provide a working CDP connection through the normal launcher.
Attach using an existing endpoint when using Chrome's native approval mode.
See [Chrome's debugging-port restrictions](https://developer.chrome.com/blog/remote-debugging-port).

## Overlaps and override examples

| Settings | Effective library behavior |
| --- | --- |
| `headless: true` plus `args.headless: false` | Omit `--headless`; the generated window-size argument remains unless also overridden. |
| `headless: false` plus `args.headless: 'new'` | Send `--headless=new`; no automatic headless window-size default was generated. |
| `windowsHide` omitted plus a raw `args.headless` override | Follow the effective `--headless` switch after the override. |
| Explicit `windowsHide: true` or `false` | Pass that value to Node's `spawn`, regardless of headless mode. |
| `extensions: true` plus `args['disable-extensions']: true` | The raw extension-disabling switch still wins. |
| `extensions: false` plus only `args['disable-extensions']: false` | Remove that flag, but retain `disable-component-extensions-with-background-pages`. Use `extensions: true` to omit both generated flags. |
| `extensions: ['*', directory]` | Select enabled profile extensions plus the explicit local directory before startup. |
| An `extensions` array plus a raw `disable-extensions-except` | The raw selection replaces the generated array; null/false suppresses that selection. |
| `images: false` plus an overridden `blink-settings` | Replace the whole string; image disabling is not appended to the caller's value. |
| `translations: false` plus `preferences['translate.enabled']: true` | Store true in the profile, while generated translation-disabling feature IDs remain on the CLI. |
| `login: true` plus `args['disable-sync']: true` | Allow profile sign-in through generated preferences while still requesting sync to be disabled. |
| Any high-level settings plus a raw `disable-features` array | Replace the generated list, including translation/sign-in additions; an active `disable-extensions-except` still appends its required feature ID. |
| `user_data_dir` plus `args['user-data-dir']` | The raw argument determines both the profile write location and the launched browser directory. |
| `port` plus `args['remote-debugging-port']` | Attach using `port`; no launch occurs, so the raw launch argument is unused. |
| Constructor options plus an existing browser label | Reuse the stored record; configuration is not merged again on every call. |
| `initialize: false` plus `runtime: true` or a binding name | Skip optional target setup, including domain enabling and binding installation. |
| `binding: false` plus `runtime: true` | Skip binding installation but retain Runtime enabling/reporting. |

For translation/sign-in behavior, prefer the high-level option unless a mixed
configuration is intentional. Browser versions and policies ultimately determine
the outcome of contradictory native settings; the library only constructs the
arguments and writes the preferences described here.

A raw feature list can be extended without losing the generated entries:

```js
const generated = browser.build_args({
  translations: true,
  login: false,
})

const clientWithOverrides = new cdp({
  translations: true,
  login: false,
  args: {
    'disable-features': [...generated['disable-features'], 'AnotherFeature'],
  },
})
await clientWithOverrides.close()
```

## Target options and lifecycle

Target configuration belongs in `params.target`:

```js
await client.call({
  method: 'Runtime.evaluate',
  params: {
    target: {
      name: 'events',
      binding: 'send_to_host',
      runtime: true,
      network: false,
      create_params: {
        background: false,
      },
    },
    expression: 'document.title',
    returnByValue: true,
  },
})
```

| Option | Default | Meaning / purpose of default |
| --- | --- | --- |
| `name` | required in an object | Logical label in this browser's `targets` mapping. |
| `targetId` | `null` | Optional existing physical target ID. Reused if discovered; otherwise create a new target. |
| `create_params` | `{}` | Native creation overrides, merged over `url: 'about:blank'` and `background: true`; start from a blank target without requesting foreground activation. |
| `initialize` | `true` | Run the convenience setup sequence; false skips it. |
| `runtime` | `'bootstrap'` | Enable Runtime for setup, then disable reporting. `true` leaves it enabled; `false` skips both operations. |
| `page` | `true` | Enable Page domain reporting for navigation/page operations and events. |
| `network` | `true` | Enable Network reporting so native network events are available. |
| `service_worker` | `true` | Enable ServiceWorker reporting. |
| `focus_emulation` | `true` | Request target focus emulation, including when the actual window is not focused. |
| `binding` | `'_send_to_cdp'` | Default page-to-host JavaScript binding. String changes its name; false skips installation; true selects the default name. |
| `background_service` | `true` | Clear, observe and record `pushMessaging` background-service events in Chromium. |

Domain options set to false skip setup commands; they do not actively disable a
domain already enabled by another caller. Likewise, `binding: false` does not
remove a previously installed binding. Use native CDP commands for immediate
changes. `initialize: false` skips binding installation too;
`Runtime.runIfWaitingForDebugger` is still sent at the end. The browser option
`waitForDebuggerOnStart` defaults to `false`. With `true`, auto-attachment requests
a pause. Bootstrap setup sends `Runtime.disable` before the resume command.
To ensure setup completes before navigating, keep the initial `about:blank` and
use `Page.navigate` afterward, as below. The pause flag alone does not guarantee
that a URL supplied through `create_params.url` waits for setup; Chromium can
execute that navigation's scripts during initialization.

Set this option in constructor browser defaults or in `params.browser`:

```js
await client.call({
  method: 'Page.navigate',
  params: {
    browser: {
      name: 'paused',
      waitForDebuggerOnStart: true,
    },
    target: 'page',
    url: 'https://example.com/',
  },
})
```

The setting affects auto-attachment across that browser connection. Only targets
selected through `params.target` receive setup and automatic resume. Other newly
auto-attached tabs can remain paused: select their physical ID using
`params.target.targetId`, or send `Runtime.runIfWaitingForDebugger` through the
browser socket with their `sessionId`.

Setup CDP errors are collected as strings in `target.setup_errors`, allowing the
sequence to continue when a browser/target does not support a setup command.
Transport failures and timeouts reject initialization. Errors from the caller's
actual native request reject normally.

The first request creates/selects a target, attaches a flattened session and
runs setup. Concurrent requests share that work. Detachment invalidates the
cached session; destruction/crash invalidates target discovery information.
Later use reattaches or creates a target as needed. Reconnection retains labels
and configuration, reuses surviving physical targets and reapplies setup.
Failed commands are never replayed.

Navigation readiness is the caller's responsibility. For example, with one
selected target and no other concurrent navigation:

```js
import { util } from './cdp.js'

await client.call({
  method: 'Page.enable',
  params: {
    target: 'demo',
  },
})
const loaded = util.on_first(client, 'Page.loadEventFired')
await client.call({
  method: 'Page.navigate',
  params: {
    target: 'demo',
    url: 'data:text/html,<title>Example</title><p>Ready</p>',
  },
})
await loaded
```

## XPath custom methods

Both built-ins require `params.target`; `params.browser` defaults to `main`
through the normal router. They use `Runtime.evaluate` with `returnByValue`,
`awaitPromise`, `silent` and `userGesture` set to true: serialize the result,
await async page code, suppress evaluation exception reporting, and evaluate
with a user gesture respectively.

| Method | Parameters | Remote result in `response.result.value` |
| --- | --- | --- |
| `_.click` | `xpath` string; `attempts` number, default `5`; `interval_ms` number, default `300` | True after the first matching node's `.click()`. False when no node is found after the attempts or the node has no click function. |
| `_.find` | `xpath` string; `limit` number, default `20` | `{ count, items }`: total matches and at most `limit` serialized nodes. |

The click defaults provide a short wait for a node to appear; the find limit
bounds returned item data. Use positive integer attempt counts and non-negative
integer limits. Click waits only between unsuccessful attempts. It calls DOM
`.click()`, not mouse movement or coordinate input. `_.find` does not retry.

| Find item field | Meaning |
| --- | --- |
| `node_type`, `node_name` | DOM `nodeType` and `nodeName`; non-element nodes are supported. |
| `text` | Trimmed `innerText` or `textContent`, limited to 2,000 characters to bound returned text. |
| `tag` | Lowercase `tagName`, when present. |
| `id`, `href`, `value` | Corresponding DOM properties, when present. |
| `class` | String form of `className`, when present. |
| `rect` | `getBoundingClientRect().toJSON()` for nodes that support it. |

Absent optional properties may be omitted by serialization. `count` is the full
XPath snapshot length, even when `items` is limited or empty.

`util.normalize_xpath(xpath)` rewrites `ends-with(a, b)` and ASCII
`icontains(a, b)` into XPath 1 expressions. These are regular-expression rewrites,
not a complete parser; arbitrary nested or comma-containing arguments are outside
that rewriting logic. Ordinary XPath expressions pass through unchanged.

`client.evaluate_xpath(params, fn, options)` is available for other helpers:

```js
const text = await client.evaluate_xpath({
  target: 'demo',
  xpath: '//p',
}, xpath => document.evaluate(
  xpath,
  document,
  null,
  XPathResult.FIRST_ORDERED_NODE_TYPE,
  null,
).singleNodeValue?.textContent)
console.log(text.result.value)
```

`params` supplies `browser`, `target` and `xpath`. `fn` is serialized and called in
the target as `fn(normalizedXPath, options)`; it cannot capture Node.js variables
or imported helpers. `options` must be JSON-serializable; omission becomes null
in the argument array. Results retain native `exceptionDetails` if page code throws.

### Register, replace or remove handlers

`client.custom_methods` is an ordinary public object with a separate copy of the
built-ins per client. Assign or delete keys directly; there are no registration
methods. Only method names starting with `_.` use this dispatch path.

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
const title = await client.call({
  method: '_.title',
  params: {
    target: 'demo',
  },
})
console.log(title.result.value)

client.custom_methods['_.click'] = async function (params) {
  return { handled: params.xpath }
}
delete client.custom_methods['_.find']
```

Handlers receive the original `params`, with `this` bound to the `cdp` instance.
Use a regular function when that binding is needed. They run before automatic
browser/target resolution, may be synchronous or asynchronous, and define their
own return value. Their exceptions propagate. An unregistered `_.` name rejects
without launching a browser.

## Events and bindings

| Emitter / event | `event.detail` |
| --- | --- |
| `client`, `notify` | CDP message with browser and, when known, target labels added to `params`. |
| `client`, native method such as `Runtime.bindingCalled` | That message's routed parameters. |
| `client`, `close` | `{ browser, code }` for closure of the current browser socket. |
| `socket`, `notify` | The unmodified CDP notification from the raw transport. |

Labels are strings, not record objects. Native `sessionId` remains available on
messages that carry it. Events are delivered directly: there is no history,
polling API or library-level filtering. Use normal event listeners and inspect
labels when handling several targets.

```js
client.addEventListener('Runtime.bindingCalled', event => {
  const { browser, target, name, payload } = event.detail
  console.log(browser, target, name, payload)
})
await client.call({
  method: 'Runtime.evaluate',
  params: {
    target: {
      name: 'bridge',
      binding: 'send_to_host',
      runtime: true,
    },
    expression: 'send_to_host(JSON.stringify({ hello: "world" }))',
  },
})
console.log(client.browsers.main.targets.bridge.binding) // send_to_host
```

Bindings accept a string payload. `runtime: true` keeps reporting enabled for
ongoing binding and console events; bootstrap mode disables Runtime after setup.
The configured binding name lives on the target record and is reapplied during
subsequent initialization.

`util.on_first(target, 'open error close', timeout_ms)` supports EventTarget and
EventEmitter. For EventTarget, `args[0]` is the event; for EventEmitter, `args` is
the emitted argument list. The helper removes listeners and cancels its timer
after completion. Timeout rejects with `AbortError`; EventEmitter error handling
follows Node.js `events.once` semantics.

## Public records

Mappings use object indexing, not `Map` instances or accessor methods. Some
dictionary containers have a null prototype.

| Path | Contents |
| --- | --- |
| `client.base_path` | Resolved profile root. |
| `client.options` | Constructor browser defaults, excluding `base_path` and `reverse_server`. |
| `client.reverse_server` | Shared listener configuration; the effective hostname/port are stored after startup. |
| `client.custom_methods[name]` | Handler function. |
| `client.browsers[name]` | Browser configuration fields plus live state. |
| `client.reverse_sockets[extension_id]` | Announced incoming native WebSocket, available even before the first call. |
| `record.extension_id`, `record.extension_path` | Expected extension identity and the managed copy's canonical directory. |
| `client.server` | Current native Deno reverse `HttpServer`, or unset/null when not listening. |
| `client.server_closing` | Shutdown promise while the reverse listener is stopping, otherwise unset/null. |
| `record.socket` | Current `jsrpc` connection once created. |
| `record.proc` | Owned child process; absent for external attachment. |
| `record.connecting` | In-progress connection promise, cleared after settlement. |
| `record.targets[label]` | Target options, physical `targetId`, `sessionId`, `connecting` and `setup_errors` after setup. |
| `record.target_info[targetId]` | Discovered native target info plus cached `sessionId` when attached. |
| `record.session_targets[sessionId]` | Physical `targetId` for a session. |
| `socket.pending[id]` | Response-wait promise, removed on completion. |
| `socket.id`, `socket.timeout_ms` | Request counter and effective timeout. |

```js
const record = client.browsers.main
const target = record.targets.demo
console.log(target.targetId, target.sessionId, target.binding)
console.log(target.setup_errors)
console.log(record.target_info[target.targetId])
console.log(record.session_targets[target.sessionId])
```

Mappings appear as their connection/setup steps run and are updated by events.
`target_info` and `session_targets` are rebuilt on reconnection. They are live,
mutable state, not persistent snapshots.

## Raw transport and standalone launch

This complete example bypasses the manager:

```js
import { browser, jsrpc, util } from './cdp.js'
import * as path from 'node:path'

const launched = await browser.launch({
  user_data_dir: path.resolve('./profiles/raw'),
  headless: true,
})
const socket = new jsrpc(launched.url, {
  request_timeout_ms: 10000,
})
try {
  await util.on_first(socket, 'open error close')
  console.log(await socket.req({
    method: 'Browser.getVersion',
  }, 5000))
  await socket.req({ method: 'Browser.close' })
} finally {
  socket.close()
  launched.proc.kill()
}
```

`browser.launch` builds arguments, starts the process, reads the
DevTools WebSocket URL from stderr and returns `{ proc, url }`. With `cdp_ext: true`,
it waits for process spawn instead and returns `url: undefined`; the caller must
prepare the extension and supply its directory as `extension_path`.
It does not open a CDP connection or write preference files; `update_preferences`, `preferences`
and `local_state` are manager options, ignored by this helper.
To prepare files independently, call
`browser.update_profile_preferences` explicitly before launch. The helper does
not resolve `user_data_dir` or `args['user-data-dir']`; explicit paths should be
absolute. Omitting the directory lets Chromium select its system directory,
subject to the debugging-port restrictions described above.
Readiness timeout or launch failure rejects and attempts to
terminate the spawned process.

`jsrpc` takes a WebSocket URL or an accepted native WebSocket and an options
object whose recognized option is
`request_timeout_ms` (default `30000`). Wait for the socket to open before `req`.
For an accepted socket, it returns that same WebSocket with RPC fields/methods;
it remains a native WebSocket, but need not be an instance of the `jsrpc` subclass.
The reverse server consumes the initial browser announcement before equipping
the socket with RPC behavior. Empty-text heartbeats are ignored.
The request is a raw envelope: `method`, optional `params`, and optional top-level
`sessionId`. `req` assigns its own incrementing ID even if the input contains one.
Its second argument overrides the timeout for that request. There are no browser
labels, target labels, custom methods or reconnection policy in this layer.

## Errors and timeouts

| Situation | Behavior |
| --- | --- |
| CDP returns `error` | Reject with `Error`; response in `error.cdp`, request/response in `error.cause.req` / `.ret`. |
| Page JavaScript throws during evaluation | Native result may contain `exceptionDetails`; not converted to a rejected promise. |
| Request times out | Reject with `AbortError`, clear local waiting state; Chromium may still execute the command. |
| Socket closes during a request | Reject the pending request; no automatic replay. |
| `req` before the socket opens | Reject with a connection-state error. |
| Unknown `_.` handler | Reject before browser creation. |
| Invalid profile JSON or filesystem failure | Propagate the parsing/filesystem error. |
| Failed discovery or local launch | Reject the call establishing the connection. |

```js
try {
  await client.call({
    method: 'NoSuchDomain.noSuchMethod',
    params: {
      target: 'demo',
    },
  })
} catch (error) {
  console.error(error.message)
  if (error.cdp) console.error(error.cdp.error.code)
}
```

## Development

Contributors and coding agents should read [AGENTS.md](AGENTS.md) and
[DEV_PREF.md](DEV_PREF.md). The maintained implementation is [cdp.js](cdp.js).
Planned work is tracked in [TODO.md](TODO.md).
`extra/`, when present locally, holds ignored reference files and is not part of
the tracked source or runtime dependencies.

[Manual chat monitoring](tests/chat-monitoring.md) documents the observed network
workflow for detecting new conversations and extracting connector session handles
from tool-call history. It is a caller-side recipe, not additional library API.

For npm packaging, account setup, and GitHub publishing, see
[Publishing](npm/PUBLISHING.md). Publishing copies `cdp.js`, this README and the
two `cdp_ext/` files into `npm/` alongside its manifest; no build script is needed.

```sh
node --check cdp.js
node --test tests/cdp.test.js
deno test -A tests/reverse.test.js
```

Integration tests launch local headless Chromium with disposable profiles under
`build/tests/`. Set `CDP_BROWSER` if discovery does not match the machine. Direct
library use needs no build or package installation; npm packaging is optional.
The Deno test loads the real extension into two headless Chrome instances on one
server port without remote-debugging arguments. It checks native/custom calls,
Network events, bindings, child sessions, reconnect, detach/recreate and isolation.
Extension API coverage checks granted permissions, positional arguments, nested
API receivers, synchronous/Promise/callback results, CSS/script injection, storage,
native errors (including rejection of string-valued `func`) and
false/null/undefined results.
Managed-launch coverage checks concurrent first use, profile-specific identity,
connection timeout without process replacement, lazy listener startup/shutdown
independent of direct browsers, and relaunch after confirmed exit. External reverse
timeouts release the listening port; other live reverse connections retain it.
The npm tarball contains `package.json`, `cdp.js`, `README.md` and the two extension
files required by managed reverse launches.
