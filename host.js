/**
 * 给任何人讲清楚 (Human-Readable) — Host half.
 *
 * One HTTP route the composer button calls:
 *   POST /dsh-human-readable/rewrite  { sessionId, draft, rounds }
 *   -> { ok: true, value: { text, elapsedMs, model, rounds, hasContext } }
 *
 * The rewrite reads the last N turns from the live Session, asks the Session's own
 * model to restate the draft so a stranger can follow it, and returns plain text.
 * Nothing is written to the Session log.
 */

export const name = 'human-readable'

export const inject = ['llm', 'sessions', 'connection', 'webServer']

const DEFAULT_ROUNDS = 6
const MAX_ROUNDS = 20
const DEFAULT_CONTEXT_TOKENS = 3000
const MIN_CONTEXT_TOKENS = 200
const MAX_CONTEXT_TOKENS = 8000
const MAX_OUTPUT_TOKENS = 800
const MAX_BODY_BYTES = 1024 * 1024
const DEADLINE_MS = 8000

const SYSTEM_PROMPT = `你是一个「提示词澄清器」。用户会给你两部分内容：最近几轮对话的上下文，以及他此刻在输入框里写的一句话。

你的任务：把这句话改写成一段任何人——小孩、老人、完全不懂他项目的人——听完就能直接照做的话。

最重要的边界（违反这条，输出就是废的）：
- 输出是「用户马上要发给 AI 的那句话」，永远用用户的第一人称说。
- 你不是在回复用户。禁止出现「你说」「你可以」「接下来你」「我建议你」这类助手口吻；如果读起来像在回答用户，就是错的。
- 不要回答草稿里的问题，也不要替 AI 执行草稿里的请求。你只负责把它说得更清楚。
- 上下文只用来判断「这句话指的是什么」。不要复述、不要照抄上下文里的任何句子，尤其是助手说过的话，以及其中出现的示例或预期答案。

判断指代的顺序（按这个顺序找，不要跳步）：
1. 先看标注了「用户刚看完的就是这条」的那条助手消息——草稿通常是对它的回应；
2. 只有最近一轮确实解释不了草稿时，才往前看更早的轮次；
3. 仍然无法确定，就把不确定点写成一句明确的问句，不要猜。

判断标准：把改写后的内容念给十个陌生人听，只要有一个要问「什么意思」，就算失败。

规则：
1. 不改变原意，不新增需求，不加原文没有的约束。
2. 把所有指代（这个、那个、上面那段、继续、刚才那个）换成上下文里具体的东西。
3. 补齐四件事：要做什么、对什么做、有什么限制、要什么形式的结果。上下文里没有的，不要编。
4. 用日常口语、短句、主动语态；不用行话、缩写、内部代号；非用不可时，第一次出现就解释。
5. 长度不超过原文的 2 倍，宁短勿长。
6. 只输出改写后的正文。不要前言、不要解释、不要「以下是改写结果」，不要用引号或 Markdown 代码块包裹。
7. 草稿是「可以了」「继续」「好的」这类确认或推进词时，把它展开成用户自己明确表达的意思（例如「这次的改动我确认没问题，请继续下一步」），不要替助手把话说完。
8. 上下文不足以确定意图时，把不确定点写成一句明确的问句，而不是猜一个填上。
9. 输出语言与用户输入的语言一致。`

function clampRounds(value) {
  const rounds = Number(value)
  if (!Number.isFinite(rounds)) return DEFAULT_ROUNDS
  return Math.min(MAX_ROUNDS, Math.max(0, Math.trunc(rounds)))
}

function clampContextTokens(value) {
  const tokens = Number(value)
  if (!Number.isFinite(tokens)) return DEFAULT_CONTEXT_TOKENS
  return Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, Math.trunc(tokens)))
}

/** Plain text of one model-visible message. */
function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  if (typeof message.text === 'string' && message.text.trim() !== '') return message.text.trim()
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Cheap CJK-aware token estimate; good enough to bound one request. */
function estimateTokens(text) {
  let wide = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code >= 0x2e80 && code <= 0x9fff) wide += 1
  }
  return Math.ceil(wide + (text.length - wide) / 4)
}

/** Last `rounds` user/assistant exchanges, newest first, within the token budget. */
function recentTranscript(session, rounds, budget) {
  if (!session || rounds <= 0) return ''
  let messages
  try {
    messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    return ''
  }
  if (!Array.isArray(messages)) return ''
  const picked = []
  for (const message of messages) {
    const role = message && message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = messageText(message)
    if (text === '') continue
    picked.push({ role, text })
  }
  const lines = []
  let used = 0
  let taggedLatest = false
  const maxMessages = rounds * 2
  for (let index = picked.length - 1; index >= 0 && lines.length < maxMessages; index -= 1) {
    const item = picked[index]
    let who = item.role === 'user' ? '用户' : '助手'
    if (!taggedLatest && item.role === 'assistant') {
      who = '助手（用户刚看完的就是这条）'
      taggedLatest = true
    }
    const line = `${who}：${item.text}`
    const cost = estimateTokens(line) + 2
    if (used + cost > budget) break
    lines.unshift(line)
    used += cost
  }
  return lines.join('\n\n')
}


