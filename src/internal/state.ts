import { EventEmitter } from "node:events";
import {
  ApplicationCommandType,
  ChannelType,
  type APIApplicationCommand,
  type APIAttachment,
  type APIAutoModerationRule,
  type APIApplicationCommandPermission,
  type APIAuditLogEntry,
  type APIBan,
  type ChannelFlags,
  type GuildMemberFlags,
  type UserFlags,
  type RoleFlags,
  type APIChannel,
  type APIEmoji,
  type GatewayPresenceUpdate,
  type APIGuildMember,
  type APIGuildScheduledEvent,
  type APIMessage,
  type APIRole,
  type APIStageInstance,
  type APISoundboardSound,
  type APISticker,
  type APIUser,
  type APIVoiceState,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { snowflake } from "./snowflake.js";

/** A guild template (resources/guild-template): a snapshot of its guild, kept until synced. */
export interface TemplateRecord {
  code: string;
  guildId: string;
  creatorId: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** The guild as it was when the template was made or last synced. */
  snapshot: Record<string, unknown>;
}

/** An invite: Discord's invite object plus its metadata (resources/invite). */
export interface InviteRecord {
  code: string;
  guildId: string;
  channelId: string;
  inviterId: string;
  uses: number;
  max_uses: number;
  max_age: number;
  temporary: boolean;
  created_at: string;
}

/** A channel webhook (resources/webhook, type 1 Incoming). */
export interface WebhookRecord {
  id: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  name: string;
  /** Incoming webhooks only; a channel follower webhook has none. */
  token?: string;
  /** The announcement channel a channel follower webhook copies posts from. */
  sourceChannelId?: string;
}

export interface GuildRecord {
  id: string;
  name: string;
  ownerId: string;
  roles: Map<string, APIRole>;
  members: Map<string, APIGuildMember>;
  bans: Map<string, APIBan>;
  channelIds: string[];
  /** Custom emojis by id, each with the user who uploaded it. */
  emojis: Map<string, APIEmoji & { id: string; user: APIUser }>;
  /** Guild stickers by id, each with the user who uploaded it. */
  stickers: Map<string, APISticker & { user: APIUser }>;
  /** Soundboard sounds by id, each with the user who uploaded it. */
  soundboardSounds: Map<string, APISoundboardSound & { user: APIUser }>;
  /** The widget settings; disabled with no invite channel until changed (inferred, not checked). */
  widget: { enabled: boolean; channel_id: string | null };
  /** When members were last seen, by user id; a member not listed was seen just now. */
  lastSeen: Map<string, number>;
}

/**
 * The fake Discord's in-memory truth. REST writes mutate it; the gateway
 * announces the mutations. Tests read it to assert what the bot did.
 */
export class DiscordState extends EventEmitter<{
  messageCreate: [APIMessage];
  messageUpdate: [APIMessage];
  threadCreate: [APIChannel];
}> {
  readonly users = new Map<string, APIUser>();
  readonly guilds = new Map<string, GuildRecord>();
  /** Guilds in an outage: the bot hears nothing from them (gateway-events#guild-delete). */
  readonly outages = new Set<string>();
  /** Live stages, by stage channel id (resources/stage-instance). */
  readonly stageInstances = new Map<string, APIStageInstance>();
  readonly channels = new Map<string, APIChannel>();
  readonly messages = new Map<string, APIMessage[]>();
  /** Users who turned off DMs from server members, so the bot can't message them. */
  readonly closedDms = new Set<string>();
  /** Thread id to its members' join timestamps, by user id. */
  private readonly threadMemberIds = new Map<string, Map<string, string>>();
  /** Bytes behind each attachment url, keyed by attachment id. */
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  /** Base for attachment urls; set when the server listens. */
  cdnUrl = "";
  /** Keyed by guild id or "global", then by `${type}:${name}`: names are unique per type and scope. */
  readonly commands = new Map<string, Map<string, APIApplicationCommand>>();
  /** Who is in a voice channel, by guild id, then user id. */
  readonly voiceStates = new Map<string, Map<string, APIVoiceState>>();
  /** Command permission overrides by guild id, then command id (or the application id for all). */
  readonly commandPermissions = new Map<
    string,
    Map<string, APIApplicationCommandPermission[]>
  >();
  /** Audit log entries by guild id, oldest first. */
  readonly auditLog = new Map<string, APIAuditLogEntry[]>();
  /** Channel webhooks by id. */
  readonly webhooks = new Map<string, WebhookRecord>();
  /** Invites by code. */
  readonly invites = new Map<string, InviteRecord>();
  /** Poll votes by message id, then user id: the answer ids they picked. */
  readonly pollVotes = new Map<string, Map<string, number[]>>();
  /** AutoMod rules by id. */
  readonly autoModRules = new Map<string, APIAutoModerationRule>();
  /** Guild scheduled events by id. */
  readonly scheduledEvents = new Map<string, APIGuildScheduledEvent>();
  /** Guild templates by code. */
  readonly templates = new Map<string, TemplateRecord>();
  /** Each user's presence once they set one; nobody in it is offline. */
  readonly presences = new Map<
    string,
    Omit<GatewayPresenceUpdate, "guild_id">
  >();
  /** Emojis the app uploaded for its own use, by id. */
  readonly applicationEmojis = new Map<string, APIEmoji>();
  /** Who marked each scheduled event Interested, by event id. */
  readonly eventSubscribers = new Map<string, Set<string>>();

  readonly applicationId: string;
  /** The app's description, which a bot can rewrite with PATCH /applications/@me. */
  applicationDescription = "";
  readonly bot: APIUser;

  constructor() {
    super();
    this.applicationId = snowflake();
    this.bot = this.createUser({
      username: "bot",
      bot: true,
      id: this.applicationId,
    });
  }

  createUser(input: { username: string; bot?: boolean; id?: string }): APIUser {
    const user: APIUser = {
      id: input.id ?? snowflake(),
      username: input.username,
      discriminator: "0",
      global_name: null,
      avatar: null,
      public_flags: 0 as UserFlags,
      ...(input.bot ? { bot: true } : {}),
    };
    this.users.set(user.id, user);
    return user;
  }

  createGuild(input: { name: string; ownerId?: string }): GuildRecord {
    const id = snowflake();
    // Every role is copied from @everyone. Discord sends `description` on roles (the contract run
    // saw it); discord-api-types doesn't list it yet.
    const everyone: APIRole & { description: string | null } = {
      id,
      name: "@everyone",
      description: null,
      color: 0,
      colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
      hoist: false,
      icon: null,
      unicode_emoji: null,
      position: 0,
      // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | USE_APPLICATION_COMMANDS, plus
      // CONNECT | SPEAK so members can join voice, as in a new Discord server (inferred from the
      // app's defaults, not checked: the default set isn't documented).
      permissions: String(
        (1n << 10n) |
          (1n << 11n) |
          (1n << 16n) |
          (1n << 31n) |
          (1n << 20n) |
          (1n << 21n),
      ),
      managed: false,
      mentionable: false,
      flags: 0 as RoleFlags,
    };
    const guild: GuildRecord = {
      id,
      name: input.name,
      // Never the bot by default: owners bypass every permission check, which would hide permission bugs.
      ownerId:
        input.ownerId ??
        this.createUser({ username: `${input.name}-owner` }).id,
      roles: new Map([[id, everyone]]),
      members: new Map(),
      bans: new Map(),
      channelIds: [],
      emojis: new Map(),
      stickers: new Map(),
      soundboardSounds: new Map(),
      widget: { enabled: false, channel_id: null },
      lastSeen: new Map(),
    };
    this.guilds.set(id, guild);
    this.addMember(guild.id, guild.ownerId);
    this.addMember(guild.id, this.bot.id);
    return guild;
  }

  addMember(
    guildId: string,
    userId: string,
    input: { nick?: string } = {},
  ): APIGuildMember {
    const guild = this.requireGuild(guildId);
    const member: APIGuildMember = {
      user: this.requireUser(userId),
      roles: [],
      joined_at: new Date().toISOString(),
      nick: input.nick ?? null,
      avatar: null,
      banner: null,
      pending: false,
      premium_since: null,
      communication_disabled_until: null,
      deaf: false,
      mute: false,
      flags: 0 as GuildMemberFlags,
    };
    guild.members.set(userId, member);
    return member;
  }

  createRole(
    guildId: string,
    input: { name: string; permissions: bigint },
  ): APIRole {
    const guild = this.requireGuild(guildId);
    const role: APIRole = {
      ...guild.roles.get(guild.id)!,
      id: snowflake(),
      name: input.name,
      position: guild.roles.size,
      permissions: String(input.permissions),
    };
    guild.roles.set(role.id, role);
    return role;
  }

  assignRole(guildId: string, userId: string, roleId: string) {
    const member = this.requireGuild(guildId).members.get(userId);
    if (!member)
      throw new Error(`discordjs-test-kit: ${userId} isn't a member`);
    if (!member.roles.includes(roleId)) member.roles.push(roleId);
  }

  deleteChannel(id: string): APIChannel {
    const channel = this.requireChannel(id);
    this.channels.delete(id);
    this.messages.delete(id);
    if ("guild_id" in channel && channel.guild_id) {
      const guild = this.requireGuild(channel.guild_id);
      guild.channelIds = guild.channelIds.filter((c) => c !== id);
    }
    return channel;
  }

  createCategoryChannel(guildId: string, input: { name: string }): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: ChannelType.GuildCategory,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      flags: 0 as ChannelFlags,
    } satisfies APIChannel;
    this.channels.set(channel.id, channel);
    guild.channelIds.push(channel.id);
    return channel;
  }

  createTextChannel(
    guildId: string,
    input: { name: string; parentId?: string; announcement?: boolean },
  ): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: input.announcement
        ? ChannelType.GuildAnnouncement
        : ChannelType.GuildText,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      parent_id: input.parentId ?? null,
      nsfw: false,
      topic: null,
      last_message_id: null,
      rate_limit_per_user: 0,
      flags: 0 as ChannelFlags,
    } satisfies APIChannel;
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    guild.channelIds.push(channel.id);
    return channel;
  }

  /** A voice channel (resources/channel#channel-object-example-guild-voice-channel). */
  createVoiceChannel(
    guildId: string,
    input: { name: string; stage?: boolean },
  ): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: input.stage ? ChannelType.GuildStageVoice : ChannelType.GuildVoice,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      parent_id: null,
      nsfw: false,
      last_message_id: null,
      rate_limit_per_user: 0,
      bitrate: 64000,
      user_limit: 0,
      rtc_region: null,
      flags: 0 as ChannelFlags,
    } satisfies APIChannel;
    this.channels.set(channel.id, channel);
    guild.channelIds.push(channel.id);
    return channel;
  }

  /**
   * A forum (thread-only) channel. Its posts are threads; see `createThread`.
   * docs.discord.food/topics/threads#thread-only-channels
   */
  createForumChannel(
    guildId: string,
    input: { name: string; tags?: string[] },
  ): APIChannel {
    const guild = this.requireGuild(guildId);
    const channel = {
      id: snowflake(),
      type: ChannelType.GuildForum,
      guild_id: guild.id,
      name: input.name,
      position: guild.channelIds.length,
      permission_overwrites: [],
      parent_id: null,
      nsfw: false,
      topic: null,
      last_message_id: null,
      rate_limit_per_user: 0,
      flags: 0 as ChannelFlags,
      // resources/channel#forum-tag-object.
      available_tags: (input.tags ?? []).map((name) => ({
        id: snowflake(),
        name,
        moderated: false,
        emoji_id: null,
        emoji_name: null,
      })),
      default_reaction_emoji: null,
      default_sort_order: null,
      default_forum_layout: 0,
    } as unknown as APIChannel;
    this.channels.set(channel.id, channel);
    guild.channelIds.push(channel.id);
    return channel;
  }

  /**
   * A public thread under `parentId`. In a forum, the starter message shares the thread's id
   * (docs.discord.food/topics/threads#thread-only-channels); `archived` files it under the
   * archived list instead of the active one.
   */
  createThread(input: {
    parentId: string;
    name: string;
    ownerId: string;
    archived?: boolean;
    /** A thread started from a message takes the message's id. */
    id?: string;
    type?: ChannelType;
    autoArchiveDuration?: number;
    /** Slowmode in seconds; Discord's docs, Start Thread from Message: rate_limit_per_user. */
    rateLimitPerUser?: number;
    invitable?: boolean;
    /** Tag ids, for a post in a forum. */
    appliedTags?: string[];
  }): APIChannel {
    const parent = this.requireChannel(input.parentId);
    if (!("guild_id" in parent) || !parent.guild_id)
      throw new Error("discordjs-test-kit: threads live in guild channels");
    const now = new Date().toISOString();
    const thread = {
      id: input.id ?? snowflake(),
      type: input.type ?? ChannelType.PublicThread,
      guild_id: parent.guild_id,
      parent_id: parent.id,
      owner_id: input.ownerId,
      name: input.name,
      last_message_id: null,
      rate_limit_per_user: input.rateLimitPerUser ?? 0,
      message_count: 0,
      member_count: 1,
      total_message_sent: 0,
      flags: 0 as ChannelFlags,
      ...(parent.type === ChannelType.GuildForum
        ? { applied_tags: input.appliedTags ?? [] }
        : {}),
      thread_metadata: {
        archived: !!input.archived,
        // docs.discord.food/resources/channel#start-thread-from-message: default 4320.
        auto_archive_duration: input.autoArchiveDuration ?? 4320,
        archive_timestamp: now,
        locked: false,
        create_timestamp: now,
        ...(input.invitable === undefined
          ? {}
          : { invitable: input.invitable }),
      },
    } as unknown as APIChannel;
    this.channels.set(thread.id, thread);
    this.messages.set(thread.id, []);
    this.threadMemberIds.set(thread.id, new Map());
    this.addThreadMember(thread.id, input.ownerId);
    this.emit("threadCreate", thread);
    return thread;
  }

  /** True when `userId` wasn't in the thread yet. */
  addThreadMember(threadId: string, userId: string): boolean {
    const members = this.threadMemberIds.get(threadId)!;
    if (members.has(userId)) return false;
    members.set(userId, new Date().toISOString());
    this.syncMemberCount(threadId);
    return true;
  }

  /** True when `userId` was in the thread. */
  removeThreadMember(threadId: string, userId: string): boolean {
    const removed = this.threadMemberIds.get(threadId)!.delete(userId);
    this.syncMemberCount(threadId);
    return removed;
  }

  /** resources/channel#thread-member-object: id, user_id, join_timestamp, flags. */
  threadMember(threadId: string, userId: string) {
    const joined = this.threadMemberIds.get(threadId)?.get(userId);
    return joined === undefined
      ? undefined
      : { id: threadId, user_id: userId, join_timestamp: joined, flags: 0 };
  }

  threadMembers(threadId: string) {
    return [...(this.threadMemberIds.get(threadId)?.keys() ?? [])].map(
      (userId) => this.threadMember(threadId, userId)!,
    );
  }

  // resources/channel#channel-object: member_count "stops counting at 50".
  private syncMemberCount(threadId: string) {
    const thread = this.requireChannel(threadId) as { member_count?: number };
    thread.member_count = Math.min(
      50,
      this.threadMemberIds.get(threadId)!.size,
    );
  }

  /** The DM channel between the bot and `userId`, created on first use. */
  dmChannel(userId: string): APIChannel {
    const existing = [...this.channels.values()].find(
      (c) =>
        c.type === ChannelType.DM && c.recipients?.some((u) => u.id === userId),
    );
    if (existing) return existing;
    const channel = {
      id: snowflake(),
      type: ChannelType.DM,
      last_message_id: null,
      recipients: [this.requireUser(userId)],
      flags: 0 as ChannelFlags,
    } as unknown as APIChannel;
    this.channels.set(channel.id, channel);
    this.messages.set(channel.id, []);
    return channel;
  }

  /** The channel a thread's permissions come from: its parent. Any other channel is its own. */
  permissionChannel(channel: APIChannel): APIChannel {
    return "thread_metadata" in channel && channel.parent_id
      ? this.requireChannel(channel.parent_id)
      : channel;
  }

  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ) {
    const message = this.requireMessage(channelId, messageId);
    const reactions = (message.reactions ??= []);
    let reaction = reactions.find((r) => r.emoji.name === emoji);
    if (!reaction) {
      reaction = {
        count: 0,
        count_details: { burst: 0, normal: 0 },
        me: false,
        me_burst: false,
        burst_colors: [],
        emoji: { id: null, name: emoji },
      };
      reactions.push(reaction);
    }
    const by = this.reactors.get(`${messageId}:${emoji}`) ?? new Set<string>();
    if (by.has(userId)) return false;
    by.add(userId);
    this.reactors.set(`${messageId}:${emoji}`, by);
    reaction.count++;
    reaction.count_details.normal++;
    if (userId === this.bot.id) reaction.me = true;
    return true;
  }

  removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ) {
    const message = this.requireMessage(channelId, messageId);
    const by = this.reactors.get(`${messageId}:${emoji}`);
    if (!by?.delete(userId)) return false;
    const reaction = message.reactions!.find((r) => r.emoji.name === emoji)!;
    reaction.count--;
    reaction.count_details.normal--;
    if (userId === this.bot.id) reaction.me = false;
    if (!reaction.count)
      message.reactions = message.reactions!.filter((r) => r !== reaction);
    return true;
  }

  /** Removes every reaction on `message`, or only `emoji`'s. False when there was none. */
  clearReactions(message: APIMessage, emoji?: string) {
    const before = message.reactions?.length ?? 0;
    message.reactions = (message.reactions ?? []).filter(
      (r) => emoji !== undefined && r.emoji.name !== emoji,
    );
    for (const key of this.reactors.keys())
      if (
        key === `${message.id}:${emoji}` ||
        (!emoji && key.startsWith(`${message.id}:`))
      )
        this.reactors.delete(key);
    return message.reactions.length < before;
  }

  /** Who reacted with what, keyed by `${messageId}:${emoji}`. */
  readonly reactors = new Map<string, Set<string>>();

  /** Keeps `file`'s bytes for the CDN route and returns the attachment object that points at them. */
  storeAttachment(
    channelId: string,
    file: { name: string; data: Uint8Array; contentType: string },
  ): APIAttachment {
    const attachmentId = snowflake();
    this.files.set(attachmentId, {
      data: file.data,
      contentType: file.contentType,
    });
    // Real urls point at cdn.discordapp.com and carry signed ex/is/hm params; inferred shape.
    const url = `${this.cdnUrl}/attachments/${channelId}/${attachmentId}/${encodeURIComponent(file.name)}`;
    return {
      id: attachmentId,
      filename: file.name,
      size: file.data.byteLength,
      url,
      proxy_url: url,
      content_type: file.contentType,
    };
  }

  createMessage(input: {
    channelId: string;
    authorId: string;
    content?: string;
    /** Files the author uploaded; served at `cdnUrl`. */
    files?: { name: string; data: Uint8Array; contentType: string }[];
    /** The message this one replies to. */
    replyTo?: string;
    /** Whether the reply pings the replied-to author (Discord's default; allowed_mentions.replied_user). */
    pingReplied?: boolean;
    /** Use this id, e.g. a forum post's starter message shares the thread's id. */
    id?: string;
    embeds?: APIMessage["embeds"];
    components?: APIMessage["components"];
    flags?: number;
    /** docs.discord.food/resources/message#message-interaction-metadata-structure */
    interaction?: {
      id: string;
      type: number;
      userId: string;
      guildId?: string;
      /** Component interactions only. */
      interactedMessageId?: string;
      /** Followups only. */
      originalResponseMessageId?: string;
    };
    webhookId?: string;
    poll?: APIMessage["poll"];
  }): APIMessage {
    const channel = this.requireChannel(input.channelId);
    // No guild_id: Discord sends it on gateway dispatches only, not in REST message objects.
    const id = input.id ?? snowflake();
    const attachments = (input.files ?? []).map((file) =>
      this.storeAttachment(channel.id, file),
    );
    const message: APIMessage = {
      id,
      channel_id: channel.id,
      author: this.requireUser(input.authorId),
      content: input.content ?? "",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments,
      embeds: input.embeds ?? [],
      components: withIds(input.components ?? []),
      pinned: false,
      // 20 CHAT_INPUT_COMMAND for any interaction response, followups and component replies
      // included: inferred, not checked (the docs only describe 20 as the slash command reply).
      type: input.interaction ? 20 : input.replyTo ? 19 : 0,
      // docs.discord.food/resources/message: referenced_message accompanies a REPLY. discord.js
      // reads mentions.repliedUser from its author (Message#_patch).
      ...(input.replyTo
        ? {
            referenced_message: (() => {
              const { referenced_message: _, ...referenced } =
                this.requireMessage(channel.id, input.replyTo);
              return referenced;
            })(),
          }
        : {}),
      ...(input.replyTo
        ? {
            message_reference: {
              type: 0,
              message_id: input.replyTo,
              channel_id: channel.id,
              ...("guild_id" in channel && channel.guild_id
                ? { guild_id: channel.guild_id }
                : {}),
            },
          }
        : {}),
      flags: input.flags ?? 0,
      ...(input.poll ? { poll: input.poll } : {}),
      ...(input.webhookId ? { webhook_id: input.webhookId } : {}),
      ...(input.interaction
        ? {
            interaction_metadata: {
              id: input.interaction.id,
              type: input.interaction.type,
              user: this.requireUser(input.interaction.userId),
              authorizing_integration_owners: {
                0: input.interaction.guildId ?? "0",
              },
              ...(input.interaction.interactedMessageId
                ? {
                    interacted_message_id:
                      input.interaction.interactedMessageId,
                  }
                : {}),
              ...(input.interaction.originalResponseMessageId
                ? {
                    original_response_message_id:
                      input.interaction.originalResponseMessageId,
                  }
                : {}),
            } as APIMessage["interaction_metadata"],
          }
        : {}),
    };
    if (input.replyTo && (input.pingReplied ?? true)) {
      const author = message.referenced_message!.author;
      if (!message.mentions.some((u) => u.id === author.id))
        message.mentions.push(author);
    }
    this.messages.get(channel.id)!.push(message);
    // docs.discord.food/topics/threads: message_count and total_message_sent count MESSAGE_CREATEs.
    if ("thread_metadata" in channel) {
      const counts = channel as {
        message_count?: number;
        total_message_sent?: number;
      };
      counts.message_count = (counts.message_count ?? 0) + 1;
      counts.total_message_sent = (counts.total_message_sent ?? 0) + 1;
    }
    (channel as { last_message_id?: string | null }).last_message_id =
      message.id;
    this.emit("messageCreate", message);
    return message;
  }

  deleteMessage(channelId: string, messageId: string) {
    const messages = this.messages.get(channelId) ?? [];
    const index = messages.findIndex((m) => m.id === messageId);
    if (index >= 0) messages.splice(index, 1);
  }

  updateMessage(
    channelId: string,
    messageId: string,
    patch: Partial<APIMessage>,
  ): APIMessage {
    const message = this.requireMessage(channelId, messageId);
    if (patch.components)
      patch = { ...patch, components: withIds(patch.components) };
    Object.assign(message, patch, {
      edited_timestamp: new Date().toISOString(),
    });
    this.emit("messageUpdate", message);
    return message;
  }

  setCommands(
    scope: string,
    bodies: RESTPostAPIApplicationCommandsJSONBody[],
  ): APIApplicationCommand[] {
    const existing = this.commands.get(scope);
    const next = new Map<string, APIApplicationCommand>();
    // docs.discord.food/interactions/application-commands: bulk overwrite replaces the scope;
    // a command whose name (and type) already exists keeps its id.
    for (const body of bodies) {
      const key = commandKey(body);
      next.set(key, this.buildCommand(scope, body, existing?.get(key)?.id));
    }
    this.commands.set(scope, next);
    return [...next.values()];
  }

  /**
   * Create Application Command is an upsert: "Returns 201 if a command with the same name does not
   * already exist, or a 200 if it does (in which case the previous command will be overwritten)".
   */
  upsertCommand(
    scope: string,
    body: RESTPostAPIApplicationCommandsJSONBody,
  ): { command: APIApplicationCommand; created: boolean } {
    const commands = this.scopeCommands(scope);
    const key = commandKey(body);
    const previous = commands.get(key);
    const command = this.buildCommand(scope, body, previous?.id);
    commands.set(key, command);
    return { command, created: !previous };
  }

  /** Edit Application Command: "any fields provided will entirely overwrite the existing values". */
  editCommand(
    scope: string,
    id: string,
    patch: Partial<RESTPostAPIApplicationCommandsJSONBody>,
  ): APIApplicationCommand | undefined {
    const commands = this.scopeCommands(scope);
    const [key, previous] =
      [...commands].find(([, command]) => command.id === id) ?? [];
    if (!key || !previous) return undefined;
    const command = {
      ...previous,
      ...patch,
      version: snowflake(),
    } as APIApplicationCommand;
    commands.delete(key);
    commands.set(commandKey(command), command);
    return command;
  }

  deleteCommand(scope: string, id: string): boolean {
    const commands = this.scopeCommands(scope);
    const key = [...commands].find(([, command]) => command.id === id)?.[0];
    // "Deleting or renaming a command will permanently delete all permissions for the command"
    // (Edit Application Command Permissions). Renaming isn't modelled.
    for (const overrides of this.commandPermissions.values())
      overrides.delete(id);
    return key ? commands.delete(key) : false;
  }

  /** The command named like `body` in `scope`, other than `id`: a rename onto it collides. */
  commandNamed(
    scope: string,
    body: { name?: string; type?: number },
    id: string,
  ): APIApplicationCommand | undefined {
    const found = this.commands.get(scope)?.get(commandKey(body));
    return found && found.id !== id ? found : undefined;
  }

  commandById(scope: string, id: string): APIApplicationCommand | undefined {
    return [...(this.commands.get(scope)?.values() ?? [])].find(
      (command) => command.id === id,
    );
  }

  private scopeCommands(scope: string) {
    let commands = this.commands.get(scope);
    if (!commands) this.commands.set(scope, (commands = new Map()));
    return commands;
  }

  private buildCommand(
    scope: string,
    body: RESTPostAPIApplicationCommandsJSONBody,
    id = snowflake(),
  ): APIApplicationCommand {
    return {
      id,
      application_id: this.applicationId,
      version: snowflake(),
      default_member_permissions: null,
      type: 1,
      description: "",
      ...(scope === "global" ? {} : { guild_id: scope }),
      ...body,
    } as APIApplicationCommand;
  }

  findCommand(
    guildId: string | undefined,
    name: string,
    type: ApplicationCommandType = ApplicationCommandType.ChatInput,
  ): APIApplicationCommand | undefined {
    return this.commandsVisibleIn(guildId, type).find((c) => c.name === name);
  }

  /**
   * The commands of `type` a user can use in `guildId` (or a DM): the guild's, then the global
   * ones. Names are unique per type and scope (Discord's docs, application-command-naming).
   */
  commandsVisibleIn(
    guildId: string | undefined,
    type: ApplicationCommandType = ApplicationCommandType.ChatInput,
  ): APIApplicationCommand[] {
    return [
      ...((guildId && this.commands.get(guildId)?.values()) || []),
      ...(this.commands.get("global")?.values() ?? []),
    ].filter((command) => command.type === type);
  }

  requireUser(id: string): APIUser {
    const user = this.users.get(id);
    if (!user) throw new Error(`discordjs-test-kit: unknown user ${id}`);
    return user;
  }
  /** Whether the bot is still in guild `id`: it can leave, or be kicked. */
  botIn(id: string): boolean {
    return !!this.guilds.get(id)?.members.has(this.bot.id);
  }
  requireGuild(id: string): GuildRecord {
    const guild = this.guilds.get(id);
    if (!guild) throw new Error(`discordjs-test-kit: unknown guild ${id}`);
    return guild;
  }
  requireChannel(id: string): APIChannel {
    const channel = this.channels.get(id);
    if (!channel) throw new Error(`discordjs-test-kit: unknown channel ${id}`);
    return channel;
  }
  requireMessage(channelId: string, id: string): APIMessage {
    const message = this.messages.get(channelId)?.find((m) => m.id === id);
    if (!message)
      throw new Error(
        `discordjs-test-kit: unknown message ${id} in ${channelId}`,
      );
    return message;
  }
}

/** Names are unique "per application, per type, within each scope". */
function commandKey(body: { name?: string; type?: number }) {
  return `${body.type ?? 1}:${body.name}`;
}

/**
 * components/reference, anatomy of a component: `id` "must be unique within the message and is
 * generated sequentially if left empty", skipping ids already used, and 0 counts as empty. Numbering
 * depth first from 1, accessories after children, is inferred, not checked.
 */
function withIds<T>(components: T[]): T[] {
  type Node = { id?: number; components?: Node[]; accessory?: Node };
  const copy = structuredClone(components) as Node[];
  const all: Node[] = [];
  const walk = (c: Node) => {
    all.push(c);
    c.components?.forEach(walk);
    if (c.accessory) walk(c.accessory);
  };
  copy.forEach(walk);
  const used = new Set(all.map((c) => c.id).filter(Boolean));
  let next = 1;
  for (const c of all) {
    if (c.id) continue;
    while (used.has(next)) next++;
    c.id = next++;
  }
  return copy as T[];
}
