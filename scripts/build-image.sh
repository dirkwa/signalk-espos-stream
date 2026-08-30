#!/bin/sh
# Local dev build of the capture image on the boat server itself.
# Tags both :dev (for explicit dev configs) and :<plugin version> (so
# imageTag "auto" finds the local image without a registry pull).
#
# Runs niced: podman build is CPU/IO heavy and this host is also the live
# Signal K server.
set -eu

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
IMAGE=ghcr.io/dirkwa/signalk-espos-stream

exec nice -n 15 ionice -c 3 podman build \
    -t "$IMAGE:dev" \
    -t "$IMAGE:$VERSION" \
    container/
