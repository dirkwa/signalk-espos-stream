# v0.1.0

Initial release.

- Capture chain (Xvfb + Chromium kiosk + ffmpeg) as a managed container
  (`sk-espos-stream`, host networking) via signalk-container.
- ACK-paced MJPEG stream server (protocol v2) with UDP touch backchannel,
  source-IP gated XTEST injection, and a loopback health endpoint.
- TypeBox-schema configuration, custom Admin UI config panel with live
  status, version selection and container update controls.
- `imageTag: "auto"` follows the plugin version; images published to
  ghcr.io in lockstep with releases.
