# Agent guidance

Signal K plugin that streams a browser-rendered dashboard to an espOS panel
(ESP32-P4) as ACK-paced MJPEG over TCP with a UDP touch backchannel. The
capture chain (Xvfb + Chromium kiosk + ffmpeg + `container/capture-server-ack.py`)
runs in a container managed through signalk-container, via
signalk-container-helper. Successor to `signalk-esp32-stream`, whose
host-level systemd chain this replaces.

## Licensing

The project is licensed under the Apache License 2.0 (`LICENSE`), like the
other signalk-espOS repositories, and `package.json` says `"license":
"Apache-2.0"`. Contributions come in under the same licence. Runtime and
bundled dependency licences still gate additions: `dependencies` and anything
webpack bundles into `public/` ship to users.

## Architecture rules

- **ESM only, strict TypeScript.** `"type": "module"`, NodeNext resolution
  with `.js` extensions on relative imports in `src/` (the panel under
  `src/configpanel/` is bundler-resolved TSX, extensionless imports, compiled
  by babel via webpack and typechecked by `tsconfig.panel.json`).
- **signalk-container is a runtime peer, never a dependency.** It is declared
  via `"signalk": { "requires": ["signalk-container"] }`; coupling happens
  through `globalThis.__signalk_containerManager` (the helper wraps this).
  Never import it at compile time.
- **The container uses host networking** (`networkMode: "host"`). Do not add
  `ports` or `signalkAccessiblePorts` to the container config — the manager
  treats them as mutually exclusive with networkMode. This is why readiness
  is a manual `waitForHttpReady` against the loopback health port rather
  than the helper's `readiness` option.
- **Never probe the stream TCP port for health.** The capture server accepts
  one client at a time; a probe connection would be served as the panel and
  lock it out for a full ACK-timeout window. `/health` on the loopback
  health port is the only health signal.
- **`buildContainerConfig` must stay pure and stable.** The `command` array
  is always fully present; conditional fields read as drift on every
  `ensureRunning` and cause recreate loops.
- **`/dev/shm` is bind-mounted from the host** because signalk-container
  cannot express `--shm-size` and Chromium needs real shared memory. The
  `disableDevShm` advanced setting is the fallback, not the default.
- `plugin.start()` must never throw (Signal K neither awaits nor catches it)
  — all async work runs under the helper's `startSafely`. `plugin.stop()` is
  async and awaited.
- On update apply, persist the REQUESTED tag ("auto"), never the resolved
  version — auto-tracking must survive restarts.
- `imageTag: "auto"` resolves to the plugin's own package.json version; the
  release CI publishes the ghcr image in lockstep. `scripts/build-image.sh`
  tags a local image with both `dev` and the current version.
- `container/capture-server-ack.py` is the runtime, not a bring-up aid. Its
  protocol (v2: `[u32 BE len][JPEG]` + 1-byte ACK; touch LE u16 x, u16 y,
  u8 type) is consumed by the espos-p4-cockpit `stream` widget — change it
  only in lockstep with the firmware.

## Packaging

`files` in package.json is an allowlist: `dist/`, `public/` (the config
panel), LICENSE and README.md ship. The `container/` directory and
workflows do not — the image is distributed via ghcr, not npm.

The npm-version trap applies to publishing: OIDC trusted publishing requires
npm ≥ 11.5, while npm 12 breaks `--provenance` with "Cannot find module
'sigstore'". The publish workflow pins `npm@^11`.

Releases are cut by release-please: merging its `chore: release x.y.z` PR
tags the release, and the same `publish.yml` run then pushes the image and
publishes npm (image first, npm last). Never bump the version or push a
release tag by hand. npm's trusted publisher names `publish.yml`, as in the
other plugin repos.

The release notes, which the release PR also adds to `CHANGELOG.md`, are the
ones GitHub generates: each PR's title with its author, sorted by the label
`label-by-title.yml` sets from the title's type (`.github/release.yml`), so
the PR title is the release note. Only `feat`, `fix`, `perf`, `revert`, a
breaking change, a `build(deps)` bump or a `Release-As:` footer refreshes
the release PR, and the release PR's own merge is let through to tag it (the
gate in `publish.yml`). So is a push of 2048 commits or more, which the
event cannot list in full. Running `publish.yml` by hand without a tag
refreshes the release PR after a change to the release configuration.

## Conventions

- Angular conventional commits; branch names use hyphens, never slashes.
- Never commit directly to `master`; open a PR.
- No `Co-Authored-By` lines and no AI attribution anywhere.
- `npm run format` FIRST, then `npm run build`, then `npm test` — CI checks
  formatting separately from lint.
- Don't claim tests ran when they didn't.
