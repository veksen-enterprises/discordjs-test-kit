import { once } from "node:events";
import { AuditLogEvent, Client, Events, GatewayIntentBits } from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";
import { Permission } from "../src/internal/payloads.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start(botPermissions: bigint) {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const mod = mock.createUser("mod");
  mock.addMember(guild, mod);
  mock.createRole(
    guild,
    "mods",
    Permission.KickMembers | Permission.BanMembers,
    [mod],
  );
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  mock.grantBot(botPermissions);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
    ],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  return {
    guild,
    general,
    mod,
    alice,
    cached: client.guilds.cache.get(guild.id)!,
  };
}

it("names the moderator who kicked a member, in the log and as it happens", async () => {
  const { guild, mod, alice, cached } = await start(Permission.ViewAuditLog);
  const logged = once(client, Events.GuildAuditLogEntryCreate);

  mock.moderate(guild, mod, alice, "kick", "spam");

  const [entry] = await logged;
  expect([
    entry.action,
    entry.executorId,
    entry.targetId,
    entry.reason,
  ]).toEqual([AuditLogEvent.MemberKick, mod.id, alice.id, "spam"]);
  const log = await cached.fetchAuditLogs({
    type: AuditLogEvent.MemberKick,
    limit: 1,
  });
  expect(log.entries.first()?.executor?.username).toBe("mod");
  mock.assertNoUnhandledRequests();
});

it("logs who renamed the server, with the old and new name", async () => {
  // Arrange
  const { guild, cached } = await start(Permission.ViewAuditLog);
  const owner = mock.state.requireUser(guild.ownerId);

  // Act
  mock.renameGuild(guild, "Titan", owner.id);

  // Assert
  const log = await cached.fetchAuditLogs({ type: AuditLogEvent.GuildUpdate });
  const entry = log.entries.first();
  expect([entry?.executorId, entry?.changes]).toEqual([
    owner.id,
    [{ key: "name", old: "g", new: "Titan" }],
  ]);
});

it("logs the bot's own actions with their reason, newest first", async () => {
  const { alice, cached } = await start(
    Permission.ViewAuditLog |
      Permission.BanMembers |
      Permission.ManageNicknames,
  );
  const member = await cached.members.fetch(alice.id);

  await member.setNickname("Al", "rename");
  await cached.members.ban(alice.id, { reason: "spam, again" });

  const log = await cached.fetchAuditLogs();
  expect(log.entries.map((e) => [e.action, e.reason])).toEqual([
    [AuditLogEvent.MemberBanAdd, "spam, again"],
    [AuditLogEvent.MemberUpdate, "rename"],
  ]);
  expect(log.entries.last()?.changes).toEqual([{ key: "nick", new: "Al" }]);
  expect((await cached.bans.fetch(alice.id)).reason).toBe("spam, again");
  mock.assertNoUnhandledRequests();
});

it("refuses the log without View Audit Log, and keeps the entry event from that bot", async () => {
  const { guild, mod, alice, cached } = await start(0n);
  let heard = false;
  client.on(Events.GuildAuditLogEntryCreate, () => (heard = true));

  mock.moderate(guild, mod, alice, "ban");
  await mock.waitForIdle();

  expect(heard).toBe(false);
  await expect(cached.fetchAuditLogs()).rejects.toMatchObject({ code: 50013 });
});

it("doesn't let a member without Ban Members ban", async () => {
  const { guild, mod, alice } = await start(0n);

  expect(() => mock.moderate(guild, alice, mod, "ban")).toThrow("Ban Members");
});
