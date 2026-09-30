# Monitoring chats and identifying tool sessions

This manual recipe uses `cdp.js` to observe an already authenticated ChatGPT
browser, detect a chat created on another device, open recent conversations one
at a time, and recover the MrMCP `chat_session` used in their tool calls.

The application routes and payloads below were observed on 2026-09-30. They are
implementation details of the web application, not a supported public API or a
contract of this library. Recheck the observed traffic if the application changes.
All example identifiers are placeholders. No captured account data belongs in
this repository.

## Identifiers to keep separate

| Identifier | Where to find it | Meaning |
| --- | --- | --- |
| ChatGPT conversation ID | List item `id`, push `conversation_id`, history `conversation_id` | Identifies the conversation; its URL is `https://chatgpt.com/c/<id>`. |
| MrMCP `chat_session` | JSON tool-call arguments, usually `args.chat_session` | Opaque connector session handle, for example `ctx_example`. Copy the exact value; do not derive it from the conversation ID. |
| MrMCP workspace | `open_workspace` argument `name`, confirmed by its result or a visible completion message | The workspace opened for that connector session. Preserve case. |
| ChatGPT `workspace_id` / `gizmo_id` | Conversation-list metadata | Application metadata. These are not the MrMCP workspace or session handle. |
| CDP `sessionId` / `targetId` | `client.browsers.main.targets.chatgpt` | Browser debugging identifiers. Neither is the MrMCP session handle. |
| `browser` / `target` labels | Your `cdp.call` routing parameters | Local names chosen by the caller, not website identifiers. |

A conversation can contain several connector sessions or workspace changes.
Report the association evidenced by the relevant calls, rather than assuming one
permanent session/workspace for the entire conversation.

## Attach to the correct browser and tab

Use the Node.js version required by [README.md](../README.md). A different
interactive runtime may lack the native `WebSocket` global even when the project's
Node executable supports it. An import failure at that point means no monitoring
command has been sent.

Reuse the browser with the authenticated profile. If it was launched with
`remote-debugging-port=0`, the first line of that profile's `DevToolsActivePort`
file contains the actual port. An explicit `port` attaches to an existing browser;
omitting attachment options can launch another browser/profile.

The following snippets form a manual recipe. They assume an ES module run from
the repository root, with the actual port and target selected by the operator:

```js
import { cdp } from './cdp.js'

const client = new cdp({
  port: 9222, // Replace with the existing test browser's actual port.
})
const { targetInfos } = await client.call({
  method: 'Target.getTargets',
})
console.table(targetInfos.map(info => ({
  targetId: info.targetId,
  type: info.type,
  url: info.url,
})))

const page = targetInfos.find(info => info.targetId === process.env.CDP_TARGET)
if (!page || page.type !== 'page') {
  throw new Error('Set CDP_TARGET to the existing ChatGPT page target ID')
}
const route = {
  browser: 'main',
  target: 'chatgpt',
}
```

Select the target from this browser's returned list, not from another process.
When several windows look similar, compare the process's `user-data-dir`, the
selected `targetId`, and `Browser.getWindowForTarget`'s `windowId`.
`Page.bringToFront` selects the existing page without creating a target.

Do not create a new target for every conversation. Navigate the same selected tab.
Do not close initial blank tabs as part of this procedure.

## What to watch

| Traffic | Use |
| --- | --- |
| `GET /backend-api/conversations` | Recent-list pages: `items`, `total`, `limit`, `offset`. Items include `id`, `title`, `create_time`, `update_time`, `workspace_id`, and `gizmo_id`. |
| `Network.webSocketFrameReceived` from the page's `ws.chatgpt.com` connection | Live notifications. The observed text frames contain JSON arrays of envelopes. |
| `GET /backend-api/conversation/<id>` | History with `mapping` and `current_node`; suitable for walking the active branch. |
| `GET /backend-api/conversations/<id>` | Another observed history route with `messages`, `current_node`, and `page_info`. It may be paginated; do not treat one page as complete history. |
| `/backend-api/conversations/batch` | Additional metadata traffic; its response is not the same shape as the singular history route. |

