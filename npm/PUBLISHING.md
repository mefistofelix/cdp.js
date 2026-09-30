# Publishing the npm package

The package is `@mefistofelix/cdp.js`. Its version and metadata live in
[package.json](package.json), outside the repository root. The published entry
point is the original `cdp.js`, including its named and default exports. There is
no compilation, wrapper module, lockfile, or runtime dependency.

The packaging layout follows the separate `npm/` manifest and GitHub Actions OIDC
approach used by [auto.js](https://github.com/mefistofelix/auto.js). Preparation
copies only the manifest, `cdp.js`, and the root README into disposable `build/npm`.
The manifest's `files` allowlist further limits the npm archive; npm includes the
manifest and README automatically. Profiles, tests, local references, development
instructions, and downloaded tools are not package contents.

## Prepare and inspect

On Windows, run from the repository root:

```powershell
.\build.bat
```

The script uses an existing Node executable or downloads portable Node 24.19.0
for Windows x64 if Node is missing. It caches npm 11.20.0 under `tools/`, skips
downloads already present, and creates `build/mefistofelix-cdp.js-0.1.0.tgz` for
the initial version. Both `tools/` and `build/` are disposable and ignored.
It does not log in or publish.

With Node.js and npm already available, the cross-platform equivalent is:

```sh
node npm/prepare.mjs
npm pack ./build/npm --pack-destination ./build
```

Before publishing, inspect the archive and run the local checks:

```sh
node --check cdp.js
node --test tests/cdp.test.js
npm pack ./build/npm --dry-run
```

The package should contain exactly `package.json`, `cdp.js`, and `README.md`.
An installed Chromium-family browser is required for the integration tests.
The package itself requires Node.js 22.19 or later.

## First publication

A new package must exist on npm before its trusted publisher can be configured.
Perform its first publication through the existing npm account. On this setup,
the portable CLI can be invoked explicitly without a global npm installation:

```powershell
node tools/npm-11.20.0/bin/npm-cli.js login --auth-type=web --registry=https://registry.npmjs.org/
node tools/npm-11.20.0/bin/npm-cli.js whoami --registry=https://registry.npmjs.org/
node tools/npm-11.20.0/bin/npm-cli.js publish ./build/mefistofelix-cdp.js-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
```

Complete login and any publishing verification directly in npm's browser flow.
Use the account with publishing rights to the `@mefistofelix` scope. Never paste
credentials or verification codes into repository files. If Node was bootstrapped
because it was absent from PATH, replace `node` in these commands with
`.\tools\node-v24.19.0-win-x64\node.exe`.

Publishing is public even while the GitHub repository remains private. Publishing
does not change repository visibility. No license grant is added by the packaging
metadata; the repository currently has no declared license.

Verify the result:

```sh
npm view @mefistofelix/cdp.js version dist.tarball
```

## Configure GitHub as a trusted publisher

After the first publication, open the package's npm settings and add a GitHub
Actions trusted publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization or user | `mefistofelix` |
| Repository | `cdp.js` |
| Workflow filename | `npm.yml` |
| Environment | Leave empty; this workflow does not use a named environment. |
| Allowed publishing action | Enable direct `npm publish`. |

Alternatively, npm 11.20.0 supports the corresponding CLI command:

```sh
npm trust github @mefistofelix/cdp.js --repository mefistofelix/cdp.js --file npm.yml --allow-publish
```

The CLI trust configuration requires account-level 2FA and an existing package.
The publisher authorization is per package: the configuration for another package
does not automatically authorize this one. See [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

The [workflow](../.github/workflows/npm.yml) uses GitHub's short-lived OIDC identity
and `id-token: write`; no npm publishing token is stored in GitHub secrets. Its
checkout authenticates with the job's read-only repository token so a private
repository works too. The workflow does not force `--provenance`: npm cannot
generate provenance from a private source repository. For a public source
repository and public package, trusted publishing can generate it automatically.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Later releases

1. Update `version` in `npm/package.json` and review the source/documentation.
2. Run the local checks, prepare the package, and inspect its contents.
3. Commit and push the intended release changes.
4. Run the `npm` workflow manually from GitHub Actions or through the CLI:

```sh
gh workflow run npm.yml --ref master
```

The workflow builds from the selected commit and publishes its manifest version.
Do not dispatch `0.1.0` after publishing that same version locally: npm versions
are immutable. Use the next version for the next release.

The tag trigger is present but commented out for explicit opt-in. To publish on
version tags as well, enable that `push.tags` block and push a tag such as `v0.1.1`
only after the package version matches. `prepare.mjs` rejects a mismatched tag.
Routine branch pushes do not publish packages. The workflow performs packaging
and publication; the browser integration suite is run locally.
