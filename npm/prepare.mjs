import * as fs from 'node:fs/promises'

const manifest = JSON.parse(await fs.readFile(new URL('package.json', import.meta.url), 'utf8'))
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v' + manifest.version) {
  throw new Error('Release tag must match npm/package.json version: v' + manifest.version)
}

const destination = new URL('../build/npm/', import.meta.url)
await fs.mkdir(destination, { recursive: true })
await fs.copyFile(new URL('package.json', import.meta.url), new URL('package.json', destination))
for (const filename of ['cdp.js', 'README.md']) {
  await fs.copyFile(new URL('../' + filename, import.meta.url), new URL(filename, destination))
}
console.log('Prepared ' + manifest.name + '@' + manifest.version + ' in build/npm')
