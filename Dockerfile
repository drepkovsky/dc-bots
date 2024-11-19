# Use the official Bun image as base
FROM oven/bun AS builder

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

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN bun build ./src/index.ts --outdir ./dist --target bun

# Create production image
FROM oven/bun:1.0.30 AS production

# Install only FFmpeg in production image
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy only the built bundle
COPY --from=builder /app/dist ./dist

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Run the built application
CMD ["bun", "run", "./dist/index.js"]