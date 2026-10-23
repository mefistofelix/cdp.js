import { cdp } from '../cdp.js'
import * as path from 'node:path'

const client = new cdp({
  cdp_ext: true,
  user_data_dir: path.resolve('.cdp/example'),
  connect_timeout_ms: 60000,
})
process.once('SIGINT', () => client.close())
console.log('Launching Chrome with cdp_ext; Ctrl+C closes Chrome and the server.')
try {
  console.log(await client.call({ method: 'Browser.getVersion' }))
  // Select/create a target through extension APIs, without a debugger.
  console.log(await client.call({
    method: 'chrome.tabs.query',
    params: {
      target: 'demo',
      args: [{}],
    },
  }))
  console.log('Click the CDP reverse connection extension icon to open its debug sidebar.')
  // Explicit native CDP attaches the debugger even on this default API target.
  console.log(await client.call({
    method: 'Runtime.evaluate',
    params: {
      target: 'demo',
      expression: '21 * 2',
    },
  }))
} catch (error) {
  await client.close()
  throw error
}
await client.server?.finished
