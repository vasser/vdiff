# Pinned Playwright image: same Chromium, fonts and rendering on every machine, so pixels are stable.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /opt/vdiff
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && ln -s /opt/vdiff/dist/cli.js /usr/local/bin/vdiff && chmod +x dist/cli.js

# Worktrees and builds of the target repo are cached here; mount a volume to keep them between runs.
ENV VDIFF_CACHE_DIR=/cache
# The target repo is mounted at /repo; git refuses repos owned by another uid without this.
RUN git config --system --add safe.directory '*'
WORKDIR /repo
ENTRYPOINT ["vdiff"]
CMD ["--help"]
