import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApplicationCommandPermissionType,
  AuditLogEvent,
  ApplicationCommandType,
  ButtonStyle,
  ApplicationCommandOptionType,
  ChannelType,
  ComponentType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIApplicationCommand,
  type APIAttachment,
  type APIApplicationCommandOption,
  type RESTPostAPIApplicationCommandsJSONBody,
  type APIChannel,
  type APIAutoPopulatedSelectMenuComponent,
  type APIButtonComponent,
  type APIComponentInLabel,
  type APIMessage,
  type APIMessageComponent,
  type APIModalInteractionResponseCallbackData,
  type APIUser,
  type RESTPatchAPIApplicationCommandJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPICurrentUserCreateDMChannelJSONBody,
  type RESTPostAPIInteractionCallbackJSONBody,
  type RESTPostAPIInteractionFollowupJSONBody,
  type RESTPutAPIChannelPermissionJSONBody,
} from "discord-api-types/v10";
import { reasonOf, recordAudit, registerAuditLogRoutes } from "./audit.js";
import { moderateMessage, registerAutoModRoutes } from "./automod.js";
import {
  overridesFor,
  registerCommandPermissionRoutes,
} from "./command-permissions.js";
import { registerExpressionRoutes } from "./expressions.js";
import { Gateway } from "./gateway.js";
import { registerGuildRoutes } from "./guilds.js";
import { deleteInvite, registerInviteRoutes } from "./invites.js";
import {
  channelEditError,
  choicesLimitError,
  messageLimitError,
  modalLimitError,
  unknownReplyError,
} from "./limits.js";
import { banUser, kickMember, registerMemberRoutes } from "./members.js";
import { registerMessageRoutes } from "./messages.js";
import {
  ALL_PERMISSIONS,
  computePermissions,
  guildPayload,
  interactionMember,
  Permission,
} from "./payloads.js";
import { pollFrom, registerPollRoutes, removeVote, vote } from "./polls.js";
import {
  RestRouter,
  respond,
  type RestHandler,
  type RestRequest,
} from "./rest.js";
import { runnable, wall } from "./runnable-clock.js";
import { registerScheduledEventRoutes } from "./scheduled-events.js";
import { snowflake } from "./snowflake.js";
import { registerSoundboardRoutes } from "./soundboard.js";
import { endStage, registerStageRoutes, startStage } from "./stages.js";
import { DiscordState, type GuildRecord } from "./state.js";
import { registerTemplateRoutes } from "./templates.js";
import {
  addMentionedToPrivateThread,
  registerThreadRoutes,
} from "./threads.js";
import { announceTyping, registerTypingRoute } from "./typing.js";
import { VoiceServer } from "./voice-server.js";
import {
  botVoiceStateUpdate,
  registerVoiceRoutes,
  setVoiceState,
} from "./voice.js";
import { registerWebhookRoutes } from "./webhooks.js";

export { respond } from "./rest.js";
export type { RestHandler, RestRequest, RestResponse } from "./rest.js";
export { Permission } from "./payloads.js";

// Captured at import, before a test can fake timers: a wait must still time out after a test
// calls vi.useFakeTimers() to move the bot's clock.
const realSetImmediate = globalThis.setImmediate;

/** What a user posts: text, files, and the message it replies to. */
/** A file a member uploads: in a post, or as a command's attachment option. */
export interface FileUpload {
  name: string;
  data: Uint8Array;
  contentType: string;
}

/** `bits` as the permission names a test author knows, e.g. "ManageGuild, BanMembers". */
function permissionNames(bits: bigint) {
  const names = Object.entries(Permission)
    .filter(([, bit]) => bit !== 0n && (bits & bit) === bit)
    .map(([name]) => name);
  return names.length ? names.join(", ") : String(bits);
}

export interface UserMessage {
  content?: string;
  files?: FileUpload[];
  replyTo?: APIMessage;
}

export interface DiscordMockOptions {
  /** Privileged intents enabled "in the developer portal". Default: all three. */
  privilegedIntents?: number;
  /** Discord voids an interaction not acknowledged within 3s. */
  interactionDeadlineMs?: number;
}

type InteractionState = "pending" | "deferred" | "replied" | "modal";

/**
 * How long a run waits on a bot that keeps sending requests without showing its reply. Discord keeps
 * the token for 15 minutes; this bounds a test, not the bot, and is set above the slowest flow the
 * trials hit (TitanBot's /poll, about 5s of spaced reactions).
 */
const MAX_BUSY_WAIT_MS = 10_000;

/**
 * Event-loop turns a quiet spell must last before waitForIdle counts it. The bot runs in this process,
 * and after a stall Node runs due timers before it reads I/O that arrived meanwhile (the timers phase
 * comes before the poll phase), so a quiet timer can fire while the bot's next request or a Dispatch
 * is already waiting to be read. Each turn polls I/O once. With no window at all, the collector test
 * failed 8 runs in 10 without these turns and passed 10 in 10 with three.
 */
const QUIET_CONFIRM_TURNS = 3;

/** A user-triggered interaction, and what the bot did with it. */
export class InteractionRun extends EventEmitter<{ change: [] }> {
  state: InteractionState = "pending";
  /** The callback type the bot answered with (4 = reply, 5 = defer, 7 = update, ...). */
  responseType?: InteractionResponseType;
  /** The message @original points at: the reply, or the clicked message for component updates. */
  originalMessageId?: string;
  ephemeral = false;
  /** The modal the bot opened (callback type 9), while state is "modal". */
  modal?: APIModalInteractionResponseCallbackData;
  /** The choices the bot suggested (callback type 8) to an autocomplete interaction. */
  choices?: { name: string; value: string | number }[];
  readonly followups: APIMessage[] = [];
  /** The bot deleted its reply (DELETE @original). */
  replyDeleted = false;
  // Discord's deadline runs on its clock, which a starved bot process can't slow: wall time.
  readonly createdAt = wall.now();

  constructor(
    private mock: DiscordMock,
    readonly id: string,
    readonly token: string,
    readonly type: InteractionType,
    /** The user who triggered it. */
    readonly userId: string,
    readonly channelId: string,
    readonly guildId?: string,
    readonly sourceMessageId?: string,
  ) {
    super();
  }

  get original(): APIMessage | undefined {
    return this.mock.state.messages
      .get(this.channelId)
      ?.find((m) => m.id === this.originalMessageId);
  }

  /** Resolves when `predicate` holds, re-checked after every callback/edit/followup. */
  waitUntil(
    predicate: (run: this) => boolean,
    timeoutMs = 2_000,
  ): Promise<this> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this)) return;
        cleanup();
        resolve(this);
      };
      // Wall time: this waits out Discord's deadline, which a starved process can't stretch.
      const timer = wall.setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discordjs-test-kit: interaction ${this.id} still "${this.state}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        wall.clearTimeout(timer);
        this.off("change", check);
      };
      this.on("change", check);
      check();
    });
  }

  /**
   * Resolves when `predicate` holds. Once the bot has sent no request and received no dispatch for
   * `quietMs`, rejects ("fail") or resolves all the same ("settle"), rather than after a fixed time.
   * A bot that never goes quiet (a polling loop) fails after `MAX_BUSY_WAIT_MS`, naming its latest
   * requests, instead of holding the test until the runner's own timeout.
   */
  private waitWhileBotActive(
    predicate: (run: this) => boolean,
    whenQuiet: "fail" | "settle" = "fail",
    // "settle" uses the quiet spell idle() uses.
    quietMs = whenQuiet === "fail" ? 2_000 : 100,
  ): Promise<this> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof runnable.setTimeout> | undefined;
      // Wall time: this bounds how long a test runs, whatever the machine's load.
      const busy = wall.setTimeout(() => {
        cleanup();
        const latest = this.mock.rest.log
          .slice(-3)
          .map((r) => `${r.method} ${r.path}`)
          .join(", ");
        reject(
          new Error(
            `discordjs-test-kit: the bot was still working ${MAX_BUSY_WAIT_MS / 1000}s after this interaction without showing a reply. Its latest requests: ${latest || "none"}`,
          ),
        );
      }, MAX_BUSY_WAIT_MS);
      const arm = () => {
        runnable.clearTimeout(timer);
        timer = runnable.setTimeout(() => {
          cleanup();
          if (whenQuiet === "settle") return resolve(this);
          reject(
            new Error(
              `discordjs-test-kit: the bot deferred, then went quiet for ${quietMs / 1000}s without editing in its reply, so the user sees "thinking…" until the token expires`,
            ),
          );
        }, quietMs);
      };
      const check = () => {
        arm();
        if (!predicate(this)) return;
        cleanup();
        resolve(this);
      };
      const cleanup = () => {
        runnable.clearTimeout(timer);
        wall.clearTimeout(busy);
        this.off("change", check);
        this.mock.activity.off("change", arm);
      };
      this.on("change", check);
      this.mock.activity.on("change", arm);
      check();
    });
  }

  /** Waits for the bot's first callback, within the deadline Discord gives it. */
  async acknowledged(): Promise<this> {
    // Discord gives the bot the whole deadline to acknowledge, so a shorter wait would fail a bot
    // that works on Discord. The margin covers the callback request landing just inside it.
    const deadlineMs = this.mock.interactionDeadlineMs;
    // What the Discord app shows for an unanswered autocomplete is from the app, not the docs.
    const appText =
      this.type === InteractionType.ApplicationCommandAutocomplete
        ? "Loading options failed"
        : "The application did not respond";
    return this.waitUntil((r) => r.state !== "pending", deadlineMs + 250).catch(
      () => {
        throw new Error(
          `discordjs-test-kit: the bot didn't answer within ${deadlineMs / 1000}s, so Discord shows the user "${appText}"`,
        );
      },
    );
  }

  /** The choices the bot suggested to this autocomplete interaction. */
  async suggestions(): Promise<{ name: string; value: string | number }[]> {
    await this.acknowledged();
    return this.choices!;
  }

  /** The visible reply: waits through a defer until the bot edits in real content. */
  async reply(timeoutMs?: number): Promise<APIMessage> {
    await this.acknowledged();
    if (this.modal)
      throw new Error(
        `discordjs-test-kit: the bot opened the form ${describeModal(this.modal)} instead of replying. Pass the values to fill it in`,
      );
    const visible = (r: this) =>
      r.replyDeleted ||
      (r.state === "replied" &&
        !!r.original &&
        !((r.original.flags ?? 0) & MessageFlags.Loading));
    // After a defer, Discord keeps the interaction token for 15 minutes, so a fixed wait would fail
    // a bot that works on Discord (one adding ten reactions 500ms apart before it edits). The run
    // waits while the bot keeps talking to Discord, and gives up once it has gone quiet.
    // A deferred update (type 6) shows the user no "thinking…": the message just stays as it is
    // until the bot edits it, by this interaction or any other way. So the click is done once the
    // bot goes quiet, and the member sees the message as it then stands.
    if (this.responseType === InteractionResponseType.DeferredMessageUpdate) {
      await this.waitWhileBotActive(visible, "settle");
      return this.mock.state.requireMessage(
        this.channelId,
        this.sourceMessageId!,
      );
    }
    if (this.state === "deferred" && timeoutMs === undefined)
      await this.waitWhileBotActive(visible);
    else await this.waitUntil(visible, timeoutMs);
    if (this.replyDeleted)
      throw new Error(
        "discordjs-test-kit: the bot deleted its reply, so the user sees no answer",
      );
    return this.original!;
  }
}

export class DiscordMock {
  readonly state = new DiscordState();
  readonly rest = new RestRouter();
  // Real tokens start with the bot's id in base64, and bots such as Needle decode it to find their
  // application id. Shape inferred from tokens in the wild, not documented.
  /** Who owns the application in the developer portal; start's appOwner sets it to a member. */
  developerId = snowflake();
  readonly token = `${Buffer.from(this.state.applicationId).toString("base64").replace(/=+$/, "")}.${snowflake()}.mock`;
  readonly gateway: Gateway;
  /** The fake voice server bots' voice connections talk to; it starts on the first op 4. */
  readonly voiceServer = new VoiceServer((what) => void this.rest.gap(what));
  private server: Server;
  private interactions = new Map<string, InteractionRun>();
  /** REST requests the bot has open. With `activity`, tells when the bot has gone quiet. */
  private inFlight = 0;
  readonly activity = new EventEmitter<{ change: [] }>();
  readonly interactionDeadlineMs: number;
  readonly privilegedIntents: number;
  apiUrl = "";

  /** Keeps the runnable clock advancing while this mock is open, for interaction deadlines. */
  private readonly releaseClock = runnable.hold();

  constructor(options: DiscordMockOptions = {}) {
    this.interactionDeadlineMs = options.interactionDeadlineMs ?? 3_000;
    this.privilegedIntents =
      options.privilegedIntents ??
      GatewayIntentBits.GuildMembers |
        GatewayIntentBits.GuildPresences |
        GatewayIntentBits.MessageContent;
    this.gateway = new Gateway(this.state, {
      token: this.token,
      privilegedIntents: this.privilegedIntents,
      recordGap: (what) => void this.rest.gap(what),
      onDispatch: () => this.activity.emit("change"),
      onVoiceStateUpdate: (d, reply) =>
        void botVoiceStateUpdate(this, d, reply).catch((error: Error) =>
          this.rest.gap(error.message),
        ),
    });
    this.server = createServer((req, res) => {
      this.inFlight++;
      this.activity.emit("change");
      res.on("close", () => {
        this.inFlight--;
        this.activity.emit("change");
      });
      this.rest.handle(req, res, /^\/api(\/v\d+)?/).catch((error) => {
        res.writeHead(500).end(String(error));
      });
    });
    this.server.on("upgrade", (req, socket, head) =>
      this.gateway.upgrade(req, socket, head),
    );
    this.registerRoutes();
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.apiUrl = `http://127.0.0.1:${port}/api`;
    this.state.cdnUrl = `http://127.0.0.1:${port}`;
    this.gateway.url = `ws://127.0.0.1:${port}/gateway`;
    return this;
  }

  /** Spread into `new Client({...})`. Points REST here; the gateway URL follows from GET /gateway/bot. */
  get clientOptions() {
    return { rest: { api: this.apiUrl } };
  }

