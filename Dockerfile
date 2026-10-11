FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# app + db/migrations (npm run migrate) + scripts (backfill saat cutover)
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
