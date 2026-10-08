# TODO

- [x] Add a minimal Chrome extension reverse transport integrated with `cdp.js`:
  `cdp_ext/` connects to one native Deno WebSocket server, announces its native
  extension ID and reuses the existing call/session/event transport. Managed
  `cdp_ext: true` launches associate that ID with a logical browser name and keep
  live processes through transport failures. Real headless Chrome
  tests cover two browsers on the same port without remote-debugging arguments.
- [ ] Replace path-derived reverse registration with launch-URL bootstrap so one
  extension directory can serve multiple browser instances. Pass the logical
  browser name and shared WebSocket endpoint in a recognizable local URL, such as
  `http://127.0.0.1:0/cdp_ext?browser=work&websocket_url=...`.
  Read startup tabs and URL changes through extension tabs APIs; do not depend on
  executable paths or `chrome.runtime.id` for browser-instance identity.
  Registration then echoes the bootstrap browser name. Retain bootstrap settings
  through worker restarts without persisting manager session/target mappings.

  A local real-Chrome probe verified that a normal already running instance accepts
  this URL and exposes its parameters to extension tabs queries, with or without
  `no-default-browser-check`; the forwarding launcher exits while Chrome remains
  alive. Current Chromium rejects process-singleton forwarding if either command
  line uses `enable-automation` or headless mode. The existing launch preset enables
  automation, so reuse needs deliberate argument handling. Keep isolated headless
  launch coverage and add normal-browser reuse coverage with automation disabled.

  Handle an already installed/active extension separately from startup loading:
  an existing browser does not apply a new process's extension-loading switches.
  Distinguish a short-lived forwarding launcher from an owned browser process,
  and preserve external Chrome on manager close. Decide how another logical name
  for the same live instance should map to the existing record; avoid pretending
  it is a second physical browser or silently invalidating the previous name.
- [ ] Extend the optional browser extension transport to Firefox/Camoufox.
  Enable the extension in a browser profile and control the browser through a
  WebSocket proxy without `--remote-debugging-port` or `--remote-debugging-pipe`.
  Keep the existing `call({ method, params })` interface, custom methods, native
  event routing, public browser/target/session mappings, and result/error contracts.
  Chrome is implemented with restricted debugger domains; Firefox, including
  Camoufox as an optional browser, still needs a different backend.

  Investigate before choosing the implementation:

  - Keep the extension-to-server direction and first instance-ID announcement
    used by the Chrome implementation; one listener serves multiple browsers.
  - A Firefox/Camoufox backend using available extension APIs, with protocol
    translation where needed. Assess WebDriver BiDi or a native bridge if needed;
    do not assume Firefox exposes Chrome's debugger API or full CDP parity.
    Document the supported command subset and explicit unsupported-command errors.
  - Profile installation and activation, Chrome Manifest V3 background lifecycle,
    WebSocket lifetime/reconnection, Firefox extension loading, and actual Camoufox
    compatibility, including headless operation.

  Keep the extension and bridge small, preserve the existing direct CDP transport,
  and verify the common API against real current Chrome and Firefox/Camoufox.

  References:

  - [Hacker News discussion](https://news.ycombinator.com/item?id=49929970)
    about an extension communicating with a browser driver over WebSockets.
  - [4play](https://git.lolcat.ca/lolcat/4play), a Firefox extension that connects
    to a WebSocket server and translates commands to extension operations.
  - [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger),
    an alternative CDP transport with restricted domains.
  - [Firefox remote protocols](https://firefox-source-docs.mozilla.org/remote/),
    covering Marionette and WebDriver BiDi.