  async close() {
    this.releaseClock();
    this.voiceServer.close();
    this.gateway.close();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** msw-style override for one route; checked before the stateful handlers. Return undefined to fall through. */
  use(
    method: string,
    path: string,
    handler: RestHandler,
    opts?: { once?: boolean },
  ): () => void {
    return this.rest.use(method, path, handler, opts);
  }

  /** Throws if the bot hit a route the mock doesn't implement: the mock can't vouch for that code path. */
  assertNoUnhandledRequests() {
    if (this.rest.unhandled.length) {
      throw new Error(
        `discordjs-test-kit: unhandled requests:\n  ${this.rest.unhandled.join("\n  ")}`,
      );
    }
  }

  // ---- world building -------------------------------------------------------

  createUser(username: string, opts: { bot?: boolean } = {}) {
    return this.state.createUser({ username, bot: opts.bot });
  }

  // World changes after the bot connected are announced like Discord announces them, so
  // the bot's cache follows: GUILD_CREATE, CHANNEL_CREATE, GUILD_MEMBER_ADD (the last needs
  // GUILD_MEMBERS, docs.discord.food/gateway/gateway-events#guild-member-add).

  createGuild(name: string, opts: { ownerId?: string } = {}) {
    const guild = this.state.createGuild({ name, ownerId: opts.ownerId });
    // A guild built after grantBot added the bot through the same invite link, so the bot gets the
    // same role there (topics/oauth2#bot-authorization-flow: the permissions are granted on join).
    if (this.invitePermissions !== undefined)
      this.createRole(guild, "bot", this.invitePermissions, [this.state.bot]);
    this.gateway.announceGuild(guild);
    return guild;
  }

  /** A category; pass it as `parent` to `createTextChannel`. */
  createCategory(guild: GuildRecord, name: string) {
    return this.announceChannel(
      this.state.createCategoryChannel(guild.id, { name }),
    );
  }

  createTextChannel(
    guild: GuildRecord,
    name: string,
    opts: { parent?: APIChannel } = {},
  ) {
    return this.announceChannel(
      this.state.createTextChannel(guild.id, {
        name,
        parentId: opts.parent?.id,
      }),
    );
  }

  /** An announcement channel: other servers' channels can follow it, and posts get crossposted. */
  createAnnouncementChannel(guild: GuildRecord, name: string) {
    return this.announceChannel(
      this.state.createTextChannel(guild.id, { name, announcement: true }),
    );
  }

  /** A voice channel: members join it with `joinVoice`. */
  createVoiceChannel(guild: GuildRecord, name: string) {
    return this.announceChannel(
      this.state.createVoiceChannel(guild.id, { name }),
    );
  }

  /** A stage channel: a voice channel members can make live with a topic. */
  createStageChannel(guild: GuildRecord, name: string) {
    return this.announceChannel(
      this.state.createVoiceChannel(guild.id, { name, stage: true }),
    );
  }

  /**
   * `user` joins voice channel `channel`, moves to it, or leaves voice with null. They need View
   * Channel and Connect there, as the Discord app does; a full channel (user_limit) isn't modelled.
   */
  joinVoice(guild: GuildRecord, user: APIUser, channel: APIChannel | null) {
    if (channel) {
      const perms = computePermissions(this.state, guild, user.id, channel);
      const needed = Permission.ViewChannel | Permission.Connect;
      if ((perms & needed) !== needed)
        throw new Error(
          `discordjs-test-kit: ${user.username} can't join ${channel.name ?? channel.id} without View Channel and Connect`,
        );
    }
    if (!channel && !this.state.voiceStates.get(guild.id)?.has(user.id))
      throw new Error(`discordjs-test-kit: ${user.username} isn't in voice`);
    setVoiceState(this, guild, user.id, { channelId: channel?.id ?? null });
  }

  /** A forum with these tags: users post in it with `as(user).forumPost()`. */
  createForum(guild: GuildRecord, name: string, tags: string[] = []) {
    return this.announceChannel(
      this.state.createForumChannel(guild.id, { name, tags }),
    );
  }

  /**
   * Archive `thread`, as Discord does to an inactive one. docs.discord.food/topics/threads:
   * archiving sets archive_timestamp and is announced as THREAD_UPDATE with the full channel.
   */
  /**
   * A moderator locks `thread`: it stays open, but only MANAGE_THREADS can unarchive it once
   * archived (topics/threads). Announced as THREAD_UPDATE with the full channel.
   */
  lockThread(thread: APIChannel) {
    const record = this.state.requireChannel(thread.id);
    if (!("thread_metadata" in record) || !record.thread_metadata)
      throw new Error(`discordjs-test-kit: ${thread.id} is not a thread`);
    record.thread_metadata.locked = true;
    this.gateway.dispatch(
      GatewayDispatchEvents.ThreadUpdate,
      record,
      GatewayIntentBits.Guilds,
    );
    return record;
  }

  archiveThread(thread: APIChannel) {
    const record = this.state.requireChannel(thread.id);
    if (!("thread_metadata" in record) || !record.thread_metadata)
      throw new Error(`discordjs-test-kit: ${thread.id} is not a thread`);
    record.thread_metadata.archived = true;
    record.thread_metadata.archive_timestamp = new Date().toISOString();
    this.gateway.dispatch(
      GatewayDispatchEvents.ThreadUpdate,
      record,
      GatewayIntentBits.Guilds,
    );
    return record;
  }

  addMember(guild: GuildRecord, user: APIUser, opts: { nick?: string } = {}) {
    const member = this.state.addMember(guild.id, user.id, opts);
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberAdd,
      { ...member, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );
    return member;
  }

  /**
   * `user` joins through the invite `code`: its uses go up, then GUILD_MEMBER_ADD. An invite that
   * reaches max_uses is deleted, with INVITE_DELETE (inferred, not checked). Expiry by max_age isn't
   * modelled.
   */
  joinWithInvite(
    guild: GuildRecord,
    code: string,
    user: APIUser,
    opts: { nick?: string } = {},
  ) {
    const invite = this.state.invites.get(code);
    if (invite?.guildId !== guild.id)
      throw new Error(
        `discordjs-test-kit: ${guild.name} has no invite ${code}; it may be used up or deleted`,
      );
    invite.uses += 1;
    const member = this.addMember(guild, user, opts);
    if (invite.max_uses !== 0 && invite.uses >= invite.max_uses)
      deleteInvite(this, invite);
    return member;
  }

  /**
   * `user` sets their server nickname in `guild` (null clears it). Discord's docs,
   * gateway-events#guild-member-update: GUILD_MEMBER_UPDATE with the member and guild_id,
   * sent only with GUILD_MEMBERS.
   */
  setNickname(guild: GuildRecord, user: APIUser, nick: string | null) {
    const member = this.state.guilds.get(guild.id)?.members.get(user.id);
    if (!member)
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't a member of ${guild.name}`,
      );
    member.nick = nick;
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberUpdate,
      { ...member, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );
  }

  /**
   * `user` changes their display name (global_name). docs.discord.food/gateway/gateway-events#guild-member-update:
   * GUILD_MEMBER_UPDATE "will also fire when the user object of a guild member changes", so each
   * guild they share with the bot announces it, with GUILD_MEMBERS. discord.js turns the changed
   * user into `userUpdate` (actions/GuildMemberUpdate.js).
   */
  setDisplayName(user: APIUser, name: string | null) {
    user.global_name = name;
    for (const guild of this.state.guilds.values()) {
      const member = guild.members.get(user.id);
      if (member)
        this.gateway.dispatch(
          GatewayDispatchEvents.GuildMemberUpdate,
          { ...member, guild_id: guild.id },
          GatewayIntentBits.GuildMembers,
        );
    }
  }

  /** `guild` is renamed; a bot in it hears GUILD_UPDATE with the guild (gateway-events#guild-update). */
  renameGuild(guild: GuildRecord, name: string) {
    guild.name = name;
    if (this.state.botIn(guild.id))
      this.gateway.dispatch(
        GatewayDispatchEvents.GuildUpdate,
        guildPayload(guild),
        GatewayIntentBits.Guilds,
      );
  }

