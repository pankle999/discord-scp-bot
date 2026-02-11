# SCP Bank Discord Bot

## Setup

1. Push this folder to GitHub
2. Connect to Render.com
3. Add environment variables in Render:

```
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...paste entire JSON...}
GUILD_ID=your_server_id_for_testing
```

## Command Deployment

### Testing (Instant Updates)
Set `GUILD_ID` to your Discord server ID. Commands update instantly in that server.

### Production (Global)
Remove `GUILD_ID` and set `DEPLOY_GLOBAL=true`. Commands work in all servers but take up to 1 hour to update.

## Commands

- `/balance` - View your banks
- `/bank [name]` - View bank details
- `/items [bank]` - View items in bank
- `/transactions [bank] [limit]` - View transaction history
- `/catalog` - View all available items

## Deploy to Render

```bash
cd "C:\F Drive\Claude\Discord Bot\discord-scp-bot"
git init
git add .
git commit -m "Initial bot"
git remote add origin https://github.com/yourusername/discord-scp-bot.git
git push -u origin main
```

Then connect the repo to Render.com