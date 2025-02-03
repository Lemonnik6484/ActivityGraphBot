const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const QuickChart = require('quickchart-js');
const Database = require('better-sqlite3');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const db = new Database('messages.db');

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
    messageId TEXT PRIMARY KEY,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    authorId TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL
)`).run();
db.prepare(`
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channelId)
`).run();
db.prepare(`
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp)
`).run();


db.pragma('journal_mode = WAL');

const activityStmts = {
    insert: db.prepare(`
        INSERT OR IGNORE INTO messages 
        (messageId, guildId, channelId, authorId, content, timestamp, type)
        VALUES (@messageId, @guildId, @channelId, @authorId, @content, @timestamp, @type)
    `),
    getLastTimestamp: db.prepare(`
        SELECT timestamp FROM messages 
        WHERE channelId = @channelId 
        ORDER BY timestamp DESC 
        LIMIT 1
    `),
    getChannelData: db.prepare(`
        SELECT timestamp, type FROM messages 
        WHERE channelId = @channelId AND timestamp >= @startTime
    `)
};

function determineMessageType(message) {
    if (message.components.length > 0) return 'poll';
    if (message.stickers.size > 0) return 'sticker';
    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();
        return attachment?.contentType?.startsWith('image/') ? 'image' :
            attachment?.contentType?.startsWith('video/') ? 'video' : 'file';
    }
    return 'text';
}

async function loadChannelHistory(channel) {
    try {
        const lastMessage = db.prepare(`
            SELECT messageId FROM messages 
            WHERE channelId = ? 
            ORDER BY timestamp DESC 
            LIMIT 1
        `).get(channel.id);

        let before = lastMessage?.messageId || null;
        let messagesAdded = 0;
        let hasMore = true;

        const insertMany = db.transaction((messages) => {
            for (const message of messages) {
                try {
                    activityStmts.insert.run(message);
                } catch (error) {
                    if (error.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                        throw error;
                    }
                }
            }
        });

        while (hasMore) {
            const options = { limit: 100 };
            if (before) options.before = before;

            const messages = await channel.messages.fetch(options)
                .catch(() => new Collection());

            if (messages.size === 0) {
                hasMore = false;
                break;
            }

            const batch = [];
            messages.forEach(msg => {
                if (msg.author.bot) return;

                batch.push({
                    messageId: msg.id,
                    guildId: msg.guild.id,
                    channelId: msg.channel.id,
                    authorId: msg.author.id,
                    content: msg.content.replace(/\n/g, ' ').slice(0, 1000),
                    timestamp: msg.createdTimestamp,
                    type: determineMessageType(msg)
                });
            });

            if (batch.length > 0) {
                try {
                    insertMany(batch);
                    messagesAdded += batch.length;
                } catch (error) {
                    console.error('Batch insert error:', error);
                }
            }

            before = messages.last()?.id;
            hasMore = messages.size === 100;
        }

        console.log(`[${new Date().toISOString()}] Loaded ${messagesAdded} messages for #${channel.name}`);
    } catch (error) {
        console.error('Error loading channel history:', error);
    }
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const guilds = client.guilds.cache;
    for (const guild of guilds.values()) {
        await guild.channels.fetch();
        const channels = guild.channels.cache.filter(ch => ch.isTextBased() && !ch.isThread());
        for (const channel of channels.values()) {
            if (channel.type !== 0) continue;
            await loadChannelHistory(channel);
        }
    }
    console.info('All messages have been loaded!');

    const commands = [
        new SlashCommandBuilder()
            .setName('activity')
            .setDescription('Show message activity in THIS channel')
            .addStringOption(option =>
                option.setName('period')
                    .setDescription('Select time period')
                    .addChoices(
                        { name: 'Last hour', value: 'hour' },
                        { name: 'Last 24 hours', value: 'day' },
                        { name: 'Last week', value: 'week' },
                        { name: 'Last month', value: 'month' },
                        { name: 'Last year', value: 'year' }
                    )
                    .setRequired(true)
            )
    ].map(command => command.toJSON());

    await client.application.commands.set(commands);
});

