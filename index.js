require('dotenv').config();
const Discord = require('discord.js');
const { TeamSpeak } = require('ts3-nodejs-library');
const fs = require('fs').promises;
const path = require('path');

const CONFIG = {
  updateInterval: 10000,
  forceRefreshInterval: 180000,
  embedColor: 0xFF69B4,
  embedTitle: 'TS Status',
  embedDataFile: path.join(__dirname, 'embedData.json'),
  reconnectDelay: 5000,
  countChannelId: process.env.DISCORD_COUNT_CHANNEL_ID || process.env.DISCORD_VC_STATUS_ID || null,
  countChannelUpdateInterval: 60000,
  countChannelNameTemplate: 'TeamSpeak: %COUNT%📞',
  maxUsernameLength: 15,
  ignoreDefaultChannel: true
};

const state = {
  tsClient: null,
  discordClient: null,
  statusEmbed: {},
  countChannel: null,
  lastCount: null,
  schedulerTimer: null,
  lastEmbedEdit: 0,
  pendingEmbedUpdate: false,
  recentRenames: []
};

function initDiscord() {
  state.discordClient = new Discord.Client({ 
    intents: [Discord.Intents.FLAGS.GUILDS, Discord.Intents.FLAGS.GUILD_MESSAGES],
    disableMentions: 'everyone' 
  });
  
  state.discordClient.once('ready', async () => {
    console.log(`Logged in as ${state.discordClient.user.tag}!`);
    await loadEmbedData();
    await ensureCountChannel();
    startSchedulerTimer();
    connectToTeamSpeak();
  });
  
  state.discordClient.on('message', handleDiscordMessage);
  state.discordClient.on('messageDelete', message => {
    if (state.statusEmbed?.messageId === message.id) {
      console.log('Status message was deleted, stopping updates');
      resetEmbedStatus();
    }
  });
  
  state.discordClient.login(process.env.DISCORD_TOKEN);
}

async function connectToTeamSpeak() {
  try {
    if (state.tsClient) {
      await state.tsClient.quit().catch(() => {});
      state.tsClient = null;
    }
    
    state.tsClient = await TeamSpeak.connect({
      host: process.env.TS_SERVER,
      queryport: parseInt(process.env.TS_PORT),
      username: process.env.TS_USERNAME,
      password: process.env.TS_PASSWORD,
      keepalive: true
    });
    
    console.log('Connected to TS server!');
    await state.tsClient.useByPort(parseInt(process.env.TS_VOICE_PORT || '9987'));
    await registerTeamSpeakEvents();
  } catch (error) {
    console.error('Error connecting to TeamSpeak:', error);
    reconnectTeamSpeak(30000);
  }
}

function reconnectTeamSpeak(delay = CONFIG.reconnectDelay) {
  if (state.tsClient) {
    state.tsClient.quit().catch(() => {});
    state.tsClient = null;
  }
  setTimeout(connectToTeamSpeak, delay);
}

async function registerTeamSpeakEvents() {
  if (!state.tsClient) return;
  
  try {
    await state.tsClient.registerEvent('server');
    await state.tsClient.registerEvent('channel', 0);
    
    state.tsClient.on('clientconnect', () => {
      state.pendingEmbedUpdate = true;
    });
    
    ['clientdisconnect', 'clientmoved'].forEach(event => {
      state.tsClient.on(event, () => { state.pendingEmbedUpdate = true; });
    });
    
    state.tsClient.on('error', error => {
      console.error('TS error:', error);
      const connectionErrors = ['ECONNRESET', 'not connected', 'Connection timed out'];
      if (error && (connectionErrors.some(msg => error.message?.includes(msg)) || error.id === '520')) {
        reconnectTeamSpeak();
      }
    });
    
    state.tsClient.on('close', () => {
      console.log('TS connection closed');
      reconnectTeamSpeak();
    });
  } catch (error) {
    console.error('Error registering TS events:', error);
    reconnectTeamSpeak();
  }
}

