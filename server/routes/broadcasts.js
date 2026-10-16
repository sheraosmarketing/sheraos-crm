import { Router } from 'express'
import fetch from 'node-fetch'
import db from '../db.js'
import { requireRole } from '../middleware/auth.js'
import { broadcastSSE } from '../sse.js'
import { sendViaInstance, checkWhatsAppNumbersBulk } from '../services/leadHandoff.js'

const router = Router()

const MIN_VARIATIONS = 3 // total messages: principal + 2 variations minimum
const MIN_DELAY_SECONDS = 8
const DEFAULT_DELAY_SECONDS = 15

// List broadcasts
router.get('/', requireRole('super_admin', 'gerente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const broadcasts = db.prepare(`
    SELECT b.*, w.instance_name as instance_name, w.status as instance_status
    FROM broadcasts b
    LEFT JOIN whatsapp_instances w ON w.id = b.instance_id
    WHERE b.account_id = ?
    ORDER BY b.created_at DESC
  `).all(req.accountId)
  res.json({ broadcasts })
})

// Create broadcast
router.post('/', requireRole('super_admin', 'gerente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { name, message_template, message_variations, media_url, media_base64, media_mime, media_filename, lead_ids, delay_seconds, instance_id, scheduled_at } = req.body
  if (!name || !message_template) return res.status(400).json({ error: 'name e message_template obrigatorios' })

  // Validacao de midia: limite 5MB base64 (~3.75MB real), tipos permitidos
  if (media_base64) {
    if (!media_mime || typeof media_mime !== 'string') {
      return res.status(400).json({ error: 'media_mime obrigatorio quando enviar anexo' })
    }
    const ALLOWED = ['image/', 'video/', 'application/pdf']
    if (!ALLOWED.some(p => media_mime.startsWith(p))) {
      return res.status(400).json({ error: 'Tipo de arquivo nao permitido. Use imagem, video ou PDF.' })
    }
    const approxBytes = Math.floor(media_base64.length * 0.75)
    const MAX = media_mime.startsWith('video/') ? 16 * 1024 * 1024 : 5 * 1024 * 1024
    if (approxBytes > MAX) {
      return res.status(413).json({ error: `Arquivo excede ${Math.floor(MAX / 1024 / 1024)}MB` })
    }
  }

  // Valida instancia (deve existir e pertencer a conta)
  if (!instance_id) return res.status(400).json({ error: 'Selecione um numero de saida (instancia WhatsApp)' })
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ? AND account_id = ?').get(instance_id, req.accountId)
  if (!instance) return res.status(400).json({ error: 'Instancia invalida pra esta conta' })

  // Valida minimo de variacoes (principal + N variacoes >= MIN_VARIATIONS mensagens diferentes)
  const variationsArr = Array.isArray(message_variations) ? message_variations.filter(v => v && v.trim()) : []
  const totalMessages = 1 + variationsArr.length
  if (totalMessages < MIN_VARIATIONS) {
    return res.status(400).json({ error: `Minimo ${MIN_VARIATIONS} mensagens diferentes (1 principal + ${MIN_VARIATIONS - 1} variacoes). Voce tem ${totalMessages}.` })
  }

  // Valida delay minimo
  let delay = parseInt(delay_seconds) || DEFAULT_DELAY_SECONDS
  if (delay < MIN_DELAY_SECONDS) delay = MIN_DELAY_SECONDS

  const variationsJson = variationsArr.length > 0 ? JSON.stringify(variationsArr) : null

  // Valida agendamento (opcional). Aceita ISO string. Tem que ser >= now+60s pra evitar race com scheduler.
  let scheduledAtISO = null
  let initialStatus = 'draft'
  if (scheduled_at) {
    const d = new Date(scheduled_at)
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'scheduled_at invalido' })
    if (d.getTime() < Date.now() + 60_000) return res.status(400).json({ error: 'Agendamento precisa ser pelo menos 1min no futuro' })
    // Salva em UTC formato SQLite compativel: 'YYYY-MM-DD HH:MM:SS'
    scheduledAtISO = d.toISOString().replace('T', ' ').slice(0, 19)
    initialStatus = 'scheduled'
  }

  const result = db.prepare(`
    INSERT INTO broadcasts (account_id, name, message_template, message_variations, delay_seconds, media_url, media_base64, media_mime, media_filename, total_count, created_by, instance_id, status, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.accountId, name, message_template, variationsJson, delay, media_url || null, media_base64 || null, media_mime || null, media_filename || null, lead_ids?.length || 0, req.user.id, instance_id, initialStatus, scheduledAtISO)

  // Add recipients (only opted-in leads)
  let skippedNoOptin = 0
  if (lead_ids && Array.isArray(lead_ids)) {
    const stmt = db.prepare('INSERT INTO broadcast_recipients (broadcast_id, lead_id, phone) VALUES (?, ?, ?)')
    for (const leadId of lead_ids) {
      const lead = db.prepare('SELECT phone, opted_in_at, opted_out_at FROM leads WHERE id = ? AND phone IS NOT NULL AND is_archived = 0 AND is_blocked = 0').get(leadId)
      if (!lead) continue
      if (lead.opted_out_at && (!lead.opted_in_at || lead.opted_out_at > lead.opted_in_at)) { skippedNoOptin++; continue }
      stmt.run(result.lastInsertRowid, leadId, lead.phone)
    }
    db.prepare('UPDATE broadcasts SET total_count = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = ?) WHERE id = ?').run(result.lastInsertRowid, result.lastInsertRowid)
  }

  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(result.lastInsertRowid)
  res.json({ broadcast, skippedNoOptin })
})

