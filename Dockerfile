FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ARG GIT_SHA=dev
ENV NODE_ENV=production PORT=8080 GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/web/src/shared ./web/src/shared
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
