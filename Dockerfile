# Single-container ScoutBox: the Gleam API server also hosts the built club app
# (/app), the Grassroots app (/grassroots), the Agent app (/agent) and the
# T&S console (/console). The player app is an Expo project —
# host its web export anywhere static, pointed at this API via
# EXPO_PUBLIC_API_URL.
#
# Build from the repository root (docker build .). Each portal imports the
# shared design system (../../design-system) and Pro and Grassroots import the
# role rules (../../shared/roles.ts), so every build stage keeps the
# repository layout: the app in /build/<app>, its shared sources beside it.

FROM node:22-slim AS build-club
WORKDIR /build/scoutbox-club
COPY scoutbox-club/package*.json ./
RUN npm ci
COPY design-system/ /build/design-system/
COPY shared/ /build/shared/
COPY scoutbox-club/ ./
# Same-origin deploy: the club app calls the API it is served from.
RUN VITE_API_URL="" npx vite build --base=/app/

FROM node:22-slim AS build-grassroots
WORKDIR /build/scoutbox-grassroots
COPY scoutbox-grassroots/package*.json ./
RUN npm ci
COPY design-system/ /build/design-system/
COPY shared/ /build/shared/
COPY scoutbox-grassroots/ ./
RUN VITE_API_URL="" npx vite build --base=/grassroots/

FROM node:22-slim AS build-agent
WORKDIR /build/scoutbox-agent
COPY scoutbox-agent/package*.json ./
RUN npm ci
COPY design-system/ /build/design-system/
COPY scoutbox-agent/ ./
RUN VITE_API_URL="" npx vite build --base=/agent/

FROM node:22-slim AS build-admin
WORKDIR /build/scoutbox-admin
COPY scoutbox-admin/package*.json ./
RUN npm ci
COPY design-system/ /build/design-system/
COPY scoutbox-admin/ ./
RUN VITE_API_URL="" npx vite build --base=/console/

# The server: the patched esqlite NIF compiled here, against this image's ERTS,
# then an Erlang shipment. The runtime stage below is the same Erlang release
# on the same Debian, so the NIF loads there unchanged.
FROM erlang:29.1.2 AS build-server
ARG GLEAM_VERSION=1.19.2
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=x86_64; sum=2ba2afb66ca9f6dcc01a4a6e9169b6942963bad6483bec9571ddc078cfe6f41f ;; \
      aarch64) arch=aarch64; sum=d1d1a9d53f6b317c0563a4806873c8ccace54291ead023373728af379402d4f1 ;; \
      *) echo "no Gleam build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gleam.tar.gz \
      "https://github.com/gleam-lang/gleam/releases/download/v${GLEAM_VERSION}/gleam-v${GLEAM_VERSION}-${arch}-unknown-linux-musl.tar.gz"; \
    echo "${sum}  /tmp/gleam.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gleam.tar.gz -C /usr/local/bin; \
    rm /tmp/gleam.tar.gz
# dev/esqlite.mjs (which fetches, patches and compiles esqlite) needs only Node itself.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /build/scoutbox-server
COPY scoutbox-server/ ./
RUN node dev/esqlite.mjs && gleam export erlang-shipment

FROM erlang:29.1.2-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build-server /build/scoutbox-server/build/erlang-shipment ./server
COPY --from=build-club /build/scoutbox-club/dist ./public/club
COPY --from=build-admin /build/scoutbox-admin/dist ./public/admin
COPY --from=build-grassroots /build/scoutbox-grassroots/dist ./public/grassroots
COPY --from=build-agent /build/scoutbox-agent/dist ./public/agent
# DATA_DIR and PUBLIC_DIR default to data/ and public/ in the working directory.
# Persistence lives in /srv/data — mount a volume there.
VOLUME /srv/data
EXPOSE 4000
CMD ["/srv/server/entrypoint.sh", "run"]
