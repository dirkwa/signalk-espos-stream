# Agent guidance

Signal K plugin that streams a browser-rendered dashboard to an espOS panel
(ESP32-P4) as ACK-paced MJPEG over TCP with a UDP touch backchannel. The
capture chain (Xvfb + Chromium kiosk + ffmpeg + `container/capture-server-ack.py`)
runs in a container managed through signalk-container, via
signalk-container-helper. Successor to `signalk-esp32-stream`, whose
host-level systemd chain this replaces.

## Licensing

This project is **source-available, not open source**: use and modification are
free, redistribution is not. `LICENSE.md` is authoritative.

- **Never propose returning to a permissive license** — that is the copyright
  holder's decision alone.
- `package.json` uses `"license": "SEE LICENSE IN LICENSE.md"`. This is not an
  SPDX-listed license; inventing an identifier breaks tooling validation.
- `CONTRIBUTING.md` carries an inbound contribution grant.
- The license text derives from a plain-language template whose authors permit
  adaptation only if all mention of their project is removed. It has been. Do
  not add attribution to them back in.
- **Runtime dependency licenses gate this.** Runtime deps are
  `signalk-container-helper` (Apache-2.0) and `typebox` (MIT). The config
  panel bundles `zustand` (MIT) into `public/remoteEntry.js`, which ships in
  the npm package. Re-check before adding a runtime or bundled dependency;
  pure devDependencies do not matter.

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
panel), LICENSE.md and README.md ship. The `container/` directory and
workflows do not — the image is distributed via ghcr, not npm.

The npm-version trap applies to publishing: OIDC trusted publishing requires
npm ≥ 11.5, while npm 12 breaks `--provenance` with "Cannot find module
'sigstore'". The publish workflow pins `npm@^11`.

## Conventions

- Angular conventional commits; branch names use hyphens, never slashes.
- Never commit directly to `master`; open a PR.
- No `Co-Authored-By` lines and no AI attribution anywhere.
- `npm run format` FIRST, then `npm run build`, then `npm test` — CI checks
  formatting separately from lint.
- Don't claim tests ran when they didn't.
