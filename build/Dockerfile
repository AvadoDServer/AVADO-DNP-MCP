# AVADO AI Connect package image (same build layout as the AVADO Care package).
#
# Build context is the repository root (docker-compose.yml: context ".",
# dockerfile "build/Dockerfile"), so the image can read the package version
# from dappnode_package.json. See /.dockerignore for what is sent.

# Base images, pinned by digest (the multi-arch index digest). The tag is only
# a label; the digest decides. Update tag and digest together: get the digest
# with `docker buildx imagetools inspect node:<tag>` (the "Digest:" line).
# Node 22.23.4 (security release of 2026-10-20), checked 2026-11-04. AVADO-DNP-Care
# and AVADO-DNP-Rocketpool still pin 22.23.2 until their own bump.
ARG NODE_IMAGE=node:22.23.4-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd
ARG NODE_SLIM_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

########## Service: install, type-check, test, build
FROM --platform=linux/amd64 ${NODE_IMAGE} AS service
WORKDIR /usr/src/service
COPY build/service/package.json build/service/yarn.lock ./
RUN yarn install --frozen-lockfile
COPY build/service/ ./
# A failing check or test fails the image build, so a release can never be
# built on a red suite (scope enforcement, the never-list, redaction, a real
# MCP client against the server). The Admin sync test is skipped here; the hash
# check of the vendored files runs.
RUN yarn lint && yarn test
# Only what the runtime needs goes into /out.
RUN yarn build \
    && yarn install --frozen-lockfile --production --ignore-scripts --prefer-offline \
    && mkdir -p /out \
    && cp -a package.json dist public node_modules /out/

########## Ports 80 and 443 without root
# The node binary gets the file capability cap_net_bind_service, so the `node`
# user can bind ports 80 and 443 on every Docker version (NET_BIND_SERVICE is in
# Docker's default capability set). Docker 20.10+ would also allow it through
# net.ipv4.ip_unprivileged_port_start=0, older Docker does not. setcap comes
# from libcap2-bin, installed in this stage only.
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE} AS caps
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && setcap cap_net_bind_service=+ep /usr/local/bin/node \
    && getcap /usr/local/bin/node | grep -q cap_net_bind_service

########## Runtime
FROM --platform=linux/amd64 ${NODE_SLIM_IMAGE}

# COPY keeps the security.capability extended attribute set above.
COPY --from=caps /usr/local/bin/node /usr/local/bin/node

COPY --from=service /out /usr/src/service

# Package version, read from the manifest so an `avadosdk increase` bump can
# never leave it stale.
COPY dappnode_package.json /tmp/dappnode_package.json
RUN node -e 'const v = require("/tmp/dappnode_package.json").version; \
        if (!/^[0-9A-Za-z.+-]+$/.test(v || "")) { console.error("bad package version"); process.exit(1); } \
        require("fs").writeFileSync("/usr/src/service/package-version", v + "\n");' \
    && rm /tmp/dappnode_package.json \
    && test -f /usr/src/service/dist/server.js \
    && test -f /usr/src/service/dist/admin/health/engine.js \
    && test -f /usr/src/service/public/index.html \
    && test -f /usr/src/service/public/connect.html \
    && test -f /usr/src/service/dist/tools.js \
    && mkdir -p /data && chown node:node /data

# No root needed: node may bind ports 80 and 443 (see the caps stage), and
# /data is owned by `node`, so a new volume starts out owned by it too.
USER node
# A memory ceiling (the manifest format has no memory limit): the service needs
# a few tens of MB; a leak ends in a restart instead of growing without bound.
ENV NODE_OPTIONS=--max-old-space-size=128 \
    NODE_ENV=production \
    STATE_DIR=/data \
    PUBLIC_DIR=/usr/src/service/public \
    HTTP_PORT=80 \
    HTTPS_PORT=443 \
    AGENT_PORT=8000
WORKDIR /usr/src/service
# 80: page + MCP (http), 443: page + MCP (https, *.my.ava.do), 8000: MCP only (for Tailscale)
EXPOSE 80 443 8000
CMD ["node", "dist/server.js"]
