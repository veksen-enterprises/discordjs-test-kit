import { once } from "node:events";
import {
  ApplicationCommandPermissionType,
  ChannelType,
  GatewayIntentBits,
  type APIMessage,
  type APIUser,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Client } from "discord.js";
import { onTestFinished } from "vitest";
import { hookCollectors, skip } from "./internal/clock.js";
import { setCommandPermissions } from "./internal/command-permissions.js";
import {
  deleteExpression,
  renameExpression,
  uploadExpression,
} from "./internal/expressions.js";
import { createInvite } from "./internal/invites.js";
import {
  createDiscordMock,
  matches,
  quote,
  readable,
  shown,
  type DiscordMock,
  type FileUpload,
  type InteractionRun,
  type UserMessage,
} from "./internal/mock.js";
import { computePermissions, Permission } from "./internal/payloads.js";
import { setPresence, type PresenceInput } from "./internal/presence.js";
import type { RestResponse } from "./internal/rest.js";
import {
  createScheduledEvent,
  deleteScheduledEvent,
  editScheduledEvent,
  setInterest,
} from "./internal/scheduled-events.js";

export { respond } from "./internal/rest.js";
export type { RestResponse } from "./internal/rest.js";
export { Permission };
export type { FileUpload, UserMessage } from "./internal/mock.js";

declare const kind: unique symbol;
declare const inGuild: unique symbol;

/**
 * What every handle carries in its type: what it is, and which guild it belongs to, so a test
 * can't pass one guild's channel to another guild's member.
 */
interface Handle<Kind extends string, G extends string> {
  readonly id: string;
  readonly name: string;
  readonly [kind]: Kind;
  readonly [inGuild]: G;
}

/** A guild (a server). `G` is its name, so handles made in it can't be used in another. */
export type Guild<G extends string = string> = Handle<"guild", G>;
/** A channel category. Pass it as a text channel's category. */
export type Category<G extends string = string> = Handle<"category", G>;
/** A text channel. */
export type TextChannel<G extends string = string> = Handle<"text", G>;
/** A voice channel: members join it with `member.joinVoice`. */
export type VoiceChannel<G extends string = string> = Handle<"voice", G>;
/** A stage channel, made with `discord.stageChannel`. */
export type StageChannel<G extends string = string> = Handle<"stage", G>;
/** A forum: members open posts in it with `member.postInForum`. */
export type Forum<G extends string = string> = Handle<"forum", G>;
/** A thread, such as a forum post. */
export type Thread<G extends string = string> = Handle<"thread", G>;
/** A role. Members pick it in a role select. */
export type Role<G extends string = string> = Handle<"role", G>;
/** A custom emoji, which members upload with `member.addEmoji`. */
export type Emoji<G extends string = string> = Handle<"emoji", G>;
/** A guild sticker, which members upload with `member.addSticker`. */
export type Sticker<G extends string = string> = Handle<"sticker", G>;
/** A scheduled event, which members create with `member.createEvent`. */
export type ScheduledEvent<G extends string = string> = Handle<"event", G>;
/** What a member can pick in a user, role, mentionable or channel select. */
export type Pickable<G extends string = string> =
  | Member<G>
  | Role<G>
  | Category<G>
  | TextChannel<G>
  | VoiceChannel<G>
  | Forum<G>
  | Thread<G>;
/** A message as Discord stores it. The object is live: edits, reactions and updates show up on it. */
export type Message = APIMessage;

/**
 * What the member enters in the form (modal) the bot opens, by each field's label: text for a text
 * input; an option's label (or several) for a select, radio group or checkbox group; true or
 * false for a checkbox; members, roles or channels for those selects; a file (or several) for a
 * file upload. Pass it as the last argument of the action that opens the form; the action then
 * resolves with the bot's answer to the submitted form.
 * @example await alice.click(panel, "Report", { Reason: "spam", Who: bob, Severity: "High" });
 */
export type Form<G extends string = string> = Record<
  string,
  | string
  | string[]
  | boolean
  | Pickable<G>
  | Pickable<G>[]
  | FileUpload
  | FileUpload[]
>;

/** One autocomplete suggestion: `name` is what the member sees, `value` what the command receives. */
export interface Choice {
  name: string;
  value: string | number;
}

/**
 * What a slash command option can be given: a value; a handle where the option is a user, role or
 * channel (a member or a role for a mentionable); or a file where it's an attachment.
 * @example await alice.runCommand(general, "upload", { file: { name: "a.txt", data: new TextEncoder().encode("hi"), contentType: "text/plain" } });
 */
export type OptionValue<G extends string = string> =
  | string
  | number
  | boolean
  | Member<G>
  | Role<G>
  | Category<G>
  | TextChannel<G>
  | VoiceChannel<G>
  | StageChannel<G>
  | Forum<G>
  | Thread<G>
  | FileUpload;

