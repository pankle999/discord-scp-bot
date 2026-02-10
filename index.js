
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Command deployment configuration
const DEPLOY_GLOBAL = process.env.DEPLOY_GLOBAL === 'true'; // Set to 'true' in env for global
const GUILD_ID = process.env.GUILD_ID; // Your Discord server ID for testing

// Register commands
(async () => {
  try {
    console.log('🔄 Registering slash commands...');
    
    if (DEPLOY_GLOBAL) {
      // Global commands (takes 1 hour to update)
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Global slash commands registered!');
    } else if (GUILD_ID) {
      // Guild-specific commands (instant update, for testing)
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Guild slash commands registered for ${GUILD_ID}!`);
    } else {
      console.log('⚠️ No deployment mode set. Add DEPLOY_GLOBAL=true or GUILD_ID to env');
    }
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
})();

// Initialize Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Commands array
const commands = [
  {
    name: 'balance',
    description: 'View your vault balances'
  },
  {
    name: 'vault',
    description: 'View details of a specific vault',
    options: [{
      name: 'name',
      description: 'Vault name',
      type: 3, // STRING
      required: true
    }]
  },
  {
    name: 'items',
    description: 'View items in your vault',
    options: [{
      name: 'vault',
      description: 'Vault name',
      type: 3,
      required: true
    }]
  },
  {
    name: 'transactions',
    description: 'View recent transactions',
    options: [{
      name: 'vault',
      description: 'Vault name',
      type: 3,
      required: true
    }, {
      name: 'limit',
      description: 'Number of transactions (default: 10)',
      type: 4, // INTEGER
      required: false
    }]
  },
  {
    name: 'catalog',
    description: 'View all available items'
  }
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
})();

// Bot ready event
client.once('ready', () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} servers`);
  client.user.setActivity('SCP Foundation Database', { type: 'WATCHING' });
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'balance') {
      await handleBalance(interaction);
    } else if (commandName === 'vault') {
      await handleVault(interaction);
    } else if (commandName === 'items') {
      await handleItems(interaction);
    } else if (commandName === 'transactions') {
      await handleTransactions(interaction);
    } else if (commandName === 'catalog') {
      await handleCatalog(interaction);
    }
  } catch (error) {
    console.error('Error handling command:', error);
    await interaction.reply({
      content: '❌ An error occurred while processing your command.',
      ephemeral: true
    });
  }
});

// Command handlers
async function handleBalance(interaction) {
  await interaction.deferReply();
  
  const userId = interaction.user.id;
  
  // Get user's vaults
  const banksSnapshot = await db.collection('banks')
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (banksSnapshot.empty) {
    return interaction.editReply('❌ You have no authorized vaults. Contact an administrator.');
  }
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle('💰 YOUR VAULTS')
    .setDescription('**SCP FOUNDATION - FINANCIAL DATABASE**')
    .setTimestamp();
  
  banksSnapshot.forEach(doc => {
    const bank = doc.data();
    const totalIncome = Object.values(bank.generators || {})
      .reduce((sum, gen) => sum + (gen.weeklyIncome || 0), 0);
    
    let value = `**Balance:** $${bank.balance.toFixed(2)}\n`;
    value += `**Items:** ${Object.keys(bank.items || {}).length} types\n`;
    if (totalIncome > 0) {
      value += `**Income:** $${totalIncome.toFixed(2)}/week`;
    }
    
    embed.addFields({ name: `🏦 ${bank.name}`, value, inline: true });
  });
  
  await interaction.editReply({ embeds: [embed] });
}

async function handleVault(interaction) {
  await interaction.deferReply();
  
  const vaultName = interaction.options.getString('name');
  const userId = interaction.user.id;
  
  // Find vault
  const vaultSnapshot = await db.collection('banks')
    .where('name', '==', vaultName)
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (vaultSnapshot.empty) {
    return interaction.editReply('❌ Vault not found or access denied.');
  }
  
  const vault = vaultSnapshot.docs[0].data();
  const vaultId = vaultSnapshot.docs[0].id;
  
  // Calculate totals
  const totalIncome = Object.values(vault.generators || {})
    .reduce((sum, gen) => sum + (gen.weeklyIncome || 0), 0);
  const netIncome = totalIncome * 0.75; // After 25% tax
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle(`🏦 VAULT: ${vault.name}`)
    .setDescription('**[CLASSIFIED - LEVEL 4]**')
    .addFields(
      { name: '💵 Balance', value: `$${vault.balance.toFixed(2)}`, inline: true },
      { name: '📦 Items', value: `${Object.keys(vault.items || {}).length} types`, inline: true },
      { name: '⚙️ Generators', value: `${Object.keys(vault.generators || {}).length}`, inline: true }
    )
    .setFooter({ text: `Vault ID: ${vaultId.substring(0, 8)}` })
    .setTimestamp();
  
  if (totalIncome > 0) {
    embed.addFields({
      name: '💰 Weekly Income',
      value: `**Gross:** $${totalIncome.toFixed(2)}\n**Tax (25%):** -$${(totalIncome * 0.25).toFixed(2)}\n**Net:** $${netIncome.toFixed(2)}`
    });
  }
  
  if (vault.owner) {
    embed.addFields({ name: '👤 Owner', value: `<@${vault.owner}>`, inline: true });
  }
  
  if (vault.managers && vault.managers.length > 0) {
    const managers = vault.managers.slice(0, 3).map(m => `<@${m}>`).join(', ');
    const extra = vault.managers.length > 3 ? `\n+${vault.managers.length - 3} more` : '';
    embed.addFields({ name: '👥 Managers', value: managers + extra, inline: true });
  }
  
  await interaction.editReply({ embeds: [embed] });
}

