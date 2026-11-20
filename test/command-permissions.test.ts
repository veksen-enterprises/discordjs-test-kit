import { once } from "node:events";
import {
  ApplicationCommandPermissionType,
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setCommandPermissions } from "../src/internal/command-permissions.js";
import { createDiscordMock, type DiscordMock } from "../src/internal/mock.js";

let mock: DiscordMock;
let client: Client;

beforeEach(async () => {
  mock = await createDiscordMock();
});

afterEach(async () => {
  await client?.destroy();
  await mock.close();
});

async function start() {
  const guild = mock.createGuild("g");
  const general = mock.createTextChannel(guild, "general");
  const alice = mock.createUser("alice");
  mock.addMember(guild, alice);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    ...mock.clientOptions,
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) await interaction.reply("done");
  });
  const ready = once(client, Events.ClientReady);
  await client.login(mock.token);
  await ready;
  const [ban] = (
    await client.guilds.cache
      .get(guild.id)!
      .commands.set([
        new SlashCommandBuilder()
          .setName("ban")
          .setDescription("ban")
          .setDefaultMemberPermissions(0n)
          .toJSON(),
      ])
  ).values();
  return { guild, general, alice, ban: ban! };
}

it("hands the bot the overrides an admin set, and announces each change", async () => {
  const { guild, general, alice, ban } = await start();
  const cached = client.guilds.cache.get(guild.id)!;
  await expect(
    cached.commands.permissions.fetch({ command: ban.id }),
  ).rejects.toMatchObject({ code: 10066 });

  const updated = once(client, Events.ApplicationCommandPermissionsUpdate);
  setCommandPermissions(mock, guild, ban.id, [
    {
      id: alice.id,
      type: ApplicationCommandPermissionType.User,
      permission: true,
    },
    {
      id: general.id,
      type: ApplicationCommandPermissionType.Channel,
      permission: false,
    },
  ]);
  expect((await updated)[0].permissions).toHaveLength(2);

  const all = await cached.commands.permissions.fetch({});
  const one = await cached.commands.permissions.fetch({ command: ban.id });
  expect([...all.keys()]).toEqual([ban.id]);
  expect(one.map((p) => p.permission)).toEqual([true, false]);
  mock.assertNoUnhandledRequests();
});

it("lets a member an override allows run a command they lack the default permissions for", async () => {
  const { guild, general, alice, ban } = await start();
  expect(() => mock.as(alice).slashCommand(general, "ban", {})).toThrow(
    "it's for administrators only",
  );

  setCommandPermissions(mock, guild, ban.id, [
    {
      id: alice.id,
      type: ApplicationCommandPermissionType.User,
      permission: true,
    },
  ]);

  expect(
    (await mock.as(alice).slashCommand(general, "ban", {}).reply()).content,
  ).toBe("done");
});

it("records a Gap when the bot edits overrides, which needs a Bearer token", async () => {
  const { guild, alice, ban } = await start();

  await expect(
    client.guilds.cache.get(guild.id)!.commands.permissions.set({
      command: ban.id,
      token: "bearer",
      permissions: [
        {
          id: alice.id,
          type: ApplicationCommandPermissionType.User,
          permission: true,
        },
      ],
    }),
  ).rejects.toThrow();

  expect(() => mock.assertNoUnhandledRequests()).toThrow(/Bearer token/);
});
