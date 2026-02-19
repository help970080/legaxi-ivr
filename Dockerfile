FROM node:20-slim

RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && \
    python3 -m venv /opt/tts && \
    /opt/tts/bin/pip install edge-tts && \
    ln -s /opt/tts/bin/edge-tts /usr/local/bin/edge-tts && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p audio

EXPOSE 3000
CMD ["node", "server.js"]
