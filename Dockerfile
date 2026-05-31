FROM oven/bun:1-slim AS base

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
  && sed -i 's|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
  podman uidmap catatonit openssh-client git git-crypt ca-certificates fish vim sudo curl \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r loopat \
  && useradd -m -g loopat -G sudo -s /bin/bash loopat \
  && echo "loopat ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/loopat \
  && chmod 0440 /etc/sudoers.d/loopat

# Rootless podman needs subuid/subgid mappings for the loopat user.
RUN echo "loopat:100000:65536" >> /etc/subuid \
  && echo "loopat:100000:65536" >> /etc/subgid

# Install mise (dev tool version manager)
RUN curl -fsSL https://mise.run | MISE_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

FROM base AS build
COPY . .
# Full workspace install so web/node_modules (vite, the pinned TypeScript)
# is in place — build:web's `bunx tsc/vite` must resolve the project's
# tools, not download newer ones.
RUN bun install --frozen-lockfile
RUN bun run build:web

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

# Pre-create the data dir owned by loopat so the VOLUME (and any named
# volume mounted onto it) initializes writable by the non-root user.
RUN mkdir -p /home/loopat/.loopat && chown loopat:loopat /home/loopat/.loopat

USER loopat

EXPOSE 10001 7788

VOLUME ["/home/loopat/.loopat"]

CMD ["bun", "run", "server/src/index.ts"]