/** A user who has joined a guild. The test acts as them. */
export interface Member<G extends string = string> extends Handle<"member", G> {
  /**
   * Runs `/command` in `channel`, typed as a user would: `"report"`, or `"admin-config set"` for a
   * subcommand. Resolves with the reply once it's visible, after any defer.
   * @example const reportMenu = await bob.runCommand(challengesChannel, "report");
   */
  runCommand(
    channel: TextChannel<G> | Thread<G>,
    command: string,
    options?: Record<string, OptionValue<G>>,
    form?: Form<G>,
  ): Promise<Message>;
  /**
   * Types `typed` into `option` of `/command`, with `filled` already entered, and resolves with the
   * choices the bot suggests (its autocomplete answer). Run the command with a choice's value after.
   * @example const choices = await alice.typeInOption(general, "docs", "query", "Promise.al");
   */
  typeInOption(
    channel: TextChannel<G> | Thread<G>,
    command: string,
    option: string,
    typed: string | number,
    filled?: Record<string, OptionValue<G>>,
  ): Promise<Choice[]>;
  /**
   * Right-clicks `member` while in `channel` and picks `command` from the Apps menu: a user
   * command (registered with type User). Resolves with the reply once it's visible.
   * @example const card = await alice.runUserCommand(general, "View Profile", bob);
   */
  runUserCommand(
    channel: TextChannel<G> | Thread<G>,
    command: string,
    member: Member<G>,
    form?: Form<G>,
  ): Promise<Message>;
  /**
   * Right-clicks `message` while in `channel` and picks `command` from the Apps menu: a message
   * command (registered with type Message). Resolves with the reply once it's visible.
   * @example const saved = await alice.runMessageCommand(general, "Bookmark", announcement);
   */
  runMessageCommand(
    channel: TextChannel<G> | Thread<G>,
    command: string,
    message: Message,
    form?: Form<G>,
  ): Promise<Message>;
  /**
   * Presses the button labelled `label` on `message` (or showing that emoji, when it has no label).
   * Resolves with the message visible afterwards: the same one when the bot updates it in place.
   * @example await alice.click(panel, "Join Ladder");
   */
  click(
    message: Message,
    label: string | RegExp,
    form?: Form<G>,
  ): Promise<Message>;
  /**
   * Picks the option labelled `label` from the select menu on `message`, or several labels for a
   * multi-select (between its min_values and max_values). Resolves with the message
   * visible afterwards: the same one when the bot updates it in place.
   * @example await bob.select(reportMenu, "5-2");
   */
  select(
    message: Message,
    label: string | RegExp | (string | RegExp)[],
    form?: Form<G>,
  ): Promise<Message>;
  /**
   * Picks members, roles or channels in the user, role, mentionable or channel select on `message`
   * that offers them, one or several (between its min_values and max_values). Resolves like the
   * label form.
   * @example await alice.select(setupPanel, [modRole, adminRole]);
   */
  select(
    message: Message,
    picks: Pickable<G> | Pickable<G>[],
    form?: Form<G>,
  ): Promise<Message>;
  /**
   * Posts in `channel`. Files are served by the mock, so the bot can download them.
   * @example alice.post(isoChannel, { content: "ISO Shako" });
   */
  post(channel: TextChannel<G> | Thread<G>, message: UserMessage): Message;
  /**
   * Sends the bot a direct message. The bot needs the DirectMessages intent (and Partials.Channel)
   * to hear it, as on Discord. Read its answer with `discord.waitForDM(member, …)`.
   * @example alice.dm({ content: "!help" }); await discord.waitForDM(alice, /commands/);
   */
  dm(message: UserMessage): Message;
  /** Opens a post in `forum`: a thread whose first message is `post`, with the forum's tags named in `tags`. */
  postInForum(
    forum: Forum<G>,
    post: UserMessage & { title: string; tags?: string[] },
  ): { thread: Thread<G>; message: Message };
  /** Reacts to `message` with a unicode emoji. */
  react(message: Message, emoji: string): void;
  /**
   * Votes in the poll on `message` for the answer labelled `answer`, or several where the poll
   * allows it. The bot hears `messagePollVoteAdd` with GuildMessagePolls. Voting again needs `unvote`
   * first, as in the Discord app.
   * @example alice.vote(poll, "Pizza");
   */
  vote(message: Message, answer: string | string[]): void;
  /** Takes back their vote; the bot hears `messagePollVoteRemove`. */
  unvote(message: Message): void;
  /**
   * Makes `stage` live with `topic`. They need Manage Channels, Mute Members and Move Members there;
   * the bot hears `stageInstanceCreate`.
   * @example mod.startStage(townHall, "Q&A");
   */
  startStage(stage: StageChannel<G>, topic: string): void;
  /** Ends the live stage; the bot hears `stageInstanceDelete`. */
  endStage(stage: StageChannel<G>): void;
  /**
   * Starts typing in `channel`. The bot hears `typingStart` with GuildMessageTyping.
   * @example alice.startTyping(general);
   */
  startTyping(channel: TextChannel<G> | Thread<G>): void;
  /**
   * Turns off DMs from server members, as a privacy setting: the bot's DMs to them fail with 50007.
   * @example alice.closeDMs(); await alice.runCommand(general, "remind-me"); // the bot should say it can't DM
   */
  closeDMs(): void;
  /**
   * Sets their status, and what they're doing if `activity` is given. The bot hears
   * `presenceUpdate` in each server they share, with the GuildPresences intent. Everyone starts
   * offline.
   * @example alice.setPresence({ status: "online", activity: { name: "Diablo II", type: ActivityType.Playing } });
   */
  setPresence(presence: PresenceInput): void;
  /** Sets their server nickname; null goes back to their name. */
  setNickname(nick: string | null): void;
  /**
   * Changes their display name, shown in every server where they have no nickname; null goes back
   * to their username. The bot hears it as a member update in each server they share, which
   * discord.js also emits as `userUpdate`.
   * @example alice.setDisplayName("Alicia"); // a bot that stores display names should update
   */
  setDisplayName(name: string | null): void;
  /** Leaves the guild. */
  leaveGuild(): void;
  /** Edits their own `message`'s text, announced to the bot as MESSAGE_UPDATE. */
  editMessage(message: Message, content: string): void;
  /** Deletes their own `message`, announced to the bot as MESSAGE_DELETE. */
  deleteMessage(message: Message): void;
  /**
   * Kicks `member` from the Discord app: needs Kick Members and a higher role. The bot sees them
   * leave and, with View Audit Log, the audit log entry naming who did it.
   * @example mod.kick(alice, "spam"); // a bot that logs kicks should name mod
   */
  kick(member: Member<G>, reason?: string): void;
  /** Bans `member` from the Discord app: needs Ban Members and a higher role. Like `kick`. */
  ban(member: Member<G>, reason?: string): void;
  /**
   * Renames the guild, which needs Manage Server (the owner has it). The bot hears `guildUpdate`.
   * @example discord.owner(server).renameGuild("SIN 2"); // a bot that shows the guild name should follow
   */
  renameGuild(name: string): void;
  /**
   * Locks `thread` without archiving it, which needs Manage Threads in its channel. Once it's
   * archived, only members with Manage Threads can reopen it. The bot hears `threadUpdate`.
   * @example mod.lockThread(post.thread); // a bot that tracks locked threads should follow
   */
  lockThread(thread: Thread<G>): void;
  /**
   * Joins a voice or stage channel, or moves there from another one. The bot hears `voiceStateUpdate`
   * with GUILD_VOICE_STATES. Needs Connect there, which `@everyone` has unless an overwrite denies it.
   * @example alice.joinVoice(lobby); // a bot that logs voice activity should post
   */
  joinVoice(channel: VoiceChannel<G> | StageChannel<G>): void;
  /** Leaves voice. */
  leaveVoice(): void;
  /**
   * Creates an invite to `channel` and returns its code; the bot hears `inviteCreate` when it has
   * Manage Channels there. Pass the code to `discord.member(…, { invite })` for someone to join.
   * @example const code = alice.createInvite(general, { maxUses: 1 });
   */
  createInvite(channel: TextChannel<G>, options?: { maxUses?: number }): string;
  /**
   * Creates a scheduled event starting at `start`, in voice channel `where` or at a place outside
   * Discord named by the string. Needs Create Events (and View Channel and Connect in the channel).
   * The bot hears `guildScheduledEventCreate` with GUILD_SCHEDULED_EVENTS. A place event ends an
   * hour after it starts.
   * @example const raid = alice.createEvent("Raid night", lobby, new Date("2026-12-01T20:00Z"));
   */
  createEvent(
    name: string,
    where: VoiceChannel<G> | string,
    start: Date,
  ): ScheduledEvent<G>;
  /**
   * Changes an event's name, description or start; the bot hears `guildScheduledEventUpdate`.
   * Someone else's event needs Manage Events.
   */
  editEvent(
    event: ScheduledEvent<G>,
    changes: { name?: string; description?: string; start?: Date },
  ): void;
  /** Deletes an event; the bot hears `guildScheduledEventDelete`. Like `editEvent`. */
  deleteEvent(event: ScheduledEvent<G>): void;
  /**
   * Marks an event Interested; the bot hears `guildScheduledEventUserAdd` with
   * GUILD_SCHEDULED_EVENTS. Marking it twice does nothing.
   */
  markInterested(event: ScheduledEvent<G>): void;
  /** Takes back Interested; the bot hears `guildScheduledEventUserRemove`. */
  unmarkInterested(event: ScheduledEvent<G>): void;
  /**
   * Uploads a custom emoji named `name` (2-32 characters), which needs Create Expressions. The bot
   * hears `emojiCreate` with GUILD_EXPRESSIONS (GuildExpressions).
   * @example const pog = mod.addEmoji("pog"); // a bot that logs emoji changes should post
   */
  addEmoji(name: string): Emoji<G>;
  /** Uploads a sticker named `name` (2-30 characters), like `addEmoji`; the bot hears `stickerCreate`. */
  addSticker(name: string): Sticker<G>;
  /**
   * Renames an emoji or sticker; the bot hears `emojiUpdate` or `stickerUpdate`. Someone else's needs
   * Manage Expressions.
   */
  renameExpression(expression: Emoji<G> | Sticker<G>, name: string): void;
  /** Deletes an emoji or sticker; the bot hears `emojiDelete` or `stickerDelete`. Like `renameExpression`. */
  deleteExpression(expression: Emoji<G> | Sticker<G>): void;
}

