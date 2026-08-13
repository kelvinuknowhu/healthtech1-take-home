#!/bin/sh
# Runs once, on first container start, via docker-entrypoint-initdb.d.
# Creates the dedicated test database so `npm test` can truncate freely
# without ever touching the dev database.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE takehome_test OWNER $POSTGRES_USER;
EOSQL