  /**
   * `user` leaves `guild` (or is kicked or banned). Discord's docs, gateway-events#guild-member-remove:
   * GUILD_MEMBER_REMOVE { guild_id, user }, sent only with GUILD_MEMBERS.
   */
  removeMember(guild: GuildRecord, user: APIUser) {
    // Their voice state goes with them, without an event (inferred, not checked).
    this.state.voiceStates.get(guild.id)?.delete(user.id);
    if (!this.state.guilds.get(guild.id)?.members.delete(user.id))
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't a member of ${guild.name}`,
      );
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberRemove,
      { guild_id: guild.id, user },
      GatewayIntentBits.GuildMembers,
    );
  }

  /**
   * Moderator `executor` kicks or bans `target`, as from the Discord app: they need Kick or Ban
   * Members, and their highest role above the target's unless they own the guild
   * (topics/permissions#permission-hierarchy). The bot sees the member leave, the ban, and the audit
   * log entry naming `executor`.
   */
  moderate(
    guild: GuildRecord,
    executor: APIUser,
    target: APIUser,
    action: "kick" | "ban",
    reason?: string,
  ) {
    const needed =
      action === "kick" ? Permission.KickMembers : Permission.BanMembers;
    const highest = (id: string) =>
      Math.max(
        0,
        ...(guild.members.get(id)?.roles ?? []).map(
          (r) => guild.roles.get(r)?.position ?? 0,
        ),
      );
    const allowed =
      (computePermissions(this.state, guild, executor.id) & needed) !== 0n &&
      target.id !== guild.ownerId &&
      (executor.id === guild.ownerId ||
        highest(executor.id) > highest(target.id));
    if (!allowed)
      throw new Error(
        `discordjs-test-kit: ${executor.username} can't ${action} ${target.username}: it needs ${action === "kick" ? "Kick" : "Ban"} Members and a higher role`,
      );
    if (action === "kick") kickMember(this, guild, target, executor.id, reason);
    else banUser(this, guild, target, executor.id, reason);
  }

  /**
   * The bot leaves `guild`, or its admins kick it. docs.discord.food/resources/guild#leave-guild:
   * "Fires a Guild Delete and a Guild Member Remove Gateway event"; gateway-events#guild-delete:
   * without `unavailable`, "the user was removed from the guild". After that the bot hears
   * nothing from the guild. That its own session gets the member remove too is inferred, not checked.
   */
  removeBot(guild: GuildRecord) {
    const bot = this.state.bot;
    if (!this.state.botIn(guild.id))
      throw new Error(`discordjs-test-kit: the bot isn't in ${guild.name}`);
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberRemove,
      { guild_id: guild.id, user: bot },
      GatewayIntentBits.GuildMembers,
    );
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildDelete,
      { id: guild.id },
      GatewayIntentBits.Guilds,
    );
    guild.members.delete(bot.id);
    this.voiceServer.end(guild.id);
    this.state.voiceStates.get(guild.id)?.delete(bot.id);
  }

  private announceChannel(channel: APIChannel) {
    this.gateway.dispatch(
      GatewayDispatchEvents.ChannelCreate,
      channel,
      GatewayIntentBits.Guilds,
    );
    return channel;
  }

  /** A guild role with these permissions, given to `members`. */
  createRole(
    guild: GuildRecord,
    name: string,
    permissions: bigint,
    members: APIUser[] = [],
  ) {
    const role = this.state.createRole(guild.id, { name, permissions });
    // gateway-events#guild-role-create and #guild-member-update: a bot already connected hears
    // the role (GUILDS) and each member who got it (GUILD_MEMBERS). Without them discord.js keeps
    // the member's old roles, so GuildMember.permissions misses the new ones.
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildRoleCreate,
      { guild_id: guild.id, role },
      GatewayIntentBits.Guilds,
    );
    for (const user of members) this.giveRole(guild, user, role.id);
    return role;
  }

  /** `user` gets the role: a bot already connected hears GUILD_MEMBER_UPDATE (GUILD_MEMBERS). */
  giveRole(guild: GuildRecord, user: APIUser, roleId: string) {
    this.state.assignRole(guild.id, user.id, roleId);
    this.gateway.dispatch(
      GatewayDispatchEvents.GuildMemberUpdate,
      { ...guild.members.get(user.id)!, guild_id: guild.id },
      GatewayIntentBits.GuildMembers,
    );
  }

  /** What the bot's invite link grants, by every grantBot so far: guilds built later get it too. */
  private invitePermissions?: bigint;

  /** What the bot's invite link grants: a "bot" role with `permissions` in every guild, built or to come. */
  grantBot(permissions: bigint) {
    this.invitePermissions = (this.invitePermissions ?? 0n) | permissions;
    for (const guild of this.state.guilds.values())
      this.createRole(guild, "bot", permissions, [this.state.bot]);
  }

  /** Deny (or allow) permissions for a role/member in a channel, as a channel overwrite. */
  setOverwrite(
    channel: APIChannel,
    target: { id: string; type: 0 | 1 },
    perms: { allow?: bigint; deny?: bigint },
  ) {
    if (!("permission_overwrites" in channel))
      throw new Error("discordjs-test-kit: channel has no overwrites");
    const overwrites = (channel.permission_overwrites ??= []);
    const next = {
      id: target.id,
      type: target.type,
      allow: String(perms.allow ?? 0n),
      deny: String(perms.deny ?? 0n),
    };
    this.syncThreadsOnAccess(channel, () => {
      const i = overwrites.findIndex((o) => o.id === target.id);
      if (i === -1) overwrites.push(next);
      else overwrites[i] = next;
      this.gateway.dispatch(
        GatewayDispatchEvents.ChannelUpdate,
        channel,
        GatewayIntentBits.Guilds,
      );
    });
  }

  /**
   * Runs `change`; if the bot can see `channel` only after it, sends THREAD_LIST_SYNC with the
   * channel's active threads the bot can reach and its own thread members (gateway-events
   * #thread-list-sync: "Sent when the current user gains access to a channel"). Only overwrite
   * changes run through here: access gained through a role isn't synced yet.
   */
  private syncThreadsOnAccess(channel: APIChannel, change: () => void) {
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const sees = () => !this.checkBotPerms(channel, 0n);
    const before = sees();
    change();
    if (!guildId || before || !sees()) return;
    const guild = this.state.requireGuild(guildId);
    const bot = this.state.bot.id;
    const manages =
      (computePermissions(this.state, guild, bot, channel) &
        Permission.ManageThreads) !==
      0n;
    const threads = [...this.state.channels.values()].filter(
      (t) =>
        "parent_id" in t &&
        t.parent_id === channel.id &&
        "thread_metadata" in t &&
        !t.thread_metadata?.archived &&
        (t.type !== ChannelType.PrivateThread ||
          manages ||
          this.state.threadMember(t.id, bot)),
    );
    this.gateway.dispatch(
      GatewayDispatchEvents.ThreadListSync,
      {
        guild_id: guildId,
        channel_ids: [channel.id],
        threads,
        members: threads.flatMap(
          (t) => this.state.threadMember(t.id, bot) ?? [],
        ),
      },
      GatewayIntentBits.Guilds,
    );
  }

  // ---- assertions -----------------------------------------------------------

  messagesIn(channel: APIChannel | string): APIMessage[] {
    return (
      this.state.messages.get(
        typeof channel === "string" ? channel : channel.id,
      ) ?? []
    );
  }

  /**
   * The messages the channel routes show the bot. An ephemeral message "is only visible to the user
   * who invoked the interaction" (resources/message#message-object-message-flags), so it isn't in
   * the channel's history; the bot reaches it only through its interaction's webhook. Inferred, not
   * checked against Discord.
   */
  historyIn(channel: APIChannel | string): APIMessage[] {
    return this.messagesIn(channel).filter(
      (m) => !((m.flags ?? 0) & MessageFlags.Ephemeral),
    );
  }

  /**
   * Resolves once the bot has had no REST request open and been sent no Dispatch for `quietMs`.
   * A heuristic: a bot that thinks longer than `quietMs` before its first request looks idle.
   * The spell must then last `QUIET_CONFIRM_TURNS` turns of the event loop.
   */
  waitForIdle(
    opts: { quietMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const { quietMs = 100, timeoutMs = 2_000 } = opts;
    return new Promise((resolve, reject) => {
      let quiet: ReturnType<typeof runnable.setTimeout> | undefined;
      // Bumped by every change, so a confirmation started before it no longer counts.
      let generation = 0;
      const confirm = (turns: number, started: number) => {
        if (started !== generation) return;
        if (turns === 0) {
          cleanup();
          return resolve();
        }
        realSetImmediate(() => confirm(turns - 1, started));
      };
      const restart = () => {
        generation++;
        runnable.clearTimeout(quiet);
        const started = generation;
        quiet =
          this.inFlight === 0
            ? runnable.setTimeout(
                () => confirm(QUIET_CONFIRM_TURNS, started),
                quietMs,
              )
            : undefined;
      };
      const deadline = runnable.setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `discordjs-test-kit: the bot was still busy after ${timeoutMs / 1000}s (${this.inFlight} requests open)`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        generation++;
        runnable.clearTimeout(quiet);
        runnable.clearTimeout(deadline);
        this.activity.off("change", restart);
      };
      this.activity.on("change", restart);
      restart();
    });
  }

  /** The next message created or edited that matches `predicate`. */
  waitForMessage(
    predicate: (m: APIMessage) => boolean,
    opts: { timeoutMs?: number } = {},
  ): Promise<APIMessage> {
    return this.waitForState(
      ["messageCreate", "messageUpdate"],
      predicate,
      opts.timeoutMs,
    );
  }

  /** Resolves with the first thread created from now on that `predicate` accepts. */
  waitForThread(
    predicate: (thread: APIChannel) => boolean,
    opts: { timeoutMs?: number } = {},
  ): Promise<APIChannel> {
    return this.waitForState(["threadCreate"], predicate, opts.timeoutMs);
  }

  /**
   * Resolves with the first value `find` returns, checked now and after every request the bot
   * makes or dispatch it's sent: what the bot creates appears through its own requests.
   */
  waitFor<T>(
    find: () => T | undefined,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const now = find();
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = find();
        if (!found) return;
        cleanup();
        resolve(found);
      };
      const timer = runnable.setTimeout(() => {
        cleanup();
        reject(new Error("discordjs-test-kit: no match"));
      }, opts.timeoutMs ?? 2_000);
      const cleanup = () => {
        runnable.clearTimeout(timer);
        this.activity.off("change", check);
      };
      this.activity.on("change", check);
    });
  }

  private waitForState<T extends APIMessage | APIChannel>(
    events: ("messageCreate" | "messageUpdate" | "threadCreate")[],
    predicate: (value: T) => boolean,
    timeoutMs = 2_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const listener = (value: T) => {
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      };
      const timer = runnable.setTimeout(() => {
        cleanup();
        reject(new Error(`discordjs-test-kit: no match within ${timeoutMs}ms`));
      }, timeoutMs);
      const on = this.state.on.bind(this.state) as (
        event: string,
        fn: (value: T) => void,
      ) => void;
      const off = this.state.off.bind(this.state) as typeof on;
      const cleanup = () => {
        runnable.clearTimeout(timer);
        for (const event of events) off(event, listener);
      };
      for (const event of events) on(event, listener);
    });
  }

  // ---- acting as a user -----------------------------------------------------

  as(user: APIUser) {
    return {
      sendMessage: (channel: APIChannel, message: string | UserMessage) =>
        this.userSendsMessage(
          user,
          channel,
          typeof message === "string" ? { content: message } : message,
        ),
      /** Adds a unicode emoji reaction, dispatched as MESSAGE_REACTION_ADD. */
      /** Deletes their own message, announced as MESSAGE_DELETE. */
      deleteOwnMessage: (message: APIMessage) =>
        this.userDeletesMessage(user, message),
      /** Edits their own message's text, announced as MESSAGE_UPDATE. */
      editOwnMessage: (message: APIMessage, content: string) =>
        this.userEditsMessage(user, message, content),
      react: (message: APIMessage, emoji: string) =>
        this.userReacts(user, message, emoji),
      /**
       * A new forum post: a thread plus its starter message, which shares the thread's id. `tags`
       * are the forum's tag names.
       */
      forumPost: (
        forum: APIChannel,
        post: UserMessage & { title: string; tags?: string[] },
      ) => this.userPostsInForum(user, forum, post),
      slashCommand: (
        channel: APIChannel,
        name: string,
        options: Record<string, unknown> = {},
      ) => this.userRunsCommand(user, channel, name, options),
      /**
       * Types `value` into option `focused` of `/name`, with `input` already filled: an
       * autocomplete interaction. Resolve `.suggestions()` for the bot's choices.
       */
      autocomplete: (
        channel: APIChannel,
        name: string,
        focused: string,
        value: string | number,
        input: Record<string, unknown> = {},
      ) =>
        this.userRunsCommand(
          user,
          channel,
          name,
          { ...input, [focused]: value },
          focused,
        ),
      /** Picks the app `name` from the context menu of a member (or user) or a message in `channel`. */
      contextMenu: (
        channel: APIChannel,
        target: APIUser | APIMessage,
        name: string,
      ) => this.userRunsContextMenu(user, channel, target, name),
      /** Presses the button labelled `label` (or showing that emoji, when it has no label). */
      clickButton: (message: APIMessage, label: string | RegExp) =>
        this.userClicksButton(user, message, label),
      /** Fills the form the bot opened in answer to `run`, by field label, and submits it. */
      submitForm: (run: InteractionRun, values: Record<string, FormValue>) =>
        this.userSubmitsForm(user, run, values),
      /** Picks the option labelled `label` from the string select on `message` that offers it. */
      selectOption: (
        message: APIMessage,
        label: string | RegExp | (string | RegExp)[],
      ) => this.userSelectsOption(user, message, label),
      /**
       * Picks users, roles or channels, by id, in the user, role, mentionable or channel select on
       * `message` that accepts them.
       */
      pickEntities: (message: APIMessage, ids: string[]) =>
        this.userPicksEntities(user, message, ids),
      /** Votes for the answers labelled `labels` in `message`'s poll. */
      vote: (message: APIMessage, labels: string[]) => {
        this.requireVisibleTo(user, message);
        this.requireMembership(
          user,
          this.state.requireChannel(message.channel_id),
        );
        vote(this, user, message, labels);
      },
      /** Takes back their vote in `message`'s poll. */
      removeVote: (message: APIMessage) => removeVote(this, user, message),
      /** Makes stage channel `channel` live with `topic`, as one of its moderators. */
      startStage: (channel: APIChannel, topic: string) =>
        startStage(this, user, channel, topic),
      /** Ends the live stage in `channel`, as one of its moderators. */
      endStage: (channel: APIChannel) => endStage(this, user, channel),
      /** Starts typing in `channel`: TYPING_START. */
      startTyping: (channel: APIChannel) => {
        this.requireMembership(user, channel);
        announceTyping(this, user, channel);
      },
    };
  }

  /** A member deletes their own message, which Discord always allows its author. */
  private userDeletesMessage(user: APIUser, message: APIMessage) {
    const channel = this.state.requireChannel(message.channel_id);
    this.requireMembership(user, channel);
    if (message.author.id !== user.id)
      throw new Error(
        `discordjs-test-kit: ${user.username} can't delete ${shown(message)}: only its author can without Manage Messages`,
      );
    this.deleteMessage(message);
  }

  /**
   * A member edits their own message's text. Discord's docs, topics/threads: no edits in an
   * archived thread. Announced as MESSAGE_UPDATE with edited_timestamp set.
   */
  private userEditsMessage(
    user: APIUser,
    message: APIMessage,
    content: string,
  ) {
    const channel = this.state.requireChannel(message.channel_id);
    this.requireMembership(user, channel);
    if (message.author.id !== user.id)
      throw new Error(
        `discordjs-test-kit: ${user.username} can't edit ${shown(message)}: it's not theirs`,
      );
    if ("thread_metadata" in channel && channel.thread_metadata?.archived)
      throw new Error(
        `discordjs-test-kit: ${user.username} can't edit ${shown(message)}: the thread is archived`,
      );
    const updated = this.state.updateMessage(channel.id, message.id, {
      content,
    });
    this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
    return updated;
  }

  private userSendsMessage(
    user: APIUser,
    channel: APIChannel,
    input: UserMessage,
    id?: string,
  ): APIMessage {
    this.requireMembership(user, channel);
    const content = input.content ?? "";
    const mentions = [...content.matchAll(/<@!?(\d+)>/g)].flatMap(
      ([, userId]) => this.state.users.get(userId!) ?? [],
    );
    let message: APIMessage | undefined;
    const post = () => {
      message = this.state.createMessage({
        channelId: channel.id,
        authorId: user.id,
        content,
        files: input.files,
        replyTo: input.replyTo?.id,
        id,
      });
      for (const mentioned of mentions)
        if (!message.mentions.some((u) => u.id === mentioned.id))
          message.mentions.push(mentioned);
      this.gateway.dispatchMessage("MESSAGE_CREATE", message);
      return message;
    };
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const verdict = guildId
      ? moderateMessage(
          this,
          this.state.requireGuild(guildId),
          user,
          channel,
          content,
          post,
        )
      : (post(), undefined);
    if (verdict)
      throw new Error(
        `discordjs-test-kit: AutoMod blocked ${user.username}'s message${verdict.blocked ? `: "${verdict.blocked}"` : ""}`,
      );
    return message!;
  }

  private userReacts(user: APIUser, message: APIMessage, emoji: string) {
    const channel = this.state.requireChannel(message.channel_id);
    const member = this.requireMembership(user, channel)?.member;
    if (!this.state.addReaction(message.channel_id, message.id, emoji, user.id))
      return;
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    // docs.discord.food/gateway/gateway-events#message-reaction-add; GUILD_MESSAGE_REACTIONS
    // in guilds, DIRECT_MESSAGE_REACTIONS in DMs.
    this.gateway.dispatch(
      GatewayDispatchEvents.MessageReactionAdd,
      {
        user_id: user.id,
        channel_id: channel.id,
        message_id: message.id,
        message_author_id: message.author.id,
        ...(guildId ? { guild_id: guildId } : {}),
        ...(member ? { member } : {}),
        emoji: { id: null, name: emoji },
        type: 0,
        burst: false,
      },
      guildId
        ? GatewayIntentBits.GuildMessageReactions
        : GatewayIntentBits.DirectMessageReactions,
    );
  }

  private userPostsInForum(
    user: APIUser,
    forum: APIChannel,
    post: UserMessage & { title: string; tags?: string[] },
  ) {
    if (forum.type !== ChannelType.GuildForum)
      throw new Error(`discordjs-test-kit: ${forum.id} isn't a forum`);
    this.requireMembership(user, forum);
    const available = forum.available_tags ?? [];
    const appliedTags = (post.tags ?? []).map((name) => {
      const tag = available.find((t) => t.name === name);
      if (!tag)
        throw new Error(
          `discordjs-test-kit: ${forum.name} has no tag "${name}"${available.length ? `; it has ${available.map((t) => t.name).join(", ")}` : ""}`,
        );
      return tag.id;
    });
    const thread = this.state.createThread({
      parentId: forum.id,
      name: post.title,
      ownerId: user.id,
      appliedTags,
    });
    // docs.discord.food/gateway/gateway-events#thread-create: newly_created on creation.
    this.gateway.dispatch(
      GatewayDispatchEvents.ThreadCreate,
      { ...thread, newly_created: true },
      GatewayIntentBits.Guilds,
    );
    const message = this.userSendsMessage(user, thread, post, thread.id);
    return { thread, message };
  }

  /** `name` is the command as a user types it: "ladder", or "admin-config set" for a subcommand. */
  private userRunsCommand(
    user: APIUser,
    channel: APIChannel,
    name: string,
    input: Record<string, unknown>,
    focused?: string,
  ) {
    const [commandName, ...path] = name.split(" ");
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const command = this.state.findCommand(guildId, commandName!);
    if (!command) {
      const registered = this.state
        .commandsVisibleIn(guildId)
        .map((c) => `/${c.name}`);
      // A refused registration (a guild id from a stale config, say) is the likelier cause than
      // none at all, and the bot may have swallowed the error.
      const refused = this.rest.log.find(
        (r) =>
          (r.method === "PUT" || r.method === "POST") &&
          /^\/applications\/[^/]+\/(guilds\/[^/]+\/)?commands$/.test(r.path) &&
          r.status >= 400,
      );
      const none = refused
        ? `The bot registered no commands: its ${refused.method} ${refused.path} was answered ${refused.status}`
        : "The bot registered no commands (it never PUT any to /applications/.../commands)";
      throw new Error(
        `discordjs-test-kit: /${commandName} isn't registered. ${registered.length ? `Registered: ${registered.join(", ")}` : none}`,
      );
    }
    const guild = guildId ? this.state.requireGuild(guildId) : undefined;
    this.requireCommandAllowed(
      user,
      channel,
      guild,
      command,
      `/${commandName}`,
    );
    const { options, leaf } = commandOptions(
      command.options ?? [],
      path,
      input,
      name,
      focused,
    );
    const attachments = this.uploadAttachmentOptions(
      options as CommandOption[],
      channel.id,
    );
    return this.dispatchInteraction(
      user,
      channel,
      focused === undefined
        ? InteractionType.ApplicationCommand
        : InteractionType.ApplicationCommandAutocomplete,
      {
        id: command.id,
        name: command.name,
        type: command.type,
        options,
        resolved: resolvedFor(
          this.state,
          leaf,
          input,
          guild,
          user.id,
          attachments,
        ),
      },
    );
  }

  /**
   * docs.discord.food/interactions/receiving-and-responding: an ATTACHMENT option's value is the
   * attachment's id, and the attachment itself is in `resolved.attachments`. The file is stored so
   * the bot can download it, like a posted one.
   */
  private uploadAttachmentOptions(
    options: CommandOption[],
    channelId: string,
  ): APIAttachment[] {
    return options.flatMap((option) => {
      if (option.options)
        return this.uploadAttachmentOptions(option.options, channelId);
      if (option.type !== ApplicationCommandOptionType.Attachment) return [];
      const attachment = this.state.storeAttachment(
        channelId,
        option.value as FileUpload,
      );
      option.value = attachment.id;
      return [attachment];
    });
  }

  // Discord's docs, interactions/application-commands#permissions: default_member_permissions
  // is what a member needs to use the command; "0" leaves only admins. Discord hides it from
  // everyone else, so they can't run it at all.
  private requireCommandAllowed(
    user: APIUser,
    channel: APIChannel,
    guild: GuildRecord | undefined,
    command: APIApplicationCommand,
    shownName: string,
  ) {
    if (!guild) return;
    // A command-level override for this very member decides, over default_member_permissions
    // (change-log, "Upcoming Application Command Permission Changes"). Role, @everyone, channel
    // and app-level overrides aren't enforced: their precedence is only in a flowchart image.
    const own = overridesFor(this, guild, command.id)?.find(
      (p) =>
        p.type === ApplicationCommandPermissionType.User && p.id === user.id,
    );
    if (own?.permission) return;
    if (own)
      throw new Error(
        `discordjs-test-kit: ${user.username} can't use ${shownName}: an override denies them`,
      );
    if (command.default_member_permissions == null) return;
    const needed = BigInt(command.default_member_permissions);
    const has = computePermissions(this.state, guild, user.id, channel);
    const allowed =
      has === ALL_PERMISSIONS || (needed !== 0n && (has & needed) === needed);
    if (!allowed)
      throw new Error(
        `discordjs-test-kit: ${user.username} can't use ${shownName}: ${needed === 0n ? "it's for administrators only (default member permissions 0)" : `it needs permissions ${permissionNames(needed)}`}`,
      );
  }

  // Discord's docs, interactions/application-commands#user-commands and #message-commands: a
  // context-menu command is picked from the Apps menu of a user or a message. Its name keeps its
  // case and spaces. The interaction carries target_id and `resolved` with the target: the user
  // plus, in a guild, their partial member (no user, deaf or mute), or the full message.
  // discord.js reads resolved.users / resolved.messages without a guard
  // (ContextMenuCommandInteraction.resolveContextMenuOptions), so `resolved` is always sent.
  private userRunsContextMenu(
    user: APIUser,
    channel: APIChannel,
    target: APIUser | APIMessage,
    name: string,
  ) {
    const isMessage = "channel_id" in target;
    const type = isMessage
      ? ApplicationCommandType.Message
      : ApplicationCommandType.User;
    const guildId = "guild_id" in channel ? channel.guild_id : undefined;
    const command = this.state.findCommand(guildId, name, type);
    if (!command) {
      const kind = isMessage ? "message" : "user";
      const registered = this.state
        .commandsVisibleIn(guildId, type)
        .map((c) => `"${c.name}"`);
      throw new Error(
        `discordjs-test-kit: the ${kind} command "${name}" isn't registered. ${registered.length ? `Registered ${kind} commands: ${registered.join(", ")}` : `The bot registered no ${kind} commands (type ${type})`}`,
      );
    }
    const guild = guildId ? this.state.requireGuild(guildId) : undefined;
    this.requireCommandAllowed(user, channel, guild, command, `"${name}"`);
    let resolved: Record<string, unknown>;
    if (isMessage) {
      if (target.channel_id !== channel.id)
        throw new Error(
          `discordjs-test-kit: ${shown(target)} isn't in #${(channel as { name?: string }).name ?? channel.id}`,
        );
      this.requireVisibleTo(user, target);
      resolved = { messages: { [target.id]: target } };
    } else {
      // "A user must have permission to send text messages in the channel they invoke a user
      // command in" (Discord's docs, #user-commands); Discord shows them "Permission Denied".
      if (
        guild &&
        (computePermissions(this.state, guild, user.id, channel) &
          Permission.SendMessages) ===
          0n
      )
        throw new Error(
          `discordjs-test-kit: ${user.username} can't use "${name}" in #${(channel as { name?: string }).name}: they can't send messages there, so Discord answers "Permission Denied"`,
        );
      const member = guild?.members.get(target.id);
      const { user: _, deaf: _d, mute: _m, ...partial } = member ?? {};
      resolved = {
        users: { [target.id]: target },
        ...(member ? { members: { [target.id]: partial } } : {}),
      };
    }
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.ApplicationCommand,
      {
        id: command.id,
        name: command.name,
        type,
        target_id: target.id,
        resolved,
      },
    );
  }

  // Discord's docs, resources/message#message-object-message-flags: an EPHEMERAL message "is only
  // visible to the user who invoked the Interaction", so nobody else can use its components.
  private requireVisibleTo(user: APIUser, message: APIMessage) {
    if (
      (message.flags ?? 0) & MessageFlags.Ephemeral &&
      message.interaction_metadata?.user.id !== user.id
    )
      throw new Error(
        `discordjs-test-kit: ${user.username} can't see ${shown(message)}: it's ephemeral, only ${message.interaction_metadata?.user.username} can`,
      );
  }

  // A user finds a button by what it shows: its label, or its emoji when it has none. A link
  // button has no custom_id (docs.discord.food/resources/components#button-object): it opens a
  // URL in the client and sends the bot nothing.
  private userClicksButton(
    user: APIUser,
    message: APIMessage,
    label: string | RegExp,
  ) {
    this.requireVisibleTo(user, message);
    const buttons = componentsIn(message).filter(
      (c) => c.type === ComponentType.Button,
    );
    const found = buttons.filter((b) => matches(buttonLabel(b), label));
    if (found.length !== 1)
      throw new Error(
        found.length
          ? `discordjs-test-kit: ${quote(label)} matches ${found.length} buttons on ${shown(message)}: ${found.map(buttonLabel).join(", ")}`
          : `discordjs-test-kit: ${user.username} can't click ${quote(label)}: ${shown(message)} has ${buttons.length ? `buttons ${buttons.map(buttonLabel).join(", ")}` : "no buttons"}`,
      );
    const button = found[0]!;
    if (button.disabled)
      throw new Error(
        `discordjs-test-kit: button ${buttonLabel(button)} on ${shown(message)} is disabled`,
      );
    // docs.discord.food/resources/components#button-object: a link button (style 5) opens its
    // URL and a premium button (style 6) opens a purchase; neither sends the bot an interaction.
    if (!("custom_id" in button))
      throw new Error(
        `discordjs-test-kit: button ${buttonLabel(button)} ${button.style === 6 ? "opens a purchase" : "opens a URL"}; the bot gets no interaction`,
      );
    const channel = this.state.requireChannel(message.channel_id);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      { custom_id: button.custom_id, component_type: ComponentType.Button },
      message,
    );
  }

  // docs.discord.food/resources/components: a string select offers `options`; the user picks
  // between min_values and max_values (default 1) of them. Picking one option by its label is
  // what a user does; multi-select is not modelled yet.
  // docs.discord.food/interactions/receiving-and-responding: the bot receives custom_id,
  // component_type and `values` (the picked options' values).
  private userSelectsOption(
    user: APIUser,
    message: APIMessage,
    labels: string | RegExp | (string | RegExp)[],
  ) {
    this.requireVisibleTo(user, message);
    const offered = componentsIn(message)
      .filter((c) => c.type === ComponentType.StringSelect)
      .flatMap((select) =>
        (select.options ?? []).map((option) => ({ select, option })),
      );
    const picks = (Array.isArray(labels) ? labels : [labels]).map((label) => {
      const found = offered.filter(({ option }) =>
        matches(option.label, label),
      );
      if (found.length !== 1)
        throw new Error(
          found.length
            ? `discordjs-test-kit: ${quote(label)} matches ${found.length} options in ${shown(message)}: ${found.map(({ option }) => option.label).join(", ")}`
            : `discordjs-test-kit: ${user.username} can't pick ${quote(label)}: ${shown(message)} ${offered.length ? `offers ${offered.map(({ option }) => option.label).join(", ")}` : "has no select menu"}`,
        );
      return found[0]!;
    });
    const select = picks[0]!.select;
    if (picks.some((p) => p.select !== select))
      throw new Error(
        `discordjs-test-kit: the options picked on ${shown(message)} are in different select menus`,
      );
    if (select.disabled)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} is disabled`,
      );
    // components/reference#string-select: min_values defaults to 1, max_values to 1 (max 25). The
    // Discord app won't send fewer or more.
    const min = select.min_values ?? 1;
    const max = select.max_values ?? 1;
    if (picks.length < min || picks.length > max)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} takes ${min === max ? min : `${min} to ${max}`} picks, not ${picks.length}`,
      );
    const channel = this.state.requireChannel(message.channel_id);
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      {
        custom_id: select.custom_id,
        component_type: ComponentType.StringSelect,
        values: picks.map(({ option }) => option.value),
      },
      message,
    );
  }

  // components/reference#user-select (and role, mentionable, channel select): the user picks
  // members, roles or channels; the bot receives their ids as `values` and the entities in
  // `resolved` (interactions/receiving-and-responding#interaction-object-resolved-data-structure).
  // A user select offers the guild's members, a channel select the channels the user can view
  // (both inferred, not checked: the Discord app's picker isn't documented).
  private userPicksEntities(user: APIUser, message: APIMessage, ids: string[]) {
    this.requireVisibleTo(user, message);
    const channel = this.state.requireChannel(message.channel_id);
    const guild =
      "guild_id" in channel && channel.guild_id
        ? this.state.requireGuild(channel.guild_id)
        : undefined;
    const picked = {
      users: [] as string[],
      roles: [] as string[],
      channels: [] as string[],
    };
    for (const id of ids) {
      if (guild?.roles.has(id)) picked.roles.push(id);
      else if (this.state.users.has(id)) {
        if (guild && !guild.members.has(id))
          throw new Error(
            `discordjs-test-kit: ${this.state.requireUser(id).username} isn't in ${guild.name}, so no select offers them`,
          );
        picked.users.push(id);
      } else if (this.state.channels.has(id)) {
        const target = this.state.requireChannel(id);
        if (
          guild &&
          !(
            computePermissions(this.state, guild, user.id, target) &
            Permission.ViewChannel
          )
        )
          throw new Error(
            `discordjs-test-kit: ${user.username} can't see ${"name" in target ? target.name : id}, so no select offers it`,
          );
        picked.channels.push(id);
      } else
        throw new Error(`discordjs-test-kit: no user, role or channel ${id}`);
    }
    // Which select accepts every pick: users and roles go in a mentionable select too.
    const accepts = (select: APIAutoPopulatedSelectMenuComponent) => {
      switch (select.type) {
        case ComponentType.UserSelect:
          return !picked.roles.length && !picked.channels.length;
        case ComponentType.RoleSelect:
          return !picked.users.length && !picked.channels.length;
        case ComponentType.MentionableSelect:
          return !picked.channels.length;
        case ComponentType.ChannelSelect:
          return (
            !picked.users.length &&
            !picked.roles.length &&
            picked.channels.every(
              (id) =>
                !select.channel_types?.length ||
                select.channel_types.includes(
                  this.state.requireChannel(id).type,
                ),
            )
          );
        default:
          return false;
      }
    };
    const selects = componentsIn(message).filter(
      (c) =>
        c.type === ComponentType.UserSelect ||
        c.type === ComponentType.RoleSelect ||
        c.type === ComponentType.MentionableSelect ||
        c.type === ComponentType.ChannelSelect,
    );
    const found = selects.filter(accepts);
    if (found.length !== 1)
      throw new Error(
        found.length
          ? `discordjs-test-kit: ${found.length} select menus on ${shown(message)} accept those picks`
          : `discordjs-test-kit: ${user.username} can't pick those: ${shown(message)} ${selects.length ? "has no select menu that offers them" : "has no user, role, mentionable or channel select"}`,
      );
    const select = found[0]!;
    if (select.disabled)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} is disabled`,
      );
    // components/reference#user-select: min_values and max_values default to 1.
    const min = select.min_values ?? 1;
    const max = select.max_values ?? 1;
    if (ids.length < min || ids.length > max)
      throw new Error(
        `discordjs-test-kit: the select menu on ${shown(message)} takes ${min === max ? min : `${min} to ${max}`} picks, not ${ids.length}`,
      );
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.MessageComponent,
      {
        custom_id: select.custom_id,
        component_type: select.type,
        values: ids,
        resolved: resolvedData(this.state, guild, user.id, picked),
      },
      message,
    );
  }

  // docs.discord.food/interactions/receiving-and-responding#modal-submit-component-data-structure:
  // the bot gets MODAL_SUBMIT (type 5) with the modal's custom_id and its components echoed back,
  // each carrying what the member entered; `message` only when a component opened the modal.
  // The per-type shapes (text input and radio group `value`, checkbox `value: boolean`, selects,
  // checkbox groups and file uploads `values`) and `resolved` for picked entities and files are
  // discord-api-types' ModalSubmitComponent, as discord.js's ModalSubmitFields reads them.
  private userSubmitsForm(
    user: APIUser,
    run: InteractionRun,
    values: Record<string, FormValue>,
  ) {
    const modal = run.modal;
    if (!modal || run.userId !== user.id)
      throw new Error(
        `discordjs-test-kit: the bot didn't open a form for ${user.username}`,
      );
    const fields = modalFields(modal);
    const unknown = Object.keys(values).filter(
      (label) => !fields.some((f) => f.label === label),
    );
    if (unknown.length)
      throw new Error(
        `discordjs-test-kit: the form ${describeModal(modal)} has no field ${unknown.map((l) => `"${l}"`).join(", ")}`,
      );
    const channel = this.state.requireChannel(run.channelId);
    const guild =
      "guild_id" in channel && channel.guild_id
        ? this.state.requireGuild(channel.guild_id)
        : undefined;
    const picked = {
      users: [] as string[],
      roles: [] as string[],
      channels: [] as string[],
    };
    const uploaded: APIAttachment[] = [];
    const answers = new Map<object, Record<string, unknown>>();
    for (const { label, input } of fields)
      answers.set(
        input,
        submittedField(
          input,
          values[label],
          `field "${label}" of ${describeModal(modal)}`,
          {
            pick: (ids, type) => {
              const isRole = (id: string) => guild?.roles.has(id) ?? false;
              if (type === ComponentType.ChannelSelect)
                picked.channels.push(...ids);
              else if (type === ComponentType.RoleSelect)
                picked.roles.push(...ids);
              else if (type === ComponentType.UserSelect)
                picked.users.push(...ids);
              else {
                picked.roles.push(...ids.filter(isRole));
                picked.users.push(...ids.filter((id) => !isRole(id)));
              }
            },
            upload: (files) =>
              files.map((file) => {
                const attachment = this.state.storeAttachment(
                  run.channelId,
                  file,
                );
                uploaded.push(attachment);
                return attachment.id;
              }),
          },
        ),
      );
    // Discord numbers components it wasn't given an id for; the order here is inferred, not checked.
    let nextId = 1;
    const id = (c: { id?: number }) => c.id ?? nextId++;
    const input = (c: APIComponentInLabel) => ({
      type: c.type,
      id: id(c),
      custom_id: c.custom_id,
      ...answers.get(c),
    });
    const submitted = modal.components.map((top) => {
      if (top.type === ComponentType.ActionRow)
        return {
          type: top.type,
          id: id(top),
          components: top.components.map(input),
        };
      if (top.type === ComponentType.Label)
        return { type: top.type, id: id(top), component: input(top.component) };
      return { type: top.type, id: id(top) };
    });
    const resolved = resolvedData(this.state, guild, user.id, picked);
    run.modal = undefined;
    const source = run.sourceMessageId
      ? this.state.requireMessage(run.channelId, run.sourceMessageId)
      : undefined;
    return this.dispatchInteraction(
      user,
      channel,
      InteractionType.ModalSubmit,
      {
        custom_id: modal.custom_id,
        components: submitted,
        ...(resolved || uploaded.length
          ? {
              resolved: {
                ...resolved,
                ...(uploaded.length
                  ? {
                      attachments: Object.fromEntries(
                        uploaded.map((a) => [a.id, a]),
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      },
      source,
    );
  }

  /**
   * `channel`'s server and `user`'s member record in it, or undefined in a DM. A non-member can't see a
   * server's channels at all (Discord answers 50001 Missing Access), so the World refuses the
   * action rather than let a test act as someone the bot would never hear from.
   */
  private requireMembership(user: APIUser, channel: APIChannel) {
    if (!("guild_id" in channel) || !channel.guild_id) return undefined;
    const guild = this.state.requireGuild(channel.guild_id);
    const member = guild.members.get(user.id);
    if (!member)
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't a member of ${guild.name}`,
      );
    // topics/threads: a private thread is visible only to its members and to MANAGE_THREADS.
    if (
      channel.type === ChannelType.PrivateThread &&
      !this.state.threadMember(channel.id, user.id) &&
      !(
        computePermissions(this.state, guild, user.id, channel) &
        Permission.ManageThreads
      )
    )
      throw new Error(
        `discordjs-test-kit: ${user.username} isn't in the private thread "${(channel as { name?: string }).name}"; the bot adds them with thread.members.add`,
      );
    return { guild, member };
  }

  private dispatchInteraction(
    user: APIUser,
    channel: APIChannel,
    type: InteractionType,
    data: unknown,
    message?: APIMessage,
  ) {
    const { guild, member } = this.requireMembership(user, channel) ?? {};
    if (guild && !this.state.botIn(guild.id))
      throw new Error(
        `discordjs-test-kit: the bot isn't in ${guild.name} any more (it left or was kicked), so ${user.username} can't use its commands there`,
      );
    const run = new InteractionRun(
      this,
      snowflake(),
      `itoken-${snowflake()}`,
      type,
      user.id,
      channel.id,
      guild?.id,
      message?.id,
    );
    if (message) run.originalMessageId = message.id;
    this.interactions.set(run.id, run);
    const botPerms = guild
      ? computePermissions(this.state, guild, this.state.bot.id, channel)
      : 0n;
    this.gateway.dispatch(GatewayDispatchEvents.InteractionCreate, {
      id: run.id,
      application_id: this.state.applicationId,
      type,
      data,
      token: run.token,
      version: 1,
      channel,
      channel_id: channel.id,
      ...(guild
        ? {
            guild_id: guild.id,
            guild: { id: guild.id, locale: "en-US", features: [] },
            member: interactionMember(this.state, guild, member!, channel),
          }
        : { user }),
      ...(message ? { message } : {}),
      app_permissions: String(botPerms),
      locale: "en-US",
      guild_locale: "en-US",
      entitlements: [],
      authorizing_integration_owners: { 0: guild?.id ?? "0" },
      context: guild ? 0 : 1,
      attachment_size_limit: 10 * 1024 * 1024,
    });
    return run;
  }

  // ---- REST: the bot's side ---------------------------------------------------

  private registerRoutes() {
    const { rest, state } = this;
    const authed =
      (handler: RestHandler): RestHandler =>
      (req) => {
        if (req.headers.authorization !== `Bot ${this.token}`)
          return respond.unauthorized();
        // A guild the bot left or was kicked from. 50001 is what a channel there answers
        // (no VIEW_CHANNEL); that a guild route answers it too is inferred, not checked.
        const guildId = req.params.guildId;
        if (guildId && state.guilds.has(guildId) && !state.botIn(guildId))
          return respond.missingAccess();
        return handler(req);
      };
    registerMessageRoutes(this, authed);
    registerCommandPermissionRoutes(this, authed);
    registerWebhookRoutes(this, authed);
    registerAuditLogRoutes(this, authed);

    // gateway/using-gateway#get-gateway: unauthenticated, `{ url }` only.
    rest.route("GET", "/gateway", () =>
      respond.json({ url: this.gateway.url }),
    );
    rest.route(
      "GET",
      "/gateway/bot",
      authed(() =>
        respond.json({
          url: this.gateway.url,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 1000,
            reset_after: 86_400_000,
            max_concurrency: 1,
          },
        }),
      ),
    );
    rest.route(
      "GET",
      "/users/@me",
      authed(() => respond.json(state.bot)),
    );
    // docs.discord.food/resources/user#modify-current-user: returns the user and fires USER_UPDATE
    // (gateway-events#user-update, no intent). A bot changes `username` (2-32 characters) and
    // `avatar` (image data or null); the other fields are for user accounts or premium, so they're
    // a Gap. The `token` field the docs add is a user account's new token: a bot's doesn't change,
    // so it's left out (inferred). A bad username or image answering 50035 is inferred.
    // `image/jpg` is accepted: discord.js's resolveBase64 labels every file it reads that way.
    rest.route(
      "PATCH",
      "/users/@me",
      authed((req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const other = Object.keys(body).find(
          (key) => key !== "username" && key !== "avatar",
        );
        if (other) return rest.gap(`PATCH the bot user's ${other}`);
        if (
          "username" in body &&
          (typeof body.username !== "string" ||
            body.username.length < 2 ||
            body.username.length > 32)
        )
          return respond.invalidFormBody();
        if (
          "avatar" in body &&
          body.avatar !== null &&
          !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(String(body.avatar))
        )
          return respond.invalidFormBody();
        if ("username" in body) state.bot.username = body.username as string;
        if ("avatar" in body)
          state.bot.avatar =
            body.avatar === null ? null : randomBytes(16).toString("hex");
        this.gateway.dispatch(GatewayDispatchEvents.UserUpdate, state.bot);
        return respond.json(state.bot);
      }),
    );
    // docs.discord.food/resources/application, Get Current Application: "Returns the application
    // object associated with the requestor." Fields per the Application Structure table; the owner
    // and verify_key values are placeholders (the World has no developer account).
    const application = () => ({
      id: state.applicationId,
      name: state.bot.username,
      icon: null,
      description: state.applicationDescription,
      bot_public: true,
      bot_require_code_grant: false,
      owner: {
        id: this.developerId,
        username: state.users.get(this.developerId)?.username ?? "developer",
        discriminator: "0",
        avatar: null,
      },
      team: null,
      flags: 0,
      verify_key: "0".repeat(64),
    });
    rest.route(
      "GET",
      "/applications/@me",
      authed(() => respond.json(application())),
    );
    // docs.discord.food/resources/application, Modify Current Application: every param is
    // optional and it "Returns the updated application object on success". Only the description
    // is modelled; neither docs.discord.food nor Discord's docs give it a length limit, so none is
    // enforced (inferred, not checked).
    rest.route(
      "PATCH",
      "/applications/@me",
      authed((req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const other = Object.keys(body).find(
          (key) => key !== "description" && body[key] !== undefined,
        );
        if (other) return rest.gap(`modify current application ${other}`);
        if ("description" in body) {
          if (body.description !== null && typeof body.description !== "string")
            return respond.invalidFormBody();
          state.applicationDescription = body.description ?? "";
        }
        return respond.json(application());
      }),
    );

    // Guild commands for a guild the bot isn't in: Discord refuses them, but how isn't documented,
    // so it's a Gap rather than a 200 that stores commands no member can see.
    const outsideGuild = (params: Record<string, string>) =>
      params.guildId && !state.botIn(params.guildId)
        ? rest.gap("guild commands for a guild the bot isn't in")
        : undefined;
    const putCommands = (
      scope: (p: Record<string, string>) => string,
    ): RestHandler =>
      authed((req) => {
        if (req.params.appId !== state.applicationId)
          return respond.error(403, 50001, "Missing Access");
        const outside = outsideGuild(req.params);
        if (outside) return outside;
        // docs.discord.food/interactions/application-commands: a CHAT_INPUT command needs a description.
        const bodies = req.body as RESTPostAPIApplicationCommandsJSONBody[];
        if (
          bodies.some(
            (c) =>
              (c.type ?? 1) === 1 && !("description" in c && c.description),
          )
        )
          return respond.invalidFormBody();
        return respond.json(state.setCommands(scope(req.params), bodies));
      });
    rest.route(
      "PUT",
      "/applications/:appId/commands",
      putCommands(() => "global"),
    );
    rest.route(
      "PUT",
      "/applications/:appId/guilds/:guildId/commands",
      putCommands((p) => p.guildId!),
    );
    const scopeOf = (p: Record<string, string>) => p.guildId ?? "global";
    for (const base of [
      "/applications/:appId/commands",
      "/applications/:appId/guilds/:guildId/commands",
    ]) {
      rest.route(
        "GET",
        base,
        authed(
          (req) =>
            outsideGuild(req.params) ??
            respond.json([
              ...(state.commands.get(scopeOf(req.params))?.values() ?? []),
            ]),
        ),
      );
      // interactions/application-commands#create-global-application-command: an upsert, 201 for
      // a new name, 200 for one that exists.
      rest.route(
        "POST",
        base,
        authed((req) => {
          if (req.params.appId !== state.applicationId)
            return respond.error(403, 50001, "Missing Access");
          const outside = outsideGuild(req.params);
          if (outside) return outside;
          const body = req.body as RESTPostAPIApplicationCommandsJSONBody;
          if (
            (body.type ?? 1) === 1 &&
            !("description" in body && body.description)
          )
            return respond.invalidFormBody();
          const { command, created } = state.upsertCommand(
            scopeOf(req.params),
            body,
          );
          return respond.json(command, created ? 201 : 200);
        }),
      );
      rest.route(
        "GET",
        `${base}/:commandId`,
        authed((req) => {
          const outside = outsideGuild(req.params);
          if (outside) return outside;
          const command = state.commandById(
            scopeOf(req.params),
            req.params.commandId!,
          );
          return command ? respond.json(command) : unknownCommand();
        }),
      );
      // #edit-global-application-command: 200 with the command. Renaming onto a name the scope
      // already uses has an error code (40041) but no documented trigger: a Gap until checked.
      rest.route(
        "PATCH",
        `${base}/:commandId`,
        authed((req) => {
          const outside = outsideGuild(req.params);
          if (outside) return outside;
          const scope = scopeOf(req.params);
          const previous = state.commandById(scope, req.params.commandId!);
          if (!previous) return unknownCommand();
          const body = req.body as RESTPatchAPIApplicationCommandJSONBody;
          const patch = {
            type: previous.type,
            name: previous.name,
            ...body,
          };
          if (state.commandNamed(scope, patch, previous.id))
            return rest.gap("rename a command onto an existing name");
          return respond.json(state.editCommand(scope, previous.id, body)!);
        }),
      );
      // #delete-global-application-command: "Returns 204 No Content".
      rest.route(
        "DELETE",
        `${base}/:commandId`,
        authed(
          (req) =>
            outsideGuild(req.params) ??
            (state.deleteCommand(scopeOf(req.params), req.params.commandId!)
              ? respond.noContent()
              : unknownCommand()),
        ),
      );
    }

    rest.route(
      "GET",
      "/channels/:channelId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        // docs.discord.food/resources/channel: requires VIEW_CHANNEL. 50001 is inferred, not checked.
        return this.checkBotPerms(channel, 0n) ?? respond.json(channel);
      }),
    );

    // Get Guild Channels (resources/guild): no threads, and "omits any channel your bot doesn't
    // have permission to view". "Channel categories are viewable if any of their child channels
    // are viewable"; one the bot can view itself is listed too (inferred, not checked).
    rest.route(
      "GET",
      "/guilds/:guildId/channels",
      authed((req) => {
        const guild = state.guilds.get(req.params.guildId!);
        if (!guild) return respond.error(404, 10004, "Unknown Guild");
        const channels = guild.channelIds.map((id) => state.channels.get(id)!);
        const viewable = new Set(
          channels
            .filter((c) => !this.checkBotPerms(c, 0n))
            .flatMap((c) => ("parent_id" in c ? [c.id, c.parent_id] : [c.id])),
        );
        return respond.json(channels.filter((c) => viewable.has(c.id)));
      }),
    );

    // docs.discord.food/resources/channel#modify-guild-channel-positions: an array of { id,
    // position?, lock_permissions?, parent_id? }, MANAGE_CHANNELS, 204, CHANNEL_UPDATE per channel.
    // The sorting conventions "are not required or enforced by the API", so positions are stored
    // as sent. MANAGE_CHANNELS is checked on each channel, and an unknown or foreign channel is
    // 10003; both are inferred, not checked.
    rest.route(
      "PATCH",
      "/guilds/:guildId/channels",
      authed((req) => {
        const guild = state.guilds.get(req.params.guildId!);
        if (!guild) return respond.error(404, 10004, "Unknown Guild");
        if (!Array.isArray(req.body)) return respond.invalidFormBody();
        const entries = req.body as {
          id?: string;
          position?: number | null;
          lock_permissions?: boolean | null;
          parent_id?: string | null;
        }[];
        const changes = [];
        for (const entry of entries) {
          const channel = entry.id ? state.channels.get(entry.id) : undefined;
          if (
            !channel ||
            !("guild_id" in channel) ||
            channel.guild_id !== guild.id
          )
            return respond.unknownChannel();
          const denied = this.checkBotPerms(
            channel,
            Permission.ManageChannels |
              (entry.lock_permissions ? Permission.ManageRoles : 0n),
          );
          if (denied) return denied;
          const parent =
            typeof entry.parent_id === "string"
              ? state.channels.get(entry.parent_id)
              : undefined;
          if (
            typeof entry.parent_id === "string" &&
            (parent?.type !== ChannelType.GuildCategory ||
              !("guild_id" in parent) ||
              parent.guild_id !== guild.id)
          )
            return respond.invalidFormBody();
          changes.push({ channel, entry, parent });
        }
        for (const { channel, entry, parent } of changes) {
          const target = channel as {
            position?: number;
            parent_id?: string | null;
          };
          if (entry.position != null) target.position = entry.position;
          if ("parent_id" in entry) target.parent_id = parent?.id ?? null;
          if (
            entry.lock_permissions &&
            parent &&
            "permission_overwrites" in parent
          )
            Object.assign(channel, {
              permission_overwrites: structuredClone(
                parent.permission_overwrites ?? [],
              ),
            });
          this.gateway.dispatch(
            GatewayDispatchEvents.ChannelUpdate,
            channel,
            GatewayIntentBits.Guilds,
          );
        }
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/channel#create-guild-channel: MANAGE_CHANNELS; "only permissions
    // you have in the guild can be allowed/denied" in permission_overwrites, and MANAGE_ROLES there
    // "is only possible for guild administrators". Fires CHANNEL_CREATE. Text, voice, category,
    // stage and forum channels; another type, or a param not listed here, is a Gap.
    rest.route(
      "POST",
      "/guilds/:guildId/channels",
      authed((req) => {
        const guild = state.guilds.get(req.params.guildId!);
        if (!guild) return respond.error(404, 10004, "Unknown Guild");
        const body = (req.body ?? {}) as Record<string, unknown>;
        const type = (body.type ?? ChannelType.GuildText) as ChannelType;
        const creatable = [
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildCategory,
          ChannelType.GuildStageVoice,
          ChannelType.GuildForum,
        ];
        if (!creatable.includes(type))
          return rest.gap(`create channel of type ${type}`);
        const known = [
          "name",
          "type",
          "topic",
          "nsfw",
          "rate_limit_per_user",
          "user_limit",
          "bitrate",
          "parent_id",
          "permission_overwrites",
        ];
        const other = Object.keys(body).find(
          (key) => !known.includes(key) && body[key] != null,
        );
        if (other) return rest.gap(`create channel with ${other}`);
        const perms = computePermissions(state, guild, state.bot.id);
        if (!(perms & Permission.ManageChannels))
          return respond.missingPermissions();
        if (typeof body.name !== "string") return respond.invalidFormBody();
        // Discord trims the name: the contract run's "  contract-spaced  " came back without spaces.
        body.name = body.name.trim();
        if (typeof body.name === "string") body.name = body.name.trim();
        const invalid = channelEditError(body);
        if (invalid) return invalid;
        const parent =
          typeof body.parent_id === "string"
            ? state.channels.get(body.parent_id)
            : undefined;
        if (
          body.parent_id != null &&
          (type === ChannelType.GuildCategory ||
            parent?.type !== ChannelType.GuildCategory ||
            !("guild_id" in parent) ||
            parent.guild_id !== guild.id)
        )
          return respond.invalidFormBody();
        const overwrites = (body.permission_overwrites ?? []) as {
          id: string;
          type: 0 | 1;
          allow?: string;
          deny?: string;
        }[];
        const admin = (perms & Permission.Administrator) !== 0n;
        const refused = overwrites.some((o) => {
          const bits = BigInt(o.allow ?? 0) | BigInt(o.deny ?? 0);
          return (
            (bits & ~perms) !== 0n ||
            ((bits & Permission.ManageRoles) !== 0n && !admin)
          );
        });
        if (refused) return respond.missingPermissions();
        const name = body.name as string;
        const channel =
          type === ChannelType.GuildText
            ? state.createTextChannel(guild.id, { name })
            : type === ChannelType.GuildCategory
              ? state.createCategoryChannel(guild.id, { name })
              : type === ChannelType.GuildForum
                ? state.createForumChannel(guild.id, { name })
                : state.createVoiceChannel(guild.id, {
                    name,
                    stage: type === ChannelType.GuildStageVoice,
                  });
        Object.assign(channel, {
          ...pick(body, [
            "topic",
            "nsfw",
            "rate_limit_per_user",
            "user_limit",
            "bitrate",
          ]),
          ...(parent ? { parent_id: parent.id } : {}),
          permission_overwrites: overwrites.map((o) => ({
            id: o.id,
            type: o.type,
            allow: o.allow ?? "0",
            deny: o.deny ?? "0",
          })),
        });
        this.gateway.dispatch(
          GatewayDispatchEvents.ChannelCreate,
          channel,
          GatewayIntentBits.Guilds,
        );
        // 201 is inferred, not checked; the contract test settles it.
        return respond.json(channel, 201);
      }),
    );

    rest.route(
      "DELETE",
      "/channels/:channelId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        // resources/channel#delete-channel: MANAGE_CHANNELS, "or MANAGE_THREADS if the channel is a
        // thread". Contract runs 11 and 12: Discord let the bot delete a thread it started with
        // neither in the channel (Manage Channels denied there, held guild-wide). The mock reads
        // that as the creator may delete; it can't rule out that guild-wide Manage Channels is what
        // counts, since the bot can't drop its own role's permission. Others need Manage Threads
        // or Manage Channels in the channel (inferred). Fires Thread Delete, "just the id,
        // guild_id, parent_id, and type" (gateway-events#thread-delete).
        const thread = "thread_metadata" in channel ? channel : undefined;
        const denied = !thread
          ? this.checkBotPerms(channel, Permission.ManageChannels)
          : thread.owner_id === state.bot.id
            ? this.checkBotPerms(channel, 0n)
            : this.checkBotPerms(channel, Permission.ManageThreads) &&
              this.checkBotPerms(channel, Permission.ManageChannels);
        if (denied) return denied;
        state.deleteChannel(channel.id);
        if (thread)
          this.gateway.dispatch(
            GatewayDispatchEvents.ThreadDelete,
            {
              id: thread.id,
              guild_id: thread.guild_id,
              parent_id: thread.parent_id,
              type: thread.type,
            },
            GatewayIntentBits.Guilds,
          );
        else
          this.gateway.dispatch(
            GatewayDispatchEvents.ChannelDelete,
            channel,
            GatewayIntentBits.Guilds,
          );
        return respond.json(channel);
      }),
    );

    // resources/channel#modify-channel-json-params-guild-channel: MANAGE_CHANNELS; overwrites also
    // need MANAGE_ROLES, and "only permissions your bot has in the guild or parent channel can be
    // allowed/denied (unless your bot has a MANAGE_ROLES overwrite in the channel)". Fires
    // CHANNEL_UPDATE. Threads have their own Route; fields not listed here are a Gap. Slowmode is
    // stored, but members' posts don't wait for it yet.
    rest.route(
      "PATCH",
      "/channels/:channelId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        if ("thread_metadata" in channel || !("guild_id" in channel))
          return undefined;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const known = [
          "name",
          "topic",
          "nsfw",
          "rate_limit_per_user",
          "parent_id",
          "permission_overwrites",
          "lock_permissions",
        ];
        const other = Object.keys(body).find((key) => !known.includes(key));
        if (other) return rest.gap(`PATCH channel ${other}`);
        const overwrites = body.permission_overwrites as
          | { id: string; type: 0 | 1; allow?: string; deny?: string }[]
          | undefined;
        const denied = this.checkBotPerms(
          channel,
          Permission.ManageChannels |
            (overwrites || body.lock_permissions ? Permission.ManageRoles : 0n),
        );
        if (denied) return denied;
        const invalid = channelEditError(body);
        if (invalid) return invalid;
        const guild = state.requireGuild(channel.guild_id!);
        const parentId =
          "parent_id" in body ? body.parent_id : channel.parent_id;
        const parent =
          typeof parentId === "string"
            ? state.channels.get(parentId)
            : undefined;
        if (
          typeof parentId === "string" &&
          (parent?.type !== ChannelType.GuildCategory ||
            !("guild_id" in parent) ||
            parent.guild_id !== guild.id)
        )
          return respond.invalidFormBody();
        if (overwrites) {
          // Read as either: what the bot holds guild-wide, or in the parent (inferred, not checked).
          const held =
            computePermissions(state, guild, state.bot.id) |
            computePermissions(state, guild, state.bot.id, parent);
          const managesRolesHere = (channel.permission_overwrites ?? []).some(
            (o) =>
              BigInt(o.allow) & Permission.ManageRoles &&
              (o.id === state.bot.id ||
                guild.members.get(state.bot.id)?.roles.includes(o.id)),
          );
          const beyond = overwrites.some(
            (o) => BigInt(o.allow ?? 0) & ~held || BigInt(o.deny ?? 0) & ~held,
          );
          if (beyond && !managesRolesHere) return respond.missingPermissions();
        }
        const lockTo =
          body.lock_permissions && parent && "permission_overwrites" in parent
            ? structuredClone(parent.permission_overwrites ?? [])
            : undefined;
        Object.assign(channel, {
          ...pick(body, ["name", "topic", "nsfw", "rate_limit_per_user"]),
          ...("parent_id" in body ? { parent_id: parent?.id ?? null } : {}),
          // lock_permissions: "Sync channel permissions with the new or existing parent category"
          ...(overwrites
            ? {
                permission_overwrites: overwrites.map((o) => ({
                  id: o.id,
                  type: o.type,
                  allow: o.allow ?? "0",
                  deny: o.deny ?? "0",
                })),
              }
            : lockTo
              ? { permission_overwrites: lockTo }
              : {}),
        });
        this.gateway.dispatch(
          GatewayDispatchEvents.ChannelUpdate,
          channel,
          GatewayIntentBits.Guilds,
        );
        return respond.json(channel);
      }),
    );

    // resources/channel#edit-channel-permissions: needs MANAGE_ROLES on the channel, and "only
    // permissions your bot has in the guild or parent channel (if applicable) can be
    // allowed/denied (unless your bot has a MANAGE_ROLES overwrite in the channel)". The contract
    // run got 50013 for an overwrite allowing Manage Server, which the bot doesn't hold.
    rest.route(
      "PUT",
      "/channels/:channelId/permissions/:overwriteId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(channel, Permission.ManageRoles);
        if (denied) return denied;
        const body = req.body as
          | RESTPutAPIChannelPermissionJSONBody
          | undefined;
        const requested = BigInt(body?.allow ?? 0) | BigInt(body?.deny ?? 0);
        if (
          requested & ~this.permissionsToGrant(channel) &&
          !this.hasManageRolesOverwrite(channel)
        )
          return respond.missingPermissions();
        this.setOverwrite(
          channel,
          { id: req.params.overwriteId!, type: body?.type ?? 0 },
          {
            allow: BigInt(body?.allow ?? 0),
            deny: BigInt(body?.deny ?? 0),
          },
        );
        return respond.noContent();
      }),
    );

    // resources/channel#delete-channel-permission: needs MANAGE_ROLES, "Returns a 204 empty response
    // on success. Fires a Channel Update Gateway event." 10009 for an overwrite that isn't there is
    // inferred from the code table.
    rest.route(
      "DELETE",
      "/channels/:channelId/permissions/:overwriteId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(channel, Permission.ManageRoles);
        if (denied) return denied;
        const overwrites =
          "permission_overwrites" in channel
            ? channel.permission_overwrites
            : undefined;
        const i =
          overwrites?.findIndex((o) => o.id === req.params.overwriteId) ?? -1;
        if (i === -1) return respond.error(404, 10009, "Unknown Overwrite");
        this.syncThreadsOnAccess(channel, () => {
          overwrites!.splice(i, 1);
          this.gateway.dispatch(
            GatewayDispatchEvents.ChannelUpdate,
            channel,
            GatewayIntentBits.Guilds,
          );
        });
        return respond.noContent();
      }),
    );

    // Permission-checked like Discord: VIEW_CHANNEL then SEND_MESSAGES, 50001 vs 50013.
    rest.route(
      "POST",
      "/channels/:channelId/messages",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const body = req.body as RESTPostAPIChannelMessageJSONBody | undefined;
        const replyTo = body?.message_reference?.message_id;
        // docs.discord.food/resources/message#create-message: a reply also needs READ_MESSAGE_HISTORY.
        const denied = this.checkBotPerms(
          channel,
          Permission.SendMessages |
            (replyTo ? Permission.ReadMessageHistory : 0n),
        );
        if (denied) return denied;
        if (replyTo && !this.historyIn(channel).some((m) => m.id === replyTo))
          return unknownReplyError();
        const overLimit = messageLimitError(body);
        if (overLimit) return overLimit;
        // A user who turned off DMs from server members can't be messaged: 50007 "Cannot send
        // messages to this user" (Discord's code table). The 403 status is inferred, not checked.
        if (
          channel.type === ChannelType.DM &&
          channel.recipients?.some((u) => state.closedDms.has(u.id))
        )
          return respond.error(403, 50007, "Cannot send messages to this user");
        // topics/threads: "Sending a message will automatically unarchive the thread, unless the
        // thread has been locked by a moderator"; a locked one only unarchives with MANAGE_THREADS.
        // The 50083 for a locked one is inferred, not checked.
        const meta =
          "thread_metadata" in channel ? channel.thread_metadata : undefined;
        if (meta?.archived) {
          if (
            meta.locked &&
            this.checkBotPerms(channel, Permission.ManageThreads)
          )
            return respond.error(400, 50083, "Thread is archived");
          meta.archived = false;
          meta.archive_timestamp = new Date().toISOString();
          this.gateway.dispatch(
            GatewayDispatchEvents.ThreadUpdate,
            channel,
            GatewayIntentBits.Guilds,
          );
        }
        // resources/permissions: SEND_POLLS "Allows sending polls"; needed in guild channels
        // (inferred: a DM has no permissions to check).
        if (body?.poll && "guild_id" in channel && channel.guild_id) {
          const noPolls = this.checkBotPerms(channel, Permission.SendPolls);
          if (noPolls) return noPolls;
        }
        const message = state.createMessage({
          channelId: channel.id,
          authorId: state.bot.id,
          content: body?.content,
          embeds: body?.embeds,
          components: body?.components,
          flags: body?.flags,
          poll: pollFrom(body?.poll),
          replyTo,
          pingReplied: body?.allowed_mentions?.replied_user ?? true,
        });
        this.gateway.dispatchMessage("MESSAGE_CREATE", message);
        addMentionedToPrivateThread(
          this,
          channel,
          [...(message.content ?? "").matchAll(/<@!?(\d+)>/g)].map(
            ([, id]) => id!,
          ),
        );
        return respond.json(message);
      }),
    );

    rest.route(
      "GET",
      "/channels/:channelId/messages",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        // docs.discord.food/resources/message#list-messages: needs VIEW_CHANNEL; without
        // READ_MESSAGE_HISTORY "this will return no messages".
        const denied = this.checkBotPerms(channel, 0n);
        if (denied) return denied;
        if (this.checkBotPerms(channel, Permission.ReadMessageHistory))
          return respond.json([]);
        const limit = Number(req.query.get("limit") ?? 50);
        const before = req.query.get("before");
        const after = req.query.get("after");
        let list = [...this.historyIn(channel)].reverse(); // newest first, as Discord returns
        if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before));
        if (after)
          list = list
            .filter((m) => BigInt(m.id) > BigInt(after))
            .reverse()
            .slice(0, limit)
            .reverse();
        return respond.json(list.slice(0, limit).map((m) => this.readable(m)));
      }),
    );

    rest.route(
      "PATCH",
      "/channels/:channelId/messages/:messageId",
      authed((req) => {
        const message = this.historyIn(req.params.channelId!).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        if (message.author.id !== state.bot.id)
          return respond.error(
            403,
            50005,
            "Cannot edit a message authored by another user",
          );
        const overLimit =
          pollEditGap(rest, message, req.body) ?? messageLimitError(req.body);
        if (overLimit) return overLimit;
        const updated = state.updateMessage(
          message.channel_id,
          message.id,
          pickMessageFields(req.body),
        );
        this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
        return respond.json(updated);
      }),
    );

    // Discord's docs, resources/message#delete-message: another user's message in a guild
    // channel needs MANAGE_MESSAGES. 204, fires MESSAGE_DELETE { id, channel_id, guild_id? }. In
    // a DM the bot can delete only its own: another user's answers 50003 "Cannot execute action
    // on a DM channel", as bulk delete does (Discord's code table; the pairing is inferred).
    rest.route(
      "DELETE",
      "/channels/:channelId/messages/:messageId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const message = this.historyIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        const others = message.author.id !== state.bot.id;
        if (others && !("guild_id" in channel && channel.guild_id))
          return respond.error(
            400,
            50003,
            "Cannot execute action on a DM channel",
          );
        if (others) {
          const denied = this.checkBotPerms(channel, Permission.ManageMessages);
          if (denied) return denied;
        }
        this.deleteMessage(message);
        // Deleting someone else's message is a MESSAGE_DELETE audit log entry, its target the
        // author; your own isn't logged. These entries merge on Discord: not modelled.
        if (others && "guild_id" in channel && channel.guild_id)
          recordAudit(this, state.requireGuild(channel.guild_id), {
            action_type: AuditLogEvent.MessageDelete,
            user_id: state.bot.id,
            target_id: message.author.id,
            options: { channel_id: channel.id, count: "1" },
            reason: reasonOf(req),
          });
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/message#get-message: READ_MESSAGE_HISTORY in guild channels.
    rest.route(
      "GET",
      "/channels/:channelId/messages/:messageId",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const denied = this.checkBotPerms(
          channel,
          Permission.ReadMessageHistory,
        );
        if (denied) return denied;
        const message = this.historyIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        return message
          ? respond.json(this.readable(message))
          : respond.unknownMessage();
      }),
    );

    // docs.discord.food/resources/message#create-reaction: READ_MESSAGE_HISTORY, plus
    // ADD_REACTIONS when nobody has reacted with this emoji yet. 204, fires MESSAGE_REACTION_ADD.
    rest.route(
      "PUT",
      "/channels/:channelId/messages/:messageId/reactions/:emoji/@me",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const message = this.historyIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        const emoji = req.params.emoji!;
        const first = !message.reactions?.some((r) => r.emoji.name === emoji);
        const denied = this.checkBotPerms(
          channel,
          Permission.ReadMessageHistory |
            (first ? Permission.AddReactions : 0n),
        );
        if (denied) return denied;
        this.userReacts(state.bot, message, emoji);
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/message#delete-own-reaction: 204, fires MESSAGE_REACTION_REMOVE.
    rest.route(
      "DELETE",
      "/channels/:channelId/messages/:messageId/reactions/:emoji/@me",
      authed((req) => {
        const channel = state.channels.get(req.params.channelId!);
        if (!channel) return respond.unknownChannel();
        const message = this.historyIn(channel).find(
          (m) => m.id === req.params.messageId,
        );
        if (!message) return respond.unknownMessage();
        const emoji = req.params.emoji!;
        if (state.removeReaction(channel.id, message.id, emoji, state.bot.id)) {
          const guildId = "guild_id" in channel ? channel.guild_id : undefined;
          this.gateway.dispatch(
            GatewayDispatchEvents.MessageReactionRemove,
            {
              user_id: state.bot.id,
              channel_id: channel.id,
              message_id: message.id,
              ...(guildId ? { guild_id: guildId } : {}),
              emoji: { id: null, name: emoji },
              type: 0,
              burst: false,
            },
            guildId
              ? GatewayIntentBits.GuildMessageReactions
              : GatewayIntentBits.DirectMessageReactions,
          );
        }
        return respond.noContent();
      }),
    );

    // docs.discord.food/resources/channel#list-guild-active-threads. Thread members aren't modelled.
    rest.route(
      "GET",
      "/guilds/:guildId/threads/active",
      authed((req) => {
        if (!state.guilds.has(req.params.guildId!))
          return respond.error(404, 10004, "Unknown Guild");
        const threads = [...state.channels.values()]
          .filter(
            (c) =>
              "thread_metadata" in c &&
              c.guild_id === req.params.guildId &&
              !c.thread_metadata?.archived,
          )
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
        return respond.json({ threads, members: [] });
      }),
    );

    // docs.discord.food/resources/channel#list-public-archived-threads, #list-private-archived-threads
    // and #list-joined-private-archived-threads: archived threads of the channel, `limit` 2-100
    // (default 50). Public lists public and announcement threads, private lists private threads
    // and also needs MANAGE_THREADS, refused with 50001 Missing Access rather than 50013 (checked
    // by the contract run); both go newest archive_timestamp first with `before` an ISO
    // timestamp. Joined lists the private threads the bot is in, newest id first with `before` an
    // id. `members` has the bot's thread member for each thread it joined.
    type Thread = APIChannel & {
      parent_id?: string | null;
      thread_metadata: { archived: boolean; archive_timestamp: string };
    };
    const archivedRoute = (
      path: string,
      needed: bigint,
      include: (thread: Thread) => boolean,
      ordered: (threads: Thread[], before: string | null) => Thread[],
      /** Permissions whose absence Discord answers with 50001, not 50013. */
      access = 0n,
    ) =>
      rest.route(
        "GET",
        path,
        authed((req) => {
          const channel = state.channels.get(req.params.channelId!);
          if (!channel) return respond.unknownChannel();
          const denied = this.checkBotPerms(channel, needed);
          if (denied) return denied;
          if (access && this.checkBotPerms(channel, access))
            return respond.missingAccess();
          const limit = Number(req.query.get("limit") ?? 50);
          const archived = ordered(
            [...state.channels.values()].filter(
              (c): c is Thread =>
                "thread_metadata" in c &&
                c.parent_id === channel.id &&
                !!c.thread_metadata?.archived &&
                include(c as Thread),
            ),
            req.query.get("before"),
          );
          const threads = archived.slice(0, limit);
          return respond.json({
            threads,
            members: threads.flatMap(
              (t) => state.threadMember(t.id, state.bot.id) ?? [],
            ),
            has_more: archived.length > limit,
          });
        }),
      );
    const byArchiveTime = (threads: Thread[], before: string | null) =>
      threads
        .filter(
          (t) =>
            !before ||
            t.thread_metadata.archive_timestamp <
              new Date(before).toISOString(),
        )
        .sort((a, b) =>
          b.thread_metadata.archive_timestamp.localeCompare(
            a.thread_metadata.archive_timestamp,
          ),
        );
    const isPrivate = (t: Thread) => t.type === ChannelType.PrivateThread;
    archivedRoute(
      "/channels/:channelId/threads/archived/public",
      Permission.ReadMessageHistory,
      (t) => !isPrivate(t),
      byArchiveTime,
    );
    archivedRoute(
      "/channels/:channelId/threads/archived/private",
      Permission.ReadMessageHistory,
      isPrivate,
      byArchiveTime,
      Permission.ManageThreads,
    );
    archivedRoute(
      "/channels/:channelId/users/@me/threads/archived/private",
      Permission.ReadMessageHistory,
      (t) => isPrivate(t) && !!state.threadMember(t.id, state.bot.id),
      (threads, before) =>
        threads
          .filter((t) => !before || BigInt(t.id) < BigInt(before))
          .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)),
    );

    // docs.discord.food/resources/user#get-user. 10013 Unknown User is from Discord's code table.
    rest.route(
      "GET",
      "/users/:userId",
      authed((req) => {
        const user = state.users.get(req.params.userId!);
        return user
          ? respond.json(user)
          : respond.error(404, 10013, "Unknown User");
      }),
    );

    // docs.discord.food/resources/channel#create-private-channel: one recipient returns the DM.
    rest.route(
      "POST",
      "/users/@me/channels",
      authed((req) => {
        const body = req.body as
          | RESTPostAPICurrentUserCreateDMChannelJSONBody
          | undefined;
        const user = state.users.get(body?.recipient_id ?? "");
        if (!user) return respond.error(404, 10013, "Unknown User");
        return respond.json(state.dmChannel(user.id));
      }),
    );

    // The CDN: attachment bytes, unauthenticated like cdn.discordapp.com.
    rest.route("GET", "/attachments/:channelId/:attachmentId/:name", (req) => {
      const file = state.files.get(req.params.attachmentId!);
      return file
        ? { status: 200, file }
        : respond.error(404, 0, "404: Not Found");
    });

    // ---- interactions ----
    rest.route("POST", "/interactions/:id/:token/callback", (req) => {
      const run = this.interactions.get(req.params.id!);
      if (!run || run.token !== req.params.token)
        return respond.unknownInteraction();
      if (run.state !== "pending") return respond.alreadyAcknowledged();
      if (wall.now() - run.createdAt > this.interactionDeadlineMs)
        return respond.unknownInteraction();

      const body = req.body as RESTPostAPIInteractionCallbackJSONBody;
      const { type } = body;
      const data = "data" in body ? body.data : undefined;
      // receiving-and-responding#interaction-callback-type: AUTOCOMPLETE_RESULT (8) answers an
      // autocomplete, and an autocomplete takes nothing else. Discord's answer otherwise is unchecked.
      const isAutocomplete =
        run.type === InteractionType.ApplicationCommandAutocomplete;
      if (
        isAutocomplete !==
        (type === InteractionResponseType.ApplicationCommandAutocompleteResult)
      )
        return rest.gap(`callback type ${type} on a ${run.type} interaction`);
      const overLimit =
        type === InteractionResponseType.Modal
          ? modalLimitError(data)
          : isAutocomplete
            ? choicesLimitError(data)
            : messageLimitError(data);
      if (overLimit) return overLimit;
      run.responseType = type;
      switch (body.type) {
        case InteractionResponseType.ChannelMessageWithSource:
        case InteractionResponseType.DeferredChannelMessageWithSource: {
          const deferred =
            type === InteractionResponseType.DeferredChannelMessageWithSource;
          const flags = body.data?.flags ?? 0;
          run.ephemeral = !!(flags & MessageFlags.Ephemeral);
          const message = state.createMessage({
            channelId: run.channelId,
            authorId: state.bot.id,
            ...(deferred ? {} : pickMessageFields(body.data)),
            flags: flags | (deferred ? MessageFlags.Loading : 0),
            interaction: interactionMetadata(run),
            webhookId: state.applicationId,
          });
          run.originalMessageId = message.id;
          run.state = deferred ? "deferred" : "replied";
          this.gateway.dispatchMessage("MESSAGE_CREATE", message);
          break;
        }
        // docs.discord.food/interactions/receiving-and-responding: types 6 and 7 are for
        // MESSAGE_COMPONENT and MODAL_SUBMIT only. What Discord answers otherwise is unchecked: a Gap.
        case InteractionResponseType.DeferredMessageUpdate:
          if (!run.sourceMessageId)
            return rest.gap(`callback type 6 on a ${run.type} interaction`);
          run.state = "deferred";
          break;
        case InteractionResponseType.UpdateMessage: {
          if (!run.sourceMessageId)
            return rest.gap(`callback type 7 on a ${run.type} interaction`);
          const pollGap = pollEditGap(
            rest,
            state.requireMessage(run.channelId, run.sourceMessageId),
            body.data,
          );
          if (pollGap) return pollGap;
          const updated = state.updateMessage(
            run.channelId,
            run.sourceMessageId,
            pickMessageFields(body.data),
          );
          this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
          run.state = "replied";
          break;
        }
        // docs.discord.food/interactions/receiving-and-responding: MODAL (9) is allowed by
        // APPLICATION_COMMAND and MESSAGE_COMPONENT only. What Discord answers otherwise is unchecked.
        case InteractionResponseType.ApplicationCommandAutocompleteResult:
          run.choices = body.data?.choices ?? [];
          run.state = "replied";
          break;
        case InteractionResponseType.Modal:
          if (
            run.type !== InteractionType.ApplicationCommand &&
            run.type !== InteractionType.MessageComponent
          )
            return rest.gap(`callback type 9 on a ${run.type} interaction`);
          run.modal = body.data;
          run.state = "modal";
          break;
        default:
          return rest.gap(`interaction callback type ${type}`);
      }
      run.emit("change");
      if (req.query.get("with_response") !== "true") return respond.noContent();
      const original = run.original;
      // resource.message: "only if type is CHANNEL_MESSAGE_WITH_SOURCE or UPDATE_MESSAGE".
      const withMessage =
        type === InteractionResponseType.ChannelMessageWithSource ||
        type === InteractionResponseType.UpdateMessage;
      return respond.json({
        interaction: {
          id: run.id,
          type: run.type,
          activity_instance_id: null,
          response_message_id: original?.id ?? null,
          response_message_loading: run.state === "deferred",
          response_message_ephemeral: run.ephemeral,
        },
        resource:
          withMessage && original ? { type, message: original } : { type },
      });
    });

    const runFor = (req: { params: Record<string, string> }) => {
      if (req.params.appId !== state.applicationId) return undefined;
      return [...this.interactions.values()].find(
        (r) => r.token === req.params.token,
      );
    };

    rest.route("PATCH", "/webhooks/:appId/:token/messages/@original", (req) => {
      const run = runFor(req);
      if (!run || run.state === "pending") return respond.unknownWebhook();
      const overLimit = messageLimitError(req.body);
      if (overLimit) return overLimit;
      const original = run.original;
      if (!original) return respond.unknownMessage();
      const pollGap = pollEditGap(rest, original, req.body);
      if (pollGap) return pollGap;
      const updated = state.updateMessage(run.channelId, original.id, {
        ...pickMessageFields(req.body),
        flags: (original.flags ?? 0) & ~MessageFlags.Loading,
      });
      this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
      run.state = "replied";
      run.emit("change");
      return respond.json(updated);
    });

    rest.route("GET", "/webhooks/:appId/:token/messages/@original", (req) => {
      const run = runFor(req);
      return run?.original
        ? respond.json(run.original)
        : respond.unknownMessage();
    });

    // interactions/receiving-and-responding#delete-original-interaction-response: 204.
    rest.route(
      "DELETE",
      "/webhooks/:appId/:token/messages/@original",
      (req) => {
        const run = runFor(req);
        if (!run || run.state === "pending") return respond.unknownWebhook();
        const original = run.original;
        if (!original) return respond.unknownMessage();
        this.deleteMessage(original);
        run.replyDeleted = true;
        run.emit("change");
        return respond.noContent();
      },
    );

    // Get, Modify and Delete Followup Message "do not support ephemeral followups"; what Discord
    // answers for one is undocumented, so it's a Gap.
    const followupFor = (req: RestRequest) => {
      const run = runFor(req);
      const message = run?.followups.find((m) => m.id === req.params.messageId);
      if (!run || !message) return { refused: respond.unknownMessage() };
      if ((message.flags ?? 0) & MessageFlags.Ephemeral)
        return { refused: rest.gap(`${req.method} an ephemeral followup`) };
      return { run, message };
    };

    rest.route("GET", "/webhooks/:appId/:token/messages/:messageId", (req) => {
      const { refused, message } = followupFor(req);
      return refused ?? respond.json(message);
    });

    rest.route(
      "PATCH",
      "/webhooks/:appId/:token/messages/:messageId",
      (req) => {
        const { refused, run, message } = followupFor(req);
        if (refused) return refused;
        const overLimit =
          pollEditGap(rest, message, req.body) ?? messageLimitError(req.body);
        if (overLimit) return overLimit;
        const updated = state.updateMessage(
          message.channel_id,
          message.id,
          pickMessageFields(req.body),
        );
        this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
        run.emit("change");
        return respond.json(updated);
      },
    );

    rest.route(
      "DELETE",
      "/webhooks/:appId/:token/messages/:messageId",
      (req) => {
        const { refused, run, message } = followupFor(req);
        if (refused) return refused;
        this.deleteMessage(message);
        run.followups.splice(run.followups.indexOf(message), 1);
        run.emit("change");
        return respond.noContent();
      },
    );

    rest.route("POST", "/webhooks/:appId/:token", (req) => {
      const run = runFor(req);
      if (!run || run.state === "pending") return respond.unknownWebhook();
      const overLimit = messageLimitError(req.body);
      if (overLimit) return overLimit;
      // Discord's docs (discord-api-docs, Create Followup Message): right after a
      // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, a followup edits the loading message instead of
      // creating one, and the ephemeral flag is ignored.
      const original = run.original;
      if (
        run.state === "deferred" &&
        run.responseType ===
          InteractionResponseType.DeferredChannelMessageWithSource &&
        original
      ) {
        const updated = state.updateMessage(run.channelId, original.id, {
          ...pickMessageFields(req.body),
          flags: (original.flags ?? 0) & ~MessageFlags.Loading,
        });
        this.gateway.dispatchMessage("MESSAGE_UPDATE", updated);
        run.state = "replied";
        run.emit("change");
        return respond.json(updated);
      }
      const message = state.createMessage({
        channelId: run.channelId,
        authorId: state.bot.id,
        ...pickMessageFields(req.body),
        flags:
          (req.body as RESTPostAPIInteractionFollowupJSONBody | undefined)
            ?.flags ?? 0,
        interaction: {
          ...interactionMetadata(run),
          originalResponseMessageId: run.originalMessageId,
        },
        webhookId: state.applicationId,
      });
      run.followups.push(message);
      this.gateway.dispatchMessage("MESSAGE_CREATE", message);
      run.emit("change");
      return respond.json(message);
    });
    registerMemberRoutes(this, authed);
    registerGuildRoutes(this, authed);
    registerInviteRoutes(this, authed);
    registerTemplateRoutes(this, authed);
    registerVoiceRoutes(this, authed);
    registerScheduledEventRoutes(this, authed);
    registerExpressionRoutes(this, authed);
    registerSoundboardRoutes(this, authed);
    registerAutoModRoutes(this, authed);
    registerPollRoutes(this, authed);
    registerTypingRoute(this, authed);
    registerStageRoutes(this, authed);
    registerThreadRoutes(this, authed);
  }

  /**
   * Removes `message` and announces MESSAGE_DELETE { id, channel_id, guild_id? }
   * (gateway-events#message-delete), with GUILD_MESSAGES in guilds and DIRECT_MESSAGES in DMs. An
   * ephemeral message lived only in the user's client, so its deletion isn't announced (inferred).
   */
  deleteMessage(message: APIMessage) {
    const channel = this.state.requireChannel(message.channel_id);
    this.state.deleteMessage(channel.id, message.id);
    if ((message.flags ?? 0) & MessageFlags.Ephemeral) return;
    const guildId =
      "guild_id" in channel && channel.guild_id ? channel.guild_id : undefined;
    this.gateway.dispatch(
      GatewayDispatchEvents.MessageDelete,
      {
        id: message.id,
        channel_id: channel.id,
        ...(guildId ? { guild_id: guildId } : {}),
      },
      guildId
        ? GatewayIntentBits.GuildMessages
        : GatewayIntentBits.DirectMessages,
    );
  }

  /** VIEW_CHANNEL first: without it "other channel permissions are effectively ignored" (docs.discord.food/topics/permissions). */
  /**
   * `message` as REST returns it. Without the Message Content intent turned on in the Developer
   * Portal, Discord empties "fields that expose message content across Discord's APIs"
   * (events/gateway#message-content-intent), REST included, whatever intents the bot identified
   * with; DMs, the bot's own messages and messages that mention it keep theirs.
   */
  readable(message: APIMessage): APIMessage {
    if (this.privilegedIntents & GatewayIntentBits.MessageContent)
      return message;
    const channel = this.state.channels.get(message.channel_id);
    const inGuild = !!channel && "guild_id" in channel && !!channel.guild_id;
    if (
      !inGuild ||
      message.author.id === this.state.bot.id ||
      message.mentions.some((u) => u.id === this.state.bot.id)
    )
      return message;
    return {
      ...message,
      content: "",
      embeds: [],
      attachments: [],
      components: [],
      poll: undefined,
    };
  }

  /** What the bot holds in the guild, or in the channel's category when it has one. */
  private permissionsToGrant(channel: APIChannel): bigint {
    const guild = this.state.requireGuild(
      (channel as { guild_id: string }).guild_id,
    );
    const parentId = "parent_id" in channel ? channel.parent_id : null;
    const parent = parentId ? this.state.channels.get(parentId) : undefined;
    return computePermissions(this.state, guild, this.state.bot.id, parent);
  }

  /** Whether an overwrite in `channel`, for the bot or one of its roles, allows Manage Roles. */
  private hasManageRolesOverwrite(channel: APIChannel): boolean {
    const guild = this.state.requireGuild(
      (channel as { guild_id: string }).guild_id,
    );
    const roles = guild.members.get(this.state.bot.id)?.roles ?? [];
    const overwrites =
      "permission_overwrites" in channel
        ? (channel.permission_overwrites ?? [])
        : [];
    return overwrites.some(
      (o) =>
        (o.id === this.state.bot.id || roles.includes(o.id)) &&
        (BigInt(o.allow) & Permission.ManageRoles) !== 0n,
    );
  }

  checkBotPerms(channel: APIChannel, needed: bigint) {
    if (!("guild_id" in channel) || !channel.guild_id) return undefined;
    const guild = this.state.requireGuild(channel.guild_id);
    const perms = computePermissions(
      this.state,
      guild,
      this.state.bot.id,
      channel,
    );
    if (!(perms & Permission.ViewChannel)) return respond.missingAccess();
    if ((perms & needed) !== needed) return respond.missingPermissions();
    return undefined;
  }
}

