import { once } from "node:events";
import type { APIChannel, APITextChannel } from "discord-api-types/v10";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  OverwriteType,
  type TextChannel,
} from "discord.js";
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
  const record = mock.createGuild("g");
  const alice = mock.createUser("alice");
  mock.addMember(record, alice);
  const admin = mock.createUser("admin");
  mock.addMember(record, admin);
  mock.createRole(record, "admins", Permission.Administrator, [admin]);
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
  const guild = client.guilds.cache.get(record.id)!;
  return { guild, record, alice, admin };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DiscordAPIError);
  return error as DiscordAPIError;
}

it("fetches a member, and answers 10007 for someone who isn't one", async () => {
  const { guild, alice } = await start(0n);
  const stranger = mock.createUser("stranger");

  expect((await guild.members.fetch(alice.id)).user.username).toBe("alice");
  expect((await refusal(guild.members.fetch(stranger.id))).code).toBe(10007);
});

it("times a member out with Moderate Members, and the bot hears the update", async () => {
  const { guild, record, alice } = await start(Permission.ModerateMembers);
  const member = await guild.members.fetch(alice.id);
  const updated = once(client, Events.GuildMemberUpdate);

  await member.timeout(60_000, "spam");

  const [, after] = await updated;
  expect(after.isCommunicationDisabled()).toBe(true);
  expect(record.members.get(alice.id)!.communication_disabled_until).not.toBe(
    null,
  );
});

it("refuses a timeout without the permission, for an admin, and past 28 days", async () => {
  const { guild, alice, admin } = await start(Permission.ModerateMembers);
  const target = await guild.members.fetch(alice.id);

  expect(
    (await refusal((await guild.members.fetch(admin.id)).timeout(60_000))).code,
  ).toBe(50013);
  expect((await refusal(target.timeout(29 * 24 * 60 * 60 * 1000))).code).toBe(
    50035,
  );
});

it("refuses a timeout to a bot without Moderate Members", async () => {
  const { guild, alice } = await start(0n);

  const error = await refusal(
    (await guild.members.fetch(alice.id)).timeout(60_000),
  );

  expect(error.code).toBe(50013);
});

it("kicks a member below the bot, and refuses one ranked above it", async () => {
  const { guild, record, alice, admin } = await start(Permission.KickMembers);
  const removed = once(client, Events.GuildMemberRemove);

  await (await guild.members.fetch(alice.id)).kick();

  expect((await removed)[0].id).toBe(alice.id);
  expect(record.members.has(alice.id)).toBe(false);
  // The admins role was created before the bot's, so it sits below it: move it above.
  record.roles.get([...record.members.get(admin.id)!.roles][0]!)!.position = 99;
  expect((await refusal(guild.members.kick(admin.id))).code).toBe(50013);
});

it("bans and unbans, firing the ban events and removing the member", async () => {
  const { guild, record, alice } = await start(Permission.BanMembers);
  const banned = once(client, Events.GuildBanAdd);

  await guild.members.ban(alice.id, { reason: "spam" });

  expect((await banned)[0].user.id).toBe(alice.id);
  expect(record.members.has(alice.id)).toBe(false);
  expect((await guild.bans.fetch(alice.id)).reason).toBe("spam");
  const unbanned = once(client, Events.GuildBanRemove);
  await guild.members.unban(alice.id);
  await unbanned;
  expect(
    (await refusal(guild.bans.fetch({ user: alice.id, force: true }))).code,
  ).toBe(10026);
});

it("refuses a role above the bot's, and adds and removes one below it", async () => {
  const { guild, record, alice } = await start(Permission.ManageRoles);
  const helpers = mock.createRole(record, "helpers", 0n);
  const member = await guild.members.fetch(alice.id);
  // Created after the bot's role, so above it until moved below.
  expect((await refusal(member.roles.add(helpers.id))).code).toBe(50013);
  record.roles.get(helpers.id)!.position = 1;

  await member.roles.add(helpers.id);
  expect(record.members.get(alice.id)!.roles).toContain(helpers.id);
  await member.roles.remove(helpers.id);
  expect(record.members.get(alice.id)!.roles).not.toContain(helpers.id);
});

it("creates a role just above @everyone, edits and deletes it, and refuses to grant what the bot lacks", async () => {
  const { guild, record, alice } = await start(Permission.ManageRoles);
  const created = once(client, Events.GuildRoleCreate);

  const role = await guild.roles.create({ name: "helpers" });
  await (await guild.members.fetch(alice.id)).roles.add(role);
  const renamed = await role.edit({ name: "helpers+" });

  expect((await created)[0].id).toBe(role.id);
  expect(role.position).toBe(1);
  expect(renamed.name).toBe("helpers+");
  expect(
    (await refusal(guild.roles.create({ permissions: Permission.BanMembers })))
      .code,
  ).toBe(50013);
  const deleted = once(client, Events.GuildRoleDelete);
  await role.delete();
  expect((await deleted)[0].id).toBe(role.id);
  expect(record.members.get(alice.id)!.roles).not.toContain(role.id);
});