const FIND_TIMEOUT_MS = 2000;

/**
 * A fake Discord for one test. Build the server, `start` your bot, act as members, then read what
 * the bot did. It shuts down when the test ends, and fails the test if the bot sent a request the kit doesn't model.
 */
class Discord {
  private client?: Client;
  /** Messages the bot created or edited since the latest action: the ones `waitForMessage` and `waitForDM` look at. */
  private readonly written = new Set<Message>();
  private readonly markAction = () => this.written.clear();

  constructor(
    private readonly mock: DiscordMock,
    private readonly quietTimeMs: number,
  ) {
    onTestFinished(() => this.close());
    const record = (message: Message) => {
      if (message.author.id === mock.state.bot.id) this.written.add(message);
    };
    mock.state.on("messageCreate", record);
    mock.state.on("messageUpdate", record);
  }

  /**
   * The bot token this Discord accepts: give it to a bot that reads its token itself, or to a
   * deploy script that registers commands before the bot starts. Its first part is the application
   * id in base64, as a real token's is.
   */
  get token(): string {
    return this.mock.token;
  }

  /** Spread into your bot's `new Client()` options so it connects to this mock. */
  get clientOptions(): { rest: { api: string } } {
    return this.mock.clientOptions;
  }

  /** @example const server = discord.guild("SIN"); */
  guild<const G extends string>(name: G): Guild<G> {
    return handle(this.mock.createGuild(name).id, name);
  }

  category<G extends string>(guild: Guild<G>, name: string): Category<G> {
    return handle(this.mock.createCategory(this.g(guild), name).id, name);
  }

  /** A text channel. @example const challengesChannel = discord.textChannel(server, "challenges", ladderCategory); */
  textChannel<G extends string>(
    guild: Guild<G>,
    name: string,
    category?: Category<NoInfer<G>>,
  ): TextChannel<G> {
    const parent = category
      ? this.mock.state.requireChannel(category.id)
      : undefined;
    return handle(
      this.mock.createTextChannel(this.g(guild), name, { parent }).id,
      name,
    );
  }

  /**
   * An announcement channel: the bot can crosspost its posts to the channels that follow it.
   * @example const news = discord.announcementChannel(server, "patch-notes");
   */
  announcementChannel<G extends string>(
    guild: Guild<G>,
    name: string,
  ): TextChannel<G> {
    return handle(
      this.mock.createAnnouncementChannel(this.g(guild), name).id,
      name,
    );
  }

  voiceChannel<G extends string>(
    guild: Guild<G>,
    name: string,
  ): VoiceChannel<G> {
    return handle(this.mock.createVoiceChannel(this.g(guild), name).id, name);
  }

  /** A stage channel in `guild`, which a moderator makes live with `startStage`. */
  stageChannel<G extends string>(
    guild: Guild<G>,
    name: string,
  ): StageChannel<G> {
    return handle(this.mock.createStageChannel(this.g(guild), name).id, name);
  }

  /** A role in `guild` with no permissions, for members to pick in a role select. */
  role<G extends string>(guild: Guild<G>, name: string): Role<G> {
    return handle(this.mock.createRole(this.g(guild), name, 0n).id, name);
  }

  /** A forum offering these tags to its posts. @example discord.forum(server, "help", ["Solved"]) */
  forum<G extends string>(
    guild: Guild<G>,
    name: string,
    tags: string[] = [],
  ): Forum<G> {
    return handle(this.mock.createForum(this.g(guild), name, tags).id, name);
  }

  /**
   * A new user who has joined `guild`. `nickname` is their server nickname. `permissions` gives them
   * a role holding those permissions, for a moderator or admin who isn't the owner. `invite` is the
   * code they join through, from `member.createInvite`: its uses go up, as invite trackers expect.
   * `inactiveDays` is how long since Discord last saw them, for prune; everyone else was seen now.
   * `bot: true` makes another bot, whose posts carry `author.bot`.
   * @example const alice = discord.member(server, "Alice");
   * @example const mod = discord.member(server, "Mod", { permissions: Permission.ModerateMembers });
   * @example const carol = discord.member(server, "Carol", { invite: alice.createInvite(general) });
   */
  member<G extends string>(
    guild: Guild<G>,
    name: string,
    options: {
      nickname?: string;
      permissions?: bigint;
      invite?: string;
      inactiveDays?: number;
      bot?: boolean;
    } = {},
  ): Member<G> {
    const user = this.mock.createUser(name, { bot: options.bot });
    const record = this.g(guild);
    if (options.invite === undefined)
      this.mock.addMember(record, user, { nick: options.nickname });
    else
      this.mock.joinWithInvite(record, options.invite, user, {
        nick: options.nickname,
      });
    if (options.permissions !== undefined)
      this.mock.createRole(record, `${name}'s role`, options.permissions, [
        user,
      ]);
    if (options.inactiveDays !== undefined)
      record.lastSeen.set(
        user.id,
        Date.now() - options.inactiveDays * 86_400_000,
      );
    return this.actorFor(guild, user);
  }

