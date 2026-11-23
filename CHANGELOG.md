# Changelog

## Unreleased

- `discord.member(server, name, { roles })` gives the member roles made with `discord.role(server, name)`, for a bot that checks a member's roles by name.
- The bot hears `guildMemberUpdate` for its own nickname change without the Guild Members intent, as on Discord. Uploading a soundboard sound answers 201, and an emoji upload's answer leaves out `user`, as Discord's do.
- Typing where the bot can't send messages is refused with Missing Access (50001), and an invite lasting over 7 days with Invalid Form Body (50035), as the test guild answered. Both used to fail the test as unsupported.
- New `discord.waitForTextChannel(server, name)`: a handle for a text channel the bot creates, such as a ticket channel, so a test can post in it and read what the bot sends there.
- Polls: the bot can edit a poll message's text and remove its buttons; the poll stays, as on Discord. It used to fail the test as unsupported.
- New `createDiscord({ privilegedIntents })`: the privileged intents your app has turned on in the Developer Portal (all three by default). Without Message Content, messages the bot fetches arrive without their text too, as on Discord; before, only gateway events lost it.
- Bans: `members.ban(user, { deleteMessageSeconds })` works, and removes the member's messages from that window. It used to fail the test as unsupported.
- A bot deleting a member's message in their DMs is refused (50003), as Discord refuses it; it used to succeed.
- The wait before a click or pick, and the other waits for the bot to go quiet, count only time the test process could run. On a loaded machine (a busy CI runner, several suites at once), a pause the OS imposes no longer makes the kit click before the bot listens. Discord's 3-second interaction deadline stays real time.
- Setting a channel overwrite that allows or denies a permission the bot doesn't hold is refused with Missing Permissions (50013), as Discord does. It used to succeed, so a bot that does this passed its tests and failed on Discord.
- Listing who reacted without Read Message History is refused with Missing Access (50001), as Discord does, instead of 50013.
- Listing archived private threads without Manage Threads is refused with Missing Access (50001), as Discord does, instead of Missing Permissions (50013).
- Roles carry `description`, guild previews `home_header`, and scheduled events `sku_ids` and `guild_scheduled_event_exceptions`, as Discord sends them.
- `GUILD_CREATE`'s roles no longer carry `description`, and creating a scheduled event no longer answers with a `creator` object: Discord sends neither.

## 0.5.0

### Changed

- Registering commands for a server the bot isn't in used to succeed. Discord refuses it, so the test now fails and names the request. Running a command afterwards says which registration was refused, instead of saying the bot never registered any.
- `client.user.setAvatar()` with a file or URL works: it used to fail with Invalid Form Body, because discord.js labels such images `image/jpg`.
- A member refused a command is told which permissions it needs by name (`ManageGuild`), not as a number, and an administrators-only command says so.

### Added

- Stickers: `client.fetchSticker(id)` and `sticker.fetch()`.
- Widget: `client.fetchGuildWidget()` and `guild.fetchWidget()`, showing public voice channels and online members.
- Guild preview: `client.fetchGuildPreview()` and `guild.fetchPreview()` for a guild the bot is in.
- Guild templates: `guild.createTemplate()`, `fetchTemplates()`, `client.fetchGuildTemplate()`, and a template's `sync()`, `edit()` and `delete()`.
- Soundboard: `voiceChannel.sendSoundboardSound()` plays one of the guild's sounds in the voice channel the bot is in, heard as `voiceChannelEffectSend`.
- Scheduled events: a cover image on `scheduledEvents.create()` and `event.edit()`.

## 0.4.0

More of Discord's API works when your bot calls it, instead of failing the test as unsupported:

- Members: `guild.members.list()` and `search()` (search used to come back as Unknown Member), `members.bulkBan()`, `members.me.setNickname()`, `roles.fetch(id)`, `roles.fetchMemberCounts()`, and `setPosition()` on roles and channels.
- Scheduled events: the bot can create, edit, start, end and delete events, and read who is interested. New: `member.markInterested(event)` and `member.unmarkInterested(event)`, which the bot hears as `guildScheduledEventUserAdd` and `guildScheduledEventUserRemove`.
- Stages: the bot can open, retitle and end a stage it moderates, bring a member up to speak or move them back to the audience, and raise its own hand. `member.joinVoice()` now takes a stage channel.
- Stickers: the bot can upload, edit and delete guild stickers. Application emojis: the bot can upload, list, rename and delete them.
- Soundboard: the bot can upload, list, edit and delete guild sounds, and hears each change. `client.guilds.fetchSoundboardSounds()` works.
- Threads: `threads.fetchArchived({ type: "private" })`, with or without `fetchAll`. The public list no longer includes private threads.
- Webhooks: moving a webhook to another channel, and fetching, editing or deleting a message it sent.
- Widget: `guild.fetchWidgetSettings()` and `setWidgetSettings()`, with Manage Server.
- The bot's account: `client.user.setUsername()` and `setAvatar()`, heard as `userUpdate`.
- Announcements: new `discord.announcementChannel(server, name)`. The bot can follow it into another channel and crosspost posts to its followers.
- Presence: new `member.setPresence({ status, activity })`. A bot with the GuildPresences intent hears `presenceUpdate`, and sees members who were already online when it connects.

