# Reality Fork: Node + ffmpeg. Runs on any container host (Hugging Face Spaces uses port 7860 and user 1000).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p cache && chown -R node:node /app
USER node
# MODEL_API_KEY comes from the host's secret settings, never the image. The cap is per deployment (its own ledger).
ENV PORT=7860 RF_BUDGET_USD=100
EXPOSE 7860
CMD ["node", "server.mjs"]