  /** The member who owns `guild`. They have every permission, so they can run admin commands. */
  owner<G extends string>(guild: Guild<G>): Member<G> {
    return this.actorFor(
      guild,
      this.mock.state.requireUser(this.g(guild).ownerId),
    );
  }

  /**
   * Logs `client` in (it must have been built with `clientOptions`), waits for ready, and registers
   * `commands` the way a deploy script would. The client is destroyed when the test ends.
   *
   * `permissions` are what the bot's invite link grants: the bot gets a role with them in every
   * guild, including one built after `start`. Without it, it has only @everyone's. `appOwner`
   * makes a member the application's owner, `client.application.owner`.
   * @example await discord.start(bot.client, { commands, permissions: Permission.SendMessages });
   */
  async start(
    client: Client,
    options: {
      commands?: RESTPostAPIApplicationCommandsJSONBody[];
      permissions?: bigint;
      appOwner?: Member;
    } = {},
  ): Promise<void> {
    this.client = client;
    this.markAction();
    hookCollectors(client);
    if (options.appOwner) this.mock.developerId = options.appOwner.id;
    if (options.permissions !== undefined)
      this.mock.grantBot(options.permissions);
    const ready = once(client, "clientReady");
    await client.login(this.mock.token);
    await ready;
    if (options.commands)
      await client.application!.commands.set(options.commands);
  }

  /**
   * Answers every `method path` request with `response` instead of the kit's own answer, until you call the
   * function it returns. `:name` segments match anything; a literal id fails only that channel, message
   * or member.
   * @example const recover = discord.answerWith("GET", "/attachments/:channel/:id/:name", respond.serverError(503));
   */
  answerWith(method: string, path: string, response: RestResponse): () => void {
    return this.mock.use(method, path, () => response);
  }

  /**
   * Discord drops the bot's connection for long enough that its session expires. Nothing that
   * happens until `reconnect` reaches the bot as an event: Discord doesn't replay a lost session.
   * REST keeps working. A short drop that resumes is invisible to a bot, so it has no method.
   */
  disconnect(): void {
    if (!this.client)
      throw new Error("discordjs-test-kit: disconnect needs a started bot");
    this.mock.gateway.goDown();
  }

  /**
   * Discord is back after `disconnect`: the bot identifies again and receives every guild anew.
   * Resolves once discord.js reports the shard ready. That takes up to 6.5s after the bot's last
   * identify: @discordjs/ws waits 5s between identifies, plus up to 1.5s (SimpleIdentifyThrottler),
   * so a test that reconnects needs a longer timeout.
   */
  async reconnect(): Promise<void> {
    if (!this.client)
      throw new Error("discordjs-test-kit: reconnect needs a started bot");
    const ready = once(this.client, "shardReady");
    this.mock.gateway.comeBack();
    await ready;
  }

  /**
   * An admin overrides who can use `command` in `guild` (Server Settings > Integrations): each
   * `target` is a member, a channel, or the guild itself for @everyone. The bot hears
   * `applicationCommandPermissionsUpdate` and can fetch them. Call it after `start`, once the
   * command is registered. Only an override naming a member changes whether they can run it here.
   * @example discord.setCommandPermissions(server, "ban", [{ target: mod, allow: true }]);
   */
  setCommandPermissions<G extends string>(
    guild: Guild<G>,
    command: string,
    overrides: {
      target: Member<NoInfer<G>> | TextChannel<NoInfer<G>> | Guild<NoInfer<G>>;
      allow: boolean;
    }[],
  ): void {
    const record = this.g(guild);
    const found = this.mock.state.findCommand(record.id, command);
    if (!found)
      throw new Error(
        `discordjs-test-kit: no command "${command}" in ${record.name}; call this after start`,
      );
    const { users, channels } = this.mock.state;
    this.markAction();
    setCommandPermissions(
      this.mock,
      record,
      found.id,
      overrides.map(({ target, allow }) => ({
        id: target.id,
        type: users.has(target.id)
          ? ApplicationCommandPermissionType.User
          : channels.has(target.id)
            ? ApplicationCommandPermissionType.Channel
            : ApplicationCommandPermissionType.Role,
        permission: allow,
      })),
    );
  }

  /**
   * The admins of `guild` kick the bot. It gets `guildDelete` and hears nothing from the guild
   * after, as on Discord; its members can no longer use its commands there.
   * @example discord.kickBot(server); // a bot that cleans up its settings on guildDelete should
   */
  kickBot(guild: Guild): void {
    this.markAction();
    this.mock.removeBot(this.g(guild));
  }

  /**
   * A Discord outage takes `guild` away: the bot gets `guildUnavailable` and hears nothing from it
   * until `endOutage`, which brings `guildAvailable`. REST still answers during the outage.
   * @example discord.startOutage(server); discord.endOutage(server);
   */
  startOutage(guild: Guild): void {
    this.markAction();
    this.mock.gateway.startOutage(this.g(guild));
  }

  /** Ends `startOutage`: the bot gets the guild again, with `guildAvailable`. */
  endOutage(guild: Guild): void {
    this.markAction();
    this.mock.gateway.endOutage(this.g(guild));
  }

  /**
   * Takes `permission` from `who` (a member, a role, `"bot"` or `"everyone"`) in `channel`: a channel
   * overwrite denying it, announced as CHANNEL_UPDATE, which keeps what the target's overwrite
   * already allowed or denied. Discord then answers the bot there as it would: 50001 Missing Access
   * without View Channel, else 50013.
   * @example discord.deny(isoChannel, "bot", Permission.SendMessages);
   * @example discord.deny(staffChannel, "everyone", Permission.ViewChannel);
   */
  deny<G extends string>(
    channel: TextChannel<G> | Forum<G> | Category<G>,
    who: Member<NoInfer<G>> | Role<NoInfer<G>> | "bot" | "everyone",
    permission: bigint,
  ): void {
    this.overwrite(channel, who, { deny: permission });
  }

