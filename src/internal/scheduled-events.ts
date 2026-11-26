import { randomBytes } from "node:crypto";
import {
  AuditLogEvent,
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  type APIChannel,
  type APIGuildScheduledEvent,
  type APIUser,
} from "discord-api-types/v10";
import { reasonOf, recordAudit } from "./audit.js";
import type { DiscordMock } from "./mock.js";
import { computePermissions, Permission } from "./payloads.js";
import { respond, type RestHandler } from "./rest.js";
import { snowflake } from "./snowflake.js";
import type { GuildRecord } from "./state.js";

// Guild scheduled events that members create in the Discord app. Sources: discord-api-docs
// resources/guild-scheduled-event (the object, field requirements by entity type, List and Get,
// Permissions Requirements), events/gateway-events (Guild Scheduled Event Create, Update, Delete:
// "The inner payload is a guild scheduled event object"), events/gateway (GUILD_SCHEDULED_EVENTS),
// resources/audit-log (GUILD_SCHEDULED_EVENT_CREATE 100, UPDATE 101, DELETE 102), and
// docs.discord.food/resources/guild-scheduled-event for the bot's Create, Modify and Delete and
// List Guild Scheduled Event Users. Stage events and recurrence aren't modelled.

/** Where an event happens: a voice channel, or a place outside Discord. */
export type EventPlace = { channel: APIChannel } | { location: string };

export interface EventInput {
  name: string;
  start: Date;
  place: EventPlace;
  description?: string;
}

const unknownEvent = () =>
  respond.error(404, 10070, "Unknown Guild Scheduled Event");

/**
 * Permissions Requirements: a VOICE event needs CREATE_EVENTS, VIEW_CHANNEL and CONNECT in its
 * channel; an EXTERNAL one CREATE_EVENTS in the guild. Editing or deleting someone else's event
 * needs MANAGE_EVENTS in place of CREATE_EVENTS.
 */
/** Why `userId` can't act on `event`, or undefined when they can. */
function eventPermissionProblem(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
  event: { channel_id: string | null; creator_id?: string | null },
) {
  const channel = event.channel_id
    ? mock.state.requireChannel(event.channel_id)
    : undefined;
  const perms = computePermissions(mock.state, guild, userId, channel);
  const own = !event.creator_id || event.creator_id === userId;
  const manage = own
    ? Permission.CreateEvents | Permission.ManageEvents
    : Permission.ManageEvents;
  const voice = Permission.ViewChannel | Permission.Connect;
  if (!(perms & manage) || (channel && (perms & voice) !== voice))
    return `${own ? "Create Events" : "Manage Events"}${channel ? ", View Channel and Connect in its channel" : ""}`;
  return undefined;
}

function requireEventPermissions(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: { channel_id: string | null; creator_id?: string | null },
  verb: string,
) {
  const missing = eventPermissionProblem(mock, guild, user.id, event);
  if (missing)
    throw new Error(
      `discordjs-test-kit: ${user.username} can't ${verb} that event without ${missing}`,
    );
}

function announce(
  mock: DiscordMock,
  t:
    | GatewayDispatchEvents.GuildScheduledEventCreate
    | GatewayDispatchEvents.GuildScheduledEventUpdate
    | GatewayDispatchEvents.GuildScheduledEventDelete,
  event: APIGuildScheduledEvent,
) {
  // Every bot in the guild with the intent hears it, whatever the event's channel (inferred, not
  // checked: the docs name no permission for receiving it). Without `creator`: contract run
  // 45912869868 got none on create, update or delete of the bot's own event; for an event a
  // user made, inferred.
  const { creator: _, ...sent } = event;
  mock.gateway.dispatch(t, sent, GatewayIntentBits.GuildScheduledEvents);
}