// Clone data — retorna config + lead_ids pra pre-preencher modal de criar (duplicar disparo)
router.get('/:id/clone-data', requireRole('super_admin', 'gerente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })

  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId)
  if (!broadcast) return res.status(404).json({ error: 'Broadcast nao encontrado' })

  const recipients = db.prepare('SELECT lead_id FROM broadcast_recipients WHERE broadcast_id = ?').all(broadcast.id)
  const leadIds = recipients.map(r => r.lead_id).filter(Boolean)

  // Filtra apenas leads que ainda existem, ativos e nao arquivados (snapshot pode estar obsoleto)
  let validLeads = []
  if (leadIds.length) {
    const placeholders = leadIds.map(() => '?').join(',')
    validLeads = db.prepare(`SELECT id, name, phone, email, city, source, stage_id, attendant_id, instance_id, last_instance_id, created_at, updated_at, is_active FROM leads WHERE id IN (${placeholders}) AND account_id = ? AND is_active = 1 AND is_archived = 0 AND is_blocked = 0`).all(...leadIds, req.accountId)
  }

  let variations = []
  try { variations = broadcast.message_variations ? JSON.parse(broadcast.message_variations) : [] } catch {}

  res.json({
    clone: {
      name: `${broadcast.name} (cópia)`,
      message_template: broadcast.message_template,
      message_variations: variations,
      media_url: broadcast.media_url || null,
      media_base64: broadcast.media_base64 || null,
      media_mime: broadcast.media_mime || null,
      media_filename: broadcast.media_filename || null,
      delay_seconds: broadcast.delay_seconds,
      instance_id: broadcast.instance_id,
      leads: validLeads, // objetos completos pra o front popular selectedLeads direto
    },
    original: {
      total_count: broadcast.total_count,
      valid_leads_now: validLeads.length,
    },
  })
})