// 10063 is in Discord's code table; pairing it with an unknown command id is inferred, not checked.
const unknownCommand = () =>
  respond.error(404, 10063, "Unknown application command");

export async function createDiscordMock(
  options?: DiscordMockOptions,
): Promise<DiscordMock> {
  return new DiscordMock(options).listen();
}

/** The fields of `body` named in `keys` that it has. */
function pick(body: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys.filter((k) => k in body).map((k) => [k, body[k]]),
  );
}

function interactionMetadata(run: InteractionRun) {
  return {
    id: run.id,
    type: run.type,
    userId: run.userId,
    guildId: run.guildId,
    interactedMessageId: run.sourceMessageId,
  };
}

/**
 * resources/poll: "After creation, the poll message cannot be edited", and the code table has
 * 520003 "Cannot edit a poll message". That's the poll: the contract run edited a poll message's
 * components and content with 200 each, and the poll stayed. An edit that sends a new `poll` is
 * still a Gap, as is adding a poll to a message that isn't a deferred reply still loading (that one
 * becomes the reply, inferred).
 */
export function pollEditGap(
  rest: RestRouter,
  message: APIMessage,
  raw: unknown,
) {
  const body = raw as RESTPostAPIChannelMessageJSONBody | undefined;
  if (message.poll && body?.poll) return rest.gap("changing a message's poll");
  if (body?.poll && !((message.flags ?? 0) & MessageFlags.Loading))
    return rest.gap("adding a poll to a message in an edit");
  return undefined;
}

