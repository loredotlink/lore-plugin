// @bun
// amp/passiveMirror.ts
var PASSIVE_EVENTS = ["session.start", "message_added", "message_updated", "agent.end"];
function installPassiveAmpThreadMirror(amp, deps) {
  const eventApi = amp;
  if (typeof eventApi.on !== "function") {
    amp.logger.log("[lore] passive mirror status=disabled category=events_unavailable");
    return;
  }
  const queues = new Map;
  for (const eventName of PASSIVE_EVENTS) {
    eventApi.on(eventName, async (event, ctx) => {
      const threadId = resolveThreadId(event, ctx);
      if (!threadId)
        return;
      const completion = enqueue(queues, threadId, {
        full: eventName === "session.start" || eventName === "agent.end",
        ctx,
        trigger: eventName,
        settle: () => {
          return;
        }
      }, amp, deps);
      await withDeadline(completion, deps.deadlineMs ?? 15000).catch((error) => {
        logStatus(amp, eventName, threadId, "failed", retryCategory(error));
      });
    });
  }
}
function enqueue(queues, threadId, work, amp, deps) {
  const queue = queues.get(threadId) ?? { running: false, pending: [] };
  queues.set(threadId, queue);
  return new Promise((resolve) => {
    work.settle = resolve;
    const last = queue.pending.at(-1);
    if (work.trigger !== "session.start" && last?.trigger !== "session.start") {
      if (last?.full && !work.full) {
        resolve();
        return;
      }
      if (work.full) {
        while (queue.pending.length && queue.pending.at(-1)?.trigger !== "session.start") {
          queue.pending.pop()?.settle();
        }
      }
    }
    queue.pending.push(work);
    if (!queue.running)
      drain(queues, threadId, queue, amp, deps);
  });
}
async function drain(queues, threadId, queue, amp, deps) {
  queue.running = true;
  while (queue.pending.length) {
    const work = queue.pending.shift();
    try {
      await mirrorOnce(threadId, work, amp, deps);
    } catch (error) {
      logStatus(amp, work.trigger, threadId, "failed", retryCategory(error));
    } finally {
      work.settle();
    }
  }
  queue.running = false;
  queues.delete(threadId);
}
async function mirrorOnce(threadId, work, amp, deps) {
  if (work.trigger === "session.start" && deps.beforeSessionStart) {
    const signal = AbortSignal.timeout(deps.deadlineMs ?? 15000);
    await deps.beforeSessionStart(threadId, work.ctx, signal);
  }
  const thread = await deps.exportThread(threadId, work.ctx);
  if (stringOrNull(thread.id) !== threadId) {
    logStatus(amp, work.trigger, threadId, "rejected", "thread_mismatch");
    return;
  }
  const body = buildFullSnapshot(thread);
  const attempts = Math.max(1, deps.maxAttempts ?? 3);
  for (let attempt = 1;attempt <= attempts; attempt += 1) {
    try {
      const token = await deps.getToken(threadId, work.ctx);
      await deps.upload({ threadId, token, body }, AbortSignal.timeout(deps.deadlineMs ?? 15000));
      logStatus(amp, work.trigger, threadId, "uploaded", attempt > 1 ? "retried" : "none");
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === attempts)
        throw error;
      logStatus(amp, work.trigger, threadId, "retry", retryCategory(error));
      await (deps.sleep ?? delay)(100 * 2 ** (attempt - 1));
    }
  }
}
function buildFullSnapshot(thread) {
  const threadId = stringOrNull(thread.id);
  if (!threadId)
    return { resourceLogs: [] };
  const messages = Array.isArray(thread.messages) ? thread.messages.filter(isRecord) : [];
  const fallback = isoTimestamp(thread.updatedAt) ?? isoTimestamp(thread.created) ?? new Date(0).toISOString();
  const records = [{
    timeUnixNano: toUnixNano(fallback),
    attributes: attributes({ "event.name": "amp.export.thread", "event.sequence": 0, "session.id": threadId, "amp.export.kind": "thread" }),
    body: anyValue({ ...thread, messages: undefined, messageCount: messages.length })
  }];
  messages.forEach((message, index) => {
    const role = stringOrNull(message.role) ?? "";
    const timestamp = isoTimestamp(isRecord(message.meta) ? message.meta.sentAt : undefined) ?? fallback;
    const promptId = stringOrNull(message.messageId) ?? `amp-msg-${index}`;
    records.push({
      timeUnixNano: toUnixNano(timestamp),
      attributes: attributes({
        "event.name": role === "user" ? "claude_code.user_prompt" : role === "assistant" ? "claude_code.api_response_body" : "amp.export.message",
        "event.sequence": index + 1,
        "session.id": threadId,
        "prompt.id": promptId,
        "amp.export.kind": "message",
        "amp.message.index": index,
        "amp.message.role": role
      }),
      body: anyValue(message)
    });
  });
  return { resourceLogs: [{
    resource: { attributes: attributes({ "service.name": "amp", "service.namespace": "lore.amp-plugin" }) },
    scopeLogs: [{ scope: { name: "lore.amp-plugin.passive-thread-upload" }, logRecords: records }]
  }] };
}
function resolveThreadId(event, ctx) {
  if (isRecord(event)) {
    const direct = stringOrNull(event.threadId) ?? stringOrNull(event.thread_id);
    if (direct)
      return direct;
    if (isRecord(event.thread))
      return stringOrNull(event.thread.id);
  }
  return isRecord(ctx) && isRecord(ctx.thread) ? stringOrNull(ctx.thread.id) : null;
}
function attributes(record) {
  return Object.entries(record).map(([key, value]) => ({ key, value: anyValue(value) }));
}
function anyValue(value) {
  if (typeof value === "string")
    return { stringValue: value };
  if (typeof value === "boolean")
    return { boolValue: value };
  if (typeof value === "number")
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value))
    return { arrayValue: { values: value.map(anyValue) } };
  if (isRecord(value))
    return { kvlistValue: { values: Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => ({ key, value: anyValue(item) })) } };
  return { stringValue: value == null ? "" : String(value) };
}
function toUnixNano(timestamp) {
  return (BigInt(Date.parse(timestamp)) * 1000000n).toString();
}
function isoTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number")
    return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function statusOf(error) {
  return isRecord(error) && typeof error.status === "number" ? error.status : null;
}
function isRetryable(error) {
  const status = statusOf(error);
  return status === null || status === 429 || status >= 500;
}
function retryCategory(error) {
  const status = statusOf(error);
  return status === 429 ? "rate_limited" : status && status >= 500 ? "server" : status && status >= 400 ? "terminal" : "network";
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function withDeadline(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function logStatus(amp, trigger, threadId, status, category) {
  amp.logger.log(`[lore] passive mirror trigger=${trigger} thread=${threadId} status=${status} retry=${category}`);
}

// amp/orb.ts
var AMP_ORB_AUDIENCE = "urn:lore:amp-upload";
function createLoreOrbPlugin(config) {
  const origin = config.loreApiOrigin.replace(/\/+$/, "");
  const request = config.fetch ?? globalThis.fetch;
  return (amp) => installPassiveAmpThreadMirror(amp, {
    exportThread: async (threadId, ctx) => {
      const shell = requireShell(ctx);
      const result = await shell`amp threads export ${threadId}`;
      if (result.exitCode !== 0)
        throw new Error("thread_export_failed");
      return JSON.parse(result.stdout);
    },
    getToken: (threadId, ctx) => mintToken(threadId, ctx, config.expectedAmpWorkspaceId),
    beforeSessionStart: config.enrollmentChallenge ? async (threadId, ctx, signal) => {
      for (let attempt = 1;attempt <= 3; attempt += 1) {
        try {
          const token = await mintToken(threadId, ctx, config.expectedAmpWorkspaceId);
          await post(request, `${origin}/api/amp/enrollment/completions`, token, { challenge: config.enrollmentChallenge }, signal);
          return;
        } catch (error) {
          const status = error?.status;
          if (typeof status === "number" && status >= 400 && status < 500 && status !== 429 || attempt === 3)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
        }
      }
    } : undefined,
    upload: async ({ token, body }, signal) => post(request, `${origin}/api/otel/v1/logs`, token, body, signal)
  });
}
async function mintToken(_threadId, ctx, expectedWorkspaceId) {
  const shell = requireShell(ctx);
  const result = await shell`amp orb id-token --audience ${AMP_ORB_AUDIENCE} --ttl-seconds ${60}`;
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || !token)
    throw new Error("token_mint_failed");
  if (workspaceIdFromToken(token) !== expectedWorkspaceId) {
    throw Object.assign(new Error("token_workspace_mismatch"), { status: 400 });
  }
  return token;
}
function workspaceIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && typeof payload.workspace_id === "string" ? payload.workspace_id : null;
  } catch {
    return null;
  }
}
function requireShell(ctx) {
  const shell = ctx?.$;
  if (typeof shell !== "function")
    throw new Error("event_shell_unavailable");
  return shell;
}
async function post(fetcher, url, token, body, signal) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-lore-harness": "Amp" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok)
    throw Object.assign(new Error("http_request_failed"), { status: response.status });
}
var orb_default = createLoreOrbPlugin;
export {
  orb_default as default,
  createLoreOrbPlugin,
  AMP_ORB_AUDIENCE
};