it("deletes a channel overwrite, and the bot hears the channel update", async () => {
  const { guild, record, alice } = await start(Permission.ManageRoles);
  const channel = await guild.channels.fetch(
    mock.createTextChannel(record, "general").id,
  );
  if (!channel?.isTextBased() || channel.isThread()) throw new Error("text");
  const member = await guild.members.fetch(alice.id);
  await channel.permissionOverwrites.create(member, { SendMessages: false });
  const cleared = new Promise((resolve) =>
    client.on(Events.ChannelUpdate, (_, after) => {
      if (
        "permissionOverwrites" in after &&
        !after.permissionOverwrites.cache.has(alice.id)
      )
        resolve(after.id);
    }),
  );

  await channel.permissionOverwrites.delete(member);

  expect(await cleared).toBe(channel.id);
  expect(
    (await refusal(channel.permissionOverwrites.delete(member))).code,
  ).toBe(10009);
});

it("lists every role, including one made since the bot connected", async () => {
  const { guild, record } = await start(0n);
  const added = mock.createRole(record, "late", 0n);

  const roles = await guild.roles.fetch();

  expect(roles.map((r) => r.name).sort()).toEqual(
    ["@everyone", "admins", "bot", "late"].sort(),
  );
  expect(guild.roles.cache.has(added.id)).toBe(true);
  mock.assertNoUnhandledRequests();
});

it("edits a channel's name, topic and slowmode with Manage Channels, and the bot hears it", async () => {
  const { guild, record } = await start(Permission.ManageChannels);
  const channel = await guild.channels.fetch(
    mock.createTextChannel(record, "general").id,
  );
  if (channel?.type !== ChannelType.GuildText) throw new Error("text");
  const updated = once(client, Events.ChannelUpdate);

  await channel.edit({
    name: "rules",
    topic: "read me",
    rateLimitPerUser: 30,
  });

  const [, after] = await updated;
  expect(after).toMatchObject({
    name: "rules",
    topic: "read me",
    rateLimitPerUser: 30,
  });
  expect((await refusal(channel.setName("x".repeat(101)))).code).toBe(50035);
  mock.assertNoUnhandledRequests();
});

it("moves a channel into a category and syncs its overwrites, but not past the bot's own permissions", async () => {
  const { guild, record, alice } = await start(
    Permission.ManageChannels | Permission.ManageRoles,
  );
  const category = mock.createCategory(record, "staff");
  mock.setOverwrite(
    category,
    { id: record.id, type: 0 },
    { deny: Permission.SendMessages },
  );
  const channel = await guild.channels.fetch(
    mock.createTextChannel(record, "mods").id,
  );
  if (channel?.type !== ChannelType.GuildText) throw new Error("text");

  await channel.setParent(category.id, { lockPermissions: true });

  const stored = mock.state.requireChannel(channel.id) as APITextChannel;
  expect(stored.parent_id).toBe(category.id);
  expect(stored.permission_overwrites).toEqual([
    {
      id: record.id,
      type: 0,
      allow: "0",
      deny: String(Permission.SendMessages),
    },
  ]);
  expect(
    (
      await refusal(
        channel.permissionOverwrites.set([
          {
            id: alice.id,
            type: OverwriteType.Member,
            allow: [Permission.BanMembers],
          },
        ]),
      )
    ).code,
  ).toBe(50013);
});

it("refuses an overwrite allowing a permission the bot doesn't hold", async () => {
  // Arrange
  const { guild, record, alice } = await start(
    Permission.ManageChannels | Permission.ManageRoles,
  );
  const channel = await guild.channels.fetch(
    mock.createTextChannel(record, "mods").id,
  );
  if (channel?.type !== ChannelType.GuildText) throw new Error("text");

  // Act
  const edited = channel.permissionOverwrites.edit(
    alice.id,
    { BanMembers: true },
    { type: OverwriteType.Member },
  );

  // Assert
  expect((await refusal(edited)).code).toBe(50013);
});

it("lets an overwrite grant what the bot doesn't hold once the bot has Manage Roles in that channel", async () => {
  // Arrange
  const { guild, record, alice } = await start(
    Permission.ManageChannels | Permission.ManageRoles,
  );
  const mods = mock.createTextChannel(record, "mods");
  mock.setOverwrite(
    mods,
    { id: mock.state.bot.id, type: 1 },
    { allow: Permission.ManageRoles },
  );
  const channel = await guild.channels.fetch(mods.id);
  if (channel?.type !== ChannelType.GuildText) throw new Error("text");

  // Act
  await channel.permissionOverwrites.edit(
    alice.id,
    { BanMembers: true },
    { type: OverwriteType.Member },
  );

  // Assert
  const stored = mock.state.requireChannel(mods.id) as APITextChannel;
  expect(stored.permission_overwrites?.find((o) => o.id === alice.id)).toEqual({
    id: alice.id,
    type: 1,
    allow: String(Permission.BanMembers),
    deny: "0",
  });
});

