#!/bin/bash

echo "Testing pup.ai Simplified Version"
echo "================================="

# Check if .env.simple exists
if [ ! -f .env.simple ]; then
    echo "ERROR: .env.simple not found!"
    echo "Copy .env.simple.example and fill in your values"
    exit 1
fi

# Load simple environment
export $(cat .env.simple | grep -v '^#' | xargs)

# Check required variables
required_vars=("SLACK_BOT_TOKEN" "SLACK_APP_TOKEN" "SLACK_SIGNING_SECRET" "DATABASE_URL" "OPENAI_API_KEY")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "ERROR: $var is not set in .env.simple"
        exit 1
    fi
done

echo "✓ Environment variables loaded"

# Test database connection
echo -n "Testing database connection... "
if psql "$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1; then
    echo "✓"
else
    echo "✗"
    echo "ERROR: Cannot connect to database"
    exit 1
fi

# Test Redis connection
echo -n "Testing Redis connection... "
if redis-cli -u "$REDIS_URL" ping > /dev/null 2>&1; then
    echo "✓"
else
    echo "✗"
    echo "ERROR: Cannot connect to Redis"
    exit 1
fi

# Test OpenAI key
echo -n "Testing OpenAI API key... "
if curl -s -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models | grep -q "gpt"; then
    echo "✓"
else
    echo "✗"
    echo "WARNING: OpenAI API key might be invalid"
fi

echo ""
echo "All checks passed! You can now run:"
echo "  npm run dev"
echo ""
echo "Or build and run production:"
echo "  npm run build"
echo "  npm start"