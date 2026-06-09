.PHONY: help db setup-backend backend frontend dev stop

help:
	@echo "Usage: make [target]"
	@echo "Targets: db setup-backend backend frontend dev prod docker-build docker-up docker-down stop"
	@echo "  db             Start the Postgres database container"
	@echo "  setup-backend  Create backend venv and install Python dependencies"
	@echo "  backend        Run the FastAPI backend server"
	@echo "  frontend       Install the Vite app"
	@echo "  dev            Start db, backend, and frontend together"
	@echo "  prod           Build and run the production Docker stack"
	@echo "  docker-build   Build production Docker images"
	@echo "  docker-up      Start production containers"
	@echo "  docker-down    Stop production containers"
	@echo "  stop           Stop the Postgres database container"

DB_DIR := forecast-backend
FRONTEND_DIR := forecast-frontend

db:
	cd $(DB_DIR) && docker compose up -d

setup-backend:
	cd $(DB_DIR) && python3 -m venv .venv
	cd $(DB_DIR) && .venv/bin/pip install -r requirements.txt

backend:
	cd $(DB_DIR) && if [ ! -d .venv ]; then python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; fi
	cd $(DB_DIR) && . .venv/bin/activate && .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

frontend:
	cd $(FRONTEND_DIR) && npm install
	cd $(FRONTEND_DIR) && npm run dev

dev: db
	cd $(DB_DIR) && if [ ! -d .venv ]; then python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; fi
	cd $(DB_DIR) && . .venv/bin/activate && .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 &
	cd $(FRONTEND_DIR) && npm install
	cd $(FRONTEND_DIR) && npm run dev

stop:
	cd $(DB_DIR) && docker compose down

docker-build:
	docker compose -f docker-compose.prod.yml build

docker-up:
	docker compose -f docker-compose.prod.yml up -d

docker-down:
	docker compose -f docker-compose.prod.yml down

prod: docker-build docker-up

clean:
	rm -rf $(DB_DIR)/.venv
	rm -rf $(FRONTEND_DIR)/node_modules
	rm -rf $(FRONTEND_DIR)/dist
