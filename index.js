/**
 * 大肥鱼语音播报 —— Host 半身（桌宠音色版）。
 *
 * 不再自己合成音频：直接调用 dsh-pet 的本地接口
 *   POST http://127.0.0.1:<webServer 端口>/dsh-pet-7340/broadcast?pet=<id>&surface=<desktop|web>
 * 让桌宠用它自己在设置页里选的那个音色（默认「晓伊 · 女·活泼」）念出来，
 * 顺带把同一句话显示在气泡里。音色、音量、碎碎念/待办播报开关全部沿用桌宠设置，
 * 插件这一侧不产生任何本地脚本、不联网、不需要 API Key。
 *
 * 自动播报：监听 `session/event` 的 `assistant/message`，模型一有输出就让大肥鱼念。
 * 默认念**全文**、不设段数上限；长回答按标点切成 ≤60 字的小句，
 * 段间按实测语速（约 0.23 秒/字）衔接，听起来是连着一口气念下来的。
 * 每段送出去后回读桌宠日志确认真的出声（Edge TTS 429 限流会让它静默丢句），失败退避重发。
 * 手动命令：
 *   /speak <文本>        让大肥鱼念这段话（默认念全文）
 *   /voice               查看当前音色与自动播报开关
 *   /voice test          试听一句
 *   /voice auto on|off   开关"模型输出自动播报"
 *
 * 已知边界：桌宠客户端的单句念白上限是 60 字（VOICE_SPEECH_MAX_CHARS），
 * 超过的部分不会念；插件按句号/逗号把它切成多段依次送出，尽量念完。
 *
 * @module dsh-big-fish-speak
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'

/** Cordis 插件名。 */
export const name = 'big-fish-speak'

/** 命令注册需要 commands 服务；没有它的组合不会激活本插件。 */
export const inject = ['commands']

const DATA_DIR = path.join(os.homedir(), '.dsh', 'big-fish-speak')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const PET_ROOT = path.join(os.homedir(), '.dsh', 'dsh-pet')
const PET_CONFIG_FILE = path.join(PET_ROOT, 'main-config.jsonc')
const PET_LOG_FILE = path.join(PET_ROOT, 'logs.txt')

/** 桌宠注册在 DSH webServer 上的路由前缀（dsh-pet/src/host/route-segment）。 */
const PET_SEGMENT = '/dsh-pet-7340'

/** 桌宠客户端单句念白上限，超过会被它自己截断。 */
const PET_SPEECH_MAX_CHARS = 60

/**
 * 不设段数上限：长回答能念多长就念多长。这里只是一个防止死循环的极端保护
 * （200 段 ≈ 12000 字），正常输出永远碰不到。
 */
const MAX_HARD_CHUNKS = 200

/**
 * 段间节奏按真实语速算，而不是拍脑袋加长停顿：
 * dsh-pet 的 voice-cache 里 mp3 约 6KB/秒（48kbps），反推念白速度 ≈ 0.22 秒/字；
 * 这里取 0.23 秒/字并只留 0.5 秒自然换气，句子之间才不会空等十几秒。
 */
const MS_PER_CHAR = 230
const BETWEEN_GAP_MS = 500
const MIN_GAP_MS = 1000

/** 桌宠 /voice/speak 的串行队列上限是 3，超了会拒；命中忙时退避重试。 */
const BROADCAST_RETRIES = 3
const BROADCAST_RETRY_WAIT_MS = 2000

/**
 * 桌宠的 broadcast 只代表"收到了"，合成失败（Edge TTS 429 限流、WebSocket 超时）
 * 它只在 logs.txt 里写一行 `voice speak: failed chars=N …`，那一段就静默消失。
 * 所以每送一段都回读日志确认真的念出来了；失败就退避重发。
 */
const VERIFY_POLL_MS = 500
const VERIFY_TIMEOUT_MS = 16_000
const VERIFY_ATTEMPTS = 3
const VERIFY_RETRY_WAIT_MS = 3500

