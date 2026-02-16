.DEFAULT_GOAL := help
.PHONY: help dev dev-fast clean nuke build \
        check test test-watch test-cov typecheck lint fix \
        deploy logs secret secrets status \
        docker-build docker-shell docker-logs docker-prune

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────

help: ## Show all available commands
	@echo "Usage: make <target>"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) \
		| awk -F ':.*## ' '{ printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 }'

# ──────────────────────────────────────────────
# Core Dev Workflow
# ──────────────────────────────────────────────

dev: clean ## Clean start: kill stale containers, clear state, run dev server
	@npx wrangler dev

dev-fast: ## Skip cleanup, just run wrangler dev
	@npx wrangler dev

clean: ## Kill sandbox containers and remove wrangler state
	@echo "Stopping sandbox containers..."
	@-docker ps -q --filter ancestor=cloudflare-dev/sandbox | xargs -r docker kill 2>/dev/null
	@-docker ps -q --filter name=sandbox | xargs -r docker kill 2>/dev/null
	@-docker ps -q | xargs -r -I{} sh -c 'docker inspect --format="{{.Id}} {{.Config.Image}}" {} | grep sandbox | cut -d" " -f1' | xargs -r docker kill 2>/dev/null
	@echo "Removing wrangler state..."
	@rm -rf .wrangler/state
	@echo "Clean complete."

nuke: clean ## Full reset: clean + remove dist, node_modules, images, reinstall
	@echo "Removing build artifacts..."
	@rm -rf dist/
	@echo "Removing node_modules..."
	@rm -rf node_modules/
	@echo "Removing sandbox docker images..."
	@-docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep sandbox | awk '{print $$2}' | xargs -r docker rmi -f 2>/dev/null
	@echo "Reinstalling dependencies..."
	@npm install
	@echo "Nuke complete."

build: ## Build worker + client
	@npx vite build

# ──────────────────────────────────────────────
# Quality & Testing
# ──────────────────────────────────────────────

check: typecheck lint fix-format-check test ## Run ALL checks: typecheck, lint, format-check, test (mirrors CI)

fix-format-check:
	@npx oxfmt --check src/

test: ## Run tests
	@npx vitest run

test-watch: ## Run tests in watch mode
	@npx vitest

test-cov: ## Run tests with coverage
	@npx vitest run --coverage

typecheck: ## TypeScript strict check
	@npx tsc --noEmit

lint: ## Run linter
	@npx oxlint src/

fix: ## Auto-fix: lint + format
	@npx oxlint --fix src/
	@npx oxfmt --write src/

# ──────────────────────────────────────────────
# Deployment & Ops
# ──────────────────────────────────────────────

deploy: build ## Build and deploy to Cloudflare
	@npx wrangler deploy

logs: ## Tail production logs
	@npx wrangler tail

secret: ## Set a secret (usage: make secret KEY=FOO VALUE=bar)
	@echo "$(VALUE)" | npx wrangler secret put $(KEY)

secrets: ## List all secrets
	@npx wrangler secret list

status: ## Show sandbox containers, images, and listening ports
	@echo "=== Sandbox Containers ==="
	@docker ps --filter name=sandbox --format 'table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
	@echo ""
	@echo "=== Sandbox Images ==="
	@docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' | grep -E 'REPOSITORY|sandbox' || true
	@echo ""
	@echo "=== Listening Ports (8787, 5173, 18789) ==="
	@lsof -iTCP:8787 -iTCP:5173 -iTCP:18789 -sTCP:LISTEN -P -n 2>/dev/null || echo "  (none)"

# ──────────────────────────────────────────────
# Docker / Container Helpers
# ──────────────────────────────────────────────

docker-build: ## Force rebuild sandbox image (no cache)
	@docker build --no-cache -t cloudflare-dev/sandbox:local .

docker-shell: ## Shell into running sandbox container
	@docker exec -it $$(docker ps --filter name=sandbox -q | head -1) bash

docker-logs: ## Tail logs from running sandbox container
	@docker logs -f $$(docker ps --filter name=sandbox -q | head -1)

docker-prune: ## Remove old/dangling sandbox images
	@echo "Removing dangling images..."
	@-docker image prune -f
	@echo "Removing old sandbox images..."
	@-docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep sandbox | awk '{print $$2}' | xargs -r docker rmi -f 2>/dev/null
	@echo "Prune complete."