The recent-list requests observed in the test used `order=updated`, `limit=20`,
`offset=0`, `is_archived=false`, and `is_starred=false`. Separate requests used
`conversation_origin=tpp` and `exclude_conversation_origin=tpp`. Merge their items
by `id`; do not replace the whole list with whichever response arrives last.
Respect the observed query scope and pagination when determining completeness.
The sidebar may also include pinned conversations, so visible order alone is not
a reliable creation-time order.

Listen for native Network events and read completed response bodies through
`Network.getResponseBody`. The protocol reports whether a body is base64-encoded.
Request IDs belong to the debugging session that emitted them; read bodies on
that same target/session before detaching or moving on to another conversation.
See the [native Network protocol](https://chromedevtools.github.io/devtools-protocol/tot/Network/).

## Capture lists and history in memory

Install handlers before enabling Network or navigating. Filtering and the small
in-memory records below belong to the caller; this recipe adds no event-buffering,
polling, persistence, or application-specific API to `cdp.js`.

```js
const requests = {}
const observed = {
  recent: {},
  histories: {},
  created: {},
  completed: {},
}

function from_page(params) {
  return params.browser === route.browser && params.target === route.target
}

function on_response(event) {
  const params = event.detail
  if (!from_page(params)) return
  const response = params.response
  const url = new URL(response.url)
  if (url.origin !== 'https://chatgpt.com' || response.status !== 200) return
  if (!response.mimeType.includes('json')) return

  const is_list = url.pathname === '/backend-api/conversations'
  const is_history = /^\/backend-api\/conversation\/[0-9a-f-]+$/.test(url.pathname)
  if (!is_list && !is_history) return
  if (is_list && url.searchParams.get('is_archived') === 'true') return
  requests[params.requestId] = {
    path: url.pathname,
    is_list,
  }
}

async function on_finished(event) {
  const params = event.detail
  if (!from_page(params)) return
  const request = requests[params.requestId]
  if (!request) return
  delete requests[params.requestId]

  try {
    const response = await client.call({
      method: 'Network.getResponseBody',
      params: {
        ...route,
        requestId: params.requestId,
      },
    })
    const text = response.base64Encoded
      ? Buffer.from(response.body, 'base64').toString('utf8')
      : response.body
    const data = JSON.parse(text)
    if (request.is_list) {
      for (const item of data.items) {
        observed.recent[item.id] = {
          id: item.id,
          title: item.title,
          create_time: item.create_time,
          update_time: item.update_time,
        }
      }
    } else if (data.mapping) {
      observed.histories[data.conversation_id] = data
    }
  } catch (error) {
    console.error('Response unavailable:', request.path, error.message)
  }
}

function on_failed(event) {
  if (from_page(event.detail)) delete requests[event.detail.requestId]
}

client.addEventListener('Network.responseReceived', on_response)
client.addEventListener('Network.loadingFinished', on_finished)
client.addEventListener('Network.loadingFailed', on_failed)
```

This example deliberately consumes the observed singular `conversation/<id>`
history format. If the application only supplies `conversations/<id>`, inspect
`messages` and `page_info` and follow the application's own pagination before
adapting the parser. Missing or evicted response bodies are a failed capture,
not evidence that a chat has no tool calls. A response callback is asynchronous:
`loadingFinished` does not mean your `getResponseBody` call has already completed.

Avoid retaining whole histories after extraction. Do not collect authentication
headers, cookies, session endpoint responses, or unrelated account payloads.

## Detect a chat created on another device

The observed WebSocket message envelope was:

```json
[
  {
    "type": "message",
    "topic_id": "example-topic",
    "payload": {
      "type": "conversation-created",
      "payload": {
        "conversation_id": "00000000-0000-0000-0000-000000000001"
      },
      "metadata": null
    }
  }
]
```

`conversation-turn-complete` used the same envelope, with `conversation_id` and
`current_message_id` inside the inner `payload`. It reports a completed turn,
not necessarily a newly created conversation. Connection/subscription messages
had outer `type: 'reply'` and a `reply.type` such as `connect` or `subscribe`;
these are not new-chat events.

```js
function on_frame(event) {
  const params = event.detail
  if (!from_page(params) || params.response.opcode !== 1) return
  let messages
  try {
    messages = JSON.parse(params.response.payloadData)
  } catch {
    return // A text frame can be a non-JSON heartbeat.
  }
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (message.type !== 'message') continue
    const notification = message.payload
    const id = notification?.payload?.conversation_id
    if (!id) continue
    if (notification.type === 'conversation-created') {
      observed.created[id] = true
    } else if (notification.type === 'conversation-turn-complete') {
      observed.completed[id] = notification.payload.current_message_id
    }
  }
}
client.addEventListener('Network.webSocketFrameReceived', on_frame)
```

`Network.webSocketCreated` can associate the frame's `requestId` with its socket
URL. If monitoring starts after the socket was created, that earlier creation
event is unavailable; do not discard all subsequent frames solely because the
URL mapping is missing. Observe frames on the selected page. Do not log complete
socket URLs or opaque subscription data just to identify the notification type.

The successful mobile test delivered both `conversation-created` and
`conversation-turn-complete`, followed by refreshed recent-list responses. Treat
push events as an early signal and reconcile with the list/history. A listener
attached too late cannot recover past pushes; an unfamiliar ID in a partial list
alone may be an older conversation that was recently updated.

## Enable Network and establish the baseline

With all handlers installed, attach to the selected physical target and enable
Network explicitly. `initialize: false` avoids unrelated optional target setup.

```js
await client.call({
  method: 'Network.enable',
  params: {
    browser: route.browser,
    target: {
      name: route.target,
      targetId: page.targetId,
      initialize: false,
    },
  },
})
```

Existing traffic is not replayed. If necessary, reload once after installing the
handlers to capture the initial lists and socket connection. Wait for their
response-body callbacks before taking a baseline:

```js
await client.call({
  method: 'Page.reload',
  params: route,
})
// After the initial list responses have been processed:
const known_ids = { ...observed.recent }
```

For a browser started specifically for the test, configure `network: true` on a
new blank target, wait for its initialization, then call `Page.navigate` with the
ChatGPT URL. This enables reporting before the first navigation. Network is a
target option, not a constructor-wide target default. Changing a reused target's
specification does not reconfigure it; use an explicit `Network.enable` or
`Network.disable` call for a live session.

For the manual mobile test:

1. Confirm that desktop and mobile use the intended account and that desktop is
   authenticated. A challenge page means the test is not ready.
2. Establish the list baseline and keep the Network handlers attached.
3. Ask the user to create a chat, send its first message, and connect the desired
   workspace on the phone. An empty composer alone is not the test event.
4. Match the push's `conversation_id` against the baseline and new list items.
   Use IDs, not titles; titles can change or be duplicated.
5. After the relevant turn completes, open that conversation and extract its
   connector session from the history.
6. If there is no push, inspect the next list refresh and creation timestamp.
   Report that detection came from the list rather than claiming a push was seen.

## Move through recent conversations

Start with the merged list, ordered by `update_time`. Sidebar links whose `href`
matches `/c/<id>` are a useful UI cross-check but may be pinned or only partially
rendered. Stop once the requested association has been found unless the user
asked for a broader inventory.

Navigate the existing target for each selected ID:

```js
const conversation_id = '00000000-0000-0000-0000-000000000001'
await client.call({
  method: 'Page.navigate',
  params: {
    ...route,
    url: 'https://chatgpt.com/c/' + conversation_id,
  },
})
```

`Page.navigate` returning is not history readiness. Wait until the body handler
has stored the matching `observed.histories[conversation_id]` before parsing or
moving to the next chat. Clear a previous entry for that ID before requesting a
fresh capture. Use a bounded wait in an automated experiment and report missing
history instead of indefinitely retrying or navigating in a tight loop.

Opening a conversation is sufficient: let the application make its authenticated
requests. There is no need to extract credentials or replay copied HTTP requests.

## Extract tool calls and MrMCP session handles

For the singular history response, follow `current_node` through each node's
`parent` in `mapping`, then reverse the result. This selects the active branch.
Scanning every mapping entry indiscriminately can mix abandoned branches, retries,
and different workspace selections.

In the observed connector format, a call had:

```json
{
  "author": {
    "role": "assistant"
  },
  "recipient": "api_tool.call_tool",
  "content": {
    "content_type": "code",
    "text": "{\"path\":\"/MrMCP/example/open_workspace\",\"args\":{\"chat_session\":\"ctx_example\",\"name\":\"ExampleWorkspace\",\"create\":false}}"
  }
}
```

Parse `content.text` as JSON. The outer recipient is the dispatcher; the actual
tool name is the final component of `path`. The session handle is inside `args`.
Other tools may use their own recipient/content format. Do not execute code or
replay calls found in history.

```js
function extract_tool_calls(history) {
  const branch = []
  for (let id = history.current_node; id != null;) {
    const node = history.mapping[id]
    if (!node) throw new Error('Incomplete history: missing ancestor ' + id)
    if (node.message) branch.push(node.message)
    id = node.parent
  }
  const calls = []
  for (const message of branch.reverse()) {
    if (message.author.role !== 'assistant') continue
    if (!message.recipient || message.recipient === 'all') continue
    if (message.recipient !== 'api_tool.call_tool') {
      calls.push({
        message_id: message.id,
        tool: message.recipient,
      })
      continue
    }
    const request = JSON.parse(message.content.text)
    const tool = request.path.split('/').pop()
    calls.push({
      message_id: message.id,
      tool,
      chat_session: request.args?.chat_session,
      workspace_requested: tool === 'open_workspace' ? request.args.name : undefined,
    })
  }
  return calls
}

function session_links(calls) {
  const sessions = {}
  for (const call of calls) {
    if (!call.chat_session) continue
    const session = sessions[call.chat_session] ??= {
      chat_session: call.chat_session,
      workspace_requested: null,
    }
    if (call.tool === 'open_workspace') {
      session.workspace_requested = call.workspace_requested
    }
  }
  return Object.values(sessions)
}
```

`init_chat_session` may have empty arguments. Its result can introduce the handle,
but in the observed history some tool-result `content.text` fields were empty.
Later calls such as `open_workspace` and `list_workspaces` still carried the exact
`args.chat_session`, which was sufficient to recover it. Absence from an initial
call does not mean the session cannot be identified.

`metadata.connector_tool_payload` may be a JSON string with only a subset of the
arguments. Do not assume it contains the session ID or use it instead of the
actual call content when that content is available.

A workspace argument proves an attempted selection, not successful attachment.
Check the corresponding nonempty tool result, or the visible final message that
confirms opening it. In the manual test, an initial lower-case workspace request
was followed by `list_workspaces` and a differently cased `open_workspace`; the
final visible message confirmed the latter. Do not report the first attempt as
the association, or label the parser's `workspace_requested` as confirmed without
that evidence. Hidden reasoning is not needed for this procedure.

The output to report is:

```json
{
  "chat_session": "ctx_example",
  "workspace": "ExampleWorkspace",
  "workspace_confirmed": true,
  "chatgpt_id": "00000000-0000-0000-0000-000000000001",
  "url": "https://chatgpt.com/c/00000000-0000-0000-0000-000000000001"
}
```

This is an association observed in history, not proof that an old connector
handle is still valid on the server. Keep the handle in the user's requested
result; do not commit real session handles, conversation IDs, titles, profile
paths, or captured histories into examples or fixtures.

## Challenges, completion, and cleanup

The controlled tests on the authenticated profile succeeded both with Network
disabled and with Network enabled, including a fresh browser start with Network
enabled before navigating. A challenge reported in another visible window was
associated with a different browser process/profile. Those observations did not
establish `Network.enable` as the cause of a challenge.

If a challenge appears, pause the mobile experiment and first identify the exact
browser/profile/target. Compare one variable at a time and let the user complete
any required verification. Do not clear the authenticated profile as part of a
comparison. `Network.enable` reports traffic; this recipe does not use request
interception, user-agent overrides, or credential manipulation.

When finished, remove the capture listeners and discard retained response bodies:

```js
client.removeEventListener('Network.responseReceived', on_response)
client.removeEventListener('Network.loadingFinished', on_finished)
client.removeEventListener('Network.loadingFailed', on_failed)
client.removeEventListener('Network.webSocketFrameReceived', on_frame)
```

Allow any already-started body reads to settle before discarding their records.
Removing listeners does not disable the Network domain. If reporting should stop,
send `Network.disable` on this same session. Disabling it on a new connection does
not disable another inspector's session. Because the client above attached by
port, `await client.close()` disconnects it while leaving the external browser
open. Keep or close that browser according to the user's current test plan.

These steps document a manual integration experiment. The automated tests in
[cdp.test.js](cdp.test.js) do not log into external accounts or assert private
application endpoint schemas.