  /**
   * The opposite of `deny`: allows `permission` in `channel` for `who`, despite roles that don't
   * grant it.
   * @example discord.allow(staffChannel, mods, Permission.ViewChannel);
   */
  allow<G extends string>(
    channel: TextChannel<G> | Forum<G> | Category<G>,
    who: Member<NoInfer<G>> | Role<NoInfer<G>> | "bot" | "everyone",
    permission: bigint,
  ): void {
    this.overwrite(channel, who, { allow: permission });
  }

  private overwrite(
    channel: { id: string },
    who: Member | Role | "bot" | "everyone",
    perms: { allow?: bigint; deny?: bigint },
  ) {
    this.markAction();
    const record = this.mock.state.requireChannel(channel.id);
    const guildId = "guild_id" in record ? record.guild_id! : "";
    const target =
      who === "everyone"
        ? { id: guildId, type: 0 as const }
        : who === "bot"
          ? { id: this.mock.state.bot.id, type: 1 as const }
          : who instanceof MemberActor
            ? { id: who.id, type: 1 as const }
            : { id: who.id, type: 0 as const };
    // An overwrite replaces the target's earlier one: keep what it allowed or denied before.
    const existing = (
      "permission_overwrites" in record ? record.permission_overwrites : []
    )?.find((o) => o.id === target.id);
    const allow = BigInt(existing?.allow ?? 0) & ~(perms.deny ?? 0n);
    const deny = BigInt(existing?.deny ?? 0) & ~(perms.allow ?? 0n);
    this.mock.setOverwrite(record, target, {
      allow: allow | (perms.allow ?? 0n),
      deny: deny | (perms.deny ?? 0n),
    });
  }

  /**
   * Time passes for the bot's collectors: every collector whose `time` or `idle` runs out within
   * `ms` ends now, as it would then. Waits for the bot to go quiet before and after, like a click
   * does. The bot's own `setTimeout` calls don't fire.
   * @example await discord.skipTime(60_000); expect(menu.content).toBe("Timed out.");
   */
  async skipTime(ms: number): Promise<void> {
    // The bot may still be setting its timers after its reply, as a collector starts after it.
    await this.mock.waitForIdle({ quietMs: this.quietTimeMs });
    this.markAction();
    skip(ms);
    await this.mock.waitForIdle({ quietMs: this.quietTimeMs });
  }

  /** Discord archives `thread` for inactivity: it moves from the active list to the archived one. */
  autoArchive(thread: Thread): void {
    this.markAction();
    this.mock.archiveThread(this.mock.state.requireChannel(thread.id));
  }

  /**
   * Waits up to 2 seconds for the bot to start a thread from `message`, and resolves with it. A
   * thread started from a message shares its id, so this finds it whatever its name.
   * @example const thread = await discord.waitForThreadFrom(alice.post(helpChannel, { content: "help?" }));
   */
  async waitForThreadFrom(message: Message): Promise<Thread> {
    const channel = this.mock.state.requireChannel(message.channel_id);
    const started = () => {
      const thread = this.mock.state.channels.get(message.id);
      return thread && "thread_metadata" in thread
        ? handle<Thread>(thread.id, thread.name ?? "")
        : undefined;
    };
    const now = started();
    if (now) return now;
    try {
      await this.mock.waitForMessage(
        (m) => m.id === message.id && !!started(),
        { timeoutMs: FIND_TIMEOUT_MS },
      );
    } catch {
      throw new Error(
        `discordjs-test-kit: the bot started no thread from ${shown(message)} in #${channel.name} within ${FIND_TIMEOUT_MS / 1000}s`,
      );
    }
    return started()!;
  }

  /**
   * Waits for a thread in `channel` whose name contains `name` (or matches it when it's a RegExp):
   * one the bot started, from a message or not. Resolves with the newest match; rejects after 2
   * seconds, naming the threads there.
   * @example const ticket = await discord.waitForThread(supportChannel, "ticket-alice");
   */
  async waitForThread(
    channel: TextChannel,
    name: string | RegExp,
  ): Promise<Thread> {
    const state = this.mock.state;
    const threads = () =>
      [...state.channels.values()].filter(
        (c) =>
          "parent_id" in c &&
          c.parent_id === channel.id &&
          "thread_metadata" in c,
      );
    const wanted = (c: { name?: string | null }) =>
      matches(c.name ?? "", name, { partial: true });
    const found =
      threads().findLast(wanted) ??
      (await this.mock
        .waitForThread((t) => threads().includes(t) && wanted(t), {
          timeoutMs: FIND_TIMEOUT_MS,
        })
        .catch(() => undefined));
    if (!found) {
      const names = threads().map((t) => `"${t.name}"`);
      throw new Error(
        `discordjs-test-kit: no thread in #${channel.name} matched ${quote(name)} within ${FIND_TIMEOUT_MS / 1000}s. ${names.length ? `Threads there: ${names.join(", ")}` : "It has no threads"}`,
      );
    }
    return handle(found.id, found.name ?? "");
  }

  /**
   * Waits for a text channel in `guild` whose name contains `name` (or matches it when it's a
   * RegExp), such as one the bot creates for a ticket. Resolves with the newest match; rejects after
   * 2 seconds, naming the server's text channels.
   * @example await alice.click(panel, "Open ticket"); const ticket = await discord.waitForTextChannel(server, "ticket-alice");
   */
  async waitForTextChannel<G extends string>(
    guild: Guild<G>,
    name: string | RegExp,
  ): Promise<TextChannel<G>> {
    const record = this.g(guild);
    const textChannels = () =>
      record.channelIds
        .map((id) => this.mock.state.requireChannel(id))
        .filter((c) => c.type === ChannelType.GuildText);
    const find = () =>
      textChannels().findLast((c) =>
        matches(c.name ?? "", name, { partial: true }),
      );
    const found = await this.mock
      .waitForChannel(find, { timeoutMs: FIND_TIMEOUT_MS })
      .catch(() => undefined);
    if (!found) {
      const names = textChannels().map((c) => `#${c.name}`);
      throw new Error(
        `discordjs-test-kit: no text channel in ${record.name} matched ${quote(name)} within ${FIND_TIMEOUT_MS / 1000}s. ${names.length ? `Text channels there: ${names.join(", ")}` : "It has no text channels"}`,
      );
    }
    return handle(found.id, found.name ?? "");
  }

