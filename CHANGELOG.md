# Changelog

All notable changes to pup.ai v2 will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive developer experience improvements
- Feature flags system for progressive feature rollout
- Enhanced ESLint configuration with import ordering
- Husky pre-commit hooks for code quality
- Commitlint for conventional commit enforcement
- Database seeding script for development data
- VS Code debugging configurations
- Docker Compose setup for local development
- Comprehensive documentation suite (Architecture, API, Developer, MCP)
- Jest setup with coverage thresholds
- Test fixtures and utilities
- EditorConfig for consistent coding styles
- Makefile for common development tasks

### Changed
- Enhanced README with detailed setup and troubleshooting
- Improved Jest configuration with better coverage reporting
- Updated package.json with additional scripts
- Expanded CLAUDE.md with coding guidelines and patterns

### Fixed
- TypeScript path aliases configuration
- Production runtime module resolution

## [2.0.0] - 2024-01-15

### Added
- Complete rewrite in TypeScript
- pgvector integration for semantic search
- Personality engine with mood tracking
- MCP (Model Context Protocol) support
- Background job processing with BullMQ
- User profiling system
- Conversation summarization
- Rate limiting and circuit breakers
- Comprehensive error handling
- Health check endpoints

### Changed
- Migrated from JavaScript to TypeScript
- Switched to PostgreSQL with pgvector
- Implemented domain-driven design
- Added repository pattern for data access
- Improved memory retrieval algorithms

### Security
- Input sanitization on all user inputs
- SQL injection prevention
- Rate limiting per user and globally
- Slack signature verification

## [1.0.0] - 2023-06-01

### Added
- Initial Slack bot implementation
- Basic message handling
- Simple personality responses
- OpenAI integration
- Basic memory system

[Unreleased]: https://github.com/businesswalrus/pupper/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/businesswalrus/pupper/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/businesswalrus/pupper/releases/tag/v1.0.0