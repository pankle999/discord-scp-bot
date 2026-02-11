const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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
    description: 'View your bank balances'
  },
  {
    name: 'bank',
    description: 'View details of a specific bank',
    options: [{
      name: 'name',
      description: 'Bank name',
      type: 3,
      required: true
    }]
  },
  {
    name: 'items',
    description: 'View items in your bank',
    options: [{
      name: 'bank',
      description: 'Bank name',
      type: 3,
      required: true
    }]
  },
  {
    name: 'transactions',
    description: 'View recent transactions',
    options: [{
      name: 'bank',
      description: 'Bank name',
      type: 3,
      required: true
    }, {
      name: 'limit',
      description: 'Number of transactions (default: 10)',
      type: 4,
      required: false
    }]
  },
  {
    name: 'catalog',
    description: 'View all available items'
  }
];

// Command deployment configuration
const DEPLOY_GLOBAL = process.env.DEPLOY_GLOBAL === 'true';
const GUILD_ID = process.env.GUILD_ID;

// Register slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');
    
    if (DEPLOY_GLOBAL) {
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Global slash commands registered (may take up to 1 hour)!');
    } else if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Guild slash commands registered for server ${GUILD_ID}!`);
    } else {
      console.warn('⚠️ No DEPLOY_GLOBAL or GUILD_ID set. Commands not registered.');
      console.warn('⚠️ Add GUILD_ID=your_server_id for testing (instant)');
      console.warn('⚠️ Or add DEPLOY_GLOBAL=true for production (1 hour delay)');
    }
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
    } else if (commandName === 'bank') {
      await handleBank(interaction);
    } else if (commandName === 'items') {
      await handleItems(interaction);
    } else if (commandName === 'transactions') {
      await handleTransactions(interaction);
    } else if (commandName === 'catalog') {
      await handleCatalog(interaction);
    }
  } catch (error) {
    console.error('Error handling command:', error);
    const errorMsg = '❌ An error occurred while processing your command.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errorMsg, ephemeral: true });
    } else {
      await interaction.reply({ content: errorMsg, ephemeral: true });
    }
  }
});

// Command handlers
async function handleBalance(interaction) {
  await interaction.deferReply();
  
  const userId = interaction.user.id;
  
  const banksSnapshot = await db.collection('banks')
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (banksSnapshot.empty) {
    return interaction.editReply('❌ You have no authorized banks. Contact an administrator.');
  }
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle('💰 YOUR BANKS')
    .setDescription('**SCP FOUNDATION - FINANCIAL DATABASE**')
    .setTimestamp();
  
  banksSnapshot.forEach(doc => {
    const bank = doc.data();
    const totalIncome = Object.values(bank.generators || {})
      .reduce((sum, gen) => sum + (gen.weeklyIncome || 0), 0);
    
    let value = `**Balance:** $${bank.balance.toFixed(2)}\n`;
    value += `**Category:** ${bank.category || 'Department'}\n`;
    value += `**Items:** ${Object.keys(bank.items || {}).length} types\n`;
    if (totalIncome > 0) {
      const netIncome = totalIncome * 0.75;
      value += `**Income:** $${netIncome.toFixed(2)}/week (after tax)`;
    }
    
    embed.addFields({ name: `🏦 ${bank.name}`, value, inline: true });
  });
  
  await interaction.editReply({ embeds: [embed] });
}

async function handleBank(interaction) {
  await interaction.deferReply();
  
  const bankName = interaction.options.getString('name');
  const userId = interaction.user.id;
  
  const bankSnapshot = await db.collection('banks')
    .where('name', '==', bankName)
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (bankSnapshot.empty) {
    return interaction.editReply('❌ Bank not found or access denied.');
  }
  
  const bank = bankSnapshot.docs[0].data();
  const bankId = bankSnapshot.docs[0].id;
  
  const totalIncome = Object.values(bank.generators || {})
    .reduce((sum, gen) => sum + (gen.weeklyIncome || 0), 0);
  const netIncome = totalIncome * 0.75;
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle(`🏦 BANK: ${bank.name}`)
    .setDescription(`**[${bank.category || 'Department'}]**`)
    .addFields(
      { name: '💵 Balance', value: `$${bank.balance.toFixed(2)}`, inline: true },
      { name: '📦 Items', value: `${Object.keys(bank.items || {}).length} types`, inline: true },
      { name: '⚙️ Generators', value: `${Object.keys(bank.generators || {}).length}`, inline: true }
    )
    .setFooter({ text: `Bank ID: ${bankId.substring(0, 8)}` })
    .setTimestamp();
  
  if (totalIncome > 0) {
    embed.addFields({
      name: '💰 Weekly Income',
      value: `**Gross:** $${totalIncome.toFixed(2)}\n**Tax (25%):** -$${(totalIncome * 0.25).toFixed(2)}\n**Net:** $${netIncome.toFixed(2)}`
    });
  }
  
  if (bank.owner) {
    embed.addFields({ name: '👤 Owner', value: `<@${bank.owner}>`, inline: true });
  }
  
  if (bank.managers && bank.managers.length > 0) {
    const managers = bank.managers.slice(0, 3).map(m => `<@${m}>`).join(', ');
    const extra = bank.managers.length > 3 ? `\n+${bank.managers.length - 3} more` : '';
    embed.addFields({ name: '👥 Managers', value: managers + extra, inline: true });
  }
  
  await interaction.editReply({ embeds: [embed] });
}

async function handleItems(interaction) {
  await interaction.deferReply();
  
  const bankName = interaction.options.getString('bank');
  const userId = interaction.user.id;
  
  const bankSnapshot = await db.collection('banks')
    .where('name', '==', bankName)
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (bankSnapshot.empty) {
    return interaction.editReply('❌ Bank not found or access denied.');
  }
  
  const bank = bankSnapshot.docs[0].data();
  const items = bank.items || {};
  
  if (Object.keys(items).length === 0) {
    return interaction.editReply('📦 No items in storage.');
  }
  
  const itemsSnapshot = await db.collection('items').get();
  const itemDetails = {};
  itemsSnapshot.forEach(doc => {
    const data = doc.data();
    itemDetails[data.name] = data;
  });
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle(`📦 INVENTORY: ${bank.name}`)
    .setDescription('**[ITEM STORAGE]**')
    .setTimestamp();
  
  let itemsList = '';
  for (const [itemName, quantity] of Object.entries(items)) {
    const details = itemDetails[itemName];
    itemsList += `**${quantity}x ${itemName}**`;
    if (details && details.category) {
      itemsList += ` [${details.category}]`;
    }
    itemsList += '\n';
    if (details && details.description) {
      const desc = details.description.substring(0, 100);
      itemsList += `*${desc}${details.description.length > 100 ? '...' : ''}*\n`;
    }
    itemsList += '\n';
  }
  
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
  
  const bankName = interaction.options.getString('bank');
  const limit = interaction.options.getInteger('limit') || 10;
  const userId = interaction.user.id;
  
  const bankSnapshot = await db.collection('banks')
    .where('name', '==', bankName)
    .where('authorizedUsers', 'array-contains', userId)
    .get();
  
  if (bankSnapshot.empty) {
    return interaction.editReply('❌ Bank not found or access denied.');
  }
  
  const bank = bankSnapshot.docs[0].data();
  const transactions = bank.transactions || [];
  
  if (transactions.length === 0) {
    return interaction.editReply('📜 No transactions recorded.');
  }
  
  const recentTransactions = transactions
    .sort((a, b) => b.id - a.id)
    .slice(0, Math.min(limit, 25));
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle(`📜 TRANSACTION LOG: ${bank.name}`)
    .setDescription(`**Last ${recentTransactions.length} transactions**`)
    .setTimestamp();
  
  recentTransactions.forEach(tx => {
    const icon = (tx.type === 'credit' || tx.type === 'transfer_in' || tx.type === 'item_add') ? '📈' : '📉';
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
    
    if (value.length > 1024) {
      value = value.substring(0, 1020) + '...';
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
  
  const itemsByCategory = {
    'Paratechnology': [],
    'Technology': [],
    'Units': [],
    'Misc': []
  };
  
  itemsSnapshot.forEach(doc => {
    const item = doc.data();
    const category = item.category || 'Misc';
    if (!itemsByCategory[category]) {
      itemsByCategory[category] = [];
    }
    itemsByCategory[category].push(item);
  });
  
  const embed = new EmbedBuilder()
    .setColor(0xCC0000)
    .setTitle('📚 ITEM CATALOG')
    .setDescription('**SCP Foundation - Registered Items**')
    .setTimestamp();
  
  for (const [category, items] of Object.entries(itemsByCategory)) {
    if (items.length === 0) continue;
    
    let categoryText = '';
    items.slice(0, 10).forEach(item => {
      categoryText += `**${item.name}**`;
      if (item.description) {
        const desc = item.description.substring(0, 50);
        categoryText += ` - *${desc}${item.description.length > 50 ? '...' : ''}*`;
      }
      categoryText += '\n';
    });
    
    if (items.length > 10) {
      categoryText += `*+${items.length - 10} more items*`;
    }
    
    if (categoryText) {
      embed.addFields({ name: `📦 ${category}`, value: categoryText || 'None', inline: false });
    }
  }
  
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});