// Get broadcast detail (com info de instancia + recipients enriquecidos)
router.get('/:id', requireRole('super_admin', 'gerente'), (req, res) => {
  const broadcast = db.prepare(`
    SELECT b.*, w.instance_name as instance_name, w.status as instance_status, u.name as created_by_name
    FROM broadcasts b
    LEFT JOIN whatsapp_instances w ON w.id = b.instance_id
    LEFT JOIN users u ON u.id = b.created_by
    WHERE b.id = ?
  `).get(req.params.id)
  if (!broadcast) return res.status(404).json({ error: 'Disparo nao encontrado' })
  // FIX #6 (multi-tenant) — gerente da Alpha nao pode listar broadcast da Sheraos
  if (req.accountId && broadcast.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })

  const recipients = db.prepare(`
    SELECT br.*, l.name as lead_name
    FROM broadcast_recipients br
    LEFT JOIN leads l ON br.lead_id = l.id
    WHERE br.broadcast_id = ?
    ORDER BY br.id ASC
  `).all(broadcast.id)

  res.json({ broadcast, recipients })
})

// Lock em memoria pra evitar loops duplicados
const runningLoops = new Set()

// ─── Loop interno de envio (chamado por send + retomada automatica) ──
export async function runBroadcastLoop(broadcastId) {
  if (runningLoops.has(broadcastId)) {
    console.log(`[Broadcast] Loop ${broadcastId} ja em execucao, ignorando duplicata`)
    return
  }
  runningLoops.add(broadcastId)
  try {
    await runBroadcastLoopInner(broadcastId)
  } finally {
    runningLoops.delete(broadcastId)
  }
}