/** 桌宠内置音色的中文名（来自 dsh-pet 的 VOICES 表）。 */
const VOICE_LABELS = {
  'zh-CN-XiaoyiNeural': '晓伊（女·活泼）',
  'zh-CN-XiaoxiaoNeural': '晓晓（女·温柔）',
  'zh-CN-YunxiNeural': '云希（男·年轻）',
  'zh-CN-YunjianNeural': '云健（男·成熟）',
}

/** 读用户设置；只保留认识字段，旧版本留下的 preset / chunks 等键会被丢弃。 */
function readSettings() {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    return { auto: true }
  }
  return { auto: parsed?.auto === undefined ? true : parsed.auto === true }
}

/** 写设置；目录不可写时返回 false，由调用方回报，不抛异常。 */
function writeSettings(settings) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 去掉 JSONC 的注释（桌宠配置是 .jsonc，宿主 JSON.parse 不认注释）。 */
function stripJsonc(raw) {
  let out = ''
  let inString = false
  let quote = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    const next = raw[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 1
      } else if (ch === quote) {
        inString = false
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  // JSON 不允许尾逗号
  return out.replace(/,\s*([}\]])/g, '$1')
}

/** 读桌宠配置：拿到宠物 id、显示面、音色、音量与播报开关；读不到就返回默认值。 */
function readPetConfig() {
  const fallback = { petId: 'main', surface: 'desktop', voice: '', voiceEnabled: true, volume: 1 }
  let parsed
  try {
    parsed = JSON.parse(stripJsonc(fs.readFileSync(PET_CONFIG_FILE, 'utf8')))
  } catch {
    return fallback
  }
  const pets = Array.isArray(parsed?.pets) ? parsed.pets : []
  const first = pets.find((p) => typeof p?.id === 'string' && p.id.trim() !== '') ?? {}
  const display = String(first?.display ?? '')
  // 只有 web 面才用 web，其余（desktop / both / none）都让桌面窗口念
  const surface = display === 'web' ? 'web' : 'desktop'
  return {
    petId: String(first?.id ?? 'main'),
    surface,
    voice: String(parsed?.voiceName ?? ''),
    voiceEnabled: parsed?.voiceEnabled !== false,
    volume: Number.isFinite(parsed?.voiceVolume) ? parsed.voiceVolume : 1,
  }
}

/** 音色的中文名；不在内置表里就直接显示原始音色 id。 */
function voiceLabel(voiceId) {
  if (!voiceId) return '桌宠默认音色'
  return VOICE_LABELS[voiceId] ?? voiceId
}

/**
 * 找桌宠服务地址：优先用宿主 webServer 的端口，拿不到就回读桌宠日志里
 * `desktop helper started (config: http://127.0.0.1:<port>/dsh-pet-7340/config)` 那一行。
 */
