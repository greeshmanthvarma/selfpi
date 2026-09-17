FROM node:22-bookworm-slim AS build

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		git \
		libcairo2-dev \
		libgif-dev \
		libjpeg-dev \
		libpango1.0-dev \
		librsvg2-dev \
		python3 \
		ripgrep \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /opt/selfpi
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build

FROM node:22-bookworm-slim

ARG SOURCE_COMMIT
ARG PREDECESSOR_COMMIT
LABEL org.opencontainers.image.revision="${SOURCE_COMMIT}"
LABEL works.selfpi.predecessor="${PREDECESSOR_COMMIT}"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/selfpi /opt/selfpi
WORKDIR /opt/selfpi
ENTRYPOINT ["node", "packages/coding-agent/dist/bundle/cli.js"]