export function pickMessageFields(raw: unknown) {
  // The widest edit body: an interaction's webhook edit is the one that can carry a poll.
  const body = raw as RESTPatchAPIWebhookWithTokenMessageJSONBody | undefined;
  if (!body) return {};
  const out: Partial<
    Pick<APIMessage, "content" | "embeds" | "components" | "poll">
  > = {};
  if ("content" in body) out.content = body.content ?? "";
  if ("embeds" in body) out.embeds = body.embeds ?? [];
  if ("components" in body) out.components = body.components ?? [];
  if (body.poll) out.poll = pollFrom(body.poll);
  return out;
}

const OPTION_CHECKS: Partial<
  Record<ApplicationCommandOptionType, (v: unknown) => boolean>
> = {
  [ApplicationCommandOptionType.String]: (v) => typeof v === "string",
  [ApplicationCommandOptionType.Integer]: (v) => Number.isInteger(v),
  [ApplicationCommandOptionType.Number]: (v) => typeof v === "number",
  [ApplicationCommandOptionType.Boolean]: (v) => typeof v === "boolean",
  [ApplicationCommandOptionType.User]: (v) => typeof v === "string",
  [ApplicationCommandOptionType.Channel]: (v) => typeof v === "string",
  [ApplicationCommandOptionType.Role]: (v) => typeof v === "string",
  [ApplicationCommandOptionType.Mentionable]: (v) => typeof v === "string",
  [ApplicationCommandOptionType.Attachment]: (v) =>
    typeof v === "object" && v !== null && "data" in v && "name" in v,
};

