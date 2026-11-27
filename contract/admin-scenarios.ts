import { requester, type Observation } from "./scenarios.js";
import type { Target } from "./targets.js";

const CHANNEL = /^contract-admin-\d+$/;
const NAME = "contract";
const NAMES = ["contract", "contract edited"];

interface Named {
  id: string;
  name: string;
}

/**
 * What only a bot with Administrator can do: pins, webhooks, AutoMod, templates, the widget, and
 * the refusals for bans. Nothing here touches a member: a ban, kick or prune that succeeds would
 * hit a real account in the test guild, so those stay on their error paths or read-only.
 */
export async function runAdminScenarios(
  target: Target,
): Promise<Record<string, Observation>> {
  const call = requester(target);
  const guild = `/guilds/${target.guildId}`;
  const list = async <T>(path: string): Promise<T[]> => {
    const { body } = await call("GET", path);
    return Array.isArray(body) ? (body as T[]) : [];
  };
  // A stopped run leaves its channel (and the webhooks and pins in it), its AutoMod rule or its
  // template behind; sweep them before and after.
  const sweep = async () => {
    for (const c of await list<Named>(`${guild}/channels`))
      if (CHANNEL.test(c.name)) await call("DELETE", `/channels/${c.id}`);
    for (const r of await list<Named>(`${guild}/auto-moderation/rules`))
      if (NAMES.includes(r.name))
        await call("DELETE", `${guild}/auto-moderation/rules/${r.id}`);
    for (const t of await list<{ code: string; name: string }>(
      `${guild}/templates`,
    ))
      if (NAMES.includes(t.name))
        await call("DELETE", `${guild}/templates/${t.code}`);
  };

  const out: Record<string, Observation> = {};
  await sweep();
  const created = await call("POST", `${guild}/channels`, {
    name: `contract-admin-${Date.now()}`,
    type: 0,
  });
  const channelId = (created.body as { id?: string } | null)?.id;
  if (!channelId) return { createChannel: created };
  const channel = `/channels/${channelId}`;

  try {
    const sent = await call("POST", `${channel}/messages`, {
      content: "contract admin",
    });
    const messageId = (sent.body as { id?: string } | null)?.id;
    if (messageId) {
      out.pinMessage = await call(
        "PUT",
        `${channel}/messages/pins/${messageId}`,
      );
      out.listPins = await call("GET", `${channel}/messages/pins`);
      out.unpinMessage = await call(
        "DELETE",
        `${channel}/messages/pins/${messageId}`,
      );
      out.pinMessageLegacy = await call("PUT", `${channel}/pins/${messageId}`);
      out.unpinMessageLegacy = await call(
        "DELETE",
        `${channel}/pins/${messageId}`,
      );
    }

    // Webhooks: one deleted with the bot's token, one with its own.
    out.createWebhook = await call("POST", `${channel}/webhooks`, {
      name: NAME,
    });
    const hook = out.createWebhook.body as { id?: string; token?: string };
    if (hook?.id && hook.token) {
      const byToken = `/webhooks/${hook.id}/${hook.token}`;
      out.listChannelWebhooks = await call("GET", `${channel}/webhooks`);
      out.listGuildWebhooks = await call("GET", `${guild}/webhooks`);
      out.getWebhook = await call("GET", `/webhooks/${hook.id}`);
      out.getWebhookWithToken = await call("GET", byToken);
      out.editWebhook = await call("PATCH", `/webhooks/${hook.id}`, {
        name: "contract edited",
      });
      out.editWebhookWithToken = await call("PATCH", byToken, { name: NAME });
      out.executeWebhook = await call("POST", `${byToken}?wait=true`, {
        content: "contract webhook",
      });
      const posted = (out.executeWebhook.body as { id?: string } | null)?.id;
      if (posted) {
        out.getWebhookMessage = await call(
          "GET",
          `${byToken}/messages/${posted}`,
        );
        out.editWebhookMessage = await call(
          "PATCH",
          `${byToken}/messages/${posted}`,
          { content: "contract webhook, edited" },
        );
        out.deleteWebhookMessage = await call(
          "DELETE",
          `${byToken}/messages/${posted}`,
        );
      }
      out.deleteWebhook = await call("DELETE", `/webhooks/${hook.id}`);
    }
    const second = await call("POST", `${channel}/webhooks`, { name: NAME });
    const other = second.body as { id?: string; token?: string };
    if (other?.id && other.token)
      out.deleteWebhookWithToken = await call(
        "DELETE",
        `/webhooks/${other.id}/${other.token}`,
      );

    // AutoMod: a disabled keyword rule nobody can trip.
    out.createAutomodRule = await call(
      "POST",
      `${guild}/auto-moderation/rules`,
      {
        name: NAME,
        event_type: 1,
        trigger_type: 1,
        trigger_metadata: { keyword_filter: ["contractnope"] },
        // discord.js always sends an action's metadata, if empty.
        actions: [{ type: 1, metadata: {} }],
        enabled: false,
      },
    );
    const ruleId = (out.createAutomodRule.body as { id?: string } | null)?.id;
    if (ruleId) {
      const rule = `${guild}/auto-moderation/rules/${ruleId}`;
      out.listAutomodRules = await call(
        "GET",
        `${guild}/auto-moderation/rules`,
      );
      out.getAutomodRule = await call("GET", rule);
      out.editAutomodRule = await call("PATCH", rule, {
        name: "contract edited",
      });
      out.deleteAutomodRule = await call("DELETE", rule);
    }

    // Templates.
    out.createTemplate = await call("POST", `${guild}/templates`, {
      name: NAME,
    });
    const code = (out.createTemplate.body as { code?: string } | null)?.code;
    if (code) {
      out.listTemplates = await call("GET", `${guild}/templates`);
      out.syncTemplate = await call("PUT", `${guild}/templates/${code}`);
      out.editTemplate = await call("PATCH", `${guild}/templates/${code}`, {
        name: "contract edited",
      });
      out.deleteTemplate = await call("DELETE", `${guild}/templates/${code}`);
    }

    // The widget settings, written back as they were.
    out.getWidgetSettings = await call("GET", `${guild}/widget`);
    const widget = out.getWidgetSettings.body as {
      enabled?: boolean;
      channel_id?: string | null;
    };
    if (out.getWidgetSettings.status === 200)
      out.editWidgetSettings = await call("PATCH", `${guild}/widget`, {
        enabled: widget.enabled,
        channel_id: widget.channel_id,
      });

    // Members stay untouched: the ban list, an unknown ban, banning the owner (always refused),
    // and the prune count without pruning.
    out.listBans = await call("GET", `${guild}/bans`);
    out.unknownBan = await call("GET", `${guild}/bans/1`);
    const ownerId = (
      (await call("GET", guild)).body as { owner_id?: string } | null
    )?.owner_id;
    if (ownerId) {
      out.banOwner = await call("PUT", `${guild}/bans/${ownerId}`, {});
      out.bulkBanOwner = await call("POST", `${guild}/bulk-ban`, {
        user_ids: [ownerId],
      });
    }
    out.pruneCount = await call("GET", `${guild}/prune?days=30`);
  } finally {
    out.deleteChannel = await call("DELETE", channel);
    await sweep();
  }
  return out;
}
