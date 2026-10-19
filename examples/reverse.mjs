import { cdp } from '../cdp.js'

const client = new cdp({
  cdp_ext: true,
  user_data_dir: '.cdp/example',
  connect_timeout_ms: 60000,
})
process.once('SIGINT', () => client.close())
console.log('Launching Chrome with cdp_ext; Ctrl+C closes Chrome and the server.')
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
await client.server?.finished
