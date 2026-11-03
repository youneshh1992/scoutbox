# Single-container ScoutBox: the API server also hosts the built club app
# (/app), the Grassroots app (/grassroots), the Agent app (/agent) and the
# T&S console (/console). The player app is an Expo project —
# host its web export anywhere static, pointed at this API via
# EXPO_PUBLIC_API_URL.
#
# Build from the repository root (docker build .). Each portal imports the
# shared design system (../../design-system) and Pro and Grassroots import the
# role rules (../../scoutbox-server/roles.mjs), so every build stage keeps the
# repository layout: the app in /build/<app>, its shared sources beside it.

FROM node:22-slim AS build-club
WORKDIR /build/scoutbox-club
COPY scoutbox-club/package*.json ./
RUN npm ci
COPY design-system/ /build/design-system/
COPY scoutbox-server/roles.mjs /build/scoutbox-server/roles.mjs
COPY scoutbox-club/ ./
# Same-origin deploy: the club app calls the API it is served from.
RUN VITE_API_URL="" npx vite build --base=/app/

FROM node:22-slim AS build-grassroots
WORKDIR /build/scoutbox-grassroots
COPY scoutbox-grassroots/package*.json ./
RUN npm ci
COPY design-system/ /build/design-system/
COPY scoutbox-server/roles.mjs /build/scoutbox-server/roles.mjs
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

FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY scoutbox-server/package*.json ./
RUN npm ci --omit=dev
COPY scoutbox-server/ ./
COPY --from=build-club /build/scoutbox-club/dist ./public/club
COPY --from=build-admin /build/scoutbox-admin/dist ./public/admin
COPY --from=build-grassroots /build/scoutbox-grassroots/dist ./public/grassroots
COPY --from=build-agent /build/scoutbox-agent/dist ./public/agent
# Persistence lives in /srv/data — mount a volume there.
VOLUME /srv/data
EXPOSE 4000
CMD ["node", "server.mjs"]
