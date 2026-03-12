FROM node:18-bookworm-slim
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "npx prisma generate && npm run dev"]