/** An option as the interaction carries it, nested under its subcommand. */
type CommandOption = {
  type: number;
  value?: unknown;
  options?: CommandOption[];
};

const SUBCOMMAND_TYPES: ApplicationCommandOptionType[] = [
  ApplicationCommandOptionType.Subcommand,
  ApplicationCommandOptionType.SubcommandGroup,
];

/**
 * Walk `path` (subcommand group, subcommand) down the registered schema, and nest the typed
 * options under it the way Discord sends them. Returns the leaf schema for `resolved`.
 */
function commandOptions(
  schema: APIApplicationCommandOption[],
  path: string[],
  input: Record<string, unknown>,
  command: string,
  focused?: string,
): { options: unknown[]; leaf: APIApplicationCommandOption[] } {
  const subcommands = schema.filter((o) => SUBCOMMAND_TYPES.includes(o.type));
  if (!path.length) {
    if (subcommands.length)
      throw new Error(
        `discordjs-test-kit: /${command} needs a subcommand: ${subcommands.map((o) => o.name).join(", ")}`,
      );
    return {
      options: buildOptions(schema, input, command, focused),
      leaf: schema,
    };
  }
  const [next, ...rest] = path;
  const sub = subcommands.find((o) => o.name === next);
  if (!sub)
    throw new Error(
      `discordjs-test-kit: /${command} has no subcommand "${next}". It has: ${subcommands.map((o) => o.name).join(", ")}`,
    );
  const nested = commandOptions(
    ("options" in sub ? sub.options : undefined) ?? [],
    rest,
    input,
    command,
    focused,
  );
  return {
    options: [{ name: sub.name, type: sub.type, options: nested.options }],
    leaf: nested.leaf,
  };
}

