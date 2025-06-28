#!/bin/bash

echo "🐕 Setting up pup.ai simple version..."

# Create backup of current files
echo "📦 Backing up current files..."
mkdir -p backup
cp package.json backup/package.json.backup 2>/dev/null || true
cp tsconfig.json backup/tsconfig.json.backup 2>/dev/null || true
cp Dockerfile backup/Dockerfile.backup 2>/dev/null || true
cp railway.toml backup/railway.toml.backup 2>/dev/null || true

# Copy simple versions
echo "📝 Copying simple configuration files..."
cp package.simple.json package.json
cp tsconfig.simple.json tsconfig.json
cp Dockerfile.simple Dockerfile
cp railway.simple.toml railway.toml

# Remove node_modules and package-lock.json
echo "🧹 Cleaning up old dependencies..."
rm -rf node_modules
rm -f package-lock.json

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "📋 Creating .env file..."
    cp .env.simple .env
    echo "⚠️  Please edit .env with your credentials!"
fi

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your credentials"
echo "2. Run locally: npm run dev"
echo "3. Deploy: railway up"
echo ""
echo "To restore original files: cp backup/* ."