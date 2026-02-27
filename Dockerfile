# Node 22 required for @discordjs/voice 0.19 (native voice encryption support)
FROM node:22-bookworm-slim

# Install ffmpeg and build deps for @discordjs/opus (native Opus encoder)
RUN apt-get update && apt-get install -y ffmpeg build-essential python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