  /**
   * Waits for the bot to play sound in `channel` over a voice connection (@discordjs/voice, or
   * anything that speaks Discord's voice protocol): silence frames don't count. Rejects after 2
   * seconds, saying where the bot's voice connection is. Its client needs the GuildVoiceStates
   * intent, as on Discord.
   * @example await alice.runCommand(general, "play", { song: "intro" }); await discord.waitForSound(lobby);
   */
  async waitForSound(channel: VoiceChannel | StageChannel): Promise<void> {
    const server = this.mock.voiceServer;
    const playing = () =>
      [...server.sessions.values()].some(
        (s) => s.channelId === channel.id && s.soundPackets > 0,
      );
    if (playing()) return;
    const heard = await new Promise<boolean>((resolve) => {
      const listen = () => {
        if (!playing()) return;
        clearTimeout(timer);
        server.off("sound", listen);
        resolve(true);
      };
      const timer = setTimeout(() => {
        server.off("sound", listen);
        resolve(false);
      }, FIND_TIMEOUT_MS);
      server.on("sound", listen);
    });
    if (heard) return;
    const record = this.mock.state.requireChannel(channel.id);
    const session = server.sessions.get(
      "guild_id" in record ? (record.guild_id ?? "") : "",
    );
    const refused = server.refusals.get(
      "guild_id" in record ? (record.guild_id ?? "") : "",
    );
    const where = refused
      ? `the voice server closed the bot's connection with ${refused}`
      : !session
        ? "the bot has no voice connection in that server"
        : session.channelId !== channel.id
          ? `the bot is in ${this.mock.state.requireChannel(session.channelId).name}`
          : !session.secretKey
            ? "the bot's voice connection never got ready"
            : "the bot is connected there but sent no sound";
    throw new Error(
      `discordjs-test-kit: didn't hear the bot in ${channel.name} within ${FIND_TIMEOUT_MS / 1000}s: ${where}`,
    );
  }

  /** The voice or stage channel the bot is in, in `guild`, or null. */
  botVoiceChannel(guild: Guild): VoiceChannel | StageChannel | null {
    const voice = this.mock.state.voiceStates
      .get(guild.id)
      ?.get(this.mock.state.bot.id);
    if (!voice?.channel_id) return null;
    const channel = this.mock.state.requireChannel(voice.channel_id);
    return handle(channel.id, channel.name ?? "");
  }

  /** Every message in `channel`, oldest first. To wait for one, use `waitForMessage`. */
  messages(channel: TextChannel | Thread): Message[] {
    return this.mock.messagesIn(channel.id);
  }

  /** The bot's DMs with `member`, oldest first. To wait for one, use `waitForDM`. */
  dms(member: Member): Message[] {
    return this.mock.messagesIn(this.mock.state.dmChannel(member.id).id);
  }

  /**
   * Waits for a message the bot created or edited in `channel` (or a thread) since the latest
   * action (a member's action, `start` or `autoArchive`). Its text must contain `text`, or match it
   * when it's a RegExp; the text is the content plus each embed's title, description, fields and
   * footer. Resolves with the newest match already written, else the first one to land; rejects
   * after 2 seconds, showing the last messages. To check the bot did nothing more, or nothing at
   * all, `await discord.waitForIdle()` first.
   * @example await discord.waitForMessage(leaderboardChannel, /Bobby/);
   */
  waitForMessage(
    channel: TextChannel | Thread,
    text: string | RegExp,
  ): Promise<Message> {
    return this.waitForWritten(channel.id, `#${channel.name}`, text);
  }

  /**
   * Waits for a direct message the bot sent `member`, like `waitForMessage` does in a channel.
   * @example alice.dm({ content: "!help" }); await discord.waitForDM(alice, /commands/);
   */
  waitForDM(member: Member, text: string | RegExp): Promise<Message> {
    return this.waitForWritten(
      this.mock.state.dmChannel(member.id).id,
      `${member.name}'s DMs`,
      text,
    );
  }

  private async waitForWritten(
    channelId: string,
    place: string,
    text: string | RegExp,
  ): Promise<Message> {
    const wanted = (m: Message) =>
      m.channel_id === channelId &&
      matches(readable(m), text, { partial: true });
    const match = this.mock
      .messagesIn(channelId)
      .findLast((m) => this.written.has(m) && wanted(m));
    if (match) return match;
    try {
      return await this.mock.waitForMessage(wanted, {
        timeoutMs: FIND_TIMEOUT_MS,
      });
    } catch {
      const last = this.mock.messagesIn(channelId).slice(-3).map(shown);
      throw new Error(
        `discordjs-test-kit: no message in ${place} written since the last action matched ${quote(text)} within ${FIND_TIMEOUT_MS / 1000}s. ${last.length ? `Last ${last.length}: ${last.join(", ")}` : "It has no messages"}`,
      );
    }
  }

  /**
   * Waits until the bot has gone quiet: no request to Discord open and nothing new for it for 100ms.
   * Use it before asserting the bot sent exactly one reply, or none. A bot that works longer than
   * 100ms before its first request looks done, so wait on `waitForMessage` for what it should send.
   * @example alice.post(generalChannel, { content: "hello" }); await discord.waitForIdle(); expect(discord.messages(generalChannel)).toHaveLength(1);
   */
  waitForIdle(): Promise<void> {
    return this.mock.waitForIdle();
  }

  private async close(): Promise<void> {
    await this.client?.destroy();
    try {
      this.mock.assertNoUnhandledRequests();
    } finally {
      await this.mock.close();
    }
  }

  private g(guild: Guild) {
    return this.mock.state.requireGuild(guild.id);
  }

  private actorFor<G extends string>(
    guild: Guild<G>,
    user: APIUser,
  ): Member<G> {
    return new MemberActor(
      this.mock,
      this.markAction,
      this.quietTimeMs,
      guild.id,
      user.id,
      user.username,
    ) as never;
  }
}

export type { Discord };

class MemberActor {
  constructor(
    private readonly mock: DiscordMock,
    private readonly markAction: () => void,
    private readonly quietTimeMs: number,
    private readonly guildId: string,
    readonly id: string,
    readonly name: string,
  ) {}

  async runCommand(
    channel: TextChannel | Thread,
    command: string,
    options: Record<string, OptionValue> = {},
    form?: Form,
  ): Promise<Message> {
    const values = optionIds(options);
    return this.answer(
      this.actor().slashCommand(
        this.mock.state.requireChannel(channel.id),
        command,
        values,
      ),
      form,
    );
  }