/** `user` creates a scheduled event in `guild`, as from the Discord app. */
export function createScheduledEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  input: EventInput,
): APIGuildScheduledEvent {
  const channel = "channel" in input.place ? input.place.channel : undefined;
  if (channel && channel.type !== ChannelType.GuildVoice)
    throw new Error(
      "discordjs-test-kit: an event's channel must be a voice channel (stage events aren't modelled)",
    );
  if (input.name.length < 1 || input.name.length > 100)
    throw new Error("discordjs-test-kit: an event's name is 1-100 characters");
  requireEventPermissions(
    mock,
    guild,
    user,
    { channel_id: channel?.id ?? null },
    "create",
  );
  const event: APIGuildScheduledEvent = {
    id: snowflake(),
    guild_id: guild.id,
    channel_id: channel?.id ?? null,
    creator_id: user.id,
    creator: user,
    name: input.name,
    description: input.description ?? null,
    scheduled_start_time: input.start.toISOString(),
    // EXTERNAL requires an end time; the Discord app's default isn't documented, so the Mock
    // ends a place event an hour after it starts.
    scheduled_end_time: channel
      ? null
      : new Date(input.start.getTime() + 3_600_000).toISOString(),
    privacy_level: GuildScheduledEventPrivacyLevel.GuildOnly,
    status: GuildScheduledEventStatus.Scheduled,
    entity_type: channel
      ? GuildScheduledEventEntityType.Voice
      : GuildScheduledEventEntityType.External,
    entity_id: null,
    entity_metadata:
      "location" in input.place ? { location: input.place.location } : null,
    image: null,
    recurrence_rule: null,
    // Sent by Discord on every event (contract run 45099526148); not in discord-api-types.
    sku_ids: [],
    guild_scheduled_event_exceptions: [],
  } as APIGuildScheduledEvent;
  addEvent(mock, guild, user.id, event);
  return event;
}

/**
 * Stores a new event, announces it and audits it. "Creating an event will automatically add you
 * as a subscriber"; whether that subscription is announced too is undocumented, so it isn't
 * (inferred).
 */
function addEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  creatorId: string,
  event: APIGuildScheduledEvent,
  reason?: string,
) {
  mock.state.scheduledEvents.set(event.id, event);
  mock.state.eventSubscribers.set(event.id, new Set([creatorId]));
  announce(mock, GatewayDispatchEvents.GuildScheduledEventCreate, event);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.GuildScheduledEventCreate,
    user_id: creatorId,
    target_id: event.id,
    changes: [{ key: "name", new_value: event.name }],
    reason,
  });
}

/** `user` edits `event`'s name, description or start time. */
export function editScheduledEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: APIGuildScheduledEvent,
  changes: { name?: string; description?: string; start?: Date },
) {
  requireEventPermissions(mock, guild, user, event, "edit");
  // Status transitions: a COMPLETED or CANCELED event "can no longer be updated".
  if (event.status !== GuildScheduledEventStatus.Scheduled)
    throw new Error("discordjs-test-kit: only a scheduled event can be edited");
  const before = { ...event };
  if (changes.name !== undefined) event.name = changes.name;
  if (changes.description !== undefined)
    event.description = changes.description;
  if (changes.start) {
    const shift =
      changes.start.getTime() - Date.parse(event.scheduled_start_time);
    event.scheduled_start_time = changes.start.toISOString();
    if (event.scheduled_end_time)
      event.scheduled_end_time = new Date(
        Date.parse(event.scheduled_end_time) + shift,
      ).toISOString();
  }
  announce(mock, GatewayDispatchEvents.GuildScheduledEventUpdate, event);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.GuildScheduledEventUpdate,
    user_id: user.id,
    target_id: event.id,
    changes: (["name", "description", "scheduled_start_time"] as const)
      .filter((key) => before[key] !== event[key])
      .map(
        (key) =>
          ({ key, old_value: before[key], new_value: event[key] }) as never,
      ),
  });
}

/** `user` deletes `event`. */
export function deleteScheduledEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: APIGuildScheduledEvent,
) {
  requireEventPermissions(mock, guild, user, event, "delete");
  removeEvent(mock, guild, user.id, event);
}

function removeEvent(
  mock: DiscordMock,
  guild: GuildRecord,
  userId: string,
  event: APIGuildScheduledEvent,
  reason?: string,
) {
  mock.state.scheduledEvents.delete(event.id);
  mock.state.eventSubscribers.delete(event.id);
  announce(mock, GatewayDispatchEvents.GuildScheduledEventDelete, event);
  recordAudit(mock, guild, {
    action_type: AuditLogEvent.GuildScheduledEventDelete,
    user_id: userId,
    target_id: event.id,
    changes: [{ key: "name", old_value: event.name }],
    reason,
  });
}