function buildUserContent(draft, transcript) {
  if (transcript === '') return `【用户这次输入的草稿】（只改写这段，不要回复它）\n${draft}`
  return `【对话上下文】（只用来补全指代，不要续写）\n${transcript}\n\n【用户这次输入的草稿】（只改写这段，不要回复它）\n${draft}`
}

/** Normalize one model selection coming from the Session or the deployment default. */
function selectionOf(value) {
  if (!value || typeof value !== 'object') return undefined
  const provider = value.provider
  const model = value.model ?? value.id
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

export function apply(ctx) {
  /**
   * The model this Session currently runs on: the latest `request/header` in its
   * log carries the exact call config. Header metadata itself has no model.
   */
  function sessionModel(session) {
    if (!session || typeof session.eventAt !== 'function') return undefined
    try {
      let seq = Number(session.seq) - 1
      for (let steps = 0; seq >= 0 && steps < 400; steps += 1, seq -= 1) {
        const event = session.eventAt(seq)
        if (!event || event.type !== 'request/header') continue
        const config = event.data && event.data.header && event.data.header.config
        const selection = selectionOf(config)
        if (selection) return selection
      }
    } catch {
      /* an unreadable log simply falls back to the deployment default */
    }
    return undefined
  }

  /** Lowest reasoning effort this model advertises, or undefined when it has none. */
  async function lowestEffort(provider, model, signal) {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal)
      const efforts = info && info.reasoning && info.reasoning.efforts
      if (Array.isArray(efforts) && efforts.length > 0 && efforts[0] && typeof efforts[0].id === 'string') {
        return efforts[0].id
      }
    } catch {
      /* A model without reasoning metadata simply runs without an effort field. */
    }
    return undefined
  }

  async function collectText(request, signal) {
    const controller = new AbortController()
    const forward = () => controller.abort(signal && signal.reason)
    if (signal) signal.addEventListener('abort', forward, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('timeout'))
    }, DEADLINE_MS)
    let text = ''
    let aborted = false
    let truncated = false
    try {
      for await (const chunk of ctx.llm.stream({ ...request, signal: controller.signal })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason) {
          if (chunk.reason.kind === 'error') {
            throw new Error((chunk.reason.failure && chunk.reason.failure.message) || 'model error')
          }
          if (chunk.reason.kind === 'aborted') aborted = true
          if (chunk.reason.kind === 'max-tokens') truncated = true
        }
      }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', forward)
    }

    if (text.trim() === '') {
      if (timedOut) {
        throw new Error(`超过 ${Math.round(DEADLINE_MS / 1000)} 秒还没有返回，已中止：这个模型太慢，换一个快的试试`)
      }
      if (aborted) throw new Error('生成被中止，没有拿到内容')
      throw new Error('模型没有返回内容')
    }
    if (truncated) throw new Error('改写结果太长，被截断了；再点一次，或先把原文写短一点')
    return text
  }

  async function rewrite(payload, signal) {
    const startedAt = Date.now()
    const draft = typeof payload?.draft === 'string' ? payload.draft.trim() : ''
    if (draft === '') throw new Error('输入为空')

    const rounds = clampRounds(payload?.rounds)
    const contextTokens = clampContextTokens(payload?.contextTokens)
    const session = payload?.sessionId ? ctx.sessions.get(payload.sessionId) : undefined
    const transcript = recentTranscript(session, rounds, contextTokens)

    const selection = sessionModel(session) ?? selectionOf(ctx.get('agentDefaultModel')?.currentSelection?.())
    if (!selection) throw new Error('没有可用的模型')

    const effort = await lowestEffort(selection.provider, selection.model, signal)
    const request = {
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserContent(draft, transcript) }] }],
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }

    const text = (await collectText(request, signal)).trim()
    return {
      text,
      elapsedMs: Date.now() - startedAt,
      model: `${selection.provider}/${selection.model}`,
      rounds,
      contextTokens,
      hasContext: transcript !== '',
    }
  }

  async function readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function reply(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  }

  ctx.effect(() => {
    const route = {
      kind: 'exact',
      path: '/dsh-human-readable/rewrite',
      handler: async (request, response) => {
        let rejection
        try {
          rejection = ctx.connection.requestRejection(request)
        } catch {
          rejection = 403
        }
        if (rejection) {
          response.writeHead(rejection)
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405)
          response.end('method not allowed')
          return
        }
        let payload
        try {
          payload = JSON.parse(await readBody(request))
        } catch {
          response.writeHead(400)
          response.end('body is not JSON')
          return
        }
        try {
          reply(response, 200, { ok: true, value: await rewrite(payload) })
        } catch (error) {
          reply(response, 200, {
            ok: false,
            error: {
              code: (error && error.code) || 'rewrite-failed',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'human-readable: http route')
}
