## Engineering preferences

These principles apply across languages, runtimes, and frameworks.

### Simplicity and readability

- Optimize for cognitive simplicity first and source size (characters) second, not for fewer lines.
- Keep code minimal and readable. Do not use code golf or compress unrelated operations onto one line.
- Format objects and option lists with one property per line and clear indentation. Do not pack multiple fields onto one line to save space.
- Let each line express one clear idea.
- Prefer guard clauses for empty, error, and exceptional cases so the main path stays flat.
- Prefer structured data transformations over clever string manipulation.
- Use descriptive names. Do not introduce short aliases solely to reduce repetition.

### Native constructs and dependencies

- Prefer direct language, runtime, and standard-library features over wrappers or custom replacements.
- Do not introduce third-party dependencies without explicit approval.
- Rely on native validation, errors, and defaults instead of reimplementing them.
- Keep the origin of an operation visible when qualification improves clarity. Prefer repeating a short, meaningful qualified path such as `backend.foo` at each use instead of destructuring or aliasing it merely to remove repetition. Shorten an access path only when it is genuinely long, noisy, and low in semantic value. When several frequently used branches share a long prefix, alias the deepest common prefix that still has useful meaning, even if that prefix is two or three levels deep, and keep the branches below it visible. For example, prefer `const symbols = library.subsystem.symbols; symbols.open(); symbols.close(); symbols.read();` over destructuring `open`, `close`, and `read` into separate leaf aliases. Do not flatten a namespace just because several leaves are used. Keep the common-prefix alias as local as practical, but file-level scope is appropriate when that same prefix is used broadly throughout the file. Avoid redundant qualification when the imported symbol already communicates its origin.
- Do not hide ordinary public fields or attributes behind trivial accessors or properties.
- In languages with type inference, avoid redundant annotations. Keep types where required or where they clarify a public boundary.

### Abstractions and boundaries

- Add helpers, abstractions, validation layers, comments, or documentation only when they solve a concrete problem.
- Prefer a few obvious duplicated lines over an abstraction that hides semantics.
- Keep abstraction boundaries strict: lower layers expose generic representations; higher layers translate domain- or protocol-specific concepts.
- Generic parsers and formatters must not branch on concrete drivers unless that syntax belongs to the generic layer.
- At protocol boundaries, prefer a structured argument when a low-level function signature would otherwise keep growing.
- Assume established internal data contracts. Do not add machinery for every theoretical malformed input.

### Errors and concurrency

- Handle errors when they affect program logic or when additional context is actionable. Otherwise, let native errors propagate.
- Do not add broad catches, defensive checks, or fallback behavior merely to suppress possible errors.
- Do not wrap synchronous or blocking APIs in asynchronous functions unless real concurrency is required.
- When blocking work must coexist with asynchronous code, make the boundary explicit at the caller using the language's standard thread or executor mechanism.

---

## tools to use during developement
- Keep extra programs unavailable in the current OS/environment standalone and
  portable under `tools/`. Treat the entire `tools/` directory as a disposable
  download cache: deleting it must never delete unique project work, and the
  documented build/setup path must recreate the required programs.
- Never put hand-maintained scripts, source, manifests, lockfiles, configuration,
  or patches in `tools/`. Put those files in the project root (or another
  explicitly maintained source directory) and point them at `tools/` when they
  need a downloaded executable.
- Maintain exactly one Windows setup/build script, root `build.bat`. It must
  install every missing project-local SDK or portable build tool needed by the
  requested build, skip components already present, set the MSVC/Windows SDK
  environment for Windows builds, then run the build. Do not split setup across
  more batch files and do not add PowerShell scripts. Download with the
  `curl.exe` already included in Windows; use portable `hx` from
  https://github.com/mefistofelix/hx only if `curl.exe` cannot meet a concrete need.
- for python use uv
- When Microsoft Visual C/C++ and the Windows SDK are needed, use the portable
  `msvcup` tool from https://github.com/mefistofelix/msvcup. Keep the standalone
  tool under `tools/` and its downloadable toolchain under disposable `build/`;
  do not install Visual Studio globally just to obtain a compiler.

---

## common project folder structure

- The project root holds authoritative editable manifests, lockfiles,
  configuration, and `build.sh`, alongside the project directories.
