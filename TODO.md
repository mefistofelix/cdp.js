# TODO

- [x] Add a minimal Chrome extension reverse transport integrated with `cdp.js`:
  `cdp_ext/` connects to one native Deno WebSocket server, announces the browser
  label and reuses the existing call/session/event transport. Real headless Chrome
  tests cover two browsers on the same port without remote-debugging arguments.
- [ ] Extend the optional browser extension transport to Firefox/Camoufox.
  Enable the extension in a browser profile and control the browser through a
  WebSocket proxy without `--remote-debugging-port` or `--remote-debugging-pipe`.
  Keep the existing `call({ method, params })` interface, custom methods, native
  event routing, public browser/target/session mappings, and result/error contracts.
  Chrome is implemented with restricted debugger domains; Firefox, including
  Camoufox as an optional browser, still needs a different backend.

  Investigate before choosing the implementation:

  - Keep the extension-to-server direction and first browser-label announcement
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