it("deletes the banned member's messages from the window the bot asks for, and keeps older ones", async () => {
  // Arrange
  const { guild, record, alice } = await start(Permission.BanMembers);
  const general = mock.createTextChannel(record, "general");
  const old = mock.as(alice).sendMessage(general, "last week");
  old.timestamp = new Date(Date.now() - 2 * 3_600_000).toISOString();
  mock.as(alice).sendMessage(general, "spam");

  // Act
  await guild.members.ban(alice.id, { deleteMessageSeconds: 3_600 });

  // Assert
  expect(mock.messagesIn(general).map((m) => m.content)).toEqual(["last week"]);
});

it("lists the guild's bans", async () => {
  // Arrange
  const { guild, alice } = await start(Permission.BanMembers);
  await guild.members.ban(alice.id, { reason: "spam" });

  // Act
  const bans = await guild.bans.fetch();

  // Assert
  expect(bans.map((b) => [b.user.id, b.reason])).toEqual([[alice.id, "spam"]]);
});

it("sets the bot's own nickname with Change Nickname", async () => {
  // Arrange
  const { guild, record } = await start(Permission.ChangeNickname);

  // Act
  await guild.members.me!.setNickname("Ladder Bot");

  // Assert
  expect(record.members.get(client.user!.id)?.nick).toBe("Ladder Bot");
});

it("tells the bot about its own nickname change without the Guild Members intent", async () => {
  // Arrange
  const record = mock.createGuild("g");
  mock.grantBot(Permission.ChangeNickname);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const updated = once(client, Events.GuildMemberUpdate);

  // Act
  await client.guilds.cache
    .get(record.id)!
    .members.me!.setNickname("Ladder Bot");

  // Assert
  const [, after] = await updated;
  expect(after.nickname).toBe("Ladder Bot");
});

it("fetches a user who isn't cached", async () => {
  // Arrange
  const { alice } = await start(0n);

  // Act
  const user = await client.users.fetch(alice.id, { force: true });

  // Assert
  expect(user.username).toBe("alice");
});

it("fetches one role by id", async () => {
  // Arrange
  const { guild, record } = await start(0n);
  const helpers = mock.createRole(record, "helpers", 0n);

  // Act
  const role = await guild.roles.fetch(helpers.id, { force: true });

  // Assert
  expect(role?.name).toBe("helpers");
});

it("counts each role's members, leaving out @everyone", async () => {
  // Arrange
  const { guild, record } = await start(0n);
  const admins = [...record.roles.values()].find((r) => r.name === "admins")!;

  // Act
  // The route discord.js's roles.fetchMemberCounts() calls; that method is missing in 14.26.4,
  // the oldest version the kit supports.
  const counts = (await client.rest.get(
    `/guilds/${guild.id}/roles/member-counts`,
  )) as Record<string, number>;

  // Assert
  expect(counts[admins.id]).toBe(1);
  expect(guild.id in counts).toBe(false);
});

it("moves a role up past another below the bot, and the bot hears it", async () => {
  // Arrange
  const { guild, record } = await start(Permission.ManageRoles);
  const helpers = await guild.roles.create({ name: "helpers" });
  const mods = await guild.roles.create({ name: "mods" });
  const updated = once(client, Events.GuildRoleUpdate);

  // Act
  await mods.setPosition(2);

  // Assert
  expect([
    record.roles.get(mods.id)!.position,
    record.roles.get(helpers.id)!.position,
  ]).toEqual([2, 1]);
  await updated;
});

it("refuses to move a role up to the bot's own", async () => {
  // Arrange
  const { guild } = await start(Permission.ManageRoles);
  const helpers = await guild.roles.create({ name: "helpers" });
  const top = guild.members.me!.roles.highest.position;

  // Act
  const moved = helpers.setPosition(top);

  // Assert
  expect((await refusal(moved)).code).toBe(50013);
});

it("bans several users at once and reports the ones it couldn't", async () => {
  // Arrange
  const { guild, record, alice } = await start(
    Permission.BanMembers | Permission.ManageGuild,
  );

  // Act
  const result = await guild.members.bulkBan([alice.id, client.user!.id]);

  // Assert
  expect(result).toEqual({
    bannedUsers: [alice.id],
    failedUsers: [client.user!.id],
  });
  expect(record.bans.has(alice.id)).toBe(true);
});

it("refuses a bulk ban that bans nobody", async () => {
  // Arrange
  const { guild } = await start(Permission.BanMembers | Permission.ManageGuild);

  // Act
  const result = guild.members.bulkBan([client.user!.id]);

  // Assert
  expect((await refusal(result)).code).toBe(500000);
});

it("reorders channels with Manage Channels, and the bot hears each move", async () => {
  // Arrange
  const { guild, record } = await start(Permission.ManageChannels);
  const general = mock.createTextChannel(record, "general");
  const rules = mock.createTextChannel(record, "rules");
  const channel = (await guild.channels.fetch(rules.id)) as TextChannel;
  const updated = once(client, Events.ChannelUpdate);

  // Act
  await channel.setPosition(0);

  // Assert
  const position = (c: APIChannel) => (c as APITextChannel).position;
  expect(position(rules)).toBeLessThan(position(general));
  await updated;
});