client.on('messageCreate', message => {
    if (message.author.bot || !message.guild || message.channel.type !== 0) return;

    try {
        activityStmts.insert.run({
            messageId: message.id,
            guildId: message.guild.id,
            channelId: message.channel.id,
            authorId: message.author.id,
            content: message.content.replace(/\n/g, ' '),
            timestamp: message.createdTimestamp,
            type: determineMessageType(message)
        });
    } catch (error) {
        console.error('Error saving message:', error);
    }
});

const periods = {
    'hour': 3600 * 1000,
    'day': 24 * 3600 * 1000,
    'week': 7 * 24 * 3600 * 1000,
    'month': 30 * 24 * 3600 * 1000,
    'year': 365 * 24 * 3600 * 1000
};

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'activity') {
        await handleActivityCommand(interaction);
    }
});

async function handleActivityCommand(interaction) {
    await interaction.deferReply();

    try {
        const period = interaction.options.getString('period');
        const channelId = interaction.channel.id;
        const channelName = interaction.channel.name;

        if (!periods[period]) {
            return interaction.editReply('Invalid time period!');
        }

        const timeRange = periods[period];
        const now = Date.now();
        const startTime = now - timeRange;

        const data = db.prepare(`
            SELECT type, timestamp
            FROM messages
            WHERE channelId = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        `).all(channelId, startTime);

        if (data.length === 0) {
            return interaction.editReply(`No activity data in #${channelName} for this period 😢`);
        }

        const contentTypes = ['text', 'poll', 'file', 'video', 'image', 'sticker'];
        const colors = {
            'text': '#5964ff',
            'poll': '#ff5964',
            'file': '#59ff64',
            'video': '#ff59f7',
            'image': '#f7ff59',
            'sticker': '#59fff7'
        };

        const intervals = 6;
        const interval = timeRange / intervals;
        const timeLabels = [];

        const datasets = contentTypes.map(type => ({
            label: type.toUpperCase(),
            data: new Array(intervals).fill(0),
            backgroundColor: colors[type]
        }));

        // Заполнение данных
        for (let i = 0; i < intervals; i++) {
            const intervalStart = startTime + i * interval;
            const intervalEnd = intervalStart + interval;

            const messagesInInterval = data.filter(m =>
                m.timestamp >= intervalStart && m.timestamp < intervalEnd
            );

            contentTypes.forEach((type, idx) => {
                datasets[idx].data[i] = messagesInInterval.filter(m => m.type === type).length;
            });

            const startDate = new Date(intervalStart);
            let label;

            if (['hour', 'day'].includes(period)) {
                label = startDate.toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else if (period === 'week') {
                label = startDate.toLocaleDateString('en-GB', {
                    weekday: 'short',
                    day: 'numeric'
                });
            } else if (period === 'month') {
                label = startDate.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short'
                });
            } else {
                label = startDate.toLocaleDateString('en-GB', {
                    month: 'short',
                    year: '2-digit'
                });
            }

            timeLabels.push(label);
        }

        const chart = new QuickChart();
        chart.setWidth(800)
            .setHeight(400)
            .setBackgroundColor('#2f3136')
            .setConfig({
                type: 'bar',
                data: {
                    labels: timeLabels,
                    datasets: datasets
                },
                options: {
                    scales: {
                        y: {
                            stacked: true,
                            ticks: {
                                color: '#fff',
                                stepSize: 1
                            },
                            grid: {color: '#40444b'},
                            title: {
                                text: 'Message Count',
                                color: '#fff'
                            },
                            beginAtZero: true
                        },
                        x: {
                            stacked: true,
                            ticks: {color: '#fff'},
                            grid: {color: '#40444b'},
                            title: {
                                text: 'Time Period',
                                color: '#fff'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {color: '#fff'}
                        }
                    }
                }
            });

        const embed = new EmbedBuilder()
            .setTitle(`📊 Activity in #${channelName}`)
            .setDescription(`Message statistics for **${period}** period`)
            .setColor('#5865f2')
            .setImage(await chart.getShortUrl());

        await interaction.editReply({embeds: [embed]});

    } catch (error) {
        console.error('Command error:', error);
        await interaction.editReply('❌ Error generating activity report');
    }
}

client.login('YOUR_TOKEN_HERE');