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
- **Characters** — ask a bot at the table to make its character ("Sable, make your character!") and, if it has none
  in the channel yet, it makes one in keeping with its persona, the campaign, the era and the notes for bots, through
  the same card routes a player uses, so the channel's rules hold: Call of Cthulhu within the point buy when it is on
  (the custom career), D&D 2024 as a level 1 standard-array build (the background's increases, the class's saves and
  skills), PbtA with a playbook of the channel's pack that nobody at the table holds yet. It says so out of character;
  if the card cannot be made it asks the GM to make one. One character per bot and channel. The GM can also give a
  bot a character (create a PC for it, or hand one over) once the bot is there; the bot takes up the part with one
  line in character.
- **Speaking** — at the table (a window where it plays its character) a bot plays like a player: after a player's line
  it waits for the GM to answer (or about a minute and a half without one) and a quiet moment, then speaks in character,
  rolls its own dice (`.r .ra .rc .sc`, never `.st`, `.en` or a hidden roll) or passes. The GM naming its character, or
  another bot naming it, also gives it a turn, but a bot takes at most two turns per human line, so neither a GM agent nor
  other bots can keep it talking. Outside the table (no character there) it answers when someone names it, out of
  character, as itself. If a person speaks while it composes, it drops its draft and answers the newer moment instead.
  With nobody talking, bots stay quiet. The GM can take back any line of a bot. A bot's turns per hour are capped by
  its settings and by the server's AI budget; the channel's AI switch silences it too. While it composes at the table,
  its character shows as writing; it waits for anyone already writing (up to 45 seconds).
- **Joining in on its own** — outside the table, once people have talked a while without naming it (two lines) and
  the window has been quiet for 20 seconds, a bot asks itself whether it has something to add, at most every five
  minutes; it speaks no more often than its "lines on its own per hour" (it may also pass). The GM turns this off for
  a channel in the GM workspace ("Bots may join in on their own outside the table").
- **Memory** — a bot writes down what it saw at each table: when a scenario closes or the story ends, when it leaves
  the channel, and after a long stretch of play (60 lines, then ten quiet minutes). Its account of a table is in the
  first person, with the moment that struck it most, and is written from the window's lines only; what was whispered
  to its characters goes into a private part that it reads at that table alone. It also keeps notes on the people it
  played with (what they are like as players, not the story's secrets). At a table it reads that table's account, the
  whispers and the GM's private briefing for it, and its notes on the people in the window; never another table's
  story. As itself it brings up the tables that everyone in the window played at too, or every table when its
  maintainers switch on "Share memories between tables" (the private parts and briefings never). The characters it
  makes are in keeping with its memory too.
- **Reading and correcting memory** — Server settings → Bots → Memory lists what a bot remembers: maintainers add
  notes for it to keep in mind everywhere, and correct or delete what it wrote. A table's account shows to the
  maintainers who are in that channel (to all of them while the bot shares between tables); the whispers and briefings
  only to that channel's GMs. In the channel sidebar (Bots → +), the GM opens a bot's Memory: its account of this
  table, what was whispered to it, a private briefing only this bot reads here, and "Forget this table".
- **The GM's tools** — "Bots' turn" above a chat window asks every bot there to take a turn now. "Notes for bots" in
  the GM workspace is what every bot at the table is told each turn (the situation, what the characters know of the
  world, how to play here); players never see it. Server settings → Bots → Activity lists each bot's latest turns:
  where, why, and what came of them.

A bot is a user of its own (`users.is_bot`): it never signs in, never appears where people are searched for, and never
joins a player group (it will read only what it witnessed itself). Deleting a server deletes its bots.

## Coming next

1. The GM agent paces the bots at its tables, and its own co-players are retired.
2. Private one-to-one chats with a bot.

The API is in [API.md](API.md) (Bots); the model use is `text_bots` ([AI_PROVIDERS.md](AI_PROVIDERS.md)).
