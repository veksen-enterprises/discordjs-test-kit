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
const ROLE_NAMES = ["contract role", "contract role, edited"];
const EVENT_NAME = "contract event";
const EMOJI_NAMES = ["contract", "contract_edited"];
const SOUND_NAMES = ["contract", "contract edited"];
const COMMAND_NAME = "contract";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 320x320 solid PNG, the size Discord's sticker upload asks for. */
const STICKER_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAIAAABC8jL9AAACs0lEQVR42u3TQQkAAAwDsfrXNk+rh/0GgSg4uOwEeEoCMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMBgYBXAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIHBwBKAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDEoCBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgOrAAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMHBXjMloEk7zf2QAAAABJRU5ErkJggg==";
const STICKER_NAMES = ["contract", "contract edited"];
const VOICE_STATE_UPDATE = 4;
const REQUEST_GUILD_MEMBERS = 8;
const REQUEST_SOUNDBOARD_SOUNDS = 31;

interface Named {
  id: string;
  name: string;
}

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
      // A Cloudflare error page or an empty 429 isn't JSON; a throw here would skip the cleanup.
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { nonJson: text.slice(0, 200) };
      }
      if (res.status === 429 && attempt < 3) {
        const retryAfter = (parsed as { retry_after?: number } | null)
          ?.retry_after;
        await new Promise((r) => setTimeout(r, (retryAfter ?? 1) * 1000));
        continue;
      }
      return { status: res.status, body: parsed };
    }
  };

  const guild = `/guilds/${target.guildId}`;
  const app = `/applications/${target.botId}`;
  const list = async <T>(path: string): Promise<T[]> => {
    const { body } = await call("GET", path);
    if (Array.isArray(body)) return body as T[];
    return ((body as { items?: T[] } | null)?.items ?? []) as T[];
  };
  // Everything a run creates carries one of these names. A run that stopped halfway (a throw,
  // a timeout, a cancelled job) leaves some behind, so the run sweeps them before and after.
  const sweep = async () => {
    for (const c of await list<Named>(`${guild}/channels`))
      if (/^contract-(\d+|spaced|voice)$/.test(c.name)) {
        // Stopped while it denied itself Manage Channels: lift that first or the delete is refused.
        await call("DELETE", `/channels/${c.id}/permissions/${target.botId}`);
        await call("DELETE", `/channels/${c.id}`);
      }
    for (const r of await list<Named>(`${guild}/roles`))
      if (ROLE_NAMES.includes(r.name))
        await call("DELETE", `${guild}/roles/${r.id}`);
    for (const e of await list<Named>(`${guild}/scheduled-events`))
      if (e.name === EVENT_NAME)
        await call("DELETE", `${guild}/scheduled-events/${e.id}`);
    for (const e of await list<Named>(`${guild}/emojis`))
      if (EMOJI_NAMES.includes(e.name))
        await call("DELETE", `${guild}/emojis/${e.id}`);
    for (const e of await list<Named>(`${app}/emojis`))
      if (EMOJI_NAMES.includes(e.name))
        await call("DELETE", `${app}/emojis/${e.id}`);
    for (const s of await list<{ sound_id: string; name: string }>(
      `${guild}/soundboard-sounds`,
    ))
      if (SOUND_NAMES.includes(s.name))
        await call("DELETE", `${guild}/soundboard-sounds/${s.sound_id}`);
    for (const s of await list<Named>(`${guild}/stickers`))
      if (STICKER_NAMES.includes(s.name))
        await call("DELETE", `${guild}/stickers/${s.id}`);
    for (const path of [`${app}${guild}/commands`, `${app}/commands`])
      for (const c of await list<Named>(path))
        if (c.name === COMMAND_NAME) await call("DELETE", `${path}/${c.id}`);
    const me = await call("GET", `${guild}/members/${target.botId}`);
    if ((me.body as { nick?: string } | null)?.nick === "contract")
      await call("PATCH", `${guild}/members/@me`, { nick: null });
  };

  /** A multipart request, as discord.js sends a file upload. */
  const callForm = async (method: string, path: string, form: FormData) => {
    const res = await fetch(`${target.api}${path}`, {
      method,
      headers: { authorization: `Bot ${target.token}` },
      body: form,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { nonJson: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  };
  const settle = () => new Promise((r) => setTimeout(r, 1_000));

  const out: Record<string, Observation> = {};
  await sweep();
  out.gatewayBot = await call("GET", "/gateway/bot");
  out.gateway = await call("GET", "/gateway");
  out.usersMe = await call("GET", "/users/@me");
  out.getUser = await call("GET", `/users/${target.botId}`);
  out.getApplication = await call("GET", "/applications/@me");
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
      out.getMessage = await call(
        "GET",
        `/channels/${channelId}/messages/${messageId}`,
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
      out.listPinsLegacy = await call("GET", `/channels/${channelId}/pins`);
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
      out.removeOwnReaction = await call(
        "DELETE",
        `${reactions}/${thumbsUp}/@me`,
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
    const doomed = await call("POST", `/channels/${channelId}/messages`, {
      content: "to delete",
    });
    const doomedId = (doomed.body as { id?: string })?.id;
    if (doomedId)
      out.deleteMessage = await call(
        "DELETE",
        `/channels/${channelId}/messages/${doomedId}`,
      );
    out.editChannel = await call("PATCH", `/channels/${channelId}`, {
      topic: "contract topic",
      rate_limit_per_user: 5,
    });
    out.editTopicTooLong = await call("PATCH", `/channels/${channelId}`, {
      topic: "x".repeat(1025),
    });
    out.editSlowmodeTooHigh = await call("PATCH", `/channels/${channelId}`, {
      rate_limit_per_user: 21_601,
    });
    out.replyToUnknownMessage = await call(
      "POST",
      `/channels/${channelId}/messages`,
      {
        content: "reply",
        message_reference: { message_id: "1000000000000000000" },
      },
    );
    out.threadNameTooLong = await call(
      "POST",
      `/channels/${channelId}/threads`,
      {
        name: "x".repeat(101),
        type: 11,
      },
    );
    // A thread without a starter message: join, read its members, leave, archive, then list.
    out.createThread = await call("POST", `/channels/${channelId}/threads`, {
      name: "contract thread 3",
      type: 11,
    });
    const threadId = (out.createThread.body as { id?: string })?.id;
    if (threadId) {
      out.joinThread = await call(
        "PUT",
        `/channels/${threadId}/thread-members/@me`,
      );
      out.getThreadMember = await call(
        "GET",
        `/channels/${threadId}/thread-members/${target.botId}`,
      );
      out.listThreadMembers = await call(
        "GET",
        `/channels/${threadId}/thread-members`,
      );
      // Active threads span the whole guild: compare one entry's shape, as for role counts.
      const active = await call("GET", `${guild}/threads/active`);
      const activeBody = active.body as {
        threads?: { id: string }[];
        members?: { id: string }[];
      } | null;
      out.activeThreads = {
        status: active.status,
        body: activeBody && {
          threads: activeBody.threads?.filter((t) => t.id === threadId),
          members: activeBody.members?.filter((m) => m.id === threadId),
        },
      };
      out.leaveThread = await call(
        "DELETE",
        `/channels/${threadId}/thread-members/@me`,
      );
      out.addThreadMemberById = await call(
        "PUT",
        `/channels/${threadId}/thread-members/${target.botId}`,
      );
      out.removeThreadMemberById = await call(
        "DELETE",
        `/channels/${threadId}/thread-members/${target.botId}`,
      );
      out.archiveThread = await call("PATCH", `/channels/${threadId}`, {
        archived: true,
      });
      out.publicArchivedThreads = await call(
        "GET",
        `/channels/${channelId}/threads/archived/public`,
      );
      out.joinedPrivateArchivedThreads = await call(
        "GET",
        `/channels/${channelId}/users/@me/threads/archived/private`,
      );
    }
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
    if (pollId) {
      out.expirePoll = await call(
        "POST",
        `/channels/${channelId}/polls/${pollId}/expire`,
      );
      out.pollVoters = await call(
        "GET",
        `/channels/${channelId}/polls/${pollId}/answers/1`,
      );
    }
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
    // Whether Discord trims spaces around a channel name: the mock keeps them (inferred).
    out.createChannelSpaced = await call("POST", `${guild}/channels`, {
      name: "  contract-spaced  ",
      type: 0,
    });
    // Not a response: 1 when the name came back trimmed.
    out.channelNameTrimmed = {
      status:
        (out.createChannelSpaced.body as { name?: string })?.name ===
        "contract-spaced"
          ? 1
          : 0,
      body: null,
    };
    const spacedId = (out.createChannelSpaced.body as { id?: string })?.id;
    if (spacedId) await call("DELETE", `/channels/${spacedId}`);
    out.createChannelNameTooLong = await call("POST", `${guild}/channels`, {
      name: "x".repeat(101),
      type: 0,
    });
    // The test guild's @everyone grants Create Expressions.
    out.createEmoji = await call("POST", `${guild}/emojis`, {
      name: "contract",
      image: PNG,
    });
    const emojiId = (out.createEmoji.body as { id?: string })?.id;
    if (emojiId) {
      out.getEmoji = await call("GET", `${guild}/emojis/${emojiId}`);
      // Create Expressions covers editing the expressions the bot made itself.
      out.editEmoji = await call("PATCH", `${guild}/emojis/${emojiId}`, {
        name: "contract_edited",
      });
      out.deleteEmoji = await call("DELETE", `${guild}/emojis/${emojiId}`);
    }
    // 0.3s of Ogg Opus: Discord refuses a file it can't read with 50110.
    out.createSound = await call("POST", `${guild}/soundboard-sounds`, {
      name: "contract",
      sound: `data:audio/ogg;base64,${CONTRACT_SOUND}`,
    });
    const soundId = (out.createSound.body as { sound_id?: string })?.sound_id;
    if (soundId) {
      out.getSound = await call("GET", `${guild}/soundboard-sounds/${soundId}`);
      out.editSound = await call(
        "PATCH",
        `${guild}/soundboard-sounds/${soundId}`,
        { name: "contract edited" },
      );
      // Join a voice channel over the gateway (no audio connection), play the sound, leave.
      const voice = await call("POST", `${guild}/channels`, {
        name: "contract-voice",
        type: 2,
      });
      const voiceId = (voice.body as { id?: string })?.id;
      if (voiceId) {
        target.gatewaySend({
          op: VOICE_STATE_UPDATE,
          d: {
            guild_id: target.guildId,
            channel_id: voiceId,
            // Playing a sound needs the bot neither muted nor deafened.
            self_mute: false,
            self_deaf: false,
          },
        });
        await settle();
        out.botVoiceStateInVoice = await call(
          "GET",
          `${guild}/voice-states/@me`,
        );
        out.botVoiceStateById = await call(
          "GET",
          `${guild}/voice-states/${target.botId}`,
        );
        out.sendSoundboardSound = await call(
          "POST",
          `/channels/${voiceId}/send-soundboard-sound`,
          { sound_id: soundId },
        );
        target.gatewaySend({
          op: VOICE_STATE_UPDATE,
          d: {
            guild_id: target.guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: false,
          },
        });
        await settle();
        await call("DELETE", `/channels/${voiceId}`);
      }
      out.deleteSound = await call(
        "DELETE",
        `${guild}/soundboard-sounds/${soundId}`,
      );
    }
    // The test guild's @everyone grants Change Nickname.
    out.setOwnNickname = await call("PATCH", `${guild}/members/@me`, {
      nick: "contract",
    });
    if (out.setOwnNickname.status === 200)
      await call("PATCH", `${guild}/members/@me`, { nick: null });
    out.getBotMember = await call("GET", `${guild}/members/${target.botId}`);
    // Listing members needs the Server Members intent switched on for the app.
    out.listMembers = await call("GET", `${guild}/members?limit=1`);
    // The bot's own nickname through its user id rather than @me.
    out.setOwnNicknameById = await call(
      "PATCH",
      `${guild}/members/${target.botId}`,
      { nick: "contract" },
    );
    if (out.setOwnNicknameById.status === 200)
      await call("PATCH", `${guild}/members/@me`, { nick: null });
    const botName = (out.usersMe.body as { username?: string })?.username;
    if (botName)
      out.searchMembers = await call(
        "GET",
        `${guild}/members/search?query=${encodeURIComponent(botName)}&limit=1`,
      );
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
    {
      const form = new FormData();
      form.append("name", STICKER_NAMES[0]!);
      form.append("tags", "contract");
      form.append("description", "");
      form.append(
        "file",
        new Blob([Buffer.from(STICKER_PNG, "base64")], { type: "image/png" }),
        "sticker.png",
      );
      out.createSticker = await callForm("POST", `${guild}/stickers`, form);
      const stickerId = (out.createSticker.body as { id?: string })?.id;
      if (stickerId) {
        out.getGuildSticker = await call(
          "GET",
          `${guild}/stickers/${stickerId}`,
        );
        out.getSticker = await call("GET", `/stickers/${stickerId}`);
        out.editSticker = await call(
          "PATCH",
          `${guild}/stickers/${stickerId}`,
          {
            name: STICKER_NAMES[1],
          },
        );
        out.deleteSticker = await call(
          "DELETE",
          `${guild}/stickers/${stickerId}`,
        );
      }
    }
    target.gatewaySend({
      op: REQUEST_GUILD_MEMBERS,
      d: { guild_id: target.guildId, user_ids: [target.botId] },
    });
    target.gatewaySend({
      op: REQUEST_SOUNDBOARD_SOUNDS,
      d: { guild_ids: [target.guildId] },
    });
    // An empty edit: the bot's profile and the application stay as they are.
    out.editBotUser = await call("PATCH", "/users/@me", {});
    const description = (out.getApplication.body as { description?: string })
      ?.description;
    out.editApplication = await call("PATCH", "/applications/@me", {
      description: description ?? "",
    });
    // Opening a DM sends nothing; the guild owner is the one user both guilds have.
    const ownerId = (out.getGuild.body as { owner_id?: string })?.owner_id;
    if (ownerId)
      out.openDm = await call("POST", "/users/@me/channels", {
        recipient_id: ownerId,
      });
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
    out.listAppEmojis = await call("GET", `${app}/emojis`);
    out.createAppEmoji = await call("POST", `${app}/emojis`, {
      name: "contract",
      image: PNG,
    });
    const appEmojiId = (out.createAppEmoji.body as { id?: string })?.id;
    if (appEmojiId) {
      out.getAppEmoji = await call("GET", `${app}/emojis/${appEmojiId}`);
      out.editAppEmoji = await call("PATCH", `${app}/emojis/${appEmojiId}`, {
        name: "contract_edited",
      });
      out.deleteAppEmoji = await call("DELETE", `${app}/emojis/${appEmojiId}`);
    }
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
      name: EVENT_NAME,
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
      out.getScheduledEvent = await call(
        "GET",
        `${guild}/scheduled-events/${eventId}`,
      );
      out.eventUsers = await call(
        "GET",
        `${guild}/scheduled-events/${eventId}/users`,
      );
      out.cancelScheduledEvent = await call(
        "PATCH",
        `${guild}/scheduled-events/${eventId}`,
        { status: 4 },
      );
      out.deleteScheduledEvent = await call(
        "DELETE",
        `${guild}/scheduled-events/${eventId}`,
      );
    }
    const commands = `${app}${guild}/commands`;
    out.listCommandPermissions = await call("GET", `${commands}/permissions`);
    // Registering, reading, editing, overwriting and deleting a command, per guild and globally.
    // The contract app has no commands of its own, so the bulk overwrite replaces nothing real.
    for (const [scope, path] of [
      ["Guild", commands],
      ["Global", `${app}/commands`],
    ] as const) {
      const created = await call("POST", path, {
        name: COMMAND_NAME,
        description: "contract command",
        type: 1,
      });
      out[`create${scope}Command`] = created;
      const commandId = (created.body as { id?: string })?.id;
      out[`list${scope}Commands`] = await call("GET", path);
      if (commandId) {
        out[`get${scope}Command`] = await call("GET", `${path}/${commandId}`);
        out[`edit${scope}Command`] = await call(
          "PATCH",
          `${path}/${commandId}`,
          { description: "contract command, edited" },
        );
      }
      const bulk = await call("PUT", path, [
        { name: COMMAND_NAME, description: "contract command, bulk", type: 1 },
      ]);
      out[`bulk${scope}Commands`] = bulk;
      const bulkId = (bulk.body as { id?: string }[] | null)?.[0]?.id;
      if (bulkId)
        out[`delete${scope}Command`] = await call(
          "DELETE",
          `${path}/${bulkId}`,
        );
    }
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
      name: ROLE_NAMES[0],
    });
    // Not a response: the new role's position, which the mock puts at 1 (inferred).
    out.createdRolePosition = {
      status: (out.createRole.body as { position?: number })?.position ?? -1,
      body: null,
    };
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
      // Manage Roles lets the bot hand itself a role below its own.
      out.addRoleToBot = await call(
        "PUT",
        `${guild}/members/${target.botId}/roles/${roleId}`,
      );
      out.removeRoleFromBot = await call(
        "DELETE",
        `${guild}/members/${target.botId}/roles/${roleId}`,
      );
      // Where the role lands differs between the guilds: compare the answer's shape only.
      out.rolePositions = await call("PATCH", `${guild}/roles`, [
        { id: roleId, position: 1 },
      ]);
      out.deleteRole = await call(
        "DELETE",
        `/guilds/${target.guildId}/roles/${roleId}`,
      );
    }
  } finally {
    out.deleteChannel = await call("DELETE", `/channels/${channelId}`);
    await sweep();
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
