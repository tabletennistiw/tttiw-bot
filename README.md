# TTTIW Discord Bot

Reports match results to the leaderboard straight from Discord.

## Usage

Anyone in the server can type a match result in this format:

```
Winner Loser 11-9
```

The first name is always the **winner**, second is the **loser**, followed by the score.  
The bot will update both players' Glicko-2 ratings in Firestore and post a full summary.

**Examples:**
```
John Jane 11-7
@Alice @Bob 3-1
Mike Sarah 21-19
```

> Player names must match exactly (case-insensitive) as they appear on the leaderboard.  
> Discord @mentions also work if you store `discordId` on the player document.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create a Discord bot
1. Go to https://discord.com/developers/applications
2. New Application → Bot → copy the **Token**
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Invite the bot to your server with scopes: `bot` + permissions: `Send Messages`, `Read Message History`, `Embed Links`

### 3. Get a Firebase service account
1. Firebase Console → Project Settings → Service Accounts
2. Click **Generate new private key** → download the JSON file

### 4. Set environment variables

Create a `.env` file (or set in your hosting environment):

```env
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=123456789012345678        # optional: restrict to one channel
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"tttiw-6d44e",...}
```

Or point to the JSON file instead:
```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
```

### 5. Run
```bash
npm start
```

---

## Hosting (free options)

- **Railway** — easiest, connect GitHub repo, set env vars, done
- **Render** — free tier works fine for a bot
- **Fly.io** — very fast deploys
- **Your own machine** — just run `npm start` in a tmux session

---

## Optional: Link Discord accounts to players

If you add a `discordId` field to a player's Firestore document (their Discord user ID as a string), players can be matched by @mention instead of name:

```json
{ "name": "John", "discordId": "123456789012345678", ... }
```

Then `@John` will resolve to that player automatically.
