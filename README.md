# Minecraft Whitelist Discord Bot

A Discord bot that creates a persistent whitelist panel and uses Minecraft RCON to add/remove players from the server whitelist.

## Features

- `/setup-whitelist` creates/updates the panel in the current channel.
- `/set-whitelist-channel` sets the current channel for the panel.
- `/whitelist-panel` recreates the panel.
- `/whitelist <username>` manually whitelists a player.
- `/unwhitelist <username>` manually removes a player.
- Button + modal workflow for players.
- Uses RCON for the real Minecraft whitelist commands.
- SQLite request history.
- Railway-friendly environment variables.
- Admin/role permission controls.
- Prevents duplicate panel messages by storing the panel message ID.
- RCON timeout/error handling.
- Username validation.

## Railway setup

1. Upload this project to GitHub.
2. Create a Railway project and deploy the repository.
3. Add all required variables from `.env.example`.
4. Enable RCON on your Minecraft server and make sure Railway can reach the RCON port.
5. Set the Discord bot's required permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Use Application Commands
6. Start the service with `npm start`.

## Minecraft RCON

Your Minecraft server must have RCON enabled. For a Java server, the server properties commonly include:

    enable-rcon=true
    rcon.port=25575
    rcon.password=CHANGE_THIS

Use a strong RCON password.

## Discord setup

The bot needs to be invited with the `bot` and `applications.commands` scopes.

If `ADMIN_ROLE_ID` is set, that role can run the management commands. If it is blank, users with Discord Administrator permission can manage the panel.

If `WHITELIST_ROLE_ID` is set, only members with that role can use the player-facing whitelist buttons.

## Railway persistence

Railway containers can be recreated. If you want SQLite request history to survive redeploys/restarts, attach a Railway Volume and set:

    DATABASE_PATH=/data/whitelist.sqlite

The bot can still function without a persistent volume; only local request history will be lost when the filesystem is replaced.

## Important security notes

Never commit `.env` or expose the RCON password. Use Railway Variables.

Do not expose RCON directly to the public internet unless your network setup requires it. Prefer a private network/VPN/firewall rule that allows only the bot host to connect.
