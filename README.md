# markets

## Run locally

### 1) Start PostgreSQL

From `forecast-backend/`:

```bash
cd /workspaces/markets/forecast-backend
docker compose up -d
```

This starts Postgres on `localhost:5432` with:
- user: `postgres`
- password: `postgres`
- database: `forecast`

### 2) Run the backend

From `forecast-backend/`:

```bash
cd /workspaces/markets/forecast-backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend:
- `http://localhost:8000`
- docs: `http://localhost:8000/docs`

### 3) Run the frontend

From `forecast-frontend/`:

```bash
cd /workspaces/markets/forecast-frontend
npm install
npm run dev
```

Frontend:
- `http://localhost:5173`

### Notes

- The backend default database URL is configured in `forecast-backend/app/config.py`.
- You can override settings with a `.env` file in `forecast-backend/`.

### One-command startup

From the repo root:

```bash
cd /workspaces/markets
make dev
```

This will start the database container, launch the backend, and then start the frontend dev server.

To stop the database container:

```bash
cd /workspaces/markets
make stop
```

To remove the backend virtual environment and frontend dependencies/build output:

```bash
cd /workspaces/markets
make clean
```
