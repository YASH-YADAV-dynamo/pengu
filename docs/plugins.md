# Plugins

Plugins bring work into Pengu from other tools. Whatever they create is an ordinary ticket, so Team sync shares it with everyone.

| Plugin | Runs on | What it does |
|---|---|---|
| **Slack** | the sync server (`server/plugins/slack.ts`) | Mention `@Pengu` in a channel or DM it to create, list and close tickets |
| **Gmail** | each person's app (`src/main/plugins/gmail.ts`) | Emails you label `Pengu` become your tickets |

## Slack

Needs the sync server reachable over **HTTPS** (Slack must be able to call it). For a quick local try, a tunnel works,
e.g. `cloudflared tunnel --url http://localhost:8787`.
On Vercel, keep **Settings → Build → Include files outside the root directory** on (the plugin uses `src/shared/dates.ts`).

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick your workspace and paste this
   (replace the URL with your server's):

   ```yaml
   display_information:
     name: Pengu
   features:
     bot_user:
       display_name: Pengu
       always_online: true
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
   oauth_config:
     scopes:
       bot: [app_mentions:read, chat:write, im:history]
   settings:
     event_subscriptions:
       request_url: https://YOUR-SERVER/api/slack/events
       bot_events: [app_mention, message.im]
   ```

2. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) and, from **Basic Information**, the **Signing Secret**.
3. Put them in `server/.env` (or your host's environment variables) and restart the server:

   ```
   SLACK_BOT_TOKEN="<bot token>"
   SLACK_SIGNING_SECRET="<signing secret>"
   ```

   `npm run pengu -- doctor` shows whether the plugin is on.
4. Link each person to their Slack account (in Slack: profile → ⋮ → **Copy member ID**):

   ```bash
   npm run pengu -- user slack ben U01ABCDEF
   ```

5. Invite the bot to a channel (`/invite @Pengu`) and try it:

   ```
   @Pengu fix the login page for @ben by friday
   @Pengu my tickets
   @Pengu done 3f2a9c
   ```

How it stays safe: every request must carry Slack's signature (checked with the signing secret, max 5 minutes old);
only people an admin linked can act, with their Pengu role (viewers can only list); retried deliveries are handled once.
Dates like "friday" use the server's time zone.

## Gmail

Each person connects their own Gmail in **Settings → Plugins**. One admin creates the Google OAuth client once:

1. In <https://console.cloud.google.com>: create (or pick) a project, **enable the Gmail API**.
2. **OAuth consent screen**: User type *Internal* (Google Workspace) or *External* with your teammates added as test users.
   Add the scope `https://www.googleapis.com/auth/gmail.metadata`.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Share the client id and secret with the team
   through your password manager (not chat).
4. In Pengu: **Settings → Plugins → Gmail**, paste both, **Connect Gmail**, approve in the browser.
5. In Gmail, create a label called **Pengu**. Put it on any email you want as a ticket; Pengu checks every 2 minutes.

Privacy: the `gmail.metadata` scope lets Pengu read labels, subjects and senders, never email bodies or attachments.
The subject becomes the ticket title and the sender plus a Gmail link go into its notes, which Team sync shares with your
team. The Google refresh token is encrypted with the OS keychain and stays on your computer; **Disconnect** deletes it and
revokes Pengu's access at Google.

## Writing a plugin

- **Server plugin** (reacts to another service's webhooks): add a route in `server/plugins/<name>.ts`, register it in
  `server/plugins/index.ts` with the environment variables that turn it on, and add a Vercel route in `server/api/`.
  Verify the caller (signatures), act as a linked Pengu user with their role, and write rows with a new `sync_seq` value.
- **App plugin** (uses one person's account): add `src/main/plugins/<name>.ts`, keep tokens encrypted with `safeStorage`,
  create items through `store.update`, and add IPC handlers in `src/main/index.ts` plus a row in `PluginsSection.tsx`.
- Add tests (`server/test/`) and a section to this file.
