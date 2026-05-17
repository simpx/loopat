FROM oven/bun:1-slim AS base

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
  && sed -i 's|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
  bubblewrap openssh-client git git-crypt ca-certificates fish vim sudo \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r loopat \
  && useradd -m -g loopat -G sudo -s /bin/bash loopat \
  && echo "loopat ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/loopat \
  && chmod 0440 /etc/sudoers.d/loopat

RUN chmod u+s /usr/bin/bwrap

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
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production
COPY server server
COPY --from=build /app/web/dist web/dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV LOOPAT_SERVE_HOST=0.0.0.0

RUN chown -R loopat:loopat /app

USER loopat

EXPOSE 7787 7788

VOLUME ["/home/loopat/.loopat"]

CMD ["bun", "run", "server/src/index.ts"]
