import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import Pino from 'pino'

const AUTH_DIR = 'auth_info_baileys'
const QR_PATH = 'whatsapp-qr.png'
const STATUS_PATH = 'whatsapp-status.json'
const PENDING_PATH = 'pending-send.json'
const SENDING_PATH = 'pending-send.sending.json'
const RESULT_PATH = 'whatsapp-send-result.json'

const logger = Pino({ level: 'silent' })

async function writeStatus(status) {
  const body = JSON.stringify({ ...status, at: new Date().toISOString() }, null, 2)
  await writeFile(STATUS_PATH, body)
  console.log(body)
}

async function sendPending(sock) {
  try {
    await rename(PENDING_PATH, SENDING_PATH)
  } catch {
    return
  }

  let job
  try {
    job = JSON.parse(await readFile(SENDING_PATH, 'utf8'))
    const lookup = await sock.onWhatsApp(String(job.number))
    const match = Array.isArray(lookup) ? lookup.find((entry) => entry?.exists) : null
    if (!match?.jid) {
      await writeFile(RESULT_PATH, JSON.stringify({
        ok: false,
        error: 'number_not_on_whatsapp',
        number: String(job.number),
      }, null, 2))
      return
    }
    const sent = await sock.sendMessage(match.jid, { text: String(job.text) })
    await writeFile(RESULT_PATH, JSON.stringify({
      ok: true,
      number: String(job.number),
      jid: match.jid,
      id: sent?.key?.id ?? null,
    }, null, 2))
  } catch (error) {
    await writeFile(RESULT_PATH, JSON.stringify({
      ok: false,
      number: job?.number ?? null,
      error: String(error),
    }, null, 2))
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket({ auth: state, logger })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      await QRCode.toFile(QR_PATH, qr, { width: 512, margin: 2 })
      console.log(`QR saved to ${QR_PATH}`)
      await writeStatus({ state: 'qr_ready', qrFile: QR_PATH })
    }

    if (connection === 'open') {
      await writeStatus({ state: 'linked', id: sock.user?.id ?? null })
      await sendPending(sock)
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
