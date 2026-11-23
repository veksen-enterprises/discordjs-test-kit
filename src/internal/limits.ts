import { ComponentType, MessageFlags } from "discord-api-types/v10";
import type { RestResponse } from "./rest.js";

// Discord's length and count limits on a message body: create, edit, interaction callback, followup.
// Limits: discord-api-docs resources/message (Create Message params, "Embed Limits": inclusive,
// whitespace trimmed, 6000 combined) and components/reference (5 rows, 5 buttons or one select per
// row, custom_id 1-100, button label 80, select options 25). docs.discord.food/resources/message gives
// the same maxima. Discord answers 400 + 50035; the per-field `errors` codes and messages aren't
// documented, so the ones below are inferred, not checked.

type Problem = { path: (string | number)[]; message: string };

export function messageLimitError(body: unknown): RestResponse | undefined {
  return limitError(messageProblems(body as MessageBody | undefined));
}

// interactions/receiving-and-responding#interaction-response-object-modal: title max 45 characters,
// custom_id 1-100, "Between 1 and 5 (inclusive) components". discord.js's ModalBuilder doesn't check
// the 5, so a bot can send 6. The field codes are inferred, as above.
export function modalLimitError(body: unknown): RestResponse | undefined {
  const modal = (body ?? {}) as {
    title?: unknown;
    custom_id?: unknown;
    components?: unknown[];
  };
  const problems: Problem[] = [];
  if (typeof modal.title === "string" && modal.title.length > 45)
    problems.push({
      path: ["title"],
      message: "Must be 45 or fewer in length.",
    });
  if (typeof modal.custom_id === "string" && modal.custom_id.length > 100)
    problems.push({
      path: ["custom_id"],
      message: "Must be 100 or fewer in length.",
    });
  if ((modal.components?.length ?? 0) > 5)
    problems.push({
      path: ["components"],
      message: "Must be 5 or fewer in length.",
    });
  return limitError(problems);
}

// receiving-and-responding#interaction-response-object-autocomplete: "max of 25 choices". A choice's
// name and value are 1-100 characters (application-commands#application-command-option-choice-structure).
export function choicesLimitError(body: unknown): RestResponse | undefined {
  const choices =
    ((body ?? {}) as { choices?: { name?: unknown; value?: unknown }[] })
      .choices ?? [];
  const problems: Problem[] = [];
  if (choices.length > 25)
    problems.push({
      path: ["choices"],
      message: "Must be 25 or fewer in length.",
    });
  choices.forEach((choice, i) => {
    if (typeof choice.name === "string" && choice.name.length > 100)
      problems.push({
        path: ["choices", i, "name"],
        message: "Must be 100 or fewer in length.",
      });
    if (typeof choice.value === "string" && choice.value.length > 100)
      problems.push({
        path: ["choices", i, "value"],
        message: "Must be 100 or fewer in length.",
      });
  });
  return limitError(problems);
}

// resources/channel#start-thread-from-message and #modify-channel-json-params-thread: a thread's
// name is 1-100 characters. Discord doesn't trim it here as far as the docs say; untrimmed is inferred.
export function threadNameError(name: unknown): RestResponse | undefined {
  if (typeof name !== "string") return undefined;
  if (name.length >= 1 && name.length <= 100) return undefined;
  return limitError([
    {
      path: ["name"],
      message:
        name.length > 100
          ? "Must be 100 or fewer in length."
          : "Must be 1 or more in length.",
    },
  ]);
}

// resources/channel#modify-channel-json-params-guild-channel: name 1-100 characters, topic 0-1024
// (4096 in a forum, not modelled), rate_limit_per_user 0-21600. Field codes inferred, as above.
export function channelEditError(body: {
  name?: unknown;
  topic?: unknown;
  rate_limit_per_user?: unknown;
}): RestResponse | undefined {
  const problems: Problem[] = [];
  const { name, topic, rate_limit_per_user: slowmode } = body;
  if (typeof name === "string" && (name.length < 1 || name.length > 100))
    problems.push({
      path: ["name"],
      message:
        name.length > 100
          ? "Must be 100 or fewer in length."
          : "Must be 1 or more in length.",
    });
  if (typeof topic === "string" && topic.length > 1024)
    problems.push({
      path: ["topic"],
      message: "Must be 1024 or fewer in length.",
    });
  if (typeof slowmode === "number" && (slowmode < 0 || slowmode > 21600))
    problems.push({
      path: ["rate_limit_per_user"],
      message: "Must be between 0 and 21600.",
    });
  return limitError(problems);
}

function limitError(problems: Problem[]): RestResponse | undefined {
  if (problems.length === 0) return undefined;
  const errors: Record<string, unknown> = {};
  for (const { path, message } of problems) {
    let node = errors;
    for (const key of path) node = (node[String(key)] ??= {}) as typeof node;
    // oxlint-disable-next-line no-underscore-dangle -- Discord's error body names it `_errors`
    ((node._errors ??= []) as unknown[]).push({
      code: "BASE_TYPE_MAX_LENGTH",
      message,
    });
  }
  return {
    status: 400,
    body: { message: "Invalid Form Body", code: 50035, errors },
  };
}

interface MessageBody {
  content?: string | null;
  flags?: number;
  embeds?: Embed[] | null;
  components?: Component[] | null;
  poll?: {
    question?: { text?: string };
    answers?: { poll_media?: { text?: string } }[];
    duration?: number;
  } | null;
}
interface Embed {
  title?: string;
  description?: string;
  fields?: { name?: string; value?: string }[];
  footer?: { text?: string };
  author?: { name?: string };
}
interface Component {
  type: number;
  custom_id?: string;
  label?: string;
  options?: unknown[];
  components?: Component[];
}

