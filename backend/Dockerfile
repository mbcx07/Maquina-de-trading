FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run typecheck

ENV NODE_ENV=production
ENV PORT=8787
ENV DB_PATH=/app/data/trading-v34.sqlite
ENV LOCAL_VAULT_KEY_PATH=/app/data/.integration-vault-key

VOLUME ["/app/data"]
EXPOSE 8787

CMD ["npm", "start"]