async function runBroadcastLoopInner(broadcastId) {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcastId)
  if (!broadcast) return
  if (broadcast.status !== 'sending') return // apenas se esta marcado como enviando

  const instance = broadcast.instance_id
    ? db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(broadcast.instance_id)
    : null

  if (!instance || instance.status !== 'connected') {
    // Pausa: sem instancia ou desconectada
    const reason = !instance ? 'Instancia removida' : `Instancia ${instance.instance_name} desconectada`
    db.prepare("UPDATE broadcasts SET paused_at = datetime('now'), paused_reason = ? WHERE id = ?").run(reason, broadcastId)
    broadcastSSE(broadcast.account_id, 'broadcast:paused', { id: broadcastId, reason })
    return
  }

  // Marca started_at no primeiro disparo
  if (!broadcast.started_at) {
    db.prepare("UPDATE broadcasts SET started_at = datetime('now') WHERE id = ?").run(broadcastId)
  }

  // Limpa pausa anterior (caso seja retomada)
  if (broadcast.paused_at) {
    db.prepare("UPDATE broadcasts SET paused_at = NULL, paused_reason = NULL WHERE id = ?").run(broadcastId)
  }

  const variations = broadcast.message_variations ? JSON.parse(broadcast.message_variations) : []
  const allTemplates = [broadcast.message_template, ...variations].filter(Boolean)
  const baseDelay = (broadcast.delay_seconds || DEFAULT_DELAY_SECONDS) * 1000

  // Usa offset baseado em sent_count + failed_count pra continuar de onde parou
  let processedCount = (broadcast.sent_count || 0) + (broadcast.failed_count || 0)

  // ─── Pre-flight bulk: valida TODOS os recipients pendentes de uma vez no inicio.
  // Numeros que nao tem WhatsApp viram 'failed' direto sem nem tentar sendText.
  // Funciona SO se for o primeiro start do broadcast (sem retomada parcial). Em retomada
  // o cache do checkWhatsAppNumbersBulk evita revalidar (TTL 5min).
  try {
    const pendingPhones = db.prepare("SELECT id, phone FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'").all(broadcastId)
    if (pendingPhones.length > 0) {
      const phoneList = pendingPhones.map(p => p.phone)
      console.log(`[Broadcast Pre-flight] broadcast=${broadcastId} validando ${phoneList.length} numeros...`)
      const validationMap = await checkWhatsAppNumbersBulk(instance, phoneList)
      let preflightFailed = 0
      for (const recipient of pendingPhones) {
        const exists = validationMap.get(recipient.phone)
        if (exists === false) {
          db.prepare("UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?").run('number_not_on_whatsapp', recipient.id)
          db.prepare('UPDATE broadcasts SET failed_count = failed_count + 1 WHERE id = ?').run(broadcastId)
          preflightFailed++
        }
      }
      if (preflightFailed > 0) {
        console.log(`[Broadcast Pre-flight] broadcast=${broadcastId} marcados ${preflightFailed} como failed (number_not_on_whatsapp)`)
        broadcastSSE(broadcast.account_id, 'broadcast:progress', { id: broadcastId })
      }
    }
  } catch (e) {
    console.error(`[Broadcast Pre-flight] broadcast=${broadcastId} erro:`, e.message)
    // Nao bloqueia o envio se validacao falhar — segue pro while normal
  }

  while (true) {
    // Re-checa pausa manual a cada iteracao (user clicou pausar pelo UI)
    const liveBroadcast = db.prepare("SELECT status, paused_at, paused_reason FROM broadcasts WHERE id = ?").get(broadcastId)
    if (!liveBroadcast || liveBroadcast.status !== 'sending') return // canceladado/completed
    if (liveBroadcast.paused_at) {
      broadcastSSE(broadcast.account_id, 'broadcast:paused', { id: broadcastId, reason: liveBroadcast.paused_reason })
      return
    }

    // Re-checa instancia conectada antes de cada envio
    const liveInstance = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(broadcast.instance_id)
    if (!liveInstance || liveInstance.status !== 'connected') {
      const reason = !liveInstance ? 'Instancia removida' : `Instancia ${liveInstance.instance_name} desconectada`
      db.prepare("UPDATE broadcasts SET paused_at = datetime('now'), paused_reason = ? WHERE id = ?").run(reason, broadcastId)
      broadcastSSE(broadcast.account_id, 'broadcast:paused', { id: broadcastId, reason })
      return
    }

    // Pega proximo recipient pendente
    const r = db.prepare("SELECT * FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1").get(broadcastId)
    if (!r) break // todos processados

    try {
      const lead = db.prepare('SELECT name, phone, empresa, city FROM leads WHERE id = ?').get(r.lead_id)
      const template = allTemplates[processedCount % allTemplates.length]
      const firstName = (lead?.name || '').split(' ')[0] || ''
      const text = String(template)
        .replace(/\{\{name\}\}/g, lead?.name || 'Cliente')
        .replace(/\{\{nome\}\}/g, lead?.name || 'Cliente')
        .replace(/\{\{primeiro_nome\}\}/g, firstName || 'Cliente')
        .replace(/\{\{first_name\}\}/g, firstName || 'Cliente')
        .replace(/\{\{empresa\}\}/g, lead?.empresa || '')
        .replace(/\{\{cidade\}\}/g, lead?.city || '')
        .replace(/\{\{phone\}\}/g, lead?.phone || '')
        .replace(/\{\{telefone\}\}/g, lead?.phone || '')
      // skipValidation=true porque o pre-flight bulk ja rodou antes do while.
      // leadId pra cap por lead/dia. media (se tiver) vai como anexo + caption=text.
      const mediaOpt = (broadcast.media_base64 && broadcast.media_mime) ? {
        base64: broadcast.media_base64,
        mime: broadcast.media_mime,
        fileName: broadcast.media_filename || undefined,
      } : null
      const sendRes = await sendViaInstance(liveInstance, r.phone, text, {
        skipValidation: true,
        leadId: r.lead_id,
        media: mediaOpt,
      })

      if (sendRes.ok && sendRes.wamsgId) {
        db.prepare("UPDATE broadcast_recipients SET status = 'sent', wa_msg_id = ?, sent_at = datetime('now') WHERE id = ?").run(sendRes.wamsgId, r.id)
        db.prepare("UPDATE leads SET last_broadcast_at = datetime('now') WHERE id = ?").run(r.lead_id)
        db.prepare('UPDATE broadcasts SET sent_count = sent_count + 1 WHERE id = ?').run(broadcastId)
      } else {
        const errMsg = sendRes.reason || JSON.stringify(sendRes.raw || {}).substring(0, 500)
        db.prepare("UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?").run(errMsg, r.id)
        db.prepare('UPDATE broadcasts SET failed_count = failed_count + 1 WHERE id = ?').run(broadcastId)
      }
      processedCount++
      broadcastSSE(broadcast.account_id, 'broadcast:progress', { id: broadcastId })
    } catch (err) {
      db.prepare("UPDATE broadcast_recipients SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).substring(0, 500), r.id)
      db.prepare('UPDATE broadcasts SET failed_count = failed_count + 1 WHERE id = ?').run(broadcastId)
      processedCount++
    }

    // Anti-ban: jitter +30% sobre o baseDelay configurado (nunca pra menos).
    // baseDelay configurado eh o MINIMO. Real fica entre 1.0x e 1.3x.
    // Ex: user configura 100s → real fica entre 100s e 130s.
    const jitterMult = 1.0 + Math.random() * 0.3  // 1.0x a 1.3x (sempre >= baseDelay)
    const jitter = Math.round(baseDelay * jitterMult)
    await new Promise(resolve => setTimeout(resolve, jitter))
  }

  // Concluido
  const finalCounts = db.prepare('SELECT sent_count, failed_count FROM broadcasts WHERE id = ?').get(broadcastId)
  db.prepare("UPDATE broadcasts SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(broadcastId)
  broadcastSSE(broadcast.account_id, 'broadcast:completed', { id: broadcastId, sent: finalCounts.sent_count, failed: finalCounts.failed_count })
}

// Send broadcast — dispara imediato (so funciona em draft; pra agendado precisa cancelar agendamento antes)
router.post('/:id/send', requireRole('super_admin', 'gerente'), async (req, res) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id)
  if (!broadcast) return res.status(404).json({ error: 'Disparo nao encontrado' })
  // FIX #6 (multi-tenant)
  if (req.accountId && broadcast.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (broadcast.status === 'scheduled') return res.status(400).json({ error: 'Disparo esta agendado. Cancele o agendamento antes de enviar agora.' })
  if (broadcast.status !== 'draft') return res.status(400).json({ error: 'Disparo ja enviado ou em andamento' })

  if (!broadcast.instance_id) return res.status(400).json({ error: 'Disparo sem instancia configurada' })
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(broadcast.instance_id)
  if (!instance) return res.status(400).json({ error: 'Instancia nao encontrada' })
  if (instance.status !== 'connected') return res.status(400).json({ error: `Instancia "${instance.instance_name}" nao esta conectada. Conecte antes de enviar.` })

  db.prepare("UPDATE broadcasts SET status = 'sending', started_at = datetime('now') WHERE id = ?").run(broadcast.id)

  const recipientsCount = db.prepare("SELECT COUNT(*) as c FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'").get(broadcast.id).c
  res.json({ ok: true, message: `Enviando para ${recipientsCount} contatos...` })

  // Roda loop em background
  runBroadcastLoop(broadcast.id).catch(err => console.error('[Broadcast] Loop error:', err))
})

