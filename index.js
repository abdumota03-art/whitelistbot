require("dotenv").config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags, ActivityType
} = require("discord.js");
const { Rcon } = require("rcon-client");
const { Pool } = require("pg");

const required = [
  "DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID",
  "RCON_HOST", "RCON_PASSWORD", "DATABASE_URL"
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
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === "true",
  status: process.env.BOT_STATUS || "Whitelist Manager"
};

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", err => console.error("PostgreSQL pool error:", err));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id TEXT NOT NULL,
      discord_username TEXT NOT NULL,
      minecraft_username TEXT NOT NULL,
      action TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_requests_user
      ON requests(discord_user_id);

    CREATE INDEX IF NOT EXISTS idx_requests_created_at
      ON requests(created_at);
  `);

  console.log("PostgreSQL database initialized.");
}

async function getSetting(key, fallback = "") {
  const result = await pool.query(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings(key, value)
     VALUES($1, $2)
     ON CONFLICT(key)
     DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function recordRequest(user, username, action, success, response) {
  await pool.query(
    `INSERT INTO requests
      (discord_user_id, discord_username, minecraft_username, action, success, response)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, user.tag || user.username, username, action, success, response || ""]
  );
}

function validUsername(username) {
  return /^[A-Za-z0-9_]{3,16}$/.test(username);
}

function isAdmin(member) {
  if (!member) return false;
  return (config.adminRoleId && member.roles.cache.has(config.adminRoleId)) ||
    member.permissions.has(PermissionFlagsBits.Administrator);
}

function canUseWhitelist(member) {
  return !config.whitelistRoleId || member.roles.cache.has(config.whitelistRoleId);
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle("Minecraft Whitelist")
    .setDescription(
      "Use the buttons below to manage your Minecraft whitelist.\\n\\n" +
      "🟢 **Whitelist Me** — add your Minecraft account\\n" +
      "🔴 **Remove Whitelist** — remove your Minecraft account\\n\\n" +
      "Enter your exact Minecraft Java username."
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

function whitelistModal(action) {
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

async function rconCommand(command) {
  const rcon = await Rcon.connect({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
    timeout: 8000
  });

  try {
    return await rcon.send(command);
  } finally {
    try { await rcon.end(); } catch {}
  }
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
    .addStringOption(o => o.setName("username").setDescription("Minecraft username")
      .setRequired(true).setMinLength(3).setMaxLength(16)),
  new SlashCommandBuilder()
    .setName("unwhitelist")
    .setDescription("Manually remove a Minecraft username from the whitelist.")
    .addStringOption(o => o.setName("username").setDescription("Minecraft username")
      .setRequired(true).setMinLength(3).setMaxLength(16))
].map(c => c.toJSON());

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
  const savedId = await getSetting("panel_message_id", config.panelMessageId);

  if (savedId) {
    try {
      const message = await channel.messages.fetch(savedId);
      await message.edit(panelPayload());
      await setSetting("panel_channel_id", channel.id);
      return message;
    } catch {}
  }

  const message = await channel.send(panelPayload());
  await setSetting("panel_channel_id", channel.id);
  await setSetting("panel_message_id", message.id);
  return message;
}

async function replyEphemeral(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity(config.status, { type: ActivityType.Watching });

  try {
    await initDatabase();
    await registerCommands();

    const channelId = await getSetting("panel_channel_id", config.channelId);
    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) await createOrRefreshPanel(channel);
      } catch (err) {
        console.error("Panel refresh failed:", err.message);
      }
    }

    console.log("Whitelist bot is fully operational.");
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!isAdmin(interaction.member)) {
        return replyEphemeral(interaction, "❌ You do not have permission to use this command.");
      }

      if (interaction.commandName === "set-whitelist-channel") {
        await setSetting("panel_channel_id", interaction.channelId);
        return replyEphemeral(interaction, "✅ This channel is now the whitelist panel channel.");
      }

      if (interaction.commandName === "setup-whitelist" ||
          interaction.commandName === "whitelist-panel") {
        const msg = await createOrRefreshPanel(interaction.channel);
        return replyEphemeral(interaction, `✅ Whitelist panel ready. Message ID: \`${msg.id}\``);
      }

      if (interaction.commandName === "whitelist" ||
          interaction.commandName === "unwhitelist") {
        const username = interaction.options.getString("username", true).trim();
        if (!validUsername(username)) {
          return replyEphemeral(interaction,
            "❌ Invalid Minecraft username. Use 3–16 letters, numbers, or underscores.");
        }

        const add = interaction.commandName === "whitelist";
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const response = await rconCommand(
            `${add ? "whitelist add" : "whitelist remove"} ${username}`
          );
          await recordRequest(interaction.user, username, add ? "add" : "remove", true, response);
          return interaction.editReply(
            `✅ **${add ? "Whitelisted" : "Removed"}** \`${username}\`.`
          );
        } catch (err) {
          await recordRequest(interaction.user, username, add ? "add" : "remove", false, err.message);
          return interaction.editReply(
            `❌ RCON request failed: \`${String(err.message).slice(0, 500)}\``
          );
        }
      }
    }

    if (interaction.isButton()) {
      if (!canUseWhitelist(interaction.member)) {
        return replyEphemeral(interaction,
          "❌ You do not have the required Discord role to use the whitelist system.");
      }

      if (interaction.customId === "whitelist_add") {
        return interaction.showModal(whitelistModal("add"));
      }
      if (interaction.customId === "whitelist_remove") {
        return interaction.showModal(whitelistModal("remove"));
      }
    }

    if (interaction.isModalSubmit() &&
        interaction.customId.startsWith("whitelist_modal:")) {
      if (!canUseWhitelist(interaction.member)) {
        return replyEphemeral(interaction,
          "❌ You do not have the required Discord role to use the whitelist system.");
      }

      const action = interaction.customId.split(":")[1];
      const username = interaction.fields.getTextInputValue("minecraft_username").trim();

      if (!validUsername(username)) {
        return replyEphemeral(interaction,
          "❌ Invalid Minecraft username. Use 3–16 letters, numbers, or underscores.");
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await rconCommand(`${action === "add" ? "whitelist add" : "whitelist remove"} ${username}`);
        await recordRequest(interaction.user, username, action, true, "RCON command completed");

        return interaction.editReply(
          `✅ **${action === "add" ? "Whitelist successful" : "Whitelist removal successful"}**\\n` +
          `Minecraft username: \`${username}\``
        );
      } catch (err) {
        await recordRequest(interaction.user, username, action, false, err.message);
        return interaction.editReply(
          "❌ **RCON error**\\nCould not process that Minecraft username right now."
        );
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    try {
      await replyEphemeral(interaction, "❌ Something went wrong while processing your request.");
    } catch {}
  }
});

process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught exception:", err));

async function shutdown() {
  try { await pool.end(); } catch {}
  try { client.destroy(); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

client.login(config.token).catch(err => {
  console.error("Discord login failed:", err);
  process.exit(1);
});
