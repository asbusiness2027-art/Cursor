import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function clip(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > 80 ? `${t.slice(0, 77)}...` : t
}

export function asksIdentity(text) {
  return /مين معي|مين اللي|انت مين|إنت مين|حضرتك مين|مع مين/.test(text)
}

export function isGreeting(text) {
  return /^(اهلا|أهلا|السلام|سلام|هاي|هلا|مرحبا|مرحبًا|صباح|مساء)( بك| بحضرتك)?$/.test(text)
}

export function isClosing(text) {
  return /^(خلاص|تمام كده|كده تمام|لا شكرا|لأ شكرا|مش محتاج|كفاية|باي|مع السلامة)$/.test(text)
}

export function nextReply(history) {
  const customer = history.filter((m) => m.role === 'customer').map((m) => m.text.trim()).filter(Boolean)
  const assistant = history.filter((m) => m.role === 'assistant').map((m) => m.text.trim())
  const last = customer.at(-1) || ''
  const introduced = assistant.some((text) => text.includes('المساعد'))
  let reply

  if (isClosing(last)) {
    reply = 'تمام. لو احتجت حاجة تانية، ابعتلي.'
  } else if (asksIdentity(last)) {
    reply = introduced
      ? 'لسه المساعد معاك. قولي طلبك وأكمل من آخر نقطة.'
      : 'معك المساعد بتاع الحساب. أسمع طلبك وأسألك لو ناقص تفصيلة. تحب إيه؟'
  } else if (customer.length === 1 && isGreeting(last)) {
    reply = 'أهلاً. قولي محتاج إيه؟'
  } else if (/^شكر/.test(last)) {
    reply = 'العفو. في حاجة تانية ولا كده تمام؟'
  } else {
    const points = customer.filter((text) => !asksIdentity(text) && !isGreeting(text) && !/^شكر/.test(text))
    if (!points.length) {
      reply = 'قولي الطلب نفسه، وأكمل معاك من هناك.'
    } else if (points.length === 1) {
      reply = `فهمت: ${clip(points[0])}. فيه تفصيلة مهمة ناقصة؟`
    } else {
      reply = `لحد دلوقتي: ${clip(points[0])}. وآخر حاجة: ${clip(points.at(-1))}. أكمل ولا أقف؟`
    }
  }

  if (assistant.at(-1) === reply) {
    reply = 'لسه معاك. زوّد تفصيلة واحدة وأكمل.'
  }
  return reply
}

function fileFor(dir, jid) {
  const safe = jid.replace(/[^a-zA-Z0-9@._-]/g, '_')
  return path.join(dir, `${safe}.json`)
}

export async function loadMemory(dir, inboxPath) {
  await mkdir(dir, { recursive: true })
  const chats = new Map()
  const seenIds = new Set()
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json')) continue
    const chat = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
    if (chat?.jid) chats.set(chat.jid, chat)
  }
  try {
    const raw = await readFile(inboxPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      if (row.id) seenIds.add(row.id)
      if (!row.from || !row.text) continue
      const chat = chats.get(row.from) || { jid: row.from, messages: [] }
      const known = chat.messages.some((m) => m.id && m.id === row.id)
      if (!known) {
        chat.messages.push({ role: 'customer', text: row.text, at: row.at, id: row.id })
        if (row.reply) chat.messages.push({ role: 'assistant', text: row.reply, at: row.at })
      }
      chats.set(row.from, chat)
    }
  } catch {
    // No inbox yet.
  }
  for (const chat of chats.values()) await saveChat(dir, chat)
  return { chats, seenIds }
}

export async function saveChat(dir, chat) {
  await writeFile(fileFor(dir, chat.jid), JSON.stringify(chat, null, 2))
}