/**
 * `user` marks `event` Interested, or takes it back; the bot hears GUILD_SCHEDULED_EVENT_USER_ADD
 * or _REMOVE with GUILD_SCHEDULED_EVENTS (gateway-events#guild-scheduled-event-user-add: "a guild
 * scheduled event user object", plus guild_id as discord-api-types and discord.js read it).
 * Marking twice, or taking back what wasn't marked, sends nothing (inferred).
 */
export function setInterest(
  mock: DiscordMock,
  guild: GuildRecord,
  user: APIUser,
  event: APIGuildScheduledEvent,
  interested: boolean,
) {
  const subscribers = mock.state.eventSubscribers.get(event.id)!;
  if (subscribers.has(user.id) === interested) return;
  if (interested) subscribers.add(user.id);
  else subscribers.delete(user.id);
  mock.gateway.dispatch(
    interested
      ? GatewayDispatchEvents.GuildScheduledEventUserAdd
      : GatewayDispatchEvents.GuildScheduledEventUserRemove,
    {
      guild_scheduled_event_id: event.id,
      user_id: user.id,
      guild_id: guild.id,
      response: 1,
    },
    GatewayIntentBits.GuildScheduledEvents,
  );
}

/** The guild's events, for GUILD_CREATE's guild_scheduled_events. */
export function scheduledEventsIn(mock: DiscordMock, guildId: string) {
  return [...mock.state.scheduledEvents.values()].filter(
    (event) => event.guild_id === guildId,
  );
}

