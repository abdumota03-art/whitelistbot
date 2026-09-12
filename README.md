# Minecraft Whitelist Discord Bot — Railway + PostgreSQL

This version uses PostgreSQL instead of better-sqlite3, so Railway does not need Python/node-gyp to build SQLite.

## Railway

Create:
1. Discord bot service
2. PostgreSQL service

In the bot Variables, set:

DATABASE_URL=${{Postgres.DATABASE_URL}}
DATABASE_SSL=false

Replace `Postgres` with the exact PostgreSQL service name if you renamed it.

Also set the Discord and RCON variables from `.env.example`.

## Commands

/setup-whitelist
/set-whitelist-channel
/whitelist-panel
/whitelist <username>
/unwhitelist <username>

## Important

Do not put DISCORD_TOKEN or RCON_PASSWORD in GitHub. Keep secrets in Railway Variables.

RCON must be reachable from the Railway bot service.
