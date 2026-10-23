const port = chrome.runtime.connect({ name: 'cdp_debug' })
const status = document.querySelector('#status')
const heartbeat = setInterval(() => port.postMessage('ping'), 20000)
if (location.search === '?connection') {
  document.title = 'CDP.js connection'
  document.querySelector('h1').textContent = document.title
  document.querySelector('#connection-message').hidden = false
}

port.onMessage.addListener(state => {
  status.textContent = state.status
  status.classList.toggle('connected', state.connected)
  for (const [id, value] of Object.entries({
    browser: state.browser,
    endpoint: state.endpoint,
    extension: state.extension_id,
    sessions: state.sessions,
    debugger_tabs: state.debugger_tabs ?? 0,
  })) document.getElementById(id).textContent = value === '' ? '—' : value
  document.querySelector('#empty').hidden = state.commands.length > 0
  document.querySelector('#commands').replaceChildren(...state.commands.map(command => {
    const row = document.createElement('li')
    const method = document.createElement('strong')
    method.textContent = command.method
    const details = document.createElement('small')
    details.textContent = [
      new Date(command.time).toLocaleTimeString(),
      command.id == null ? (command.method === 'cdp_ext.trigger' ? 'trigger' : 'notification') : '#' + command.id,
      command.sessionId ? 'session ' + command.sessionId : 'browser',
      command.status,
      command.execution_mode,
      command.tabId == null ? '' : 'tab ' + command.tabId,
      command.browser,
      command.endpoint,
      command.action,
      command.duration_ms == null ? '' : command.duration_ms + ' ms',
    ].filter(Boolean).join(' · ')
    row.append(method, details)
    if (command.error) {
      const error = document.createElement('p')
      error.className = 'error'
      error.textContent = command.error
      row.append(error)
    }
    return row
  }))
})
port.onDisconnect.addListener(() => {
  clearInterval(heartbeat)
  status.textContent = 'Extension disconnected. Reopen this panel after reloading the extension.'
  status.classList.remove('connected')
  document.querySelector('#clear').disabled = true
})
document.querySelector('#clear').addEventListener('click', () => port.postMessage('clear'))
