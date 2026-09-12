require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ActivityType
} = require("discord.js");
const { Rcon } = require("rcon-client");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const required = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "RCON_HOST",
  "RCON_PASSWORD"
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  rconHost: process.env.RCON_HOST,
  rconPort: Number(process.env.RCON_PORT || 25575),
  rconPassword: process.env.RCON_PASSWORD,
  channelId: process.env.WHITELIST_CHANNEL_ID || "",
  panelMessageId: process.env.WHITELIST_PANEL_MESSAGE_ID || "",
  adminRoleId: process.env.ADMIN_ROLE_ID || "",
  whitelistRoleId: process.env.WHITELIST_ROLE_ID || "",
  databasePath: process.env.DATABASE_PATH || "./data/whitelist.sqlite",
  status: process.env.BOT_STATUS || "Whitelist Manager"
};

const dbDir = path.dirname(path.resolve(config.databasePath));
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    minecraft_username TEXT NOT NULL,
    action TEXT NOT NULL,
    success INTEGER NOT NULL,
    response TEXT,
    created_at INTEGER NOT NULL
  );
`);

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key, value)
    VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getPanelChannelId() {
  return getSetting("panel_channel_id", config.channelId);
}

function getPanelMessageId() {
  return getSetting("panel_message_id", config.panelMessageId);
}

function usernameIsValid(username) {
  return /^[A-Za-z0-9_]{3,16}$/.test(username);
}

function hasAdminAccess(member) {
  if (!member) return false;

  if (config.adminRoleId && member.roles.cache.has(config.adminRoleId)) {
    return true;
  }

  return member.permissions.has(PermissionFlagsBits.Administrator);
}

function hasWhitelistAccess(member) {
  if (!config.whitelistRoleId) return true;
  return member.roles.cache.has(config.whitelistRoleId);
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Minecraft Whitelist")
    .setDescription(
      "Use the buttons below to manage your Minecraft whitelist.\n\n" +
      "🟢 **Whitelist Me** — add your Minecraft account\n" +
      "🔴 **Remove Whitelist** — remove your Minecraft account\n\n" +
      "Enter your exact Minecraft Java username when prompted."
    )
    .setFooter({ text: "Minecraft Whitelist Manager" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("whitelist_add")
      .setLabel("Whitelist Me")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("whitelist_remove")
      .setLabel("Remove Whitelist")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

function buildModal(action) {
  const modal = new ModalBuilder()
    .setCustomId(`whitelist_modal:${action}`)
    .setTitle(action === "add" ? "Whitelist Minecraft Account" : "Remove Minecraft Whitelist");

  const input = new TextInputBuilder()
    .setCustomId("minecraft_username")
    .setLabel("Minecraft username")
    .setPlaceholder("Example: Steve")
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(16)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function executeRcon(command) {
  const rcon = await Rcon.connect({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
    timeout: 8000
  });

  try {
    return await rcon.send(command);
  } finally {
    try {
      await rcon.end();
    } catch {}
  }
}

function recordRequest(user, minecraftUsername, action, success, response) {
  db.prepare(`
    INSERT INTO requests
      (discord_user_id, discord_username, minecraft_username, action, success, response, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.id,
    user.tag || user.username,
    minecraftUsername,
    action,
    success ? 1 : 0,
    response || "",
    Date.now()
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup-whitelist")
    .setDescription("Create the whitelist panel in the current channel."),

  new SlashCommandBuilder()
    .setName("set-whitelist-channel")
    .setDescription("Set the current channel as the whitelist panel channel."),

  new SlashCommandBuilder()
    .setName("whitelist-panel")
    .setDescription("Create or refresh the whitelist panel."),

  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("Manually whitelist a Minecraft username.")
    .addStringOption(option =>
      option
        .setName("username")
        .setDescription("Minecraft username")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(16)
    ),

  new SlashCommandBuilder()
    .setName("unwhitelist")
    .setDescription("Manually remove a Minecraft username from the whitelist.")
    .addStringOption(option =>
      option
        .setName("username")
        .setDescription("Minecraft username")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(16)
    )
].map(command => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

async function createOrRefreshPanel(channel) {
  const payload = buildPanel();
  let message = null;
  const savedMessageId = getPanelMessageId();

  if (savedMessageId) {
    try {
      message = await channel.messages.fetch(savedMessageId);
      await message.edit(payload);
      setSetting("panel_channel_id", channel.id);
      return message;
    } catch {
      message = null;
    }
  }

  message = await channel.send(payload);
  setSetting("panel_channel_id", channel.id);
  setSetting("panel_message_id", message.id);
  return message;
}

async function safeReply(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral
    });
  }

  return interaction.reply({
    content,
    flags: MessageFlags.Ephemeral
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setActivity(config.status, {
    type: ActivityType.Watching
  });

  try {
    await registerCommands();
  } catch (error) {
    console.error("Failed to register commands:", error);
  }

  const panelChannelId = getPanelChannelId();
  if (panelChannelId) {
    try {
      const channel = await client.channels.fetch(panelChannelId);
      if (channel && channel.isTextBased()) {
        await createOrRefreshPanel(channel);
        console.log(`Whitelist panel ready in #${channel.name || panelChannelId}`);
      }
    } catch (error) {
      console.error("Could not refresh saved whitelist panel:", error.message);
    }
  }

  console.log("Whitelist bot is fully operational.");
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!hasAdminAccess(interaction.member)) {
        return safeReply(interaction, "❌ You do not have permission to use this command.");
      }

      if (interaction.commandName === "set-whitelist-channel") {
        setSetting("panel_channel_id", interaction.channelId);
        return safeReply(interaction, "✅ This channel is now the configured whitelist panel channel.");
      }

      if (interaction.commandName === "setup-whitelist" ||
          interaction.commandName === "whitelist-panel") {
        const message = await createOrRefreshPanel(interaction.channel);
        return safeReply(interaction, `✅ Whitelist panel is ready. Panel message: \`${message.id}\``);
      }

      if (interaction.commandName === "whitelist" ||
          interaction.commandName === "unwhitelist") {
        const username = interaction.options.getString("username", true).trim();

        if (!usernameIsValid(username)) {
          return safeReply(
            interaction,
            "❌ Invalid Minecraft username. Use 3–16 letters, numbers, or underscores."
          );
        }

        const add = interaction.commandName === "whitelist";
        const command = add
          ? `whitelist add ${username}`
          : `whitelist remove ${username}`;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const response = await executeRcon(command);
          recordRequest(
            interaction.user,
            username,
            add ? "add" : "remove",
            true,
            response
          );

          return interaction.editReply(
            `✅ **${add ? "Whitelisted" : "Removed"}** \`${username}\`.\n` +
            `RCON response: \`${String(response || "OK").slice(0, 500)}\``
          );
        } catch (error) {
          recordRequest(
            interaction.user,
            username,
            add ? "add" : "remove",
            false,
            error.message
          );

          return interaction.editReply(
            `❌ RCON request failed: \`${error.message.slice(0, 500)}\``
          );
        }
      }
    }

    if (interaction.isButton()) {
      if (!hasWhitelistAccess(interaction.member)) {
        return safeReply(
          interaction,
          "❌ You do not have the required Discord role to use the whitelist system."
        );
      }

      if (interaction.customId === "whitelist_add") {
        return interaction.showModal(buildModal("add"));
      }

      if (interaction.customId === "whitelist_remove") {
        return interaction.showModal(buildModal("remove"));
      }
    }

    if (interaction.isModalSubmit() &&
        interaction.customId.startsWith("whitelist_modal:")) {
      if (!hasWhitelistAccess(interaction.member)) {
        return safeReply(
          interaction,
          "❌ You do not have the required Discord role to use the whitelist system."
        );
      }

      const action = interaction.customId.split(":")[1];
      const username = interaction.fields
        .getTextInputValue("minecraft_username")
        .trim();

      if (!usernameIsValid(username)) {
        return safeReply(
          interaction,
          "❌ Invalid Minecraft username. Use 3–16 letters, numbers, or underscores."
        );
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const command = action === "add"
        ? `whitelist add ${username}`
        : `whitelist remove ${username}`;

      try {
        const response = await executeRcon(command);

        recordRequest(
          interaction.user,
          username,
          action,
          true,
          response
        );

        return interaction.editReply(
          `✅ **${action === "add" ? "Whitelist successful" : "Whitelist removal successful"}**\n` +
          `Minecraft username: \`${username}\``
        );
      } catch (error) {
        recordRequest(
          interaction.user,
          username,
          action,
          false,
          error.message
        );

        return interaction.editReply(
          `❌ **RCON error**\nCould not process \`${username}\` right now.\n` +
          `Please contact a server administrator.`
        );
      }
    }
  } catch (error) {
    console.error("Interaction error:", error);

    try {
      await safeReply(
        interaction,
        "❌ Something went wrong while processing your request."
      );
    } catch {}
  }
});

process.on("unhandledRejection", error => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Shutting down.");
  try {
    db.close();
  } finally {
    process.exit(0);
  }
});

client.login(config.token);
