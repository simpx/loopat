FROM oven/bun:1-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
  bubblewrap openssh-client git ca-certificates fish \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN bun --cwd web run build

FROM base AS release
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/web/dist web/dist
COPY server server
COPY package.json .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV LOOPAT_SERVE_HOST=0.0.0.0

EXPOSE 7787 7788

VOLUME ["/root/.loopat"]

CMD ["bun", "run", "server/src/index.ts"]
