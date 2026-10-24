import { access, appendFile, mkdir, writeFile } from 'node:fs/promises'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import Pino from 'pino'

const AUTH_DIR = 'auth_info_baileys'
const QR_PATH = 'whatsapp-qr.png'
const STATUS_PATH = 'whatsapp-status.json'
const INBOX_PATH = 'inbox.jsonl'
const LATEST_PATH = 'inbox-latest.json'
const STOP_PATH = 'replies-stopped'

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

function customerReply(text) {
  const t = (text || '').trim()
  if (!t) return 'أهلاً. اكتب طلبك في رسالة نصية واحدة وأرد عليك.'
  if (/شكر/.test(t)) return 'العفو. لو محتاج حاجة تخص الطلب، اكتبها.'
  if (/^(السلام|سلام|هاي|هلا|مرحبا|مرحبًا|اهلا|أهلا|صباح|مساء)/.test(t)) {
    return 'أهلاً بحضرتك. معك المساعد. اكتب طلبك وأساعدك.'
  }
  return 'وصلتني رسالتك. اكتب طلبك بوضوح في سطر واحد وأرد عليك.'
}

function listenForCustomers(sock, startedAt) {
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
      const text = messageText(m.message)
      const halted = await repliesHalted()
      const reply = halted ? null : customerReply(text)
      const record = {
        at: new Date().toISOString(),
        from: jid,
        id: id || null,
        text: text || null,
        kind: text ? 'text' : 'non-text',
        status: halted ? 'halted' : 'auto_reply',
        reply,
        sent: false,
      }
      if (reply) {
        await sock.sendMessage(jid, { text: reply })
        record.sent = true
      }
      await appendFile(INBOX_PATH, `${JSON.stringify(record)}\n`)
      await writeFile(LATEST_PATH, JSON.stringify(record, null, 2))
      console.log(JSON.stringify({ incoming: true, from: jid, status: record.status, sent: record.sent }))
    }
  })
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({ auth: state, logger })

  sock.ev.on('creds.update', saveCreds)
  listenForCustomers(sock, Date.now())

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      await QRCode.toFile(QR_PATH, qr, { width: 512, margin: 2 })
      console.log(`QR saved to ${QR_PATH}`)
      await writeStatus({ state: 'qr_ready', qrFile: QR_PATH })
    }

    if (connection === 'open') {
      await writeStatus({ state: 'linked', mode: 'auto_reply', id: sock.user?.id ?? null })
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
