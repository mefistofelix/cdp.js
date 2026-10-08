import { cdp } from '../cdp.js'

const client = new cdp({
  reverse: true,
  connect_timeout_ms: 60000,
})
const server = client.listen_reverse()
Deno.addSignalListener('SIGINT', () => client.close())
console.log('Waiting for cdp_ext in Chrome; Ctrl+C closes the server.')
try {
  console.log(await client.call({ method: 'Browser.getVersion' }))
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
await server.finished
