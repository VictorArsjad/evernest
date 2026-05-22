# Evernest — single entry point for common dev/CI commands.
# All targets are phony unless explicitly marked otherwise.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --no-print-directory

# Load .env if present so DATABASE_URL_LOCAL etc. are available to targets that
# need them (migrate, import-babyplus, native api-run).
ifneq ("$(wildcard .env)","")
  include .env
  export
endif

# Sensible fallbacks when .env is missing.
DATABASE_URL_LOCAL ?= postgres://evernest:evernest_dev@localhost:5432/evernest?sslmode=disable
COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env

# Pinned tool versions. KEEP IN SYNC with .github/workflows/ci.yml — both
# local `make api-lint` and CI must run the same golangci-lint binary or
# "passes locally, fails in CI" is back on the menu.
GOLANGCI_LINT_VERSION ?= v2.12.2
TOOLS_BIN := apps/api/.tools/bin
GOLANGCI_LINT := $(TOOLS_BIN)/golangci-lint

# ---------- environment ----------
.PHONY: up down logs ps reset-db env-init db

env-init: ## Copy .env.example to .env if missing
	@if [ ! -f .env ]; then cp .env.example .env && echo "Created .env from .env.example"; else echo ".env already exists"; fi

db: env-init ## Start ONLY postgres (fast dev loop: use with make api-run + make web-dev)
	$(COMPOSE) up -d db

up: env-init ## Start db + api (dev profile; builds the api image)
	$(COMPOSE) --profile dev up -d --build

down: ## Stop all services
	$(COMPOSE) --profile dev --profile prod down

logs: ## Tail logs from all services
	$(COMPOSE) --profile dev logs -f --tail=100

ps: ## Show service status
	$(COMPOSE) --profile dev ps

reset-db: ## DESTRUCTIVE: drop the postgres volume and recreate
	@read -p "Drop postgres volume and lose ALL data? [y/N] " ans; [ "$$ans" = "y" ] || exit 1
	$(COMPOSE) --profile dev down -v
	$(COMPOSE) --profile dev up -d db
	sleep 2
	$(MAKE) migrate-up

# ---------- backend (apps/api) ----------
.PHONY: api-run api-test api-lint api-tidy migrate-new migrate-up migrate-down import-babyplus

api-run: ## Run the API server natively against the docker db
	cd apps/api && DATABASE_URL="$(DATABASE_URL_LOCAL)" go run ./cmd/server

api-test: ## Run Go tests with race detector
	cd apps/api && go test ./... -race -count=1

$(GOLANGCI_LINT):
	@echo "==> installing golangci-lint $(GOLANGCI_LINT_VERSION) into $(TOOLS_BIN)"
	@mkdir -p $(TOOLS_BIN)
	@curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/$(GOLANGCI_LINT_VERSION)/install.sh \
		| sh -s -- -b $(TOOLS_BIN) $(GOLANGCI_LINT_VERSION)

api-lint: $(GOLANGCI_LINT) ## golangci-lint (pinned version, identical to CI)
	@INSTALLED=$$($(GOLANGCI_LINT) version --short 2>/dev/null || echo missing); \
	WANT=$$(echo $(GOLANGCI_LINT_VERSION) | sed 's/^v//'); \
	if [ "$$INSTALLED" != "$$WANT" ]; then \
		echo "==> reinstalling golangci-lint (have $$INSTALLED, want $$WANT)"; \
		rm -f $(GOLANGCI_LINT); \
		$(MAKE) $(GOLANGCI_LINT); \
	fi
	cd apps/api && $(abspath $(GOLANGCI_LINT)) run --timeout=5m

api-tidy: ## go mod tidy
	cd apps/api && go mod tidy

migrate-new: ## Create a new migration. Usage: make migrate-new name=add_xyz
	@if [ -z "$(name)" ]; then echo "usage: make migrate-new name=<snake_case>"; exit 1; fi
	migrate create -ext sql -dir apps/api/migrations -seq $(name)

migrate-up: ## Apply all pending migrations
	migrate -path apps/api/migrations -database "$(DATABASE_URL_LOCAL)" up

migrate-down: ## Roll back one migration
	migrate -path apps/api/migrations -database "$(DATABASE_URL_LOCAL)" down 1

import-babyplus: ## Import BabyPlus JSON export. Usage: make import-babyplus FILE=... HOUSEHOLD=... [BABY=...]
	@if [ -z "$(FILE)" ] || [ -z "$(HOUSEHOLD)" ]; then echo "usage: make import-babyplus FILE=path/to/export.json HOUSEHOLD=<uuid> [BABY=<uuid>]"; exit 1; fi
	cd apps/api && DATABASE_URL="$(DATABASE_URL_LOCAL)" go run ./cmd/import-babyplus \
		--file="$(FILE)" --household="$(HOUSEHOLD)" $(if $(BABY),--baby="$(BABY)")

# ---------- frontend (apps/web) ----------
.PHONY: web-install web-dev web-build web-test web-lint

web-install: ## Install web dependencies
	cd apps/web && npm install

web-dev: ## Run the Vite dev server (proxies /v1 to API)
	cd apps/web && npm run dev

web-build: ## Build the production web bundle
	cd apps/web && npm run build

web-test: ## Run frontend tests
	cd apps/web && npm run test --if-present

web-lint: ## Type-check + lint the frontend
	cd apps/web && npm run lint && npm run typecheck

# ---------- aggregate ----------
.PHONY: lint test build help

lint: api-lint web-lint ## Lint everything

test: api-test web-test ## Test everything

build: ## Build all docker images
	$(COMPOSE) --profile prod build

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Evernest make targets:\n"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.DEFAULT_GOAL := help
