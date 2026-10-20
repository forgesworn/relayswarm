FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY src ./src
COPY demo ./demo
COPY scripts ./scripts
COPY broadcast ./broadcast
COPY deploy/start.sh deploy/healthcheck.mjs ./deploy/
# Public runtime code must remain accessible when the build context has private modes.
RUN chmod -R go-w,a+rX /app/src /app/demo /app/scripts /app/broadcast \
      /app/package.json /app/package-lock.json /app/deploy/start.sh /app/deploy/healthcheck.mjs \
    && chmod go-w,a+rX /app/deploy \
    && chmod 0555 /app/deploy/start.sh \
    && mkdir /state && chown node:node /state && chmod 0700 /state
ARG SOURCE_REVISION=unreleased
LABEL org.opencontainers.image.source="https://github.com/forgesworn/RelaySwarm" \
    org.opencontainers.image.revision="$SOURCE_REVISION"
USER node
ENV NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["/app/deploy/start.sh"]
