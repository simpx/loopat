FROM oven/bun:1-slim

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
  && sed -i 's|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
  podman uidmap fuse-overlayfs catatonit ca-certificates curl git openssh-client git-crypt \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 2000 loopat \
  && useradd -m -u 2000 -g loopat -s /bin/bash loopat \
  && echo "loopat:100000:65536" >> /etc/subuid \
  && echo "loopat:100000:65536" >> /etc/subgid

RUN mkdir -p /etc/containers/registries.conf.d /root/.config/containers && \
    printf 'unqualified-search-registries = ["docker.io"]\n\n[[registry]]\nprefix = "docker.io"\nlocation = "docker.m.daocloud.io"\n' \
    > /etc/containers/registries.conf.d/mirror.conf && \
    cp /etc/containers/registries.conf.d/mirror.conf /root/.config/containers/registries.conf

RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

RUN git config --global --add safe.directory '*'
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV LOOPAT_SERVE_HOST=0.0.0.0

EXPOSE 7787 7788
CMD ["bun", "run", "server/src/index.ts"]
