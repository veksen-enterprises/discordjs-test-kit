import { once } from "node:events";
import {
  Events,
  RateLimitError,
  type Client,
  type ClientOptions,
  type TextChannel,
} from "discord.js";
/**
 * What a bot sees when Discord misbehaves, and whether the mock makes discord.js react the way it
 * does in production. Each expectation is about @discordjs/rest's real behaviour, not the mock's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordMock,
  Permission,
  respond,
  type DiscordMock,
  type DiscordMockOptions,
} from "../src/internal/mock.js";
import { createBot, deployCommands } from "./fixtures/bot.js";

let mock: DiscordMock;
let client: Client;

async function start(
  opts: { mock?: DiscordMockOptions; client?: Partial<ClientOptions> } = {},
) {
  mock = await createDiscordMock(opts.mock);
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const news = mock.createTextChannel(guild, "news");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  await deployCommands({
    token: mock.token,
    applicationId: mock.state.applicationId,
    guildId: guild.id,
    api: mock.apiUrl,
  });
  const bot = createBot({
    ...opts.client,
    rest: { ...mock.clientOptions.rest, ...opts.client?.rest },
  });
  client = bot.client;
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const announce = () =>
    mock
      .as(alice)
      .slashCommand(general, "announce", { channel: news.id })
      .reply();
  const postsToNews = () =>
    mock.rest.log.filter(
      (r) => r.method === "POST" && r.path === `/channels/${news.id}/messages`,
    );
  return { guild, general, news, alice, bot, announce, postsToNews };
}

afterEach(async () => {
  await client?.destroy();
  await mock?.close();
});

describe("not allowed", () => {
  it("a channel overwrite denying SEND_MESSAGES yields 50013 from the stateful fake, no stubbing", async () => {
    const { news, announce, bot } = await start();
    mock.setOverwrite(
      news,
      { id: mock.state.bot.id, type: 1 },
      { deny: Permission.SendMessages },
    );
    expect((await announce()).content).toBe("failed: 50013");
    expect(bot.errors[0]).toMatchObject({
      name: "DiscordAPIError[50013]",
      status: 403,
    });
  });

  it("without READ_MESSAGE_HISTORY, fetching messages returns none instead of failing", async () => {
    const { news } = await start();
    mock.state.createMessage({
      channelId: news.id,
      authorId: mock.state.bot.id,
      content: "old",
    });
    mock.setOverwrite(
      news,
      { id: mock.state.bot.id, type: 1 },
      { deny: Permission.ReadMessageHistory },
    );
    const channel = (await client.channels.fetch(news.id)) as TextChannel;
    expect((await channel.messages.fetch()).size).toBe(0);
  });

  it("losing VIEW_CHANNEL yields 50001 Missing Access instead", async () => {
    const { guild, news, announce } = await start();
    mock.setOverwrite(
      news,
      { id: guild.id, type: 0 },
      { deny: Permission.ViewChannel },
    );
    expect((await announce()).content).toBe("failed: 50001");
  });

  it("an override can force the same error on any route", async () => {
    const { announce } = await start();
    mock.use(
      "POST",
      "/channels/:id/messages",
      () => respond.missingPermissions(),
      { once: true },
    );
    expect((await announce()).content).toBe("failed: 50013");
  });
});

describe("discord down", () => {
  it("one 5xx is invisible: @discordjs/rest retries it", async () => {
    const { announce, postsToNews } = await start();
    mock.use("POST", "/channels/:id/messages", () => respond.serverError(502), {
      once: true,
    });
    expect((await announce()).content).toBe("posted");
    expect(postsToNews().map((r) => r.status)).toEqual([502, 200]);
  });

  it("persistent 5xx: 1 try + 3 retries, then HTTPError reaches the bot", async () => {
    const { announce, postsToNews } = await start();
    mock.use("POST", "/channels/:id/messages", () => respond.serverError(503));
    expect((await announce()).content).toBe("failed: 503");
    expect(postsToNews()).toHaveLength(4);
  });

  it("a connection closed mid-request is NOT retried: the bot gets the socket error at once", async () => {
    const { announce, postsToNews, bot } = await start();
    mock.use("POST", "/channels/:id/messages", () =>
      respond.connectionClosed(),
    );
    expect((await announce()).content).toBe("failed: UND_ERR_SOCKET");
    expect(postsToNews()).toHaveLength(1);
    expect((bot.errors[0] as Error).message).toBe("other side closed");
  });

  it("a connection reset (ECONNRESET) IS retried, like a 5xx", async () => {
    const { announce, postsToNews } = await start();
    mock.use(
      "POST",
      "/channels/:id/messages",
      () => respond.connectionReset(),
      { once: true },
    );
    expect((await announce()).content).toBe("posted");
    expect(postsToNews()).toHaveLength(2);
  });

  it("gateway drop: discord.js resumes and Discord replays what it missed", async () => {
    const { general, alice } = await start();
    const resumed = once(client, Events.ShardResume);
    mock.gateway.dropConnections();
    mock.as(alice).sendMessage(general, "!ping"); // sent while the bot is disconnected
    await resumed;
    const reply = await mock.waitForMessage(
      (m) => m.author.id === mock.state.bot.id,
      { timeoutMs: 5_000 },
    );
    expect(reply.content).toBe("pong");
  });
});

describe("rate limited", () => {
  it("a route 429 is waited out and retried; the bot just sees latency", async () => {
    const { announce, postsToNews } = await start();
    mock.use(
      "POST",
      "/channels/:id/messages",
      () => respond.rateLimited({ retryAfter: 0.3 }),
      { once: true },
    );
    const t0 = Date.now();
    expect((await announce()).content).toBe("posted");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(postsToNews().map((r) => r.status)).toEqual([429, 200]);
  });

  it("a global 429 stalls other buckets too, but not interaction callbacks", async () => {
    const { general, alice, announce } = await start();
    mock.use(
      "POST",
      "/channels/:id/messages",
      () => respond.rateLimited({ retryAfter: 0.3, global: true }),
      { once: true },
    );
    const t0 = Date.now();
    const announced = announce();
    await new Promise((r) => setTimeout(r, 50)); // let the 429 land first
    // Interaction callbacks are unauthenticated, so @discordjs/rest exempts them from the global wait.
    await mock.as(alice).slashCommand(general, "echo", { text: "hi" }).reply();
    expect(Date.now() - t0).toBeLessThan(300);
    // A different channel is a different bucket, yet it waits out the global limit.
    mock.as(alice).sendMessage(general, "!ping");
    await mock.waitForMessage((m) => m.content === "pong");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect((await announced).content).toBe("posted");
  });

  it("with rejectOnRateLimit the bot gets a RateLimitError instead of waiting", async () => {
    const { announce, bot } = await start({
      client: { rest: { rejectOnRateLimit: ["/channels"] } },
    });
    mock.use(
      "POST",
      "/channels/:id/messages",
      () => respond.rateLimited({ retryAfter: 5 }),
      { once: true },
    );
    expect((await announce()).content).toMatch(/^failed: /);
    const error = bot.errors[0] as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBeGreaterThanOrEqual(5000); // + @discordjs/rest's 50ms offset
  });
});

describe("interaction rules", () => {
  it("replying after the 3s window fails with 10062, as in production", async () => {
    const { general, alice, bot } = await start({
      mock: { interactionDeadlineMs: 50 },
    });
    const run = mock.as(alice).slashCommand(general, "lazy");
    await vi.waitFor(() =>
      expect(bot.errors[0]).toMatchObject({ code: 10062 }),
    );
    expect(run.state).toBe("pending");
  });

  it("waits for the reply as long as Discord's deadline, and says what the user sees", async () => {
    const { general, alice } = await start({
      mock: { interactionDeadlineMs: 50 },
    });
    const t0 = Date.now();

    await expect(
      mock.as(alice).slashCommand(general, "lazy").reply(),
    ).rejects.toThrow(
      `the bot didn't answer within 0.05s, so Discord shows the user "The application did not respond"`,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