// Retoma broadcast pausado (usado pelo scheduler quando instancia reconecta)
export function resumeBroadcastIfPaused(instanceId) {
  const paused = db.prepare("SELECT * FROM broadcasts WHERE instance_id = ? AND status = 'sending' AND paused_at IS NOT NULL").all(instanceId)
  for (const b of paused) {
    console.log(`[Broadcast] Retomando disparo "${b.name}" (id=${b.id}) — instancia ${instanceId} reconectou`)
    runBroadcastLoop(b.id).catch(err => console.error('[Broadcast] Resume error:', err))
  }
}

// Recovery no boot: pega disparos zumbis (status=sending mas ninguem processando)
// Acontece quando o servidor reinicia durante envio
export function recoverPendingBroadcasts() {
  const zombies = db.prepare("SELECT * FROM broadcasts WHERE status = 'sending'").all()
  if (zombies.length === 0) return
  console.log(`[Broadcast] Recovery no boot: encontrados ${zombies.length} disparo(s) em andamento. Retomando...`)
  for (const b of zombies) {
    // Limpa pause anterior (servidor caiu) e relanca
    db.prepare("UPDATE broadcasts SET paused_at = NULL, paused_reason = NULL WHERE id = ?").run(b.id)
    runBroadcastLoop(b.id).catch(err => console.error('[Broadcast] Boot recovery error:', err))
  }
}

