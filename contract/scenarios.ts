import type { Target } from "./targets.js";

export interface Observation {
  status: number;
  body: unknown;
}

const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const MANAGE_GUILD = 1n << 5n;
/** 0.3 seconds of 440 Hz, Ogg Opus (ffmpeg -f lavfi -i sine=frequency=440:duration=0.3 -c:a libopus). */
const CONTRACT_SOUND =
  "T2dnUwACAAAAAAAAAAB1NCDHAAAAAKk6WkYBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAHU0IMcBAAAAI0qA4QE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEeDkAAAAAAAB1NCDHAgAAAN0gujwQRTEsNzQ5LTI4MSwrMi4tGXiCAbdsfkDmAAAKvpqnvv+2hdcKceDda6DjxsXDMsZkHm5jUjpFDIpTj0QYsIxkq+yYlnlsVFMwVU6C5BbKWUnYxwldWXijP/esmIUDV0wlJ/WKw/WMdoevflpzXcfZ1s5DLQlJr2/POrQt+pViWY6ZIm/p7sN4m6MSUUUArNFV/6eRtPYcGJOKCT1PUU1wVpwEDuchPEkJ0n+JP8X8ocV+A3iboxG0HL+omxd8PsanS1kLdd2vT/Jw1SshsLXNMVag2dks7MR66Y3hHjevaYJ6r6R62qihX5Z4m6NfdZz8RdC0OAWcMxKhAbuEHU2z0ObjvosK82FS/jwKKgrJUOHKvDNQh42bz4rPBuL6eJujElOqRLrnpWWA9gdofhXZDzZZltPqqFzFclr1m3VfDAFtGLdGd6UmyovQMVFRuXLGN3kvQoVjeJujX3Wc/ElKIurCxscx5W+cdD1PCbIz63XEb8lJbT3RKfY138M79JGrDt6GeJujElbOI4h0kOQDb84xR2I9c+A3IgbpNSuJZYvT/YSVsThU1PvDIaEPRCdYfdOK/AZ4m6MRtBy/UlD/lDsbAOAkdr4YkiPAqSc2T+Cjkwj1/gmPRlcIBUEtsP5y9Goq4DMtu0N3BYUNi0ibKx91nPxFnnKRI2qUE6UNSymEaECWdnRhxDGtg4AviDrno+lRafTtNhrtYSNqGOhImyrSU6pEuBwG1e7q1NCm84ewhVjmjUtOW91FgNQ3HqhUX1uQqyz9YQf0kkibKx91nPxF70zhx2OetF0/Tq0WDWWhsJ+gw5JdS0X+4svTEloekNEuy+BImyrSU6pITqC1WAN4/dtG+Vq3ssoDzE1tq6wvJRw2HvTdJujCPTEmigy/+IZLw94qQEibKtG0HL9SKIDRXa0RNldzBJqDQtetG8DehVU3VTdPL0rkdgFWBPvIOLN8EFBImysfdZz8RdCz5Xl8SURzaJmJkVNg5vwHb9Galp4g31vj2ZEnT9mba/HjaEhIBdFHOi7/7MbdgOxVdrfB7UGDPZjobFdA";
const MANAGE_CHANNELS = 1n << 4n;

/**
 * Bot-triggerable requests, run in order against one Target. Each step is something a bot
 * does; user actions (slash commands, button presses) can't be triggered from a bot, so they
 * stay out of the contract.
 */
