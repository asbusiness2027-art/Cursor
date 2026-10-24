import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import Pino from 'pino'
import { loadMemory, nextReply, saveChat } from './conversation.mjs'

const AUTH_DIR = 'auth_info_baileys'
const QR_PATH = 'whatsapp-qr.png'
const STATUS_PATH = 'whatsapp-status.json'
const INBOX_PATH = 'inbox.jsonl'
const LATEST_PATH = 'inbox-latest.json'
const STOP_PATH = 'replies-stopped'
const MEMORY_DIR = 'conversations'
const OPENING_PATH = 'opening-send.json'
const OPENING_DONE = 'opening-send.done.json'
const OPENING_RESULT = 'opening-send-result.json'
const OPENING_NUMBER = '201278764440'

const logger = Pino({ level: 'silent' })
const seenMessageIds = new Set()

async function writeStatus(status) {
  const body = JSON.stringify({ ...status, at: new Date().toISOString() }, null, 2)
  await writeFile(STATUS_PATH, body)
  console.log(body)
}

function messageText(message) {
  if (!message) return ''
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || ''
}

async function repliesHalted() {
  try {
    await access(STOP_PATH)
    return true
  } catch {
    return false
  }
}

function listenForCustomers(sock, startedAt, memory) {
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return
    for (const m of event.messages) {
      if (m.key.fromMe) continue
      const jid = m.key.remoteJid || ''
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue
      const id = m.key.id || ''
      if (id && seenMessageIds.has(id)) continue
      if (id) seenMessageIds.add(id)
      const timestampMs = Number(m.messageTimestamp || 0) * 1000
      if (timestampMs && timestampMs < startedAt - 15000) continue
      const text = messageText(m.message) || 'بعت رسالة من غير نص.'
      const chat = memory.chats.get(jid) || { jid, messages: [] }
      chat.messages.push({ role: 'customer', text, at: new Date().toISOString(), id: id || null })
      const halted = await repliesHalted()
      const reply = halted ? null : nextReply(chat.messages)
      const record = {
        at: new Date().toISOString(),
        from: jid,
        id: id || null,
        text,
        kind: text ? 'text' : 'non-text',
        status: halted ? 'halted' : 'conversation',
        reply,
        sent: false,
      }
      if (reply) {
        await sock.sendMessage(jid, { text: reply })
        chat.messages.push({ role: 'assistant', text: reply, at: new Date().toISOString() })
        record.sent = true
      }
      memory.chats.set(jid, chat)
      await saveChat(MEMORY_DIR, chat)
      await appendFile(INBOX_PATH, `${JSON.stringify(record)}\n`)
      await writeFile(LATEST_PATH, JSON.stringify(record, null, 2))
      console.log(JSON.stringify({ incoming: true, from: jid, status: record.status, sent: record.sent }))
    }
  })
}

async function sendOpening(sock, memory) {
  try {
    await rename(OPENING_PATH, OPENING_DONE)
  } catch {
    return
  }
  let number = null
  try {
    const job = JSON.parse(await readFile(OPENING_DONE, 'utf8'))
    number = String(job.number || '')
    if (number !== OPENING_NUMBER) {
      throw new Error('unexpected_number')
    }
    const lookup = await sock.onWhatsApp(number)
    const match = Array.isArray(lookup) ? lookup.find((entry) => entry?.exists) : null
    if (!match?.jid?.startsWith(`${OPENING_NUMBER}@`)) {
      throw new Error('number_not_on_whatsapp')
    }
    const text = String(job.text || '')
    const sent = await sock.sendMessage(match.jid, { text })
    const chat = memory.chats.get(match.jid) || { jid: match.jid, messages: [] }
    chat.messages.push({ role: 'assistant', text, at: new Date().toISOString(), id: sent?.key?.id ?? null })
    memory.chats.set(match.jid, chat)
    await saveChat(MEMORY_DIR, chat)
    await writeFile(OPENING_RESULT, JSON.stringify({
      ok: true,
      number,
      jid: match.jid,
      id: sent?.key?.id ?? null,
    }, null, 2))
  } catch (error) {
    await writeFile(OPENING_RESULT, JSON.stringify({
      ok: false,
      number,
      error: String(error),
    }, null, 2))
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const memory = await loadMemory(MEMORY_DIR, INBOX_PATH)
  for (const id of memory.seenIds) seenMessageIds.add(id)
  const sock = makeWASocket({ auth: state, logger })

  sock.ev.on('creds.update', saveCreds)
  listenForCustomers(sock, Date.now(), memory)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      await QRCode.toFile(QR_PATH, qr, { width: 512, margin: 2 })
      console.log(`QR saved to ${QR_PATH}`)
      await writeStatus({ state: 'qr_ready', qrFile: QR_PATH })
    }

    if (connection === 'open') {
      await writeStatus({ state: 'linked', mode: 'conversation', id: sock.user?.id ?? null })
      await sendOpening(sock, memory)
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      await writeStatus({
        state: loggedOut ? 'logged_out' : 'reconnecting',
        statusCode: statusCode ?? null,
      })
      if (!loggedOut) {
        setTimeout(() => {
          connectToWhatsApp().catch((error) => {
            console.error(error)
          })
        }, 2000)
      }
    }
  })
}

await mkdir(AUTH_DIR, { recursive: true })
await writeStatus({ state: 'starting' })
connectToWhatsApp().catch(async (error) => {
  await writeStatus({ state: 'error', message: String(error) })
  console.error(error)
  process.exitCode = 1
})
