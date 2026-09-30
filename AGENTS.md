# Working on cdp.js

Read the engineering preferences in [DEV_PREF.md](DEV_PREF.md) before changing
this repository. This file adds project-specific context. [README.md](README.md)
documents public behavior, defaults, configuration precedence and examples.
Apply the user's current instructions to the task at hand.

## Repository and runtime

| Path | Role |
| --- | --- |
| `cdp.js` | Complete maintained implementation, an ES module importing only Node.js built-ins. |
| `tests/cdp.test.js` | Node test-runner coverage with real headless Chromium. |
| `tests/chat-monitoring.md` | Manual application traffic inspection and tool-session extraction recipe. |
| `README.md` | User-facing API, defaults, argument/option semantics and examples. |
| `DEV_PREF.md` | Shared engineering and Git preferences; read first. |
| `AGENTS.md` | Project-specific maintenance guidance. |
| `extra/` | Optional local reference files; ignored, untracked and not imported at runtime. |
| `build/` | Ignored disposable output; tests put profiles in `build/tests/`. |
| `.gitignore` | Inverted allowlist of maintained files/directories. |

Use Node.js 22.19+ and an installed Chromium-family browser. There is no package
install, compilation step, package manifest or third-party runtime dependency.
Use `.mjs` for standalone examples and `CDP_BROWSER` to select a test executable.

Keep the implementation in the root file. Generic examples in DEV_PREF mentioning
another language or compiled-project layout are not instructions to migrate this
repository or add a build system.

## Architecture and boundaries

The declared class order is `util`, `jsrpc`, `browser`, `cdp`. All four are named
exports and are grouped in the default export.

| Component | Responsibility |
| --- | --- |
| `util` | Static event helpers, XPath string normalization and CLI object-to-string-array conversion. No CDP execution. |
| `jsrpc extends WebSocket` | Request IDs, response correlation, timeouts, close/error rejection and raw notifications. |
| `browser` | Static executable discovery, argument construction, profile-preference updates and local launch. |
| `cdp extends EventTarget` | Browser/target selection, connection lifecycle, session mappings, initialization, event routing and custom calls. |

Do not move the CDP manager into `browser`. The browser helpers operate on
options/files/processes, not CDP connections or target/session routing.
`evaluate_xpath` belongs to `cdp` because it issues `Runtime.evaluate`; only the
string rewrite belongs to `util`.

There is no Page abstraction. Browser and target records are plain data objects.
Mappings are public objects, some with null prototypes. Custom handlers are
assigned/replaced/deleted directly on `client.custom_methods`. Preserve this
access model; do not add registration methods, trivial accessors or Maps.

## Request flow

1. `cdp.call({ method, params })` dispatches `_.` names before launching or
   resolving anything. The handler receives the original `params` and has the
   `cdp` instance as `this`.
2. For native methods, remove `browser` and `target` from a copy of `params`.
   The input object must remain usable even when frozen.
3. Create a browser record on first use. Merge constructor browser defaults and
   the per-browser spec; `args` and `preferences` each get a separate shallow
   merge. Reusing a label reuses its recorded configuration.
4. `_connect` discovers an endpoint or launches a process, opens `jsrpc`, enables
   flattened auto-attachment and target discovery. Concurrent calls share
   `record.connecting`.
5. `_target` creates/reuses a physical target, attaches if needed, then runs setup.
   Calls share `entry.connecting`; the target's usable `sessionId` is assigned
   after setup completes.
6. `jsrpc.req` sends native parameters and top-level `sessionId`, returning the
   outer response's `result`. Do not unwrap nested domain data.

The browser-side functions used by `_.click`, `_.find` and `evaluate_xpath` are
serialized. They must be self-contained, without captured module variables or
Node.js helpers. XPath/options are JSON-encoded into the invocation.

## State and event invariants

| State | Meaning |
| --- | --- |
| `client.browsers[name]` | Browser configuration and live connection/process state. |
| `record.targets[label]` | Logical target configuration, binding, physical IDs and setup status. |
| `record.target_info[targetId]` | Native target information and current attached session ID. |
| `record.session_targets[sessionId]` | Reverse lookup of physical target ID. |
| `socket.pending[id]` | In-flight response wait. |

- Distinguish physical target IDs, session IDs and labels. A surviving target can
  receive a new session after reconnection.
- `_notify` updates attachment/discovery state, emits routed `notify` and native
  method events, then handles detach/destroy/crash invalidation. Do not mutate raw
  socket notifications to insert labels.
- `_detach` only invalidates local state; it sends no protocol command. Successful
  explicit detach/close requests also invalidate cached state without depending
  on notification/response ordering.
- Reset named target session IDs for a replacement connection. A call can arrive
  after `socket.close()` but before its close event. An old socket's close handler
  must not invalidate the replacement socket.
- Keep the request's session ID stable during setup. Later map changes must not
  turn a target command into a browser-level command.
- Concurrent initialization must create one connection/target per label. Failure
  must not leave a permanently rejected cached initialization promise.
- Never replay an application command after timeout/disconnect: its execution
  outcome may be unknown.
- Creating a target must preserve initial blank tabs and other tabs. Do not add
  startup-tab cleanup behavior.

