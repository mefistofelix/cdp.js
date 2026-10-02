# TODO

- [ ] Add a minimal optional browser extension transport integrated with `cdp.js`.
  Enable the extension in a browser profile and control the browser through a
  WebSocket proxy without `--remote-debugging-port` or `--remote-debugging-pipe`.
  Keep the existing `call({ method, params })` interface, custom methods, native
  event routing, public browser/target/session mappings, and result/error contracts.
  Target the latest Chrome and Firefox, including Camoufox as an optional browser.

  Investigate before choosing the implementation:

  - Whether the extension can host the requested WebSocket server that `cdp.js`
    connects to. Evaluate a local bridge or an extension-to-Node connection if
    extension APIs cannot listen; `4play` uses the latter direction.
  - Chrome's `chrome.debugger` command/event transport, supported CDP domains,
    browser-level commands, and tab/target/session mapping.
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
