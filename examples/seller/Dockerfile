# syntax=docker/dockerfile:1
# The example seller, built from the repository root:
#   docker build -f examples/seller/Dockerfile .
# Kora is built from source, as continuous integration installs it; the workspace runs from source with tsx.

FROM rust:1.99.1-bookworm AS kora
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libudev-dev llvm libclang-dev protobuf-compiler libssl-dev \
  && rm -rf /var/lib/apt/lists/*
RUN cargo install kora-cli --version 2.0.5 --locked

FROM node:24.22.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libssl3 libudev1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kora /usr/local/cargo/bin/kora /usr/local/bin/kora
# Fails the build if Kora needs a library this image lacks.
RUN ! ldd /usr/local/bin/kora | grep -q "not found"
RUN npm install -g pnpm@12.14.0
WORKDIR /app
# Every workspace project is copied, so that the lockfile's importers are all there; only the seller's graph is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY examples examples
COPY conformance conformance
COPY e2e e2e
# The seller and what it depends on, with the root's development dependencies (tsx among them); not the end-to-end
# harness, its native Surfpool, or the other examples' dependencies.
RUN pnpm install --frozen-lockfile --filter "@lxfoundry/stint-example-seller..." \
  && test -x node_modules/.bin/tsx
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["node_modules/.bin/tsx", "examples/seller/src/main.ts"]