export async function runScenarios(
  target: Target,
): Promise<Record<string, Observation>> {
  const call = async (method: string, path: string, body?: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${target.api}${path}`, {
        method,
        headers: {
          authorization: `Bot ${target.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) =>
          setTimeout(r, (parsed.retry_after ?? 1) * 1000),
        );
        continue;
      }
      return { status: res.status, body: parsed };
    }
  };

  const out: Record<string, Observation> = {};
  out.gatewayBot = await call("GET", "/gateway/bot");
  out.usersMe = await call("GET", "/users/@me");
  out.unknownChannel = await call("GET", "/channels/1000000000000000000");

  out.createChannel = await call("POST", `/guilds/${target.guildId}/channels`, {
    name: `contract-${Date.now()}`,
    type: 0,
  });
  const channelId = (out.createChannel.body as { id?: string })?.id;
  if (!channelId) return out;

  try {
    out.sendMessage = await call("POST", `/channels/${channelId}/messages`, {
      content: "contract test",
    });
    const messageId = (out.sendMessage.body as { id?: string })?.id;
    out.listMessages = await call(
      "GET",
      `/channels/${channelId}/messages?limit=10`,
    );
    if (messageId) {
      out.startThread = await call(
        "POST",
        `/channels/${channelId}/messages/${messageId}/threads`,
        { name: "contract thread" },
      );
      out.editMessage = await call(
        "PATCH",
        `/channels/${channelId}/messages/${messageId}`,
        { content: "contract test, edited" },
      );
      // The invite has no Manage Threads or Pin Messages.
      out.deleteThread = await call("DELETE", `/channels/${messageId}`);
      // Is creating a thread enough to delete it? Deny Manage Channels on the parent and try.
      const second = await call("POST", `/channels/${channelId}/messages`, {
        content: "second thread",
      });
      const secondId = (second.body as { id: string }).id;
      await call(
        "POST",
        `/channels/${channelId}/messages/${secondId}/threads`,
        {
          name: "contract thread 2",
        },
      );
      await call("PUT", `/channels/${channelId}/permissions/${target.botId}`, {
        type: 1,
        allow: "0",
        deny: String(MANAGE_CHANNELS),
      });
      out.deleteThreadWithoutManageChannels = await call(
        "DELETE",
        `/channels/${secondId}`,
      );
      await call(
        "DELETE",
        `/channels/${channelId}/permissions/${target.botId}`,
      );
      out.pinMessage = await call(
        "PUT",
        `/channels/${channelId}/messages/pins/${messageId}`,
      );
      out.listPins = await call("GET", `/channels/${channelId}/messages/pins`);
      const reactions = `/channels/${channelId}/messages/${messageId}/reactions`;
      const thumbsUp = encodeURIComponent("👍");
      out.react = await call("PUT", `${reactions}/${thumbsUp}/@me`);
      out.listReactions = await call("GET", `${reactions}/${thumbsUp}`);
      out.removeUserReaction = await call(
        "DELETE",
        `${reactions}/${thumbsUp}/${target.botId}`,
      );
      await call("PUT", `${reactions}/${thumbsUp}/@me`);
      out.removeEmojiReactions = await call(
        "DELETE",
        `${reactions}/${thumbsUp}`,
      );
      await call("PUT", `${reactions}/${thumbsUp}/@me`);
      out.removeAllReactions = await call("DELETE", reactions);
    }
    const spam: string[] = [];
    for (const content of ["spam 1", "spam 2"]) {
      const sent = await call("POST", `/channels/${channelId}/messages`, {
        content,
      });
      spam.push((sent.body as { id: string }).id);
    }
    out.bulkDeleteTooFew = await call(
      "POST",
      `/channels/${channelId}/messages/bulk-delete`,
      { messages: [spam[0]] },
    );
    out.bulkDelete = await call(
      "POST",
      `/channels/${channelId}/messages/bulk-delete`,
      { messages: spam },
    );
    out.editChannel = await call("PATCH", `/channels/${channelId}`, {
      topic: "contract topic",
      rate_limit_per_user: 5,
    });
    out.listRoles = await call("GET", `/guilds/${target.guildId}/roles`);
    const card = {
      type: 17,
      components: [
        { type: 10, content: "contract card" },
        {
          type: 9,
          components: [{ type: 10, content: "section" }],
          accessory: { type: 2, style: 2, label: "More", custom_id: "more" },
        },
      ],
    };
    out.sendComponentsV2 = await call(
      "POST",
      `/channels/${channelId}/messages`,
      {
        flags: 1 << 15,
        components: [card],
      },
    );
    out.sendTyping = await call("POST", `/channels/${channelId}/typing`);
    out.sendPoll = await call("POST", `/channels/${channelId}/messages`, {
      poll: {
        question: { text: "contract?" },
        answers: [
          { poll_media: { text: "yes" } },
          { poll_media: { text: "no" } },
        ],
        duration: 1,
      },
    });
    const pollId = (out.sendPoll as { body?: { id?: string } }).body?.id;
    if (pollId)
      out.expirePoll = await call(
        "POST",
        `/channels/${channelId}/polls/${pollId}/expire`,
      );
    const plainId = (out.sendComponentsV2 as { body?: { id?: string } }).body
      ?.id;
    if (plainId)
      out.expireNonPoll = await call(
        "POST",
        `/channels/${channelId}/polls/${plainId}/expire`,
      );
    out.sendComponentsV2WithContent = await call(
      "POST",
      `/channels/${channelId}/messages`,
      { flags: 1 << 15, content: "not allowed", components: [card] },
    );
    out.typing = await call("POST", `/channels/${channelId}/typing`);
    // Limits whose field codes are inferred (src/internal/limits.ts).
    out.sendTooManyEmbeds = await call(
      "POST",
      `/channels/${channelId}/messages`,
      {
        embeds: Array.from({ length: 11 }, (_, i) => ({ title: `e${i}` })),
      },
    );
    out.sendEmbedTitleTooLong = await call(
      "POST",
      `/channels/${channelId}/messages`,
      { embeds: [{ title: "x".repeat(257) }] },
    );
    out.pollTooManyAnswers = await call(
      "POST",
      `/channels/${channelId}/messages`,
      {
        poll: {
          question: { text: "?" },
          answers: Array.from({ length: 11 }, (_, i) => ({
            poll_media: { text: `a${i}` },
          })),
          duration: 1,
        },
      },
    );
    out.pollTooLong = await call("POST", `/channels/${channelId}/messages`, {
      poll: {
        question: { text: "?" },
        answers: [{ poll_media: { text: "a" } }],
        duration: 769,
      },
    });
    out.sendTooLong = await call("POST", `/channels/${channelId}/messages`, {
      content: "x".repeat(2001),
    });
    out.sendPollWithoutAnswers = await call(
      "POST",
      `/channels/${channelId}/messages`,
      { poll: { question: { text: "?" }, answers: [], duration: 1 } },
    );
    const first = await call("POST", `/channels/${channelId}/messages`, {
      content: "one",
    });
    const second = await call("POST", `/channels/${channelId}/messages`, {
      content: "two",
    });
    const ids = [first, second].map((m) => (m.body as { id?: string })?.id);
    if (ids[0] && ids[1]) {
      await call(
        "PUT",
        `/channels/${channelId}/messages/${ids[0]}/reactions/%F0%9F%91%8D/@me`,
      );
      // Reading who reacted is taken to need Read Message History, like reading the message.
      await call("PUT", `/channels/${channelId}/permissions/${target.botId}`, {
        type: 1,
        allow: "0",
        deny: String(READ_MESSAGE_HISTORY),
      });
      out.listReactionsWithoutHistory = await call(
        "GET",
        `/channels/${channelId}/messages/${ids[0]}/reactions/%F0%9F%91%8D`,
      );
      await call(
        "DELETE",
        `/channels/${channelId}/permissions/${target.botId}`,
      );
      out.bulkDeleteDuplicate = await call(
        "POST",
        `/channels/${channelId}/messages/bulk-delete`,
        { messages: [ids[0], ids[0], ids[1]] },
      );
    }
    // resources/poll says a poll message "cannot be edited": run 45106174311 showed that means
    // the poll, and its components and content can change.
    {
      const poll = await call("POST", `/channels/${channelId}/messages`, {
        poll: {
          question: { text: "contract?" },
          answers: [
            { poll_media: { text: "a" } },
            { poll_media: { text: "b" } },
          ],
          duration: 1,
        },
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: "End", custom_id: "end" }],
          },
        ],
      });
      out.pollWithButton = poll;
      const pollMessageId = (poll.body as { id?: string })?.id;
      if (pollMessageId) {
        out.pollRemoveButtons = await call(
          "PATCH",
          `/channels/${channelId}/messages/${pollMessageId}`,
          { components: [] },
        );
        out.pollEditContent = await call(
          "PATCH",
          `/channels/${channelId}/messages/${pollMessageId}`,
          { content: "edited" },
        );
      }
    }
    out.sendButtons = await call("POST", `/channels/${channelId}/messages`, {
      content: "buttons",
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 1, label: "Go", custom_id: "go" }],
        },
      ],
    });
    const guild = `/guilds/${target.guildId}`;
    // A run that stopped halfway leaves its emoji and sound behind: remove them first.
    for (const emoji of ((await call("GET", `${guild}/emojis`)).body ?? []) as {
      id: string;
      name: string;
    }[])
      if (emoji.name === "contract")
        await call("DELETE", `${guild}/emojis/${emoji.id}`);
    const leftover = (await call("GET", `${guild}/soundboard-sounds`)).body as {
      items?: { sound_id: string; name: string }[];
    } | null;
    for (const sound of leftover?.items ?? [])
      if (sound.name === "contract")
        await call("DELETE", `${guild}/soundboard-sounds/${sound.sound_id}`);
    out.createChannelNameTooLong = await call("POST", `${guild}/channels`, {
      name: "x".repeat(101),
      type: 0,
    });
    // The test guild's @everyone grants Create Expressions.
    out.createEmoji = await call("POST", `${guild}/emojis`, {
      name: "contract",
      image:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    });
    const emojiId = (out.createEmoji.body as { id?: string })?.id;
    if (emojiId)
      out.deleteEmoji = await call("DELETE", `${guild}/emojis/${emojiId}`);
    // 0.3s of Ogg Opus: Discord refuses a file it can't read with 50110.
    out.createSound = await call("POST", `${guild}/soundboard-sounds`, {
      name: "contract",
      sound: `data:audio/ogg;base64,${CONTRACT_SOUND}`,
    });
    const soundId = (out.createSound.body as { sound_id?: string })?.sound_id;
    if (soundId)
      out.deleteSound = await call(
        "DELETE",
        `${guild}/soundboard-sounds/${soundId}`,
      );
    // The test guild's @everyone grants Change Nickname.
    out.setOwnNickname = await call("PATCH", `${guild}/members/@me`, {
      nick: "contract",
    });
    if (out.setOwnNickname.status === 200)
      await call("PATCH", `${guild}/members/@me`, { nick: null });
    out.listGuildChannels = await call("GET", `${guild}/channels`);
    out.listGuilds = await call("GET", "/users/@me/guilds");
    out.getGuild = await call("GET", `${guild}?with_counts=true`);
    // The invite has no Manage Server: a rename must be refused, and leaves the guild alone.
    out.renameGuild = await call("PATCH", guild, { name: "contract renamed" });
    out.createInvite = await call("POST", `/channels/${channelId}/invites`, {
      max_age: 3600,
    });
    const code = (out.createInvite.body as { code?: string })?.code;
    if (code) {
      const again = await call("POST", `/channels/${channelId}/invites`, {
        max_age: 3600,
      });
      // Not a response: 1 when the second create without `unique` reused the first invite.
      out.inviteReused = {
        status: (again.body as { code?: string })?.code === code ? 1 : 0,
        body: null,
      };
      out.getInvite = await call("GET", `/invites/${code}?with_counts=true`);
      out.listChannelInvites = await call(
        "GET",
        `/channels/${channelId}/invites`,
      );
      out.listGuildInvites = await call("GET", `${guild}/invites`);
      out.deleteInvite = await call("DELETE", `/invites/${code}`);
    }
    out.inviteOver7Days = await call("POST", `/channels/${channelId}/invites`, {
      max_age: 604_801,
      unique: true,
    });
    out.unknownInvite = await call("GET", "/invites/contractnope");
    out.botVoiceState = await call("GET", `${guild}/voice-states/@me`);
    out.listScheduledEvents = await call("GET", `${guild}/scheduled-events`);
    out.listEmojis = await call("GET", `${guild}/emojis`);
    out.listAutoModRules = await call("GET", `${guild}/auto-moderation/rules`);
    out.pruneCount = await call("GET", `${guild}/prune?days=7`);
    out.unknownEmoji = await call("GET", `${guild}/emojis/1`);
    out.listStickers = await call("GET", `${guild}/stickers`);
    out.unknownScheduledEvent = await call(
      "GET",
      `${guild}/scheduled-events/1`,
    );
    // The invite has no Manage Server: the widget settings and templates must be refused.
    out.widgetSettings = await call("GET", `${guild}/widget`);
    out.widgetJson = await call("GET", `${guild}/widget.json`);
    out.preview = await call("GET", `${guild}/preview`);
    out.unknownSticker = await call("GET", "/stickers/1");
    out.listTemplates = await call("GET", `${guild}/templates`);
    out.createTemplate = await call("POST", `${guild}/templates`, {
      name: "contract",
    });
    out.unknownTemplate = await call("GET", "/guilds/templates/contractnope");
    out.listSoundboardSounds = await call("GET", `${guild}/soundboard-sounds`);
    const counts = await call("GET", `${guild}/roles/member-counts`);
    // Keyed by role id, and the two guilds' ids differ: compare one entry's shape.
    out.roleMemberCounts = {
      status: counts.status,
      body:
        counts.body && typeof counts.body === "object"
          ? { "<role id>": Object.values(counts.body)[0] }
          : counts.body,
    };
    out.listAppEmojis = await call(
      "GET",
      `/applications/${target.botId}/emojis`,
    );
    out.archivedPrivateThreads = await call(
      "GET",
      `/channels/${channelId}/threads/archived/private`,
    );
    out.channelPositions = await call("PATCH", `${guild}/channels`, [
      { id: channelId, position: 0 },
    ]);
    // The invite has no Create Events, but the test guild's @everyone grants it.
    const start = new Date(Date.now() + 86_400_000).toISOString();
    out.createScheduledEvent = await call("POST", `${guild}/scheduled-events`, {
      name: "contract event",
      privacy_level: 2,
      entity_type: 3,
      scheduled_start_time: start,
      scheduled_end_time: new Date(Date.parse(start) + 3_600_000).toISOString(),
      entity_metadata: { location: "contract" },
    });
    const eventId = (out.createScheduledEvent.body as { id?: string })?.id;
    if (eventId) {
      // "Only the following are valid status changes: SCHEDULED --> ACTIVE, ACTIVE --> COMPLETED,
      // SCHEDULED --> CANCELED"; the code for another is inferred.
      out.eventSkipsToCompleted = await call(
        "PATCH",
        `${guild}/scheduled-events/${eventId}`,
        { status: 3 },
      );
      out.deleteScheduledEvent = await call(
        "DELETE",
        `${guild}/scheduled-events/${eventId}`,
      );
    }
    const commands = `/applications/${target.botId}${guild}/commands`;
    out.listCommandPermissions = await call("GET", `${commands}/permissions`);
    out.appCommandPermissions = await call(
      "GET",
      `${commands}/${target.botId}/permissions`,
    );
    out.createWebhook = await call("POST", `/channels/${channelId}/webhooks`, {
      name: "contract",
    });
    out.listGuildWebhooks = await call("GET", `${guild}/webhooks`);
    out.auditLog = await call("GET", `${guild}/audit-logs?limit=1`);
    out.denySendMessages = await call(
      "PUT",
      `/channels/${channelId}/permissions/${target.botId}`,
      { type: 1, allow: "0", deny: String(SEND_MESSAGES) },
    );
    out.sendWithoutPermission = await call(
      "POST",
      `/channels/${channelId}/messages`,
      { content: "should be refused" },
    );
    out.typingWithoutSend = await call("POST", `/channels/${channelId}/typing`);
    out.deleteOverwrite = await call(
      "DELETE",
      `/channels/${channelId}/permissions/${target.botId}`,
    );
    out.createRole = await call("POST", `/guilds/${target.guildId}/roles`, {
      name: "contract role",
    });
    const roleId = (out.createRole.body as { id?: string })?.id;
    if (roleId) {
      out.getRole = await call(
        "GET",
        `/guilds/${target.guildId}/roles/${roleId}`,
      );
      // The invite has no Manage Server, so an overwrite granting it must be refused.
      out.overwriteGrantingUnheld = await call(
        "PUT",
        `/channels/${channelId}/permissions/${roleId}`,
        { type: 0, allow: String(MANAGE_GUILD), deny: "0" },
      );
      out.editRole = await call(
        "PATCH",
        `/guilds/${target.guildId}/roles/${roleId}`,
        { name: "contract role, edited" },
      );
      out.deleteRole = await call(
        "DELETE",
        `/guilds/${target.guildId}/roles/${roleId}`,
      );
    }
  } finally {
    out.deleteChannel = await call("DELETE", `/channels/${channelId}`);
  }
  // Let the gateway deliver the dispatches the steps above caused.
  await new Promise((r) => setTimeout(r, 1_000));
  return out;
}

/** The first dispatch of each type, for shape comparison. */
export function firstDispatches(target: Target): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { t, d } of target.dispatches) if (!(t in out)) out[t] = d;
  return out;
}