async function handleDiscordMessage(message) {
  if (!message.content) return;
  
  const botMention = `<@${state.discordClient.user.id}>`;
  const botMentionNick = `<@!${state.discordClient.user.id}>`;
  
  if ((message.content.startsWith(botMention) || message.content.startsWith(botMentionNick)) && 
      message.content.toLowerCase().includes('create')) {
    await createStatusEmbed(message);
  }
}

async function createStatusEmbed(message) {
  if (!state.tsClient) return message.reply('Not connected to TS server yet!');
  
  try {
    const embed = {
      color: CONFIG.embedColor,
      title: CONFIG.embedTitle,
      description: 'Loading status...',
      timestamp: new Date(),
      footer: { text: 'Last updated' }
    };
    
    const sentMessage = await message.channel.send('', { embed });
    state.statusEmbed = {
      messageId: sentMessage.id,
      channelId: message.channel.id,
      guildId: message.guild?.id,
      lastUpdate: new Date().toISOString(),
      lastState: null
    };
    
    await saveEmbedData();
    state.pendingEmbedUpdate = true;
    await updateStatusEmbed(true);
    state.lastEmbedEdit = Date.now();
    
    if (message.deletable) message.delete().catch(() => {});
  } catch (error) {
    console.error('Error creating status embed:', error);
    message.reply('Failed to create status embed: ' + error.message);
  }
}

async function updateStatusEmbed(forceUpdate = false) {
  if (!state.tsClient || !state.statusEmbed?.messageId) return;
  
  try {
    const [channels, clients] = await Promise.all([
      state.tsClient.channelList(),
      state.tsClient.clientList({ clientType: 0 })
    ]);
    
    const channelData = {};
    const inactiveChannels = [];
    
    channels.forEach(channel => {
      if (channel.name.includes('spacer') || channel.name.includes('Server Query') || (CONFIG.ignoreDefaultChannel && channel.flagDefault)) return;
      
      const usersInChannel = clients.filter(client => client.cid === channel.cid);
      if (usersInChannel.length > 0) {
        channelData[channel.cid] = {
          name: channel.name,
          users: usersInChannel.map(client => {
            return client.nickname;
          })
        };
      } else {
        inactiveChannels.push(channel.name);
      }
    });
    
    const currentState = JSON.stringify({ channelData, inactiveChannels });
    if (!forceUpdate && currentState === state.statusEmbed.lastState) return;
    
    state.statusEmbed.lastState = currentState;
    state.statusEmbed.lastUpdate = new Date().toISOString();
    
    try {
      const channel = await state.discordClient.channels.fetch(state.statusEmbed.channelId);
      if (!channel) throw new Error('Channel not found');
      
      const message = await channel.messages.fetch(state.statusEmbed.messageId);
      if (!message) throw new Error('Message not found');
      
      const embed = {
        color: CONFIG.embedColor,
        title: CONFIG.embedTitle,
        fields: [],
        timestamp: new Date(),
        footer: { text: 'Last updated' }
      };
      
      Object.values(channelData).forEach(channel => {
        embed.fields.push({
          name: channel.name,
          value: channel.users.length > 0 ? 
            channel.users.map(username => formatUsername(username)).join('\n') : 
            'Empty',
          inline: false
        });
      });
      
      if (inactiveChannels.length > 0) {
        embed.fields.push({
          name: 'Inactive Channels',
          value: inactiveChannels.join(', '),
          inline: false
        });
      }
      
      await message.edit('', { embed });
      state.lastEmbedEdit = Date.now();
      await saveEmbedData();
    } catch (error) {
      console.error('Could not update embed:', error);
      resetEmbedStatus();
    }
  } catch (error) {
    console.error('Error updating status embed:', error);
  }
}

function formatUsername(username) {
  const truncatedName = username.length > CONFIG.maxUsernameLength ? 
    username.substring(0, CONFIG.maxUsernameLength) + '...' : username;
  return `- ${truncatedName}`;
}

