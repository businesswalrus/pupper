# pup.ai v2 Makefile
# Common development tasks

.PHONY: help setup dev test quality clean docker-dev docker-prod db-setup db-reset

# Default target
.DEFAULT_GOAL := help

# Colors for output
CYAN := \033[0;36m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

# Help command
help:
	@echo "$(CYAN)pup.ai v2 Development Commands$(NC)"
	@echo ""
	@echo "$(GREEN)Setup & Development:$(NC)"
	@echo "  make setup        - Initial project setup"
	@echo "  make dev          - Start development server"
	@echo "  make debug        - Start with debugger"
	@echo "  make docker-dev   - Run in Docker (development)"
	@echo ""
	@echo "$(GREEN)Testing & Quality:$(NC)"
	@echo "  make test         - Run all tests"
	@echo "  make test-unit    - Run unit tests"
	@echo "  make test-int     - Run integration tests"
	@echo "  make test-watch   - Run tests in watch mode"
	@echo "  make quality      - Run all quality checks"
	@echo "  make lint         - Run ESLint"
	@echo "  make format       - Format code with Prettier"
	@echo ""
	@echo "$(GREEN)Database:$(NC)"
	@echo "  make db-setup     - Setup database and run migrations"
	@echo "  make db-reset     - Reset database (CAUTION: deletes data)"
	@echo "  make db-seed      - Seed development data"
	@echo "  make db-migrate   - Run pending migrations"
	@echo ""
	@echo "$(GREEN)Utilities:$(NC)"
	@echo "  make clean        - Clean build artifacts"
	@echo "  make logs         - Tail application logs"
	@echo "  make shell        - Open shell in Docker container"
	@echo "  make build        - Build TypeScript"

# Initial setup
setup:
	@echo "$(CYAN)Setting up pup.ai v2...$(NC)"
	@echo "$(YELLOW)Installing dependencies...$(NC)"
	npm install
	@echo "$(YELLOW)Setting up environment...$(NC)"
	@if [ ! -f .env ]; then cp .env.example .env && echo "$(GREEN)Created .env file$(NC)"; else echo "$(YELLOW).env already exists$(NC)"; fi
	@echo "$(YELLOW)Setting up git hooks...$(NC)"
	npm run prepare
	@echo "$(YELLOW)Building TypeScript...$(NC)"
	npm run build
	@echo "$(GREEN)Setup complete! Run 'make dev' to start development$(NC)"

# Development server
dev:
	@echo "$(CYAN)Starting development server...$(NC)"
	npm run dev

# Debug mode
debug:
	@echo "$(CYAN)Starting in debug mode...$(NC)"
	npm run debug

# Run all tests
test:
	@echo "$(CYAN)Running all tests...$(NC)"
	npm test

# Run unit tests
test-unit:
	@echo "$(CYAN)Running unit tests...$(NC)"
	npm run test:unit

# Run integration tests
test-int:
	@echo "$(CYAN)Running integration tests...$(NC)"
	npm run test:int

# Run tests in watch mode
test-watch:
	@echo "$(CYAN)Running tests in watch mode...$(NC)"
	npm test -- --watch

# Run all quality checks
quality:
	@echo "$(CYAN)Running quality checks...$(NC)"
	@echo "$(YELLOW)Type checking...$(NC)"
	npm run typecheck
	@echo "$(YELLOW)Linting...$(NC)"
	npm run lint
	@echo "$(YELLOW)Running tests...$(NC)"
	npm test
	@echo "$(GREEN)All quality checks passed!$(NC)"

# Run linter
lint:
	@echo "$(CYAN)Running ESLint...$(NC)"
	npm run lint

# Format code
format:
	@echo "$(CYAN)Formatting code...$(NC)"
	npm run format

# Build TypeScript
build:
	@echo "$(CYAN)Building TypeScript...$(NC)"
	npm run build

# Database setup
db-setup:
	@echo "$(CYAN)Setting up database...$(NC)"
	@echo "$(YELLOW)Creating database...$(NC)"
	createdb pupper || echo "$(YELLOW)Database may already exist$(NC)"
	createdb pupper_test || echo "$(YELLOW)Test database may already exist$(NC)"
	@echo "$(YELLOW)Running migrations...$(NC)"
	npm run db:migrate
	@echo "$(GREEN)Database setup complete!$(NC)"

# Database reset
db-reset:
	@echo "$(RED)WARNING: This will delete all data!$(NC)"
	@echo "Press Ctrl+C to cancel, or wait 3 seconds to continue..."
	@sleep 3
	@echo "$(CYAN)Resetting database...$(NC)"
	npm run db:reset
	npm run db:migrate
	@echo "$(GREEN)Database reset complete!$(NC)"

# Seed development data
db-seed:
	@echo "$(CYAN)Seeding development data...$(NC)"
	npm run db:seed
	@echo "$(GREEN)Seeding complete!$(NC)"

# Run migrations
db-migrate:
	@echo "$(CYAN)Running database migrations...$(NC)"
	npm run db:migrate

# Docker development
docker-dev:
	@echo "$(CYAN)Starting Docker development environment...$(NC)"
	docker-compose -f docker-compose.dev.yml up

# Docker production build
docker-prod:
	@echo "$(CYAN)Building production Docker image...$(NC)"
	docker build -t pupper:latest .

# Clean build artifacts
clean:
	@echo "$(CYAN)Cleaning build artifacts...$(NC)"
	rm -rf dist/
	rm -rf coverage/
	rm -rf .nyc_output/
	rm -rf *.log
	@echo "$(GREEN)Clean complete!$(NC)"

# Tail logs
logs:
	@echo "$(CYAN)Tailing application logs...$(NC)"
	tail -f *.log

# Open shell in Docker container
shell:
	@echo "$(CYAN)Opening shell in Docker container...$(NC)"
	docker-compose -f docker-compose.dev.yml exec app /bin/sh

# Check environment
check-env:
	@echo "$(CYAN)Checking environment setup...$(NC)"
	@command -v node >/dev/null 2>&1 || { echo "$(RED)Node.js is required but not installed$(NC)"; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "$(RED)npm is required but not installed$(NC)"; exit 1; }
	@command -v psql >/dev/null 2>&1 || { echo "$(RED)PostgreSQL client is required but not installed$(NC)"; exit 1; }
	@command -v redis-cli >/dev/null 2>&1 || { echo "$(RED)Redis client is required but not installed$(NC)"; exit 1; }
	@echo "$(GREEN)All required tools are installed!$(NC)"
	@node -v
	@npm -v