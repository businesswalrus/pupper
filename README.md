# 🐕 pup.ai v2

> A context-aware Slack bot with personality, memory, and a sense of humor

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-ISC-yellow)](LICENSE)

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/businesswalrus/pupper.git
cd pupper

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
npm run db:migrate

# Seed development data
npm run db:seed

# Start development server with hot reloading
npm run dev
```

## 📋 Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Documentation](#documentation)

## ✨ Features

- **🧠 Semantic Memory**: Uses pgvector embeddings for context-aware responses
- **👥 User Profiling**: Builds personality profiles of users over time
- **💬 Natural Conversations**: Maintains conversation context and threading
- **🔍 Web Search**: Integrates Brave Search for current event awareness
- **🎭 Dynamic Personality**: Adapts mood and responses based on interactions
- **🔌 MCP Extensibility**: Model Context Protocol for modular capabilities
- **⚡ Real-time Processing**: Socket Mode for instant message handling
- **📊 Analytics**: Tracks interaction patterns and generates summaries

## 🏗 Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│   Slack API     │────▶│  Socket Mode │────▶│   Bot App   │
└─────────────────┘     └──────────────┘     └─────────────┘
                                                     │
                    ┌────────────────────────────────┼────────────────────────────────┐
                    │                                │                                │
              ┌─────▼─────┐                  ┌──────▼──────┐                 ┌───────▼──────┐
              │  Message   │                  │   Memory    │                 │ Personality  │
              │  Handler   │                  │  Retrieval  │                 │   Engine     │
              └─────┬─────┘                  └──────┬──────┘                 └───────┬──────┘
                    │                                │                                │
         ┌──────────▼──────────┐         ┌──────────▼──────────┐         ┌──────────▼──────────┐
         │   Message Store     │         │  Vector Search      │         │   AI Generation     │
         │   (PostgreSQL)      │         │   (pgvector)        │         │    (OpenAI)         │
         └─────────────────────┘         └─────────────────────┘         └─────────────────────┘
                    │                                                                 │
         ┌──────────▼──────────┐                                         ┌──────────▼──────────┐
         │   Background Jobs   │                                         │    MCP Servers      │
         │    (BullMQ)         │                                         │  (PostgreSQL, Web)  │
         └─────────────────────┘                                         └─────────────────────┘
```

## 🛠 Development

### Prerequisites

- Node.js 18+ (recommend using [nvm](https://github.com/nvm-sh/nvm))
- PostgreSQL 16+ with pgvector extension
- Redis 7+ (for job queues and caching)
- Slack App with Socket Mode enabled

### Environment Setup

Create a `.env` file with required variables:

```bash
# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/pupper
REDIS_URL=redis://localhost:6379

# AI Services
OPENAI_API_KEY=sk-your-openai-key

# Optional
LOG_LEVEL=debug
NODE_ENV=development
FEATURE_FLAGS=search,profiling
```

### Available Scripts

```bash
# Development
npm run dev          # Start with hot reloading
npm run build        # Build TypeScript
npm run start        # Start production server

# Code Quality
npm run lint         # Run ESLint
npm run lint:fix     # Fix linting issues
npm run typecheck    # TypeScript type checking
npm run format       # Format with Prettier
npm run quality      # Run all quality checks

# Testing
npm test             # Run all tests
npm run test:unit    # Unit tests only
npm run test:int     # Integration tests
npm run test:watch   # Watch mode
npm run test:cov     # Coverage report

# Database
npm run db:create    # Create new migration
npm run db:migrate   # Run migrations
npm run db:rollback  # Rollback migration
npm run db:reset     # Reset database
npm run db:seed      # Seed dev data

# Utilities
npm run debug        # Start with debugger
npm run profile      # CPU profiling
npm run analyze      # Bundle analysis
```

### Development with Make

Common tasks are available via Makefile:

```bash
make setup           # Initial project setup
make dev             # Start development
make test            # Run tests
make quality         # Code quality checks
make docker-dev      # Docker development
make clean           # Clean build artifacts
```

### Debugging

#### VS Code Launch Configuration

The project includes pre-configured debugging settings:

1. **Debug Current Test**: Debug the test file you're viewing
2. **Debug Bot**: Start the bot with debugger attached
3. **Debug Worker**: Debug background job processing

#### Chrome DevTools

```bash
npm run debug
# Open chrome://inspect and click "Inspect"
```

### Feature Flags

Control feature availability via environment variables:

```bash
FEATURE_FLAGS=search,profiling,mcp_extended
```

Available flags:
- `search`: Web search integration
- `profiling`: User profiling system
- `mcp_extended`: Extended MCP capabilities
- `debug_mode`: Verbose logging
- `rate_limit`: API rate limiting

## 🧪 Testing

### Testing Strategy

- **Unit Tests**: Business logic isolation
- **Integration Tests**: API and database interactions
- **E2E Tests**: Full message flow validation
- **Performance Tests**: Load and stress testing

### Running Tests

```bash
# Run all tests with coverage
npm test -- --coverage

# Run specific test file
npm test -- src/ai/memory.test.ts

# Run tests in watch mode
npm test -- --watch

# Run with specific pattern
npm test -- --testNamePattern="memory retrieval"
```

### Test Database

Tests use a separate database configured via `DATABASE_TEST_URL`:

```bash
# Create test database
createdb pupper_test

# Run migrations on test DB
DATABASE_URL=$DATABASE_TEST_URL npm run db:migrate
```

## 📦 Deployment

### Docker

```bash
# Build production image
docker build -t pupper:latest .

# Run with environment variables
docker run -p 3000:3000 --env-file .env pupper:latest
```

### Railway

The project is configured for Railway deployment:

```bash
# Deploy to Railway
railway up

# View logs
railway logs
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment instructions.

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](./docs/CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run quality checks (`npm run quality`)
5. Commit with conventional commits (`feat: add amazing feature`)
6. Push to your fork
7. Open a Pull Request

### Code Style

- TypeScript strict mode enabled
- ESLint + Prettier for formatting
- Conventional commits required
- 100% type coverage goal

## 📚 Documentation

- [Architecture Guide](./docs/ARCHITECTURE.md) - System design and decisions
- [API Reference](./docs/API.md) - Internal API documentation  
- [Developer Guide](./docs/DEVELOPER.md) - Setup and development
- [MCP Integration](./docs/MCP.md) - Model Context Protocol
- [Security Guide](./SECURITY_AUDIT_REPORT.md) - Security considerations

## 🐛 Troubleshooting

### Common Issues

<details>
<summary>Bot not responding to messages</summary>

1. Check Socket Mode is enabled in Slack App settings
2. Verify `SLACK_APP_TOKEN` starts with `xapp-`
3. Check bot has been invited to the channel
4. Review logs for connection errors

</details>

<details>
<summary>Database connection errors</summary>

1. Ensure PostgreSQL is running
2. Verify pgvector extension is installed: `CREATE EXTENSION vector;`
3. Check `DATABASE_URL` format
4. Confirm migrations have run

</details>

<details>
<summary>OpenAI rate limits</summary>

1. Check API key validity
2. Monitor rate limit headers in logs
3. Adjust `OPENAI_RATE_LIMIT` env var
4. Enable exponential backoff

</details>

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [Slack Bolt](https://slack.dev/bolt-js/)
- Powered by [OpenAI](https://openai.com/)
- Vector search via [pgvector](https://github.com/pgvector/pgvector)
- Job processing with [BullMQ](https://docs.bullmq.io/)

---

<p align="center">Made with ❤️ by the pup.ai team</p>