async function handleItems(interaction) {
  await interaction.deferReply();
  
  const vaultName = interaction.options.getString('vault');
  const userId = interaction.user.id;
  
  const vaultSnapshot = await db.collection('banks')
    .where('name', '==', vaultName)
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (vaultSnapshot.empty) {
    return interaction.editReply('❌ Vault not found or access denied.');
  }
  
  const vault = vaultSnapshot.docs[0].data();
  const items = vault.items || {};
  
  if (Object.keys(items).length === 0) {
    return interaction.editReply('📦 No items in storage.');
  }
  
  // Get item details from items collection
  const itemsSnapshot = await db.collection('items').get();
  const itemDetails = {};
  itemsSnapshot.forEach(doc => {
    const data = doc.data();
    itemDetails[data.name] = data;
  });
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle(`📦 INVENTORY: ${vault.name}`)
    .setDescription('**[ITEM STORAGE]**')
    .setTimestamp();
  
  let itemsList = '';
  for (const [itemName, quantity] of Object.entries(items)) {
    const details = itemDetails[itemName];
    itemsList += `**${quantity}x ${itemName}**\n`;
    if (details && details.description) {
      itemsList += `*${details.description.substring(0, 100)}${details.description.length > 100 ? '...' : ''}*\n`;
    }
    itemsList += '\n';
  }
  
  // Split into multiple fields if too long
  if (itemsList.length > 1024) {
    const chunks = itemsList.match(/[\s\S]{1,1024}/g) || [];
    chunks.forEach((chunk, i) => {
      embed.addFields({ name: i === 0 ? 'Items' : '\u200b', value: chunk });
    });
  } else {
    embed.addFields({ name: 'Items', value: itemsList || 'None' });
  }
  
  await interaction.editReply({ embeds: [embed] });
}

async function handleTransactions(interaction) {
  await interaction.deferReply();
  
  const vaultName = interaction.options.getString('vault');
  const limit = interaction.options.getInteger('limit') || 10;
  const userId = interaction.user.id;
  
  const vaultSnapshot = await db.collection('banks')
    .where('name', '==', vaultName)
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (vaultSnapshot.empty) {
    return interaction.editReply('❌ Vault not found or access denied.');
  }
  
  const vault = vaultSnapshot.docs[0].data();
  const transactions = vault.transactions || [];
  
  if (transactions.length === 0) {
    return interaction.editReply('📜 No transactions recorded.');
  }
  
  const recentTransactions = transactions
    .sort((a, b) => b.id - a.id)
    .slice(0, Math.min(limit, 25));
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle(`📜 TRANSACTION LOG: ${vault.name}`)
    .setDescription(`**Last ${recentTransactions.length} transactions**`)
    .setTimestamp();
  
  recentTransactions.forEach(tx => {
    const icon = tx.amount >= 0 ? '📈' : '📉';
    let value = `**${tx.description}**\n`;
    value += `Date: ${tx.date}\n`;
    
    if (tx.amount !== undefined) {
      value += `Amount: ${tx.amount >= 0 ? '+' : ''}$${tx.amount.toFixed(2)}\n`;
    }
    
    if (tx.previousBalance !== undefined && tx.newBalance !== undefined) {
      value += `Balance: $${tx.previousBalance.toFixed(2)} → $${tx.newBalance.toFixed(2)}\n`;
    }
    
    if (tx.items && Object.keys(tx.items).length > 0) {
      const itemsList = Object.entries(tx.items)
        .map(([name, qty]) => `${qty}x ${name}`)
        .join(', ');
      value += `Items: ${itemsList}\n`;
    }
    
    embed.addFields({ name: `${icon} Transaction`, value, inline: false });
  });
  
  await interaction.editReply({ embeds: [embed] });
}

async function handleCatalog(interaction) {
  await interaction.deferReply();
  
  const itemsSnapshot = await db.collection('items').get();
  
  if (itemsSnapshot.empty) {
    return interaction.editReply('📦 No items registered in catalog.');
  }
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle('📚 ITEM CATALOG')
    .setDescription('**SCP Foundation - Registered Items**')
    .setTimestamp();
  
  itemsSnapshot.forEach(doc => {
    const item = doc.data();
    let value = '';
    if (item.description) {
      value = `*${item.description.substring(0, 100)}${item.description.length > 100 ? '...' : ''}*`;
    } else {
      value = '*No description available.*';
    }
    
    embed.addFields({ name: `📦 ${item.name}`, value, inline: true });
  });
  
  await interaction.editReply({ embeds: [embed] });
}

// Login
client.login(process.env.DISCORD_BOT_TOKEN);

// Keep-alive for Render
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running!');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive server running on port ${process.env.PORT || 3000}`);
});
