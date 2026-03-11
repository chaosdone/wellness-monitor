FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p logs .chrome-session

ENV IS_CLOUD=true
ENV NODE_ENV=production

CMD ["node", "monitor.js"]
