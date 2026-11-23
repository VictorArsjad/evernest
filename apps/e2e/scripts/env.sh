# Shared E2E server config. Sourced by the other scripts. Test-only values.
# The dedicated evernest_e2e database is NEVER the dev database (evernest).
export E2E_PORT="${E2E_PORT:-8090}"
export E2E_DB_NAME="${E2E_DB_NAME:-evernest_e2e}"
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://evernest:evernest_dev@localhost:5432/${E2E_DB_NAME}?sslmode=disable}"
export API_PORT="$E2E_PORT"
export PUBLIC_WEB_ORIGIN="http://localhost:${E2E_PORT}"
export CORS_ALLOW_ORIGIN="$PUBLIC_WEB_ORIGIN"
export JWT_SECRET="e2e-only-jwt-secret-not-for-production-0123456789"
