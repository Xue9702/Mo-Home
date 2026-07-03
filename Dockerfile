FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN echo "强制重建于 $(date)" && npm install && npm install ws && npm cache clean --force
COPY . .
CMD ["node", "server.js"]