function messageProblems(body: MessageBody | undefined): Problem[] {
  if (!body || typeof body !== "object") return [];
  const problems: Problem[] = [];
  const tooLong = (path: Problem["path"], text: unknown, max: number) => {
    if (typeof text === "string" && text.trim().length > max)
      problems.push({ path, message: `Must be ${max} or fewer in length.` });
  };

  tooLong(["content"], body.content, 2000);

  const embeds = body.embeds ?? [];
  if (embeds.length > 10)
    problems.push({
      path: ["embeds"],
      message: "Must be 10 or fewer in length.",
    });
  let total = 0;
  const count = (text: unknown) =>
    typeof text === "string" ? text.trim().length : 0;
  embeds.forEach((embed, i) => {
    tooLong(["embeds", i, "title"], embed.title, 256);
    tooLong(["embeds", i, "description"], embed.description, 4096);
    tooLong(["embeds", i, "footer", "text"], embed.footer?.text, 2048);
    tooLong(["embeds", i, "author", "name"], embed.author?.name, 256);
    const fields = embed.fields ?? [];
    if (fields.length > 25)
      problems.push({
        path: ["embeds", i, "fields"],
        message: "Must be 25 or fewer in length.",
      });
    fields.forEach((field, j) => {
      tooLong(["embeds", i, "fields", j, "name"], field.name, 256);
      tooLong(["embeds", i, "fields", j, "value"], field.value, 1024);
      total += count(field.name) + count(field.value);
    });
    total +=
      count(embed.title) +
      count(embed.description) +
      count(embed.footer?.text) +
      count(embed.author?.name);
  });
  if (total > 6000)
    problems.push({
      path: ["embeds"],
      message: "Embed size exceeds maximum size of 6000",
    });

  // resources/poll: question text up to 300, "up to 10" answers of up to 55, duration "up to 32
  // days" in hours. At least one answer and a duration of at least 1 are inferred; so is the poll
  // being refused beside IS_COMPONENTS_V2 as message#create-message says.
  if (body.poll) {
    tooLong(["poll", "question", "text"], body.poll.question?.text, 300);
    const answers = body.poll.answers ?? [];
    if (answers.length < 1 || answers.length > 10)
      problems.push({
        path: ["poll", "answers"],
        message: "Must be between 1 and 10 in length.",
      });
    answers.forEach((answer, i) =>
      tooLong(
        ["poll", "answers", i, "poll_media", "text"],
        answer.poll_media?.text,
        55,
      ),
    );
    const hours = body.poll.duration ?? 24;
    if (hours < 1 || hours > 32 * 24)
      problems.push({
        path: ["poll", "duration"],
        message: "Must be between 1 and 768.",
      });
    if ((body.flags ?? 0) & MessageFlags.IsComponentsV2)
      problems.push({
        path: ["poll"],
        message: "Cannot be used with the IS_COMPONENTS_V2 flag.",
      });
  }

  // Components V2 (components/reference): "Messages allow up to 40 total components", nested ones
  // and accessories counted (inferred); "the content and embeds fields will no longer work", which
  // the mock answers with 50035 (inferred, not checked).
  if ((body.flags ?? 0) & MessageFlags.IsComponentsV2) {
    if (countComponents(body.components ?? []) > 40)
      problems.push({
        path: ["components"],
        message: "Must be 40 or fewer in length.",
      });
    if (body.content)
      problems.push({
        path: ["content"],
        message: "Cannot be used with the IS_COMPONENTS_V2 flag.",
      });
    if (body.embeds?.length)
      problems.push({
        path: ["embeds"],
        message: "Cannot be used with the IS_COMPONENTS_V2 flag.",
      });
  } else {
    const rows = body.components ?? [];
    if (rows.length > 5)
      problems.push({
        path: ["components"],
        message: "Must be 5 or fewer in length.",
      });
    rows.forEach((row, i) => {
      const children = row.components ?? [];
      if (children.length > 5)
        problems.push({
          path: ["components", i, "components"],
          message: "Must be 5 or fewer in length.",
        });
      children.forEach((child, j) => {
        const path = ["components", i, "components", j];
        tooLong([...path, "custom_id"], child.custom_id, 100);
        if (child.type === ComponentType.Button)
          tooLong([...path, "label"], child.label, 80);
        if ((child.options?.length ?? 0) > 25)
          problems.push({
            path: [...path, "options"],
            message: "Must be 25 or fewer in length.",
          });
      });
    });
  }
  return problems;
}

type NestedComponent = {
  components?: NestedComponent[];
  accessory?: NestedComponent;
};

function countComponents(components: NestedComponent[]): number {
  return components.reduce(
    (n, c) =>
      n +
      1 +
      countComponents(c.components ?? []) +
      (c.accessory ? countComponents([c.accessory]) : 0),
    0,
  );
}

/** A reply to a message that isn't in the channel, as the contract run got it from the test guild. */
export function unknownReplyError(): RestResponse {
  return {
    status: 400,
    body: {
      message: "Invalid Form Body",
      code: 50035,
      errors: {
        message_reference: {
          // oxlint-disable-next-line no-underscore-dangle -- Discord's error body names it `_errors`
          _errors: [
            {
              code: "MESSAGE_REFERENCE_UNKNOWN_MESSAGE",
              message: "Unknown message",
            },
          ],
        },
      },
    },
  };
}
