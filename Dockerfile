# BaggeBot. One image that runs the gateway bot, and can also run any of the
# one-shot scripts on demand:
#
#   docker compose up -d                        the bot
#   docker compose run --rm bot npm run scan    a one-shot script
#
# Nothing here is host-specific, so the same image runs on this desktop, on a
# free-tier cloud VM, or on Fly without changes.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No devDependencies in this project, but be explicit: the image must not carry
# anything the bot does not need at runtime.
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
# Written to a mounted volume, not the image layer - see compose.yaml.
ENV BONK_LOG_FILE=/app/logs/bonks.jsonl

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY bonk-message.txt ./

# uid 1000 matches a typical Linux desktop account, so a bind-mounted ./logs
# stays writable from inside the container.
RUN mkdir -p /app/logs && chown -R node:node /app/logs
USER node

# The bot traps SIGTERM and closes the gateway socket cleanly; tini (via
# `init: true` in compose) makes sure the signal actually reaches it.
CMD ["node", "src/bot.mjs"]
