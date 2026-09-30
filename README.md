# cdp.js

A low-level Chromium DevTools Protocol library for Node.js. One ES module,
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
supported by the connected browser remains available through `call`.

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
| `client.close()` | Close owned browser processes, disconnect attached browsers, then clear `client.browsers`. Profile directories remain. |
| `new jsrpc(url, options = {})` | Open a raw WebSocket JSON-RPC connection. |
| `socket.req(request, timeout_ms)` | Assign a request ID and await its native result. |
| `socket.notify(request)` | Serialize and send a raw message; no ID allocation or response wait. |
| `socket.close()` | Native WebSocket close; does not terminate the browser. |
| `browser.find_executable_path()` | Synchronously return an executable path from the environment or common locations. |
| `browser.build_args(options = {})` | Return a fresh, editable object of launch switches. |
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
| `method` | Native name such as `Page.navigate`, or a custom name beginning with `_.`. |
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

`args` and `preferences` are shallow-merged separately between steps 2 and 3.
For duplicate keys, the per-browser value wins. Arrays replace previous arrays;
they are not concatenated during this merge.

At local launch, another two independent merges happen:

- Generated CLI defaults, adjusted by high-level browser options, then raw `args`.
- Generated profile preference defaults, then raw `preferences`.

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
| `name` | string, `'main'` when routing is omitted | Required in a browser configuration object; dictionary key and default profile directory label. |
| `user_data_dir` | absolute path string, `<base_path>/<name>` | Chromium user-data directory containing profiles such as `Default`. The generated default is absolute; explicit overrides should be absolute too. |
| `executable_path` | string, automatic discovery | Executable to spawn; takes precedence over `CDP_BROWSER`. |
| `headless` | boolean, `false` | When true, add `headless: 'new'` and default `window-size: '1440,900'`. |
| `extensions` | boolean, `false` | When true, omit the two extension-disabling switches; does not install extensions. |
| `images` | boolean, `true` | When false, request `blink-settings: 'imagesEnabled=false'`; controls loading, not image processing. |
| `translations` | boolean, `false` | Set translation preferences and, unless true, disable translation feature IDs. |
| `login` | boolean, `false` | Set browser sign-in preferences and, unless true, disable sync and sign-in promotions. Does not prevent website login. |
| `args` | object, `{}` | Raw CLI overrides applied after generated defaults; keys omit `--`. |
| `preferences` | object, `{}` | Dotted JSON preference overrides applied after generated preference defaults. |
| `connect_timeout_ms` | number, `15000` | Timeout for each discovery, launch-readiness or socket-opening wait; not one combined deadline. |
| `request_timeout_ms` | number, `30000` | Default timeout for each protocol request on this browser's socket. |
| `websocket_url` | string, unset | Attach directly to a browser WebSocket endpoint. |
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

`websocket_url` takes precedence over HTTP discovery; `http_url` takes precedence
over `host`/`port`. Use one endpoint form:

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

The existing browser must already expose CDP. Launch flags and profile
preferences are not applied to it. `client.close()` disconnects its socket and
leaves that browser running.

`port: 9222` means **attach**. To **launch** on that port, use
`args: { 'remote-debugging-port': 9222 }` without an attachment endpoint.

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
| `disable-extensions` | `true` unless `extensions` is true | Disable browser extensions. |
| `disable-component-extensions-with-background-pages` | same condition | Disable those component extensions. |
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
`args['disable-features']` replaces that entire generated array.

## Profile preferences

Local launch edits the profile's JSON `Preferences` file before spawning
Chromium. The effective path is:

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

## Overlaps and override examples

| Settings | Effective library behavior |
| --- | --- |
| `headless: true` plus `args.headless: false` | Omit `--headless`; the generated window-size argument remains unless also overridden. |
| `headless: false` plus `args.headless: 'new'` | Send `--headless=new`; no automatic headless window-size default was generated. |
| `extensions: true` plus `args['disable-extensions']: true` | The raw extension-disabling switch still wins. |
| `extensions: false` plus only `args['disable-extensions']: false` | Remove that flag, but retain `disable-component-extensions-with-background-pages`. Use `extensions: true` to omit both generated flags. |
| `images: false` plus an overridden `blink-settings` | Replace the whole string; image disabling is not appended to the caller's value. |
| `translations: false` plus `preferences['translate.enabled']: true` | Store true in the profile, while generated translation-disabling feature IDs remain on the CLI. |
| `login: true` plus `args['disable-sync']: true` | Allow profile sign-in through generated preferences while still requesting sync to be disabled. |
| Any high-level settings plus a raw `disable-features` array | Replace the whole generated list, including translation/sign-in additions. |
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
`Runtime.runIfWaitingForDebugger` is still sent at the end. Auto-attachment uses
`waitForDebuggerOnStart: false`.

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
| `client.options` | Constructor browser defaults, excluding `base_path`. |
| `client.custom_methods[name]` | Handler function. |
| `client.browsers[name]` | Browser configuration fields plus live state. |
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

`browser.launch` requires a usable absolute directory through `user_data_dir` or
`args['user-data-dir']`; this helper does not resolve that path for you. It writes
preferences, starts the process, reads the
DevTools WebSocket URL from stderr and returns `{ proc, url }`. It does not open
a CDP connection. Readiness timeout or launch failure rejects and attempts to
terminate the spawned process.

`jsrpc` takes a WebSocket URL and an options object whose recognized option is
`request_timeout_ms` (default `30000`). Wait for the socket to open before `req`.
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
`extra/`, when present locally, holds ignored reference files and is not part of
the tracked source or runtime dependencies.

[Manual chat monitoring](tests/chat-monitoring.md) documents the observed network
workflow for detecting new conversations and extracting connector session handles
from tool-call history. It is a caller-side recipe, not additional library API.

For npm packaging, account setup, and GitHub publishing, see
[Publishing](npm/PUBLISHING.md). Publishing only copies `cdp.js` and this README
into `npm/` alongside its manifest; no build script is needed.

```sh
node --check cdp.js
node --test tests/cdp.test.js
```

Integration tests launch local headless Chromium with disposable profiles under
`build/tests/`. Set `CDP_BROWSER` if discovery does not match the machine. Direct
library use needs no build or package installation; npm packaging is optional.