- `src/` holds only human-maintained product source code. Keep it as simple as
  the product allows; this project currently uses one Dart file.
- `tools/` holds only downloadable portable programs needed when an equivalent
  tool is not available in the environment. The build/setup scripts must be
  able to recreate it after deletion; it contains no unique project files.
- Editable build scripts live in the project root. Windows setup and builds
  enter through the single root `build.bat`.
- `tests/` holds human-maintained test source; `examples/` holds examples.
- `build/` is entirely disposable. It may contain downloaded SDKs, generated
  host projects and native runners, caches, copied source, and build outputs.
  It must contain no unique source, dependency manifest, lockfile, or
  configuration. Deleting all of `build/` must lose no information needed to
  rebuild the application after the required SDKs are reinstalled; `build.sh`
  recreates its generated contents from authoritative files outside `build/`.

---

## git/vcs
- commit and push if we have a remote repo at each meaninful incremental step
- tag to trigger workflows on github only at meaningful milestones
- verify local git/vcs has no problems with changing crlf of files, under windows if there are problems ask before changing the global settings to leave files as they are, and then always use linux lf eols, never use .gitattributes for this never use git auto eol conversions confs
- keep .gitingnore inverted like specify what to include not to exclude
---

## GitHub

- Never mention Codex, Claude, ChatGPT, or any other agent/assistant name in commit messages, commit authorship, or repository metadata.
- Never expose user-specific or private information in repositories, commits, issues, releases, logs, or generated artifacts.
- Use `git` by default; `jj` is an acceptable alternative when it is already part of the workflow.
- Use the `gh` CLI for GitHub-specific operations such as releases, workflow inspection, issues, pull requests, and API access.

### Workflow preferences

- Prefer commands already available on GitHub-hosted runners, especially `git` and `gh`.
- During a substantial implementation or port, finish a coherent block of work
  before running analysis, tests and builds. Group verification at the end;
  rerun checks only to resolve failures or a concrete remaining risk. Deliver
  an executable matching the final source when the task includes the application.
- Avoid `uses:` actions, including convenience wrappers such as `actions/checkout`; use direct commands instead unless an action is explicitly required.
- Keep `push:` present but commented out when useful for quick opt-in CI, and include `workflow_dispatch:` so the workflow can always be triggered manually.
- Keep workflow YAML minimal. Do not embed substantial shell or application logic in the workflow; delegate real work to repository scripts such as `build.sh`.
- After checkout, ensure repository shell scripts are executable before invoking them.
- Fetch only the commit needed by the job whenever full history is unnecessary. Prefer a shallow checkout such as `--depth=1`.
- Prefer release steps to behave as an upsert so rerunning the same version or commit is convenient: create the release when it does not exist, otherwise upload the artifacts to the existing release with replacement enabled (for example `gh release create ... || gh release upload ... --clobber`).
- if possible crosscompile from a linux worker for the other platforms
- by default if not needed dont execute tests or other things in github actions, mainly use it to produce release artifacts

```yaml
name: 'ci'
on:
  #push:
  workflow_dispatch:
jobs:
  build-release:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: |
          git init
          git remote add origin $GITHUB_SERVER_URL/$GITHUB_REPOSITORY
          git fetch origin --depth=1 $GITHUB_SHA
          git checkout $GITHUB_SHA
      - run: |
          shopt -s globstar
          chmod +x ./**/*.sh
          ./build.sh
      - env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_SHA:0:12}" ./bin/bip --target "$GITHUB_SHA" ||
          gh release upload "${GITHUB_SHA:0:12}" ./bin/bip --clobber
```

### Interactive debugging on GitHub Actions runners

- For debugging on another operating system, create a dedicated minimal ad hoc workflow for the target runner platform.
- In that workflow, download the appropriate `pigeons` binary from the `n0-computer/pigeons` GitHub releases and start the tunnel directly from the job.
- Monitor the workflow log to obtain the tunnel information, then connect from the local machine using `pigeons` locally as well.
- Once connected, run only the commands needed to reproduce, inspect, and debug the problem on that platform.
- Keep these sessions short and purposeful because hosted-runner time is limited. The goal is to shorten the cross-platform debug loop, not to use CI runners as long-lived development machines.
