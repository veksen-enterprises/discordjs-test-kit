/**
 * Runs the same bot-triggerable scenarios against the mock and, when DISCORD_CONTRACT_TOKEN is
 * set, against the real test guild, then compares response statuses and shapes.
 *
 * A status or error-code difference always fails: the mock answered the bot differently,
 * and that's never accepted unreviewed. Shape differences can be accepted in baseline.json.
 * A new one fails the run; so does a baseline entry that no longer occurs, so the baseline
 * only shrinks. UPDATE_BASELINE=1 rewrites it from the current run's shape differences.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  firstDispatches,
  runScenarios,
  type Observation,
} from "./scenarios.js";
import { describe as describeDiff, diffShapes, shapeOf } from "./shape.js";
import { discordTarget, mockTarget, type Target } from "./targets.js";

const TOKEN = process.env.DISCORD_CONTRACT_TOKEN;
const GUILD = process.env.DISCORD_CONTRACT_GUILD ?? "1572343051337342976";
const BASELINE = new URL("./baseline.json", import.meta.url);
const REPORT = new URL("./report.json", import.meta.url);

const targets: Target[] = [];
afterAll(async () => {
  for (const t of targets) await t.close();
});

async function observe(target: Target) {
  targets.push(target);
  const responses = await runScenarios(target);
  return { responses, dispatches: firstDispatches(target) };
}

describe("scenarios against the mock", () => {
  it("run end to end, with no Gaps", async () => {
    const { responses } = await observe(await mockTarget());
    const statuses = Object.fromEntries(
      Object.entries(responses).map(([k, v]) => [k, v.status]),
    );
    expect(statuses).toEqual({
      gatewayBot: 200,
      gateway: 200,
      usersMe: 200,
      getUser: 200,
      getApplication: 200,
      unknownChannel: 404,
      createChannel: 201,
      sendMessage: 200,
      listMessages: 200,
      startThread: 201,
      editMessage: 200,
      getMessage: 200,
      deleteThread: 200,
      deleteThreadWithoutManageChannels: 200,
      pinMessage: 403,
      listPins: 200,
      listPinsLegacy: 200,
      react: 204,
      listReactions: 200,
      removeUserReaction: 204,
      removeEmojiReactions: 204,
      removeOwnReaction: 204,
      removeAllReactions: 204,
      bulkDeleteTooFew: 400,
      bulkDelete: 204,
      deleteMessage: 204,
      editChannel: 200,
      editTopicTooLong: 400,
      editSlowmodeTooHigh: 400,
      replyToUnknownMessage: 400,
      threadNameTooLong: 400,
      createThread: 201,
      joinThread: 204,
      getThreadMember: 200,
      listThreadMembers: 200,
      activeThreads: 200,
      leaveThread: 204,
      addThreadMemberById: 204,
      removeThreadMemberById: 204,
      archiveThread: 200,
      publicArchivedThreads: 200,
      joinedPrivateArchivedThreads: 200,
      listRoles: 200,
      sendComponentsV2: 200,
      sendTyping: 204,
      sendPoll: 200,
      expirePoll: 200,
      pollVoters: 200,
      expireNonPoll: 400,
      sendComponentsV2WithContent: 400,
      typing: 204,
      sendTooManyEmbeds: 400,
      sendEmbedTitleTooLong: 400,
      pollTooManyAnswers: 400,
      pollTooLong: 400,
      sendTooLong: 400,
      sendPollWithoutAnswers: 400,
      listReactionsWithoutHistory: 403,
      bulkDeleteDuplicate: 400,
      pollWithButton: 200,
      pollRemoveButtons: 200,
      pollEditContent: 200,
      sendButtons: 200,
      createChannelSpaced: 201,
      channelNameTrimmed: 1,
      createChannelNameTooLong: 400,
      createEmoji: 201,
      getEmoji: 200,
      editEmoji: 200,
      deleteEmoji: 204,
      createSound: 201,
      getSound: 200,
      editSound: 200,
      botVoiceStateInVoice: 200,
      botVoiceStateById: 200,
      sendSoundboardSound: 204,
      setVoiceStatus: 204,
      clearVoiceStatus: 204,
      deleteSound: 204,
      setOwnNickname: 200,
      getBotMember: 200,
      listMembers: 200,
      setOwnNicknameById: 403,
      searchMembers: 200,
      listGuildChannels: 200,
      listGuilds: 200,
      getGuild: 200,
      renameGuild: 403,
      createInvite: 200,
      inviteReused: 1,
      getInvite: 200,
      listChannelInvites: 200,
      listGuildInvites: 403,
      deleteInvite: 200,
      inviteOver7Days: 400,
      unknownInvite: 404,
      botVoiceState: 404,
      listScheduledEvents: 200,
      listEmojis: 200,
      listAutoModRules: 403,
      pruneCount: 403,
      unknownEmoji: 404,
      listStickers: 200,
      createSticker: 201,
      getGuildSticker: 200,
      getSticker: 200,
      editSticker: 200,
      deleteSticker: 204,
      editBotUser: 200,
      editApplication: 200,
      openDm: 200,
      channelMemberPermissions: 200,
      channelRolePermissions: 200,
      guildMemberPermissions: 200,
      guildRolePermissions: 200,
      unknownMemberPermissions: 404,
      unknownRolePermissions: 404,
      unknownChannelMemberPermissions: 404,
      voiceRegions: 200,
      guildVoiceRegions: 200,
      defaultSounds: 200,
      oauthApplication: 200,
      welcomeScreen: 404,
      editWelcomeScreen: 403,
      onboarding: 200,
      editOnboarding: 403,
      vanityUrl: 403,
      integrations: 403,
      deleteIntegration: 404,
      memberVerification: 403,
      editMemberVerification: 403,
      incidentActions: 403,
      widgetPng: 404,
      roleConnectionMetadata: 200,
      editRoleConnectionMetadata: 200,
      skus: 200,
      entitlements: 200,
      unknownEntitlement: 404,
      deleteUnknownEntitlement: 404,
      consumeUnknownEntitlement: 404,
      createEntitlementUnknownSku: 400,
      unknownSkuSubscriptions: 404,
      setOwnNickLegacy: 200,
      addExistingMember: 403,
      unknownScheduledEvent: 404,
      widgetSettings: 403,
      widgetJson: 403,
      preview: 200,
      unknownSticker: 404,
      listTemplates: 403,
      createTemplate: 403,
      unknownTemplate: 404,
      listSoundboardSounds: 200,
      roleMemberCounts: 200,
      listAppEmojis: 200,
      createAppEmoji: 201,
      getAppEmoji: 200,
      editAppEmoji: 200,
      deleteAppEmoji: 204,
      archivedPrivateThreads: 403,
      channelPositions: 204,
      createScheduledEvent: 200,
      eventSkipsToCompleted: 400,
      getScheduledEvent: 200,
      eventUsers: 200,
      cancelScheduledEvent: 200,
      deleteScheduledEvent: 204,
      listCommandPermissions: 200,
      createGuildCommand: 201,
      listGuildCommands: 200,
      getGuildCommand: 200,
      editGuildCommand: 200,
      bulkGuildCommands: 200,
      deleteGuildCommand: 204,
      createGlobalCommand: 201,
      listGlobalCommands: 200,
      getGlobalCommand: 200,
      editGlobalCommand: 200,
      bulkGlobalCommands: 200,
      deleteGlobalCommand: 204,
      appCommandPermissions: 404,
      createWebhook: 403,
      listGuildWebhooks: 403,
      auditLog: 403,
      denySendMessages: 204,
      sendWithoutPermission: 403,
      typingWithoutSend: 403,
      deleteOverwrite: 204,
      createRole: 200,
      createdRolePosition: 1,
      getRole: 200,
      overwriteGrantingUnheld: 403,
      editRole: 200,
      addRoleToBot: 204,
      removeRoleFromBot: 204,
      rolePositions: 200,
      deleteRole: 204,
      deleteChannel: 200,
    });
    expect(responses.sendWithoutPermission!.body).toMatchObject({
      code: 50013,
    });
  }, 20_000);
});

describe.skipIf(!TOKEN)("mock against real Discord", () => {
  it(
    "agrees on statuses, error codes and shapes",
    // About 40s on a quiet day; each 429 can wait up to 3 retries, and a timeout skips the cleanup.
    { timeout: 240_000 },
    async () => {
      const discord = await observe(await discordTarget(TOKEN!, GUILD));
      const mock = await observe(await mockTarget());

      const differences: string[] = [];
      const statusDifferences: string[] = [];
      const compare = (
        section: string,
        a: Record<string, unknown>,
        b: Record<string, unknown>,
      ) => {
        for (const key of Object.keys(a).sort()) {
          if (!(key in b)) {
            differences.push(`${section}.${key}: Discord has it, mock doesn't`);
            continue;
          }
          for (const d of diffShapes(shapeOf(a[key]), shapeOf(b[key])))
            differences.push(`${section}.${key}.${describeDiff(d)}`);
        }
      };
      const statusOf = (r: Record<string, Observation>) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            {
              status: v.status,
              // An error's code is a number; an invite's `code` is its string id, not compared.
              code: (({ code }) => (typeof code === "number" ? code : null))(
                (v.body ?? {}) as { code?: unknown },
              ),
            },
          ]),
        );
      for (const [key, real] of Object.entries(statusOf(discord.responses))) {
        const ours = statusOf(mock.responses)[key];
        if (JSON.stringify(real) !== JSON.stringify(ours))
          statusDifferences.push(
            `status.${key}: Discord ${JSON.stringify(real)}, mock ${JSON.stringify(ours)}`,
          );
      }
      compare(
        "rest",
        Object.fromEntries(
          Object.entries(discord.responses).map(([k, v]) => [k, v.body]),
        ),
        Object.fromEntries(
          Object.entries(mock.responses).map(([k, v]) => [k, v.body]),
        ),
      );
      compare("gateway", discord.dispatches, mock.dispatches);
      // An event the mock sends and Discord doesn't would let a bot's handler run in tests only.
      for (const t of Object.keys(mock.dispatches).sort())
        if (!(t in discord.dispatches))
          differences.push(`gateway.${t}: mock sends it, Discord doesn't`);

      writeFileSync(
        REPORT,
        JSON.stringify(
          { statusDifferences, differences, discord, mock },
          null,
          2,
        ),
      );
      // The report artifact holds everything; the log gets the summary so it's readable
      // without downloading.
      console.log(
        JSON.stringify(
          {
            statuses: {
              discord: statusOf(discord.responses),
              mock: statusOf(mock.responses),
            },
            discordDispatches: Object.keys(discord.dispatches),
            statusDifferences,
            differences,
          },
          null,
          2,
        ),
      );
      if (process.env.UPDATE_BASELINE)
        writeFileSync(BASELINE, JSON.stringify(differences, null, 2) + "\n");
      expect(statusDifferences).toEqual([]);
      if (process.env.UPDATE_BASELINE) return;
      const baseline: string[] = existsSync(BASELINE)
        ? JSON.parse(readFileSync(BASELINE, "utf8"))
        : [];
      expect({
        new: differences.filter((d) => !baseline.includes(d)),
        fixed: baseline.filter((d) => !differences.includes(d)),
      }).toEqual({ new: [], fixed: [] });
    },
  );
});