  async typeInOption(
    channel: TextChannel | Thread,
    command: string,
    option: string,
    typed: string | number,
    filled: Record<string, OptionValue> = {},
  ): Promise<Choice[]> {
    return this.actor()
      .autocomplete(
        this.mock.state.requireChannel(channel.id),
        command,
        option,
        typed,
        optionIds(filled),
      )
      .suggestions();
  }

  async runUserCommand(
    channel: TextChannel | Thread,
    command: string,
    member: Member,
    form?: Form,
  ): Promise<Message> {
    const state = this.mock.state;
    return this.answer(
      this.actor().contextMenu(
        state.requireChannel(channel.id),
        state.requireUser(member.id),
        command,
      ),
      form,
    );
  }

  async runMessageCommand(
    channel: TextChannel | Thread,
    command: string,
    message: Message,
    form?: Form,
  ): Promise<Message> {
    const state = this.mock.state;
    return this.answer(
      this.actor().contextMenu(
        state.requireChannel(channel.id),
        state.requireMessage(message.channel_id, message.id),
        command,
      ),
      form,
    );
  }

  async click(
    message: Message,
    label: string | RegExp,
    form?: Form,
  ): Promise<Message> {
    await this.botSettled();
    return this.answer(this.actor().clickButton(message, label), form);
  }

  async select(
    message: Message,
    picks: string | RegExp | Pickable | (string | RegExp)[] | Pickable[],
    form?: Form,
  ): Promise<Message> {
    await this.botSettled();
    const list = Array.isArray(picks) ? picks : [picks];
    const labels = list.filter(
      (pick): pick is string | RegExp =>
        typeof pick === "string" || pick instanceof RegExp,
    );
    return this.answer(
      labels.length
        ? this.actor().selectOption(message, labels)
        : this.actor().pickEntities(
            message,
            (list as Pickable[]).map((pick) => pick.id),
          ),
      form,
    );
  }

  /**
   * A member reads a message before using its components, so the bot has finished what it does
   * after sending it, such as fetching the reply and starting a component collector on it. A bot
   * still busy after the idle wait gets the click anyway, as a member wouldn't wait forever.
   */
  private async botSettled() {
    await this.mock.waitForIdle({ quietMs: this.quietTimeMs }).catch(() => {});
  }

  /** The visible reply to an action, filling and submitting the form first when the bot opens one. */
  private async answer(run: InteractionRun, form?: Form): Promise<Message> {
    await run.acknowledged();
    if (!form) return run.reply();
    if (!run.modal)
      throw new Error(
        `discordjs-test-kit: ${this.name} was given a form to fill, but the bot answered without opening one`,
      );
    return this.mock.as(this.user()).submitForm(run, form).reply();
  }

  post(channel: TextChannel | Thread, message: UserMessage): Message {
    return this.actor().sendMessage(
      this.mock.state.requireChannel(channel.id),
      message,
    );
  }

  /** Sends the bot a direct message. Read its answer with `discord.waitForDM(member, …)`. */
  dm(message: UserMessage): Message {
    return this.actor().sendMessage(
      this.mock.state.dmChannel(this.id),
      message,
    );
  }

  postInForum(
    forum: Forum,
    post: UserMessage & { title: string; tags?: string[] },
  ): { thread: Thread; message: Message } {
    const { thread, message } = this.actor().forumPost(
      this.mock.state.requireChannel(forum.id),
      post,
    );
    return { thread: handle(thread.id, post.title), message };
  }

  editMessage(message: Message, content: string): void {
    this.actor().editOwnMessage(message, content);
  }

  deleteMessage(message: Message): void {
    this.actor().deleteOwnMessage(message);
  }

  react(message: Message, emoji: string): void {
    this.actor().react(message, emoji);
  }

  vote(message: Message, answer: string | string[]): void {
    this.actor().vote(message, [answer].flat());
  }

  unvote(message: Message): void {
    this.actor().removeVote(message);
  }

  startStage(stage: StageChannel, topic: string): void {
    this.actor().startStage(this.mock.state.requireChannel(stage.id), topic);
  }

  endStage(stage: StageChannel): void {
    this.actor().endStage(this.mock.state.requireChannel(stage.id));
  }

  startTyping(channel: TextChannel | Thread): void {
    this.actor().startTyping(this.mock.state.requireChannel(channel.id));
  }

  closeDMs(): void {
    this.markAction();
    this.mock.state.closedDms.add(this.id);
  }

  setPresence(presence: PresenceInput): void {
    this.markAction();
    setPresence(this.mock, this.user(), presence);
  }

  setNickname(nick: string | null): void {
    this.markAction();
    this.mock.setNickname(this.guild(), this.user(), nick);
  }

  setDisplayName(name: string | null): void {
    this.markAction();
    this.mock.setDisplayName(this.user(), name);
  }

  leaveGuild(): void {
    this.markAction();
    this.mock.removeMember(this.guild(), this.user());
  }

  kick(member: Member, reason?: string): void {
    this.markAction();
    this.mock.moderate(
      this.guild(),
      this.user(),
      this.userOf(member),
      "kick",
      reason,
    );
  }

  ban(member: Member, reason?: string): void {
    this.markAction();
    this.mock.moderate(
      this.guild(),
      this.user(),
      this.userOf(member),
      "ban",
      reason,
    );
  }

  createInvite(
    channel: TextChannel,
    options: { maxUses?: number } = {},
  ): string {
    this.markAction();
    return createInvite(
      this.mock,
      this.mock.state.requireChannel(channel.id),
      this.user(),
      { max_uses: options.maxUses },
    ).code;
  }

  joinVoice(channel: VoiceChannel | StageChannel): void {
    this.markAction();
    this.mock.joinVoice(
      this.guild(),
      this.user(),
      this.mock.state.requireChannel(channel.id),
    );
  }

  leaveVoice(): void {
    this.markAction();
    this.mock.joinVoice(this.guild(), this.user(), null);
  }

  lockThread(thread: Thread): void {
    const record = this.mock.state.requireChannel(thread.id);
    const parentId = "parent_id" in record ? record.parent_id : undefined;
    // Modifying a thread needs Manage Threads, except unarchiving an unlocked one:
    // docs.discord.food/resources/channel#modify-channel. A thread takes its parent's overwrites.
    const parent = this.mock.state.requireChannel(parentId ?? thread.id);
    if (
      !(
        computePermissions(this.mock.state, this.guild(), this.id, parent) &
        Permission.ManageThreads
      )
    )
      throw new Error(
        `discordjs-test-kit: ${this.name} can't lock ${thread.name} without Manage Threads`,
      );
    this.markAction();
    this.mock.lockThread(record);
  }

