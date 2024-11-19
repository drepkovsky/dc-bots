# Build stage - používame Bun pre rýchly build
FROM oven/bun:debian as builder

# Install system dependencies including Python and build tools
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python-is-python3 \
    make \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies using Bun
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the application with Node.js target
RUN bun build ./src/index.ts --outdir ./dist --target node

# Production stage
FROM node:20-slim as production

# Install only FFmpeg in production image
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only the built bundle
COPY --from=builder /app/dist/index.js ./index.js

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Run the application using Node.js
CMD ["node", "index.js"]