## 0.3.0

- `discord.skipTime(ms)` ends every collector whose `time` or `idle` runs out within `ms`, so a test can let a menu time out. It needs no setup. The bot's own `setTimeout` calls don't fire.
- `createDiscord({ quietTimeMs })` sets how long the bot must be quiet before a click or pick goes through. The default stays 100. Lower it only for a bot that does nothing between sending a message and listening for its buttons; otherwise the click arrives before the bot listens.

## 0.2.0

Breaking: every name now says what the method does, what it returns and whether it waits. Methods that wait for the bot start with `waitFor`. Rename your calls with this table; nothing else in a test changes.

| 0.1                                    | 0.2                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `discord.find(channel, text)`          | `discord.waitForMessage(channel, text)`                                                            |
| `discord.find(member, text)`           | `discord.waitForDM(member, text)`                                                                  |
| `discord.findThread(channel, name)`    | `discord.waitForThread(channel, name)`                                                             |
| `discord.thread(channel, message)`     | `discord.waitForThreadFrom(message)`                                                               |
| `discord.hearBot(channel)`             | `discord.waitForSound(channel)`                                                                    |
| `discord.idle()`                       | `discord.waitForIdle()`                                                                            |
| `member.run(…)`                        | `member.runCommand(…)`                                                                             |
| `member.runApp(channel, target, name)` | `member.runUserCommand(channel, name, member)`, `member.runMessageCommand(channel, name, message)` |
| `member.autocomplete(…)`               | `member.typeInOption(…)`                                                                           |
| `member.edit(…)`, `member.delete(…)`   | `member.editMessage(…)`, `member.deleteMessage(…)`                                                 |
| `member.nickname(…)`                   | `member.setNickname(…)`                                                                            |
| `member.displayName(…)`                | `member.setDisplayName(…)`                                                                         |
| `member.leave()`                       | `member.leaveGuild()`                                                                              |
| `member.invite(…)`                     | `member.createInvite(…)`                                                                           |
| `member.forumPost(…)`                  | `member.postInForum(…)`                                                                            |
| `discord.lock(thread)`                 | `member.lockThread(thread)`, which needs Manage Threads                                            |
| `discord.deny(channel, permission)`    | `discord.deny(channel, "bot", permission)`; the same for `allow`                                   |
| `discord.archive(thread)`              | `discord.autoArchive(thread)`                                                                      |
| `discord.outage(guild)`                | `discord.startOutage(guild)`                                                                       |
| `discord.commandPermissions(…)`        | `discord.setCommandPermissions(…)`                                                                 |
| `discord.fail(…)`                      | `discord.answerWith(…)`                                                                            |
| `discord.channel(…)`                   | `discord.textChannel(…)`                                                                           |
| `discord.close()`                      | Removed: the server closes when the test ends                                                      |

New and fixed:

- Slash command options of type role, mentionable, attachment, and voice or stage channel. A file is a `FileUpload`.
- Forms (modals) with string, user, role, mentionable and channel selects, radio groups, checkbox groups, checkboxes and file uploads.
- The bot can create voice, category, stage and forum channels, with a parent and permission overwrites.
- A deferred reply waits while the bot keeps working, and fails after 2s of silence or 10s in all, naming the bot's latest requests.
- `click` and `select` wait for the bot to go quiet first, so a collector the bot starts after replying hears the click. A deferred update resolves with the message as the bot leaves it.
- Roles made or given after the bot connects reach it, so `member.permissions` is right.
- Ephemeral replies stay out of channel history, so a purge deletes only the members' messages.
- Bots with `zlib-sync` installed can connect (zlib-stream compression); the deprecated pin routes answer for `@discordjs/core` bots; a bot can rewrite its application description.

## 0.1.1

Docs only; the code is unchanged.

- The README opens with a short test of a one-command bot, compares it with hand-rolled fakes, and lists bugs the fakes miss. The full action and rules tables moved to the docs site.
- The skill's example is written as arrange-act-assert, one action per test, and tells agents to write theirs that way.
- The README, the skill and the API docs say "server" and "unmodelled request" instead of internal terms.

## 0.1.0

First release. A stock discord.js 14 `Client` logs in to a fake Discord (REST and Gateway on `127.0.0.1`), and a test drives it through `createDiscord`.

- Servers, channels (text, voice, stage, forum, threads), roles, permission overwrites and members, with Discord's permission checks.
- Messages, edits, reactions, attachments, polls, typing, pins and history.
- Slash commands, autocomplete, buttons, selects (string and entity), modals, and the 3-second deadline.
- Moderation: kicks, bans, timeouts, prune, AutoMod rules, audit log entries.
- Scheduled events, emojis, stickers, stage instances and bot voice connections.
- Failures: `fail()` for 5xx and 429, `deny()` for a missing permission, `disconnect()` and `reconnect()` for the Gateway, server outages.
- Anything the kit doesn't model is a Gap, and a Gap fails the test.

Behaviour checked against a real test server is listed in `contract/`; everything else is modelled from Discord's docs.
