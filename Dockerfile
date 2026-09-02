# Single-container ScoutBox: the API server also hosts the built club app
# (/app) and the T&S console (/console). The player app is an Expo project —
# host its web export anywhere static, pointed at this API via
# EXPO_PUBLIC_API_URL.

FROM node:22-slim AS build-club
WORKDIR /build
COPY scoutbox-club/package*.json ./
RUN npm ci
COPY scoutbox-club/ ./
# Same-origin deploy: the club app calls the API it is served from.
RUN VITE_API_URL="" npx vite build --base=/app/

FROM node:22-slim AS build-grassroots
WORKDIR /build
COPY scoutbox-grassroots/package*.json ./
RUN npm ci
COPY scoutbox-grassroots/ ./
RUN VITE_API_URL="" npx vite build --base=/grassroots/

FROM node:22-slim AS build-admin
WORKDIR /build
COPY scoutbox-admin/package*.json ./
RUN npm ci
COPY scoutbox-admin/ ./
RUN VITE_API_URL="" npx vite build --base=/console/

FROM node:22-slim
WORKDIR /srv
ENV NODE_ENV=production
COPY scoutbox-server/package*.json ./
RUN npm ci --omit=dev
COPY scoutbox-server/ ./
COPY --from=build-club /build/dist ./public/club
COPY --from=build-admin /build/dist ./public/admin
COPY --from=build-grassroots /build/dist ./public/grassroots
# Persistence lives in /srv/data — mount a volume there.
VOLUME /srv/data
EXPOSE 4000
CMD ["node", "server.mjs"]
