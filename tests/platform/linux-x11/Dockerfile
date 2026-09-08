# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
ARG CUA_DRIVER_VERSION=0.24.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      at-spi2-core ca-certificates curl dbus-x11 ffmpeg gir1.2-gtk-3.0 \
      jq libgtk-3-0 openbox picom python3-gi x11-utils xauth xdotool xvfb \
    && chrome_arch="$TARGETARCH" \
    && test "$chrome_arch" != "amd64" || chrome_arch=amd64 \
    && curl -fsSL "https://dl.google.com/linux/direct/google-chrome-stable_current_${chrome_arch}.deb" -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=secret,id=ca,required=false \
    driver_arch="$TARGETARCH" \
    && test "$driver_arch" != "amd64" || driver_arch=x86_64 \
    && asset="cua-driver-rs-${CUA_DRIVER_VERSION}-linux-${driver_arch}-binary.tar.gz" \
    && base="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}" \
    && if [ -f /run/secrets/ca ]; then export CURL_CA_BUNDLE=/run/secrets/ca; fi \
    && curl -fsSL "$base/checksums.txt" -o /tmp/checksums.txt \
    && curl -fL --retry 3 "$base/$asset" -o "/tmp/$asset" \
    && grep "  $asset$" /tmp/checksums.txt | (cd /tmp && sha256sum -c -) \
    && tar -xzf "/tmp/$asset" -C /usr/local/bin \
    && chmod 755 /usr/local/bin/cua-driver \
    && rm -f "/tmp/$asset" /tmp/checksums.txt \
    && printf '%s\n' '#!/bin/sh' 'exec /usr/bin/google-chrome --no-sandbox --disable-dev-shm-usage "$@"' > /usr/local/bin/ocu-test-chrome \
    && chmod 755 /usr/local/bin/ocu-test-chrome

WORKDIR /opt/ocu-runtime
COPY runtime/package.json runtime/package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts
COPY runtime/*.mjs ./
COPY runtime/test ./test

COPY tests/platform/linux-x11/gtk_fixture.py /opt/ocu-test/gtk_fixture.py
COPY tests/platform/linux-x11/native_http_test.py /opt/ocu-test/native_http_test.py
COPY tests/platform/linux-x11/native_parallel_test.py /opt/ocu-test/native_parallel_test.py
COPY tests/platform/linux-x11/run.sh /opt/ocu-test/run.sh
RUN chmod 755 /opt/ocu-test/run.sh /opt/ocu-test/native_http_test.py /opt/ocu-test/native_parallel_test.py

USER node
ENV HOME=/home/node
WORKDIR /home/node

CMD ["dbus-run-session", "--", "/opt/ocu-test/run.sh"]