export function registerScheduledEventRoutes(
  mock: DiscordMock,
  authed: (handler: RestHandler) => RestHandler,
) {
  const { rest, state } = mock;
  // Get Permissions: VIEW_CHANNEL in a VOICE event's channel, none for EXTERNAL. The docs don't say
  // whether List leaves out the events the bot can't get or refuses (inferred: left out).
  const visible = (guild: GuildRecord, event: APIGuildScheduledEvent) =>
    !event.channel_id ||
    (computePermissions(
      state,
      guild,
      state.bot.id,
      state.requireChannel(event.channel_id),
    ) &
      Permission.ViewChannel) !==
      0n;
  const withCount = (event: APIGuildScheduledEvent, count: boolean) =>
    count
      ? {
          ...event,
          user_count: state.eventSubscribers.get(event.id)?.size ?? 0,
        }
      : event;

  rest.route(
    "GET",
    "/guilds/:guildId/scheduled-events",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const count = req.query.get("with_user_count") === "true";
      return respond.json(
        scheduledEventsIn(mock, guild.id)
          .filter((event) => visible(guild, event))
          .map((event) => withCount(event, count)),
      );
    }),
  );

  rest.route(
    "GET",
    "/guilds/:guildId/scheduled-events/:eventId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const event = state.scheduledEvents.get(req.params.eventId!);
      if (!event || event.guild_id !== guild.id) return unknownEvent();
      if (!visible(guild, event)) return respond.missingAccess();
      return respond.json(
        withCount(event, req.query.get("with_user_count") === "true"),
      );
    }),
  );

  const eventIn = (guild: GuildRecord, eventId: string) => {
    const event = state.scheduledEvents.get(eventId);
    return event && event.guild_id === guild.id ? event : undefined;
  };
  const isTime = (value: unknown) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value));
  // The cover is image data (docs.discord.food/reference#cdn-data); the event keeps its hash. The
  // CDN serves covers as PNG, JPEG or WebP, so another type answering 50035 is inferred; a GIF,
  // which CDN data allows but the cover endpoint doesn't list, is a Gap. The hash is random: only
  // its presence is observable. `image/jpg` is what discord.js's resolveBase64 sends for a file.
  const coverProblem = (image: unknown) => {
    if (/^data:image\/(png|jpe?g|webp);base64,/.test(String(image)))
      return undefined;
    if (/^data:image\/gif;base64,/.test(String(image)))
      return rest.gap("a GIF scheduled event cover");
    return respond.invalidFormBody();
  };
  const coverHash = () => randomBytes(16).toString("hex");

  // Create Guild Scheduled Event. Required: name, privacy_level (GUILD_ONLY is the only level),
  // scheduled_start_time, entity_type; a VOICE event needs a voice channel_id, an EXTERNAL one
  // entity_metadata.location and scheduled_end_time. `image` sets the cover. Stage events and
  // recurrence_rule are a Gap, as is the 100 SCHEDULED/ACTIVE limit, whose error isn't documented. Bad input
  // answering 50035, and 50013 for missing permissions, are inferred.
  rest.route(
    "POST",
    "/guilds/:guildId/scheduled-events",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.entity_type === GuildScheduledEventEntityType.StageInstance)
        return rest.gap("a stage scheduled event");
      if (body.image != null) {
        const problem = coverProblem(body.image);
        if (problem) return problem;
      }
      if (body.recurrence_rule != null)
        return rest.gap("a recurring scheduled event");
      const active = scheduledEventsIn(mock, guild.id).filter(
        (e) =>
          e.status === GuildScheduledEventStatus.Scheduled ||
          e.status === GuildScheduledEventStatus.Active,
      );
      if (active.length >= 100)
        return rest.gap("more than 100 scheduled or active events");
      const voice = body.entity_type === GuildScheduledEventEntityType.Voice;
      const external =
        body.entity_type === GuildScheduledEventEntityType.External;
      const channel =
        typeof body.channel_id === "string"
          ? state.channels.get(body.channel_id)
          : undefined;
      const location = (body.entity_metadata as { location?: unknown } | null)
        ?.location;
      if (
        typeof body.name !== "string" ||
        body.name.length < 1 ||
        body.name.length > 100 ||
        body.privacy_level !== GuildScheduledEventPrivacyLevel.GuildOnly ||
        !isTime(body.scheduled_start_time) ||
        (!voice && !external) ||
        (voice &&
          (channel?.type !== ChannelType.GuildVoice ||
            channel.guild_id !== guild.id)) ||
        (external &&
          (body.channel_id != null ||
            typeof location !== "string" ||
            !isTime(body.scheduled_end_time)))
      )
        return respond.invalidFormBody();
      if (
        eventPermissionProblem(mock, guild, state.bot.id, {
          channel_id: channel?.id ?? null,
        })
      )
        return respond.missingPermissions();
      const event = {
        id: snowflake(),
        guild_id: guild.id,
        channel_id: channel?.id ?? null,
        creator_id: state.bot.id,
        creator: state.bot,
        name: body.name,
        description: (body.description as string | undefined) ?? null,
        scheduled_start_time: new Date(
          body.scheduled_start_time as string,
        ).toISOString(),
        scheduled_end_time: isTime(body.scheduled_end_time)
          ? new Date(body.scheduled_end_time as string).toISOString()
          : null,
        privacy_level: GuildScheduledEventPrivacyLevel.GuildOnly,
        status: GuildScheduledEventStatus.Scheduled,
        entity_type: body.entity_type,
        entity_id: null,
        entity_metadata: external ? { location } : null,
        image: body.image != null ? coverHash() : null,
        recurrence_rule: null,
        sku_ids: [],
        guild_scheduled_event_exceptions: [],
      } as APIGuildScheduledEvent;
      addEvent(mock, guild, state.bot.id, event, reasonOf(req));
      // Discord's create response has creator_id but no `creator` (seen in the contract run).
      const { creator: _, ...created } = event;
      return respond.json(created);
    }),
  );

  // Modify Guild Scheduled Event. "Only the following are valid status changes: SCHEDULED -->
  // ACTIVE, ACTIVE --> COMPLETED, SCHEDULED --> CANCELED". `image` replaces the cover; null isn't
  // documented as removing it, so that's a Gap. Changing channel_id or entity_type, and
  // recurrence_rule, are a Gap. Someone else's event needs Manage Events. An invalid
  // change answering 50035 is inferred.
  const MODIFIABLE = [
    "name",
    "description",
    "scheduled_start_time",
    "scheduled_end_time",
    "status",
    "entity_metadata",
    "privacy_level",
    "image",
  ];
  const NEXT_STATUS: Partial<
    Record<GuildScheduledEventStatus, GuildScheduledEventStatus[]>
  > = {
    [GuildScheduledEventStatus.Scheduled]: [
      GuildScheduledEventStatus.Active,
      GuildScheduledEventStatus.Canceled,
    ],
    [GuildScheduledEventStatus.Active]: [GuildScheduledEventStatus.Completed],
  };
  rest.route(
    "PATCH",
    "/guilds/:guildId/scheduled-events/:eventId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const event = eventIn(guild, req.params.eventId!);
      if (!event) return unknownEvent();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const other = Object.keys(body).find((key) => !MODIFIABLE.includes(key));
      if (other) return rest.gap(`PATCH a scheduled event's ${other}`);
      if (eventPermissionProblem(mock, guild, state.bot.id, event))
        return respond.missingPermissions();
      if ("image" in body) {
        if (body.image === null)
          return rest.gap("removing a scheduled event's cover");
        const problem = coverProblem(body.image);
        if (problem) return problem;
      }
      const status = body.status as GuildScheduledEventStatus | undefined;
      const location = (body.entity_metadata as { location?: unknown } | null)
        ?.location;
      if (
        ("name" in body &&
          (typeof body.name !== "string" ||
            body.name.length < 1 ||
            body.name.length > 100)) ||
        ("privacy_level" in body &&
          body.privacy_level !== GuildScheduledEventPrivacyLevel.GuildOnly) ||
        ("scheduled_start_time" in body &&
          !isTime(body.scheduled_start_time)) ||
        ("scheduled_end_time" in body && !isTime(body.scheduled_end_time)) ||
        ("entity_metadata" in body &&
          (event.entity_type !== GuildScheduledEventEntityType.External ||
            typeof location !== "string")) ||
        (status !== undefined &&
          status !== event.status &&
          !NEXT_STATUS[event.status]?.includes(status))
      )
        return respond.invalidFormBody();
      const changed = event as {
        name: string;
        description?: string | null;
        scheduled_start_time: string;
        scheduled_end_time: string | null;
        status: GuildScheduledEventStatus;
        entity_metadata: { location?: string } | null;
      };
      if ("name" in body) changed.name = body.name as string;
      if ("description" in body)
        changed.description = (body.description as string | null) ?? null;
      if ("scheduled_start_time" in body)
        changed.scheduled_start_time = new Date(
          body.scheduled_start_time as string,
        ).toISOString();
      if ("scheduled_end_time" in body)
        changed.scheduled_end_time = new Date(
          body.scheduled_end_time as string,
        ).toISOString();
      if (status !== undefined) changed.status = status;
      if ("entity_metadata" in body)
        changed.entity_metadata = { location: location as string };
      if ("image" in body) event.image = coverHash();
      announce(mock, GatewayDispatchEvents.GuildScheduledEventUpdate, event);
      recordAudit(mock, guild, {
        action_type: AuditLogEvent.GuildScheduledEventUpdate,
        user_id: state.bot.id,
        target_id: event.id,
        reason: reasonOf(req),
      });
      // Without `creator`, like the create response (contract run 45912869868).
      const { creator: _, ...modified } = event;
      return respond.json(modified);
    }),
  );

  // Delete Guild Scheduled Event: 204.
  rest.route(
    "DELETE",
    "/guilds/:guildId/scheduled-events/:eventId",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const event = eventIn(guild, req.params.eventId!);
      if (!event) return unknownEvent();
      if (eventPermissionProblem(mock, guild, state.bot.id, event))
        return respond.missingPermissions();
      removeEvent(mock, guild, state.bot.id, event, reasonOf(req));
      return respond.noContent();
    }),
  );

  // List Guild Scheduled Event Users: bots "always receive the new response body format", a list
  // of guild scheduled event user objects. Ascending by user id (inferred), `limit` 1-100
  // (default 100), `before`/`after` user ids, `with_member` adds the member.
  rest.route(
    "GET",
    "/guilds/:guildId/scheduled-events/:eventId/users",
    authed((req) => {
      const guild = state.guilds.get(req.params.guildId!);
      if (!guild) return respond.error(404, 10004, "Unknown Guild");
      const event = eventIn(guild, req.params.eventId!);
      if (!event) return unknownEvent();
      if (!visible(guild, event)) return respond.missingAccess();
      const limit = Number(req.query.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return respond.invalidFormBody();
      const before = req.query.get("before");
      const after = req.query.get("after");
      const withMember = req.query.get("with_member") === "true";
      const ids = [...(state.eventSubscribers.get(event.id) ?? [])]
        .filter((id) => !before || BigInt(id) < BigInt(before))
        .filter((id) => !after || BigInt(id) > BigInt(after))
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const page = before ? ids.slice(-limit) : ids.slice(0, limit);
      return respond.json(
        page.map((id) => {
          const member = guild.members.get(id);
          return {
            guild_scheduled_event_id: event.id,
            response: 1,
            user_id: id,
            user: state.requireUser(id),
            ...(withMember && member
              ? { member: { ...member, user: undefined } }
              : {}),
          };
        }),
      );
    }),
  );
}