/**
 * Turn `{ text: "hi" }` into Discord's typed option list, validated against what the bot registered.
 * With `focused`, it's an autocomplete: interactions/application-commands#autocomplete says the
 * focused option carries `focused: true` and may be partial, and required options "might not be
 * present". The option must have `autocomplete` set, or the Discord app never asks the bot.
 */
function buildOptions(
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  command: string,
  focused?: string,
) {
  if (focused !== undefined) {
    const option = schema.find((o) => o.name === focused);
    if (!option || !("autocomplete" in option && option.autocomplete))
      throw new Error(
        `discordjs-test-kit: /${command} option "${focused}" ${option ? "doesn't have autocomplete" : "doesn't exist"}, so the Discord app doesn't ask the bot for suggestions`,
      );
  }
  for (const key of Object.keys(input)) {
    if (!schema.some((o) => o.name === key))
      throw new Error(
        `discordjs-test-kit: /${command} has no option "${key}". ${schema.length ? `It has: ${schema.map((o) => o.name).join(", ")}` : "It takes no options"}`,
      );
  }
  return schema.flatMap((opt) => {
    const value = input[opt.name];
    if (value === undefined) {
      if ("required" in opt && opt.required && focused === undefined)
        throw new Error(
          `discordjs-test-kit: /${command} requires option "${opt.name}"`,
        );
      return [];
    }
    const check = OPTION_CHECKS[opt.type];
    if (!check)
      throw new Error(
        `discordjs-test-kit: option type ${opt.type} not supported yet`,
      );
    if (!check(value))
      throw new Error(
        `discordjs-test-kit: /${command} option "${opt.name}" has the wrong type`,
      );
    const choices = "choices" in opt ? opt.choices : undefined;
    if (choices?.length && !choices.some((c) => c.value === value)) {
      throw new Error(
        `discordjs-test-kit: /${command} option "${opt.name}" must be one of: ${choices.map((c) => c.name).join(", ")}`,
      );
    }
    // discord-api-docs interactions/application-commands, option structure: min/max_value and
    // min/max_length bound what a user can submit. The Discord app enforces them before sending
    // ("client-side only"), so the Actor refuses what the app would.
    const bound = (key: string) =>
      key in opt
        ? (opt as unknown as Record<string, number | undefined>)[key]
        : undefined;
    const tooSmall = bound("min_value"),
      tooBig = bound("max_value");
    if (typeof value === "number") {
      if (tooSmall !== undefined && value < tooSmall)
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at least ${tooSmall}`,
        );
      if (tooBig !== undefined && value > tooBig)
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at most ${tooBig}`,
        );
    }
    const minLength = bound("min_length"),
      maxLength = bound("max_length");
    if (typeof value === "string") {
      if (
        minLength !== undefined &&
        value.length < minLength &&
        opt.name !== focused
      )
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at least ${minLength} characters`,
        );
      if (maxLength !== undefined && value.length > maxLength)
        throw new Error(
          `discordjs-test-kit: /${command} option "${opt.name}" must be at most ${maxLength} characters`,
        );
    }
    return [
      {
        name: opt.name,
        type: opt.type,
        value,
        ...(opt.name === focused ? { focused: true } : {}),
      },
    ];
  });
}

/** docs.discord.food/interactions/receiving-and-responding#resolved-data-object */
function resolvedFor(
  state: DiscordState,
  schema: APIApplicationCommandOption[],
  input: Record<string, unknown>,
  guild: GuildRecord | undefined,
  invokerId: string,
  attachments: APIAttachment[] = [],
) {
  const idsOf = (type: ApplicationCommandOptionType) =>
    schema
      .filter((o) => o.type === type && typeof input[o.name] === "string")
      .map((o) => input[o.name] as string);
  // The option's channel_types limit what the user can pick.
  for (const o of schema) {
    if (o.type !== ApplicationCommandOptionType.Channel) continue;
    if (typeof input[o.name] !== "string") continue;
    const channel = state.requireChannel(input[o.name] as string);
    const allowed = "channel_types" in o ? o.channel_types : undefined;
    if (allowed?.length && !allowed.includes(channel.type as never))
      throw new Error(
        `discordjs-test-kit: option "${o.name}" only offers channel types ${allowed.join(", ")}`,
      );
  }
  // A MENTIONABLE option's value is a user's or a role's id; the resolved map it lands in says which.
  const mentioned = idsOf(ApplicationCommandOptionType.Mentionable);
  const isRole = (id: string) => guild?.roles.has(id) ?? false;
  const resolved = resolvedData(state, guild, invokerId, {
    users: [
      ...idsOf(ApplicationCommandOptionType.User),
      ...mentioned.filter((id) => !isRole(id)),
    ],
    roles: [
      ...idsOf(ApplicationCommandOptionType.Role),
      ...mentioned.filter(isRole),
    ],
    channels: idsOf(ApplicationCommandOptionType.Channel),
  });
  if (!attachments.length) return resolved;
  return {
    ...resolved,
    attachments: Object.fromEntries(attachments.map((a) => [a.id, a])),
  };
}

/**
 * The `resolved` object of an interaction for these ids (interactions/receiving-and-responding#
 * interaction-object-resolved-data-structure), or undefined when there are none.
 */
function resolvedData(
  state: DiscordState,
  guild: GuildRecord | undefined,
  invokerId: string,
  ids: { users: string[]; roles: string[]; channels: string[] },
) {
  const users = ids.users.map((id) => state.requireUser(id));
  // Resolved members carry no user, deaf or mute; the user is in `users`.
  const members = users.flatMap((u) => {
    const m = guild?.members.get(u.id);
    if (!m) return [];
    const { user: _, deaf: _d, mute: _m, ...partial } = m;
    return [[u.id, partial] as const];
  });
  const roles = ids.roles.map((id) => {
    const role = guild?.roles.get(id);
    if (!role) throw new Error(`discordjs-test-kit: unknown role ${id}`);
    return [id, role] as const;
  });
  // Discord's docs: a resolved channel is partial (id, name, type, permissions, parent_id, …);
  // `permissions` are the invoker's in that channel.
  const channels = ids.channels.map((id) => {
    const channel = state.requireChannel(id);
    const c = channel as APIChannel & Record<string, unknown>;
    return [
      channel.id,
      {
        id: c.id,
        name: c.name,
        type: c.type,
        parent_id: c.parent_id ?? null,
        guild_id: c.guild_id,
        flags: c.flags ?? 0,
        ...("position" in c ? { position: c.position } : {}),
        ...("thread_metadata" in c
          ? { thread_metadata: c.thread_metadata }
          : {}),
        permissions: String(
          guild ? computePermissions(state, guild, invokerId, channel) : 0n,
        ),
      },
    ] as const;
  });
  if (!users.length && !roles.length && !channels.length) return undefined;
  return {
    ...(users.length
      ? { users: Object.fromEntries(users.map((u) => [u.id, u])) }
      : {}),
    ...(members.length ? { members: Object.fromEntries(members) } : {}),
    ...(roles.length ? { roles: Object.fromEntries(roles) } : {}),
    ...(channels.length ? { channels: Object.fromEntries(channels) } : {}),
  };
}

/** The text a user reads in a message: its content, then each embed's text. */
export function readable(message: APIMessage): string {
  return [
    message.content,
    ...(message.embeds ?? []).flatMap((embed) => [
      embed.title,
      embed.description,
      ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
      embed.footer?.text,
    ]),
    // Components V2 Text Displays carry a message's text in place of content.
    ...componentsIn(message)
      .filter((c) => c.type === ComponentType.TextDisplay)
      .map((c) => c.content),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Names a message by the start of what a user reads in it, for error messages. */
export function shown(message: APIMessage): string {
  const text = readable(message).split("\n").find(Boolean);
  if (!text) return "a message with no text";
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}

/** Every component on `message`, nested ones included (rows, and Components V2 containers and accessories). */
function componentsIn(message: APIMessage): APIMessageComponent[] {
  const found: APIMessageComponent[] = [];
  const walk = (component: APIMessageComponent) => {
    found.push(component);
    if ("components" in component)
      for (const child of component.components ?? []) walk(child);
    if ("accessory" in component) walk(component.accessory);
  };
  for (const component of message.components ?? []) walk(component);
  return found;
}

function buttonLabel(button: APIButtonComponent): string {
  if (button.style === ButtonStyle.Premium) return "(no label)";
  return button.label ?? button.emoji?.name ?? "(no label)";
}

/** `text` equals `want` (or contains it, with `partial`), or matches it when it's a RegExp. */
export function matches(
  text: string | undefined,
  want: string | RegExp,
  { partial = false } = {},
) {
  if (text === undefined) return false;
  if (typeof want === "string")
    return partial ? text.includes(want) : text === want;
  want.lastIndex = 0; // a /g RegExp would otherwise resume from its last match
  return want.test(text);
}

export function quote(label: string | RegExp) {
  return typeof label === "string" ? JSON.stringify(label) : String(label);
}

/**
 * A modal's fields as the user sees them: each Label's input (components/reference#label), or a
 * text input in a deprecated action row, labelled by its own `label`.
 */
/** What a member enters in a form field, by the field's component type. */
export type FormValue =
  | string
  | string[]
  | boolean
  | { id: string }
  | { id: string }[]
  | FileUpload
  | FileUpload[];

/**
 * One field's submitted part, checked the way the Discord app checks it before it lets the member
 * submit (docs.discord.food/resources/components): `required` (true by default, false for a file
 * upload), min_length/max_length for text, min_values/max_values for picks. `given` undefined
 * leaves the field as the bot pre-filled it.
 */
function submittedField(
  input: APIComponentInLabel,
  given: FormValue | undefined,
  at: string,
  world: {
    pick: (ids: string[], type: ComponentType) => void;
    upload: (files: FileUpload[]) => string[];
  },
): Record<string, unknown> {
  const list = <T>(v: T | T[] | undefined): T[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const wrong = (what: string) =>
    new Error(`discordjs-test-kit: ${at} takes ${what}`);
  const required =
    ("required" in input ? input.required : undefined) ??
    input.type !== ComponentType.FileUpload;
  const count = (n: number, min = required ? 1 : 0, max = 1) => {
    if (required && n === 0)
      throw new Error(
        `discordjs-test-kit: ${at} is required, so the Discord app won't submit the form without it`,
      );
    if (n > 0 && (n < min || n > max))
      throw new Error(
        `discordjs-test-kit: ${at} takes ${min === max ? min : `${min} to ${max}`} picks, not ${n}`,
      );
  };
  const byLabel = (
    options: { label: string; value: string }[],
    labels: string[],
  ) =>
    labels.map((label) => {
      const option = options.find((o) => o.label === label);
      if (!option)
        throw new Error(
          `discordjs-test-kit: ${at} has no option "${label}". It offers: ${options.map((o) => `"${o.label}"`).join(", ")}`,
        );
      return option.value;
    });
  switch (input.type) {
    case ComponentType.TextInput: {
      if (given !== undefined && typeof given !== "string") throw wrong("text");
      const value = (given as string | undefined) ?? input.value ?? "";
      if (required && value === "") count(0);
      if (value !== "" && value.length < (input.min_length ?? 0))
        throw new Error(
          `discordjs-test-kit: ${at} needs at least ${input.min_length} characters`,
        );
      if (value.length > (input.max_length ?? 4000))
        throw new Error(
          `discordjs-test-kit: ${at} takes at most ${input.max_length ?? 4000} characters`,
        );
      return { value };
    }
    case ComponentType.StringSelect:
    case ComponentType.CheckboxGroup: {
      if (list(given).some((v) => typeof v !== "string"))
        throw wrong("option labels");
      const values =
        given === undefined
          ? input.options.filter((o) => o.default).map((o) => o.value)
          : byLabel(input.options, list(given as string | string[]));
      count(
        values.length,
        input.min_values ?? (required ? 1 : 0),
        input.max_values ??
          (input.type === ComponentType.StringSelect
            ? 1
            : input.options.length),
      );
      return { values };
    }
    case ComponentType.RadioGroup: {
      if (given !== undefined && typeof given !== "string")
        throw wrong("one option label");
      const value =
        given === undefined
          ? (input.options.find((o) => o.default)?.value ?? null)
          : byLabel(input.options, [given])[0]!;
      count(value === null ? 0 : 1);
      return { value };
    }
    case ComponentType.Checkbox:
      if (given !== undefined && typeof given !== "boolean")
        throw wrong("true or false");
      return { value: given ?? input.default ?? false };
    case ComponentType.UserSelect:
    case ComponentType.RoleSelect:
    case ComponentType.MentionableSelect:
    case ComponentType.ChannelSelect: {
      const picks = list(
        given as { id: string } | { id: string }[] | undefined,
      );
      if (picks.some((p) => typeof p !== "object" || !("id" in p)))
        throw wrong("members, roles or channels");
      const values =
        given === undefined
          ? ((input.default_values ?? []) as { id: string }[]).map((d) => d.id)
          : picks.map((p) => p.id);
      count(
        values.length,
        input.min_values ?? (required ? 1 : 0),
        input.max_values ?? 1,
      );
      world.pick(values, input.type);
      return { values };
    }
    case ComponentType.FileUpload: {
      const files = list(given as FileUpload | FileUpload[] | undefined);
      if (files.some((f) => typeof f !== "object" || !("data" in f)))
        throw wrong("files");
      count(files.length, input.min_values ?? 0, input.max_values ?? 10);
      return { values: world.upload(files) };
    }
    // The types list every component a label holds; a bot can still send a newer one.
    default:
      throw new Error(
        `discordjs-test-kit: ${at} is a component of type ${(input as { type: number }).type}, which forms don't model yet`,
      );
  }
}

function modalFields(
  modal: APIModalInteractionResponseCallbackData,
): { label: string; input: APIComponentInLabel }[] {
  return modal.components.flatMap((top) => {
    if (top.type === ComponentType.Label)
      return [{ label: top.label, input: top.component }];
    if (top.type === ComponentType.ActionRow)
      return top.components.map((input) => ({
        label: input.label ?? "",
        input,
      }));
    return [];
  });
}

function describeModal(modal: APIModalInteractionResponseCallbackData): string {
  const labels = modalFields(modal).map((f) => `"${f.label}"`);
  return `"${modal.title}" (fields ${labels.join(", ") || "none"})`;
}
