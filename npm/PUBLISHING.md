# Publishing the npm package

The package is `@mefistofelix/cdp.js`. Its version and metadata live in
[package.json](package.json), outside the repository root. The entry point is the
original `cdp.js`, with the same named and default exports and no dependencies.

Following [auto.js](https://github.com/mefistofelix/auto.js), publication copies
`cdp.js` and the root README into `npm/`, then publishes that directory. The copies
are ignored by Git. There is no compilation, build script, or wrapper module.

## Release through GitHub

OIDC is configured for this package and the [npm workflow](../.github/workflows/npm.yml).
Version `0.1.0` is already published. For the next release:

1. Update `version` in `npm/package.json` and review the changes.
2. Run the local checks below. Inspect the package if its contents changed.
3. Commit and push, then run:

```sh
gh workflow run npm.yml --ref master
```

The workflow copies the two files and publishes the selected commit's manifest
version. npm versions are immutable: do not rerun publication of the same version.
Routine pushes do not publish. The optional tag trigger is commented out; if
enabled, keep each `v` tag consistent with the manifest version.

## Local checks and package inspection

Use Node.js 22.19 or later, npm, and an installed Chromium-family browser:

```sh
node --check cdp.js
node --test tests/cdp.test.js
```

Copy the two files from the repository root. In PowerShell:

```powershell
Copy-Item cdp.js, README.md npm/
```

On Linux or macOS:

```sh
cp cdp.js README.md npm/
```

Then inspect without publishing:

```sh
npm pack ./npm --dry-run
```

The archive must contain exactly `package.json`, `cdp.js`, and `README.md`.
The manifest's `files` allowlist includes the source; npm includes the manifest
and README automatically. Tests, profiles, tools, and local references stay out.
Use `npm pack ./npm` to create a local archive if needed.

## Authentication and trusted publisher

This setup is already complete. These are the settings used on npm:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `mefistofelix` |
| Repository | `cdp.js` |
| Workflow filename | `npm.yml` |
| Environment | Empty |
| Allowed publishing action | Direct `npm publish` enabled |

The workflow uses `id-token: write` and npm 11.20.0 for OIDC. No npm token is
needed in GitHub secrets. Checkout uses the job's read-only repository token,
so the GitHub repository can remain private. The workflow does not force
`--provenance`: automatic provenance requires a public source repository and
public package. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For a new package, first publish through the npm account, then configure trust:

```sh
npm login
npm publish ./npm --access public
npm trust github @mefistofelix/cdp.js --repository mefistofelix/cdp.js --file npm.yml --allow-publish
```

Copy the files before publishing locally. Complete npm's verification in the
browser. The trust command requires npm 11.15+ and account-level 2FA; see
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
To use the portable npm already downloaded on this machine, replace `npm` with
`node tools/npm-11.20.0/bin/npm-cli.js`.

Publishing is public and does not change GitHub repository visibility. The
repository currently has no declared license; packaging adds no license grant.