function resolveOrigin(ctx) {
  // 宿主用 Proxy 追踪服务访问：没在 inject 里声明 webServer 时读 ctx.webServer 会直接抛错，
  // 所以这里必须 try 包住，拿不到就退回日志里的端口。
  let direct
  try {
    direct = ctx?.webServer?.port
  } catch {
    direct = undefined
  }
  if (!Number.isFinite(direct)) {
    try {
      const viaGet = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
      direct = viaGet?.port ?? undefined
    } catch {
      direct = undefined
    }
  }
  if (Number.isFinite(direct) && direct > 0) return `http://127.0.0.1:${direct}`
  try {
    const tail = fs.readFileSync(PET_LOG_FILE, 'utf8').split('\n').slice(-400).join('\n')
    const hits = [...tail.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/dsh-pet-7340/g)]
    if (hits.length > 0) {
      const port = Number(hits[hits.length - 1][1])
      if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`
    }
  } catch {
    // 日志读不到就当作找不到服务
  }
  return undefined
}

/** POST 一段 JSON，拿回解析后的响应体；网络失败抛错。 */
function postJson(url, payload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      reject(error)
      return
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = { ok: false, message: text.slice(0, 200) || `HTTP ${res.statusCode}` }
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求桌宠接口超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** 让大肥鱼念一句（同时显示气泡）。成功返回 true，失败抛错/返回原因。 */
async function broadcast(ctx, text, opts = {}) {
  const pet = readPetConfig()
  const origin = resolveOrigin(ctx)
  if (origin === undefined) {
    throw new Error('找不到桌宠服务地址：桌宠可能没在运行，或还没加载完成')
  }
  const surface = opts.surface ?? pet.surface
  const query = `?pet=${encodeURIComponent(pet.petId)}&surface=${encodeURIComponent(surface)}`
  const url = `${origin}${PET_SEGMENT}/broadcast${query}`
  // 气泡时长按字数给，至少 10 秒，避免念到一半气泡先消失
  const duration = Math.max(10_000, Math.round(text.length * 320))
  const { status, json } = await postJson(url, { text, duration: Math.min(duration, 120_000) })
  if (status !== 200) throw new Error(`桌宠接口返回 HTTP ${status}`)
  if (json?.ok !== true) {
    const reason = String(json?.reason ?? '')
    const message = String(json?.message ?? '桌宠拒绝了这次播报')
    throw new Error(reason ? `${message}（${reason}）` : message)
  }
  return true
}

/** 太短的段不用预热：等它的时间本来就短，预热反而会跟"校验回读"抢日志。 */
const WARM_MIN_CHARS = 20

/**
 * 提前把下一段合成进桌宠自己的语音缓存（voice-cache）：
 * 等它真正要念这段时就是 cache=hit，几乎零延迟接上，段间只留一个换气。
 * 只是预热，不播放；失败（限流/超时）静默忽略，到时仍由 broadcast 正常合成。
 */
async function warmVoice(ctx, text) {
  const pet = readPetConfig()
  const origin = resolveOrigin(ctx)
  if (origin === undefined || typeof text !== 'string' || text.length < WARM_MIN_CHARS) return false
  let parsed
  try {
    parsed = new URL(`${origin}${PET_SEGMENT}/voice/speak`)
  } catch {
    return false
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const body = Buffer.from(JSON.stringify({ text, voice: pet.voice }), 'utf8')
    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
        },
        timeout: 25_000,
      },
      (res) => {
        res.on('data', () => {})
        res.on('end', () => finish(res.statusCode === 200))
        res.on('error', () => finish(false))
      },
    )
    req.on('timeout', () => {
      try {
        req.destroy()
      } catch {
        // 已经断了就算了
      }
      finish(false)
    })
    req.on('error', () => finish(false))
    req.write(body)
    req.end()
  })
}

/**
 * 切一段不超过 limit 的文本，尽量断在标点上：
 * 优先断在句末（。！？；…换行），让每次念出去的都是一句完整的话；
 * 一句装不下 60 字时再退到句读（，、：等）；实在没有标点才硬切。
 * 只有断点足够靠后（≥ limit/3）才采用，避免切出两三个字的碎段。
 */
function cutOne(text, limit) {
  if (text.length <= limit) return text
  const window = text.slice(0, limit)
  const minAt = Math.floor(limit / 3)
  const lastOf = (stops) => {
    let best = -1
    for (const stop of stops) {
      const at = window.lastIndexOf(stop)
      if (at > best) best = at
    }
    return best >= minAt ? best : -1
  }
  const sentenceStops = ['。', '！', '？', '；', '…', '\n']
  const clauseStops = ['，', '、', '：', '）', '」', '”', ',', '.', '!', '?', ';', ':']
  const sentAt = lastOf(sentenceStops)
  if (sentAt >= 0) return window.slice(0, sentAt + 1)
  const clauseAt = lastOf(clauseStops)
  if (clauseAt >= 0) return window.slice(0, clauseAt + 1)
  return window
}

/**
 * 按桌宠单句上限把长文本切成若干段。
 * maxChunks 传 0（默认）= 不设段数上限，只受 MAX_HARD_CHUNKS 极端保护；
 * 还剩多少字用 restChars 回报（正常情况恒为 0）。
 */
export function chunkText(text, limit = PET_SPEECH_MAX_CHARS, maxChunks = 0) {
  let rest = String(text ?? '').trim()
  const out = []
  const cap = maxChunks > 0 ? Math.min(maxChunks, MAX_HARD_CHUNKS) : MAX_HARD_CHUNKS
  while (rest !== '' && out.length < cap) {
    const piece = cutOne(rest, limit).trim()
    if (piece === '') break
    out.push(piece)
    rest = rest.slice(piece.length).trim()
  }
  return { chunks: out, clipped: rest !== '', restChars: rest.length }
}

/**
 * 把模型回复整理成"能读出来的人话"：
 * 去掉代码块、行内代码、表格、标题井号、加粗/斜体标记、链接地址，压缩空白。
 * 导出只为便于脱离宿主单测。
 */
export function toSpeakable(raw) {
  let text = String(raw ?? '')
  text = text.replace(/```[\s\S]*?```/g, '') // 代码块整块丢掉
  text = text.replace(/`[^`]*`/g, '') // 行内代码
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
  text = text.replace(/^\s*\|.*\|\s*$/gm, '') // 表格行
  text = text.replace(/^\s*#+\s*/gm, '') // 标题井号
  text = text.replace(/^\s*[-*+]\s+/gm, '') // 列表符号
  text = text.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/__([^_]*)_+/g, '$1')
  text = text.replace(/[*_~]{1,2}/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

/** 从 `assistant/message` 事件里取最后一段可用正文。 */
function assistantTextOf(event) {
  const content = event?.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return block.text
    }
  }
  return ''
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 桌宠队列忙/被拒时退避重试；其它错误直接抛。 */
async function broadcastWithRetry(ctx, text) {
  let lastError
  for (let attempt = 0; attempt < BROADCAST_RETRIES; attempt += 1) {
    try {
      return await broadcast(ctx, text)
    } catch (error) {
      lastError = error
      const message = String(error?.message ?? error)
      if (!/queue|busy|忙|队列|请稍后/i.test(message)) throw error
      if (attempt < BROADCAST_RETRIES - 1) await sleep(BROADCAST_RETRY_WAIT_MS * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * 回读桌宠日志，找出"字数等于 len"的 voice speak 记录。
 * 只用来判断"这一段到底念出来没有"，读不到日志就当作未知（放行）。
 */
function speakLinesOf(len) {
  try {
    const needle = 'voice speak:'
    const charTag = `chars=${len} `
    return fs
      .readFileSync(PET_LOG_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.includes(needle) && line.includes(charTag))
  } catch {
    return []
  }
}

/** 等桌宠把这段合成完（日志里多一行）；返回 ok / failed / unknown。 */
async function waitSpeakVerdict(len, countBefore) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const lines = speakLinesOf(len)
    if (lines.length > countBefore) {
      const last = lines[lines.length - 1]
      return last.includes('failed') ? 'failed' : 'ok'
    }
    await sleep(VERIFY_POLL_MS)
  }
  return 'unknown'
}

/**
 * 送一段并确认桌宠真的念出来了：
 * broadcast 只代表"收到了"，Edge TTS 429 / 超时会只写一行 failed 就静默丢掉，
 * 所以这里比对日志，失败就退避重发，最多 VERIFY_ATTEMPTS 次。
 * 返回 { ok, elapsed }：elapsed 是这次送达到"开始出声"之间花掉的时间，用来算下一段该等多久。
 */
async function sendWithVerify(ctx, text) {
  const len = text.length
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    const countBefore = speakLinesOf(len).length
    await broadcastWithRetry(ctx, text)
    const verdict = await waitSpeakVerdict(len, countBefore)
    // 日志那一行写出时，这段音频刚好开始播：计时零点落在这里。
    // 若用"发送时刻"算已播时间，会把合成等待误算进去，下一段就会顶上来叠着念。
    if (verdict !== 'failed') return { ok: verdict === 'ok', elapsed: 0, attempt: attempt + 1 }
    if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_RETRY_WAIT_MS * (attempt + 1))
  }
  return { ok: false, elapsed: 0, attempts: VERIFY_ATTEMPTS }
}

/**
 * 从 startIndex 开始把 chunks 依次送给桌宠。
 * 每段先确认真的出声，再按"这段字数 × 实测语速 + 0.5 秒换气"扣掉已经花掉的合成时间，
 * 这样既不会空等十几秒，也不会两句叠在一起。
 * 单段彻底失败不中断整段朗读，记进 dropped 继续念下一句。
 */
async function runChunks(ctx, chunks, startIndex = 0, lead = null) {
  let spoken = 0
  const dropped = []
  // lead：调用方已经先送出去的那一段（及它花掉的合成时间），先按它的时长等够再续念
  if (lead && startIndex < chunks.length) {
    void warmVoice(ctx, chunks[startIndex])
    const targetMs = Math.round(lead.chars * MS_PER_CHAR) + BETWEEN_GAP_MS
    await sleep(Math.max(MIN_GAP_MS, targetMs - lead.elapsed))
  }
  for (let i = startIndex; i < chunks.length; i += 1) {
    let elapsed = 0
    try {
      const res = await sendWithVerify(ctx, chunks[i])
      elapsed = res.elapsed
      if (res.ok) spoken += 1
      else dropped.push(i + 1)
    } catch (error) {
      const wrapped = new Error(
        `第 ${i + 1}/${chunks.length} 段没送出去：${String(error?.message ?? error).split('\n')[0]}`,
      )
      wrapped.spoken = spoken
      wrapped.dropped = dropped
      throw wrapped
    }
    if (i < chunks.length - 1) {
      // 这段还在播的时候，先把下一段合成进缓存，下一段就能立刻接上
      void warmVoice(ctx, chunks[i + 1])
      const targetMs = Math.round(chunks[i].length * MS_PER_CHAR) + BETWEEN_GAP_MS
      await sleep(Math.max(MIN_GAP_MS, targetMs - elapsed))
    }
  }
  return { spoken, dropped }
}

/**
 * 念一段可能超过 60 字的文本：分段后按预估时长错开送出，让桌宠连着念。
 * maxChunks 传 0 表示念全文（调用方负责卡安全上限）。
 */
async function speakChunks(ctx, text, limit, maxChunks) {
  const { chunks, clipped, restChars } = chunkText(text, limit, maxChunks)
  if (chunks.length === 0) throw new Error('没有可念的内容')
  const { spoken, dropped } = await runChunks(ctx, chunks, 0)
  return { chunks, spoken, dropped, clipped, restChars }
}

/**
 * 挂载命令与自动播报。全部资源注册在同一个 effect 里，卸载时一起回收。
 *
 * @param ctx - Host 上下文，携带 commands 服务、事件总线与 webServer。
 * @param config - 本行的 config（cordis.patch.yml 里可以为空）。
 * @returns 清理函数。
 */
export function apply(ctx, config = {}) {
  return ctx.effect(() => {
    const disposers = []

    // 旧版（0.1/0.2）留下的 preset 已随声线表一起删掉，这里顺手清掉，避免越积越脏
    const initialRaw = (() => {
      try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      } catch {
        return {}
      }
    })()
    if (initialRaw?.preset !== undefined) {
      writeSettings(readSettings())
    }

    /** 正在念的时候不再叠新的，避免一句话没念完就被下一句打断。 */
    let busy = false
    /** 同一条消息只念一次（同一轮可能重复派发）。 */
    let lastSpokenKey = ''

    const doSpeak = async (text, limit, maxChunks) => {
      busy = true
      try {
        return await speakChunks(ctx, text, limit, maxChunks)
      } finally {
        busy = false
      }
    }

    // ---- 自动播报：模型输出 ---------------------------------------------
    const eventDisposer = ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'assistant/message') return
        const settings = readSettings()
        if (settings.auto !== true) return
        if (busy) return

        const spoken = toSpeakable(assistantTextOf(event))
        if (spoken === '') return

        const limit = Number.isFinite(config?.maxChars) && config.maxChars > 0
          ? Math.min(PET_SPEECH_MAX_CHARS, config.maxChars)
          : PET_SPEECH_MAX_CHARS
        // 默认念全文，不设段数上限（只受 MAX_HARD_CHUNKS 极端保护）
        const autoChunks = Number.isFinite(config?.autoChunks) && config.autoChunks > 0
          ? Math.min(MAX_HARD_CHUNKS, Math.round(config.autoChunks))
          : MAX_HARD_CHUNKS

        const sessionId = String(session?.header?.id ?? session?.id ?? 'unknown')
        const messageId = String(
          event?.data?.message?.id ?? event?.data?.messageId ?? event?.seq ?? '',
        )
        const key = `${sessionId}:${messageId}`
        if (key !== ':' && key === lastSpokenKey) return
        lastSpokenKey = key

        // 不 await：事件回调必须同步返回，念的过程在后台跑
        doSpeak(spoken, limit, autoChunks).catch(() => {
          // 播报失败静默跳过，不打断对话
        })
      } catch {
        // 事件处理绝不能让宿主报错
      }
    })
    if (typeof eventDisposer === 'function') disposers.push(eventDisposer)

    // ---- /speak -------------------------------------------------------
    const speakDisposer = ctx.commands.register({
      name: 'speak',
      description: '让大肥鱼用桌宠自己的声音念一段话',
      input: { hint: '<文本>' },
      handler: async ({ rawInput }) => {
        const raw = String(rawInput ?? '').trim()
        if (raw === '') {
          return { kind: 'error', text: '用法：/speak 你要念的话（音色就是桌宠设置页里选的那个）' }
        }
        const pet = readPetConfig()
        if (pet.voiceEnabled !== true) {
          return {
            kind: 'error',
            text: '桌宠设置页里的「语音播报」是关着的，先打开它大肥鱼才会出声。',
          }
        }
        const maxChunks = Number.isFinite(config?.speakChunks) && config.speakChunks > 0
          ? Math.min(MAX_HARD_CHUNKS, Math.round(config.speakChunks))
          : MAX_HARD_CHUNKS
        // 先切段，再把第一段真的送出去：一段都发不出去才算失败，剩下的在后台接着念
        let plan
        try {
          plan = chunkText(raw, PET_SPEECH_MAX_CHARS, maxChunks)
        } catch (error) {
          return { kind: 'error', text: `播报失败：${String(error?.message ?? error).split('\n')[0]}` }
        }
        const { chunks, clipped, restChars } = plan
        if (chunks.length === 0) {
          return { kind: 'error', text: '没有可念的内容。' }
        }
        busy = true
        let firstOk = false
        let firstElapsed = 0
        try {
          const first = await sendWithVerify(ctx, chunks[0])
          firstOk = first.ok
          firstElapsed = first.elapsed
        } catch (error) {
          busy = false
          return { kind: 'error', text: `播报失败：${String(error?.message ?? error).split('\n')[0]}` }
        }
        if (!firstOk && chunks.length === 1) {
          busy = false
          return { kind: 'error', text: '这一段没念出来（桌宠合成失败，多半是 Edge TTS 限流），稍等几秒再试。' }
        }
        const spokenChars = chunks.reduce((sum, piece) => sum + piece.length, 0)
        if (chunks.length > 1) {
          // 长文本不阻塞命令：后续段落后台念完（先按第一段字数等够），念完自动释放 busy
          void runChunks(ctx, chunks, 1, { chars: chunks[0].length, elapsed: firstElapsed })
            .catch(() => undefined)
            .finally(() => {
              busy = false
            })
        } else {
          busy = false
        }
        const tail = clipped ? `；剩下 ${restChars} 字超过极端保护上限（${MAX_HARD_CHUNKS} 段），没念` : ''
        return {
          kind: 'success',
          text: `大肥鱼用「${voiceLabel(pet.voice)}」开念：${chunks.length} 段 / 约 ${spokenChars} 字${
            chunks.length > 1 ? '，后面几段我连着放' : ''
          }${firstOk ? '' : '（第一段被限流漏掉了，已重试）'}${tail}。开头是：${chunks[0].slice(0, 24)}${
            chunks[0].length > 24 ? '…' : ''
          }`,
        }
      },
    })
    if (typeof speakDisposer === 'function') disposers.push(speakDisposer)

    // ---- /voice -------------------------------------------------------
    const voiceDisposer = ctx.commands.register({
      name: 'voice',
      description: '查看大肥鱼用的是哪个声音、开关自动播报、试听',
      input: { hint: '[test|auto on/off]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim()
        const settings = readSettings()
        const pet = readPetConfig()

        if (arg === '' || arg.toLowerCase() === 'list') {
          return {
            kind: 'success',
            text: [
              `当前声音：${voiceLabel(pet.voice)}（${pet.voice || '未配置'}）`,
              `音量：${pet.volume}　语音播报开关：${pet.voiceEnabled ? '开' : '关'}`,
              `自动播报：${settings.auto ? '开' : '关'}${busy ? '（正在念）' : ''}`,
              '念多长：不设段数上限，模型输出多少就念多少（按标点切句、段间按真实语速衔接）。',
              '这套声音是桌宠自己的，想换就右击大肥鱼 → 设置 → 音色下拉里换，插件这边只有这一个声音。',
              '用法：/voice test 试听；/voice auto off 关自动播报。',
            ].join('\n'),
          }
        }

        if (arg.toLowerCase() === 'test') {
          try {
            await doSpeak(`你好，我是大肥鱼，现在用的是${voiceLabel(pet.voice)}。`, PET_SPEECH_MAX_CHARS, 1)
          } catch (error) {
            return { kind: 'error', text: `试听失败：${String(error?.message ?? error).split('\n')[0]}` }
          }
          return { kind: 'success', text: `已用「${voiceLabel(pet.voice)}」试听。` }
        }

        const autoArg = /^auto(?:\s+(on|off))?$/i.exec(arg)
        if (autoArg !== null) {
          const desired = autoArg[1] === undefined ? !settings.auto : autoArg[1].toLowerCase() === 'on'
          const saved = writeSettings({ ...settings, auto: desired })
          if (!saved) {
            return { kind: 'error', text: `设置已生效但写入 ${SETTINGS_FILE} 失败，重启后会恢复。` }
          }
          return {
            kind: 'success',
            text: desired
              ? '自动播报已开：模型每次给你输出，大肥鱼都会用它的声音念完（默认全文）。'
              : '自动播报已关：大肥鱼不再自动念模型输出，只有 /speak 会念。',
          }
        }

        return {
          kind: 'error',
          text: '这里不再提供换声线：声音由桌宠设置页决定。输入 /voice 查看当前声音。',
        }
      },
    })
    if (typeof voiceDisposer === 'function') disposers.push(voiceDisposer)

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个资源回收失败不应拦住其余清理
        }
      }
    }
  }, 'big-fish-speak: pet-voice commands + auto broadcast')
}