## Defaults, overlap and error behavior

Preserve the defaults and explanations in README. High-level browser options
control generated flags/preferences; raw `args` and `preferences` override their
respective generated values independently. There is no cross-layer conflict
resolver. Do not add one implicitly or silently change defaults while refactoring.

Constructor options supply browser defaults, not target defaults. Per-browser
`args`/`preferences` use shallow key merges; arrays replace rather than concatenate.
Configuration objects are applied on first use of a label, not on every call.
Target configuration belongs to `params.target`.

Target setup enables configured domains, focus emulation and the target-scoped
binding; it can configure `pushMessaging` background-service recording. Runtime
defaults to bootstrap: enabled during setup, disabled afterwards. `runtime: true`
keeps reporting. `initialize: false` skips optional setup, including bindings,
but still sends `Runtime.runIfWaitingForDebugger`. Setting a setup flag false
skips an operation; it does not undo an operation already performed elsewhere.

Setup CDP errors go into `target.setup_errors`; transport errors/timeouts still
fail initialization. Normal request errors reject with the response in `error.cdp`
and request/response context in `error.cause`. Page-side JavaScript exceptions
remain native `exceptionDetails` results.

`util.on_first` handles event races/request waits. Register before an operation
can emit its event; remove losing listeners and clear timers. Preserve cleanup
on success, timeout and disconnect.

## Launch and persistence boundaries

- Keep CLI arguments as an editable key/value object without `--` until final
  `spawn` materialization. Use procedural option handling; raw `args` win.
  Every array is comma-joined. Do not add a separate disabled-feature option.
- Keep per-browser headless, extensions, images, translations and login controls.
  Image-loading control is separate from image-processing support; browser sign-in
  control is separate from website authentication.
- `port`/`http_url`/`websocket_url` attach to an existing browser. Raw
  `args['remote-debugging-port']` configures a new process.
- Profile preferences use dotted keys and preserve unrelated JSON. Only a missing
  file becomes an empty object; parsing/other filesystem errors propagate.
  Apply preferences before spawning.
- Locate `Preferences` using the effective `user-data-dir` and `profile-directory`
  arguments, including raw overrides.
- `browser.launch` returns `{ proc, url }` and opens no CDP socket. Track owned
  processes separately from attachments. Closing a manager preserves external
  browsers and profile directories. Process launch uses `windowsHide: true`.
- Browser/target/session mappings remain in memory. Profile preference files do
  not authorize adding persistence for those mappings.

## Scope and simplification

Keep the library low-level and self-contained. Do not add `package.json`, reference
utility dependencies, SQLite persistence, batch methods, image helpers, event
filtering/buffering/polling, or a Page abstraction. Native CDP pass-through remains
available; these exclusions concern library-level features. Do not introduce
references to unrelated projects in the maintained API/docs.

The explicitly requested application recipe in `tests/chat-monitoring.md` names
the services whose traffic it explains. Keep those observed schemas and connector
details in that recipe, outside the library implementation. Use synthetic values
in its examples; never copy real account/session data into documentation or tests.

Use descriptive names and one object property per line. Optimize cognitive
simplicity first, source characters second, not line count. Prefer native
constructs and established contracts over defensive scaffolding.

A size target around 15 KB was requested but has not been met. Marginal size-only
refactoring was stopped. Do not resume speculative rewrites merely to chase the
number: identify a substantial structural saving that preserves agreed features
and readable formatting. Do not minify, use opaque aliases, move code elsewhere
merely to shrink this file, or silently remove behavior. If no substantial
improvement is identified, stop and say so.

## Verification and Git workflow

Inspect the working tree and relevant code/tests before editing. Scope changes to
the task and preserve unrelated work. After a coherent implementation change:

```sh
node --check cdp.js
node --test tests/cdp.test.js
git diff --check
```

Tests use a real browser and disposable `build/tests/` profiles. Coverage includes
native results/errors, custom handlers, concurrency, XPath, event labels, bindings,
detach/close/recreation, reconnect including immediate socket reuse, independent
browsers, endpoint forms, timeout/listener cleanup, CLI overrides, preference
merging and actual Chrome translation/sign-in settings. If the browser is
unavailable, report that rather than claiming unrun checks passed.

Add tests for meaningful behavioral risks, not trivial wrappers or source-shape
assertions. For documentation-only changes, validate examples, links and API
claims; prose edits alone do not require repeated full integration runs. Keep
checks local unless workflow work was requested. There is no compiled release
artifact to produce.

Measure actual source bytes when relevant, for example in PowerShell:

```powershell
(Get-Item cdp.js).Length
```

Use LF. Do not add `.gitattributes`, EOL-conversion settings or global Git config
changes. Keep `.gitignore` inverted; allowlist maintained root files explicitly.
Keep `extra/`, generated profiles and caches ignored. Do not re-add local reference
files to Git without an explicit request. Update README for public behavior and
this file for architecture/maintenance constraints.

Follow [DEV_PREF.md](DEV_PREF.md)'s commit-and-push workflow for meaningful completed
steps when a remote exists. Review the diff and stage only intended files. Report
checks actually performed. Do not include assistant names or private/user-specific
information in commits or repository metadata.
