FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
ENV QUICKINV_DB=/data/quickinv.db PORT=3000 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
