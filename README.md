# vdiff

Self-hosted visual regression testing for component libraries. vdiff checks out two git refs,
builds your stories at each, screenshots every story in headless Chromium and diffs the pixels.
The result is a static HTML report with side-by-side, diff and slider views. It works like Percy,
but runs entirely on your machine or CI runner, with no external service and no committed baseline images.

```
vdiff run --base origin/main          # compare the working tree with main
open ~/.cache/vdiff/<repo>-<hash>/report/index.html
```

## How it works

1. **Checkout**: base and head refs go into reusable git worktrees under `~/.cache/vdiff`.
   `--head .` (the default) uses your working tree as-is, uncommitted changes included.
2. **Build**: runs your `install` / `build` commands in each checkout. A worktree remembers the
   commit and lockfile it was built from, so re-running against the same base skips both steps.
3. **Harness**: esbuild bundles every story file into one static page. Stories can import source
   directly, or a prebuilt library (webpack, vite, …) under a package name (`bundle.importName`).
4. **Affected stories**: a story is rendered only if something in its import graph differs between
   the two sides. This is decided by file content, so it works with any build setup. When everything
   goes through one prebuilt bundle, any change to the bundle marks all stories affected. Use `--all` to
   render everything.
5. **Capture**: Playwright Chromium, a fixed clock, animations disabled, and every host blocked except
   `allowHosts`. One retry per story absorbs transient failures.
6. **Compare**: pixelmatch, and a size change counts as a change. Results go to `index.html` and
   machine-readable `summary.json`.

Exit codes: `0` no visual changes, `1` changes or story errors, `2` vdiff itself failed.

## Stories

Any module matched by `stories`. Every PascalCase named export is a story, in a loose
[Component Story Format](https://storybook.js.org/docs/api/csf) style:

```jsx
export default { component: Card, args: { title: 'Rent' } };   // optional meta

export const Primary = () => <Button label="Save" />;          // component
export const WithArgs = { args: { title: 'Deposit' } };        // args for meta.component
export const Custom = { render: (args) => <Card {...args} /> };
```

Story ids are `<file name>/<export>`, e.g. `Button/Primary`.

## Config

`vdiff.config.{ts,mts,js,mjs,json}` in the repo root, or anywhere via `--config`. Relative paths
are relative to the repo root, except `wrapper`, which is relative to the config file. `install` and `build` run
with `VDIFF_CONFIG_DIR`, `VDIFF_SIDE` (`base`/`head`) and `VDIFF_REPO` set, so a config kept
outside the repo can ship its own build scripts.

```ts
export default {
  install: 'npm ci',                // per checkout; skipped while node_modules can be linked
  linkNodeModules: true,            // symlink the repo's node_modules when the lockfile is unchanged
  build: 'npm run build:lib',       // optional
  bundle: { js: 'dist/lib.js', importName: '@acme/ui' },   // optional prebuilt library
  css: ['dist/lib.css'],            // global stylesheets; a change here affects every story
  stories: 'src/**/*.stories.tsx',
  wrapper: './vdiff.wrapper.jsx',   // default export wraps every story: ({ children, id }) => ...
  viewport: '1024x768',
  delay: 150,                       // ms to wait after render
  overrides: {                      // by file name or story id
    Modal: { viewport: '900x650', fullPage: true },
    'Tooltip/Hover': { delay: 400 },
    'Chart/Live': { skip: true }
  },
  allowHosts: ['fonts.gstatic.com'],
  now: '2024-01-15T10:00:00Z',      // Date.now() in every story
  threshold: 0.1,                   // pixelmatch colour threshold
  maxDiffRatio: 0,                  // ignore diffs up to this share of pixels
  workers: 6
};
```

See [`examples/basic`](examples/basic) for a minimal project.

## CLI

```
vdiff run [--repo .] [--config file] [--base ref] [--head ref|.] [--out dir]
          [--all] [--only Button] [--force] [--exit-zero]
vdiff compare <baseDir> <headDir> [--out dir]    # diff two folders of PNGs
vdiff clean [--repo .]                           # drop cached worktrees and builds
```

`--base` defaults to the merge-base of `HEAD` and `origin/main`.

## Docker

Fonts and anti-aliasing differ between operating systems. For results that match across
machines (and CI), run inside the pinned Playwright image:

```
docker build -t vdiff .
docker run --rm -v "$PWD:/repo" -v vdiff-cache:/cache vdiff run --base origin/main --out /repo/.vdiff-report
```

Local before/after runs on one machine are consistent without Docker, because both sides render
on the same machine.

## Roadmap

- CodeBuild integration with GitHub status and Slack reporting
- GitHub Action with a `/vdiff` PR comment command
- Page scenarios: full app routes with mocked API responses

## Development

```
npm install && npx playwright install chromium
npm test
npm run dev -- run --repo examples/basic   # run from source
```