function startSchedulerTimer() {
  if (state.schedulerTimer) clearInterval(state.schedulerTimer);
  state.schedulerTimer = setInterval(async () => {
    const now = Date.now();

    if (state.countChannel && state.tsClient) {
      await updateCountChannelName().catch(() => {});
    }

    if (state.statusEmbed?.messageId) {
      const lastEmbedUpdateTime = state.statusEmbed.lastUpdate ? new Date(state.statusEmbed.lastUpdate).getTime() : 0;
      const needRegular = now - lastEmbedUpdateTime >= CONFIG.updateInterval;
      const needForce = now - lastEmbedUpdateTime >= CONFIG.forceRefreshInterval;

      if ((state.pendingEmbedUpdate || needRegular || needForce) && (now - state.lastEmbedEdit >= 5000)) {
        await updateStatusEmbed(needForce || state.pendingEmbedUpdate).catch(() => {});
        state.lastEmbedEdit = Date.now();
        state.pendingEmbedUpdate = false;
      }
    }
  }, 5000);
}

async function ensureCountChannel() {
  if (!CONFIG.countChannelId) {
    console.warn('DISCORD_COUNT_CHANNEL_ID not set – count feature disabled');
    return;
  }
  try {
    const channel = await state.discordClient.channels.fetch(CONFIG.countChannelId);
    if (!channel) {
      console.error('Count channel ID is invalid / not found');
      return;
    }
    state.countChannel = channel;
  } catch (error) {
    console.error('Error fetching count channel:', error);
  }
}

async function updateCountChannelName() {
  if (!state.countChannel || !state.tsClient) return;
  try {
    const [channels, clients] = await Promise.all([
      state.tsClient.channelList(),
      state.tsClient.clientList({ clientType: 0 })
    ]);
    
    const defaultChannel = channels.find(ch => ch.flagDefault);
    const defaultChannelId = defaultChannel?.cid;
    
    const activeClients = CONFIG.ignoreDefaultChannel ? clients.filter(client => client.cid !== defaultChannelId) : clients;
    const count = activeClients.length;
    if (state.lastCount === count) return;
    
    const now = Date.now();
    state.recentRenames = state.recentRenames.filter(time => now - time < 600000);
    
    const timeSinceLastRename = state.recentRenames.length > 0 ? 
      now - Math.max(...state.recentRenames) : Infinity;
    
    if (timeSinceLastRename >= 61000 && state.recentRenames.length < 2) {
      state.lastCount = count;
      const newName = CONFIG.countChannelNameTemplate.replace('%COUNT%', count);
      await state.countChannel.setName(newName);
      state.recentRenames.push(now);
    }
  } catch (error) {
    console.error('Failed to update count channel name:', error);
  }
}

function resetEmbedStatus() {
  state.statusEmbed = {
    messageId: null, channelId: null, guildId: null,
    lastUpdate: null, lastState: null
  };
  saveEmbedData();
  
  
}

async function saveEmbedData() {
  try {
    await fs.writeFile(CONFIG.embedDataFile, JSON.stringify(state.statusEmbed, null, 2));
  } catch (error) {
    console.error('Error saving embed data:', error);
  }
}

async function loadEmbedData() {
  try {
    try {
      await fs.access(CONFIG.embedDataFile);
    } catch (error) {
      console.log('Newfag. :P');
      state.statusEmbed = {};
      return false;
    }
    
    const data = await fs.readFile(CONFIG.embedDataFile, 'utf8');
    const loadedData = JSON.parse(data);
    
    if (loadedData?.messageId && loadedData?.channelId) {
      state.statusEmbed = loadedData;
      return true;
    }
  } catch (error) {
    console.error('Error loading embed data:', error);
    state.statusEmbed = {};
  }
  return false;
}

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (state.tsClient) await state.tsClient.quit().catch(() => {});
  if (state.discordClient) state.discordClient.destroy();
  if (state.schedulerTimer) clearInterval(state.schedulerTimer);
  process.exit(0);
});

initDiscord();