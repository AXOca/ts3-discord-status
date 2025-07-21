# TeamSpeak Status/Channel Monitor

A Discord bot that displays real-time TeamSpeak server status and user counts.

## What This Does

This bot bridges TeamSpeak and Discord by providing:

- **Real-time status embeds** showing who's in which TeamSpeak channels
- **Configurable user count** in Discord channel names
- **Live embeds** showing exactly who's in which channels

<img width="292" height="70" alt="Screenshot Counter" src="https://github.com/user-attachments/assets/1ce53f45-4d29-4b9b-9e4d-4f93de893fb1" />


## Features

- Live embeds showing exactly who's in which channels
- Gentle rate limit handling for Discord channel renames (2 per 10 minutes) and message edits

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. `npm install`
3. `node bot.js`
4. Mention the bot with "create" to make a status embed

## Configuration

Edit the `CONFIG` object at the top of the file:
- `ignoreDefaultChannel: true` - Skip the default channel in counts/embeds
- `maxUsernameLength: 15` - Prevent embed overflow from long usernames
- `countChannelNameTemplate` - Customize the counter format

## Requirements

- Node.js
- TeamSpeak server with Query access
- Discord bot token

---

**Built with:** [Node.js](https://nodejs.org/), [Discord.js](https://discord.js.org/), [ts3-nodejs-library](https://github.com/Multivit4min/TS3-NodeJS-Library)