// Cancelar disparo em andamento (ou pausado) — para definitivamente, marca como 'cancelled'.
// Recipients pending continuam pendentes na tabela (auditoria) mas nao sao mais processados.
router.post('/:id/cancel', requireRole('super_admin', 'gerente'), (req, res) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId)
  if (!broadcast) return res.status(404).json({ error: 'Disparo nao encontrado' })
  if (!['sending', 'paused'].includes(broadcast.status) && !(broadcast.status === 'sending' && broadcast.paused_at)) {
    if (broadcast.status !== 'sending') return res.status(400).json({ error: 'Disparo nao esta em andamento nem pausado (status: ' + broadcast.status + ')' })
  }
  db.prepare("UPDATE broadcasts SET status = 'cancelled', paused_at = NULL, paused_reason = NULL, completed_at = datetime('now') WHERE id = ?").run(broadcast.id)
  const updated = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcast.id)
  broadcastSSE(broadcast.account_id, 'broadcast:cancelled', { id: broadcast.id })
  res.json({ broadcast: updated })
})

// Endpoint manual de pausar (user clicou pra pausar no UI)
router.post('/:id/pause', requireRole('super_admin', 'gerente'), (req, res) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId)
  if (!broadcast) return res.status(404).json({ error: 'Disparo nao encontrado' })
  if (broadcast.status !== 'sending') return res.status(400).json({ error: 'Disparo nao esta em andamento (status: ' + broadcast.status + ')' })
  if (broadcast.paused_at) return res.status(400).json({ error: 'Disparo ja esta pausado' })
  db.prepare("UPDATE broadcasts SET paused_at = datetime('now'), paused_reason = ? WHERE id = ?").run('manual_user', broadcast.id)
  const updated = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcast.id)
  res.json({ broadcast: updated })
})

// Endpoint manual de retomar (caso queira forcar)
router.post('/:id/resume', requireRole('super_admin', 'gerente'), async (req, res) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id)
  if (!broadcast) return res.status(404).json({ error: 'Disparo nao encontrado' })
  // FIX #6 (multi-tenant)
  if (req.accountId && broadcast.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (broadcast.status !== 'sending') return res.status(400).json({ error: 'Disparo nao esta em andamento' })
  // Limpa pause se houver
  db.prepare("UPDATE broadcasts SET paused_at = NULL, paused_reason = NULL WHERE id = ?").run(broadcast.id)
  res.json({ ok: true })
  runBroadcastLoop(broadcast.id).catch(err => console.error('[Broadcast] Resume error:', err))
})

// Cancelar agendamento — volta pra draft, limpa scheduled_at
router.post('/:id/cancel-schedule', requireRole('super_admin', 'gerente'), (req, res) => {
  const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId)
  if (!broadcast) return res.status(404).json({ error: 'Disparo nao encontrado' })
  if (broadcast.status !== 'scheduled') return res.status(400).json({ error: 'Disparo nao esta agendado (status: ' + broadcast.status + ')' })
  db.prepare("UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = ?").run(broadcast.id)
  const updated = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(broadcast.id)
  res.json({ broadcast: updated })
})

// Delete broadcast — permite draft OU scheduled (cancela e apaga)
router.delete('/:id', requireRole('super_admin', 'gerente'), (req, res) => {
  db.prepare("DELETE FROM broadcasts WHERE id = ? AND status IN ('draft', 'scheduled')").run(req.params.id)
  res.json({ ok: true })
})

export default router