  renameGuild(name: string): void {
    const guild = this.guild();
    if (
      !(
        computePermissions(this.mock.state, guild, this.id) &
        Permission.ManageGuild
      )
    )
      throw new Error(
        `discordjs-test-kit: ${this.name} can't rename ${guild.name} without Manage Server`,
      );
    this.markAction();
    this.mock.renameGuild(guild, name);
  }

  createEvent(
    name: string,
    where: VoiceChannel | string,
    start: Date,
  ): ScheduledEvent {
    this.markAction();
    const event = createScheduledEvent(this.mock, this.guild(), this.user(), {
      name,
      start,
      place:
        typeof where === "string"
          ? { location: where }
          : { channel: this.mock.state.requireChannel(where.id) },
    });
    return handle(event.id, name);
  }

  editEvent(
    event: ScheduledEvent,
    changes: { name?: string; description?: string; start?: Date },
  ): void {
    this.markAction();
    editScheduledEvent(
      this.mock,
      this.guild(),
      this.user(),
      this.eventOf(event),
      changes,
    );
  }

  deleteEvent(event: ScheduledEvent): void {
    this.markAction();
    deleteScheduledEvent(
      this.mock,
      this.guild(),
      this.user(),
      this.eventOf(event),
    );
  }

  markInterested(event: ScheduledEvent): void {
    this.markAction();
    setInterest(
      this.mock,
      this.guild(),
      this.user(),
      this.eventOf(event),
      true,
    );
  }

  unmarkInterested(event: ScheduledEvent): void {
    this.markAction();
    setInterest(
      this.mock,
      this.guild(),
      this.user(),
      this.eventOf(event),
      false,
    );
  }

  addEmoji(name: string): Emoji {
    this.markAction();
    const id = uploadExpression(
      this.mock,
      this.guild(),
      this.user(),
      "emoji",
      name,
    );
    return handle(id, name);
  }

  addSticker(name: string): Sticker {
    this.markAction();
    const id = uploadExpression(
      this.mock,
      this.guild(),
      this.user(),
      "sticker",
      name,
    );
    return handle(id, name);
  }

  renameExpression(expression: Emoji | Sticker, name: string): void {
    this.markAction();
    const guild = this.guild();
    renameExpression(
      this.mock,
      guild,
      this.user(),
      this.kindOf(expression),
      expression.id,
      name,
    );
  }

  deleteExpression(expression: Emoji | Sticker): void {
    this.markAction();
    const guild = this.guild();
    deleteExpression(
      this.mock,
      guild,
      this.user(),
      this.kindOf(expression),
      expression.id,
    );
  }

  private kindOf(expression: Emoji | Sticker) {
    const guild = this.guild();
    if (guild.emojis.has(expression.id)) return "emoji";
    if (guild.stickers.has(expression.id)) return "sticker";
    throw new Error(`discordjs-test-kit: ${expression.name} was deleted`);
  }

  private eventOf(event: ScheduledEvent) {
    const found = this.mock.state.scheduledEvents.get(event.id);
    if (!found)
      throw new Error(`discordjs-test-kit: event ${event.name} was deleted`);
    return found;
  }

  private actor() {
    this.markAction();
    return this.mock.as(this.user());
  }
  private user() {
    return this.mock.state.requireUser(this.id);
  }
  private userOf(member: Member) {
    return this.mock.state.requireUser(member.id);
  }
  private guild() {
    return this.mock.state.requireGuild(this.guildId);
  }
}

/** Handles become the ids Discord sends for user, role and channel options; files stay files. */
function optionIds(options: Record<string, OptionValue>) {
  return Object.fromEntries(
    Object.entries(options).map(([name, value]) => [
      name,
      typeof value === "object" && "id" in value ? value.id : value,
    ]),
  );
}

/** Handles exist only in types; at run time they're the entity's id and name. */
function handle<T>(id: string, name: string): T {
  return { id, name } as T;
}

/** Settings for `createDiscord`. */
export interface DiscordOptions {
  /**
   * How long, in milliseconds, the bot must stay quiet (no request to Discord open, nothing new sent
   * to it) before a member clicks a button or picks from a select. Default: 100.
   *
   * A member reads a message before using it, so the bot has time to finish what it does after
   * replying, such as fetching its reply and starting a component collector on it. The kit can't see
   * work the bot does away from Discord, such as a database query or a timer: that work has to fit in
   * this window. Too low, and a click can land before the bot listens for it; the test then fails with
   * "The application did not respond", although the bot works on Discord.
   *
   * Lower it to speed up tests that click or pick many times, when the bot does nothing between
   * sending a message and listening for its buttons. 0 still waits for every open request and for
   * whatever reached the bot to be read.
   */
  quietTimeMs?: number;
  /**
   * The privileged intents your app has turned on in the Developer Portal. Default: all three.
   *
   * Leave one out to test the bot as it runs without it. Without Message Content, messages the bot
   * reads arrive with empty content, embeds, attachments and components, over the gateway and when
   * it fetches them, except in DMs, its own messages and messages that mention it. A bot that
   * connects asking for an intent left out here is refused, as Discord refuses it.
   * @example await createDiscord({ privilegedIntents: [GatewayIntentBits.GuildMembers] });
   */
  privilegedIntents?: (
    | GatewayIntentBits.GuildMembers
    | GatewayIntentBits.GuildPresences
    | GatewayIntentBits.MessageContent
  )[];
}

const PRIVILEGED = [
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.MessageContent,
];

/**
 * A fake Discord for the current test, on its own port, shut down when the test finishes.
 * @example const discord = await createDiscord();
 * @example const discord = await createDiscord({ quietTimeMs: 20 });
 */
export async function createDiscord(
  options: DiscordOptions = {},
): Promise<Discord> {
  const { quietTimeMs = 100, privilegedIntents = PRIVILEGED } = options;
  const notPrivileged = privilegedIntents.find((i) => !PRIVILEGED.includes(i));
  if (notPrivileged !== undefined)
    throw new Error(
      `discordjs-test-kit: privilegedIntents takes Guild Members, Guild Presences and Message Content only, not ${String(notPrivileged)}`,
    );
  if (
    typeof quietTimeMs !== "number" ||
    !Number.isFinite(quietTimeMs) ||
    quietTimeMs < 0
  )
    throw new Error(
      `discordjs-test-kit: quietTimeMs must be a number of milliseconds, 0 or more, not ${String(quietTimeMs)}`,
    );
  return new Discord(
    await createDiscordMock({
      privilegedIntents: privilegedIntents.reduce((all, i) => all | i, 0),
    }),
    quietTimeMs,
  );
}
