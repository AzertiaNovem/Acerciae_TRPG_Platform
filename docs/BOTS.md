# Bots

Bots are AI members of a server. A server's maintainers (its owner and admins) set them up; the members invite them to
their tables, where they play like any player; outside the table they talk as themselves. They replace the AI
co-players of the GM agent (`gm-agent/`), which will be retired once bots can do everything co-players do. The staged
plan, and what is done so far, is in [BOTS_PLAN.md](BOTS_PLAN.md).

## What exists now

- **Setting bots up** — Server settings → Features → Bots turns them on (off by default), with the most bots one
  channel may hold (1–8, default 3). Server settings → Bots lists the server's bots: a name, a persona for outside the
  table (who the bot is, up to 8000 bytes; its role cards will follow it), a speaking style, a switch, how many lines an
  hour it may start on its own outside the table (0–60, default 2), a ceiling on its turns an hour (default 60), and
  whether what it saw at one table may come up at another (off by default). Retiring a bot takes it out of every
  channel; its lines and characters stay.
- **Inviting** — any member of a channel invites one of the server's bots from the channel sidebar (Bots → +). It joins
  at once as a player of the Main Chat, and a system line says who brought it. The GM can remove it, and can turn
  invitations off for players in the GM workspace ("Players may invite bots"); the GM can still invite. One member may
  invite at most ten bots an hour.
- **The tag** — a bot's name carries a "bot" tag everywhere: on its lines, its characters, the member lists and the
  sidebar. The mobile apps show the tag too.
- **Characters** — the GM can give a bot a character in the channel (create a PC for it, or hand one over), once the
  bot is there.
- **Speaking** — at the table (a window where it plays its character) a bot plays like a player: after a player's line
  it waits for the GM to answer (or about a minute and a half without one) and a quiet moment, then speaks in character,
  rolls its own dice (`.r .ra .rc .sc`, never `.st`, `.en` or a hidden roll) or passes. The GM naming its character, or
  another bot naming it, also gives it a turn, but a bot takes at most two turns per human line, so neither a GM agent nor
  other bots can keep it talking. Outside the table (no character there) it answers only when someone names it, out of
  character, as itself. If a person speaks while it composes, it drops its draft and answers the newer moment instead.
  With nobody talking, bots stay quiet. The GM can take back any line of a bot. A bot's turns per hour are capped by
  its settings and by the server's AI budget; the channel's AI switch silences it too.

A bot is a user of its own (`users.is_bot`): it never signs in, never appears where people are searched for, and never
joins a player group (it will read only what it witnessed itself). Deleting a server deletes its bots.

## Coming next

1. Bots make their own role cards when asked, in keeping with their persona and memory, or accept one the GM designs.
2. Memory: after each table, a summary of what the bot saw and the most striking moment, so players can keep them as
   regular friends; notes on the people it meets.
3. The GM agent paces the bots at its tables, and its own co-players are retired.
4. Private one-to-one chats with a bot.

The API is in [API.md](API.md) (Bots); the model use is `text_bots` ([AI_PROVIDERS.md](AI_PROVIDERS.md)).
