import { Router } from 'express'
import fetch from 'node-fetch'
import db, { DEFAULT_EVOLUTION_API_URL, DEFAULT_EVOLUTION_API_KEY } from '../db.js'
import { requireRole } from '../middleware/auth.js'
import { runPollNow } from '../scheduler.js'

const router = Router()

// Helper: get instance only if it belongs to the user's account (or user is super_admin)
function getOwnedInstance(req, res) {
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(req.params.id)
  if (!instance) { res.status(404).json({ error: 'Instancia nao encontrada' }); return null }
  if (req.user.role !== 'super_admin' && instance.account_id !== req.accountId) {
    res.status(403).json({ error: 'Sem permissao para esta instancia' }); return null
  }
  return instance
}

// ─── Get Evolution API config for account ────────────────────────
// Atendente le tambem (precisa pra UI ja saber que ta configurado e mostrar instancias),
// mas recebe versao saneada — apenas a flag `configured`, sem api_url/api_key.
router.get('/evolution-config', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const account = db.prepare('SELECT evolution_api_url, evolution_api_key FROM accounts WHERE id = ?').get(req.accountId)
  const apiUrl = account?.evolution_api_url || DEFAULT_EVOLUTION_API_URL
  const apiKey = account?.evolution_api_key || DEFAULT_EVOLUTION_API_KEY
  const configured = !!(apiUrl && apiKey)
  if (req.user.role === 'atendente') {
    return res.json({ api_url: null, api_key: null, configured })
  }
  res.json({ api_url: apiUrl, api_key: apiKey, configured })
})

// ─── Save Evolution API config for account ───────────────────────
router.put('/evolution-config', requireRole('super_admin', 'gerente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { api_url, api_key } = req.body
  if (!api_url || !api_key) return res.status(400).json({ error: 'api_url e api_key obrigatorios' })
  const baseUrl = api_url.replace(/\/+$/, '')
  db.prepare("UPDATE accounts SET evolution_api_url = ?, evolution_api_key = ?, updated_at = datetime('now') WHERE id = ?").run(baseUrl, api_key, req.accountId)
  res.json({ ok: true, api_url: baseUrl })
})

// ─── List WhatsApp instances ─────────────────────────────────────
// Gerente/super_admin ve todas da conta.
// Atendente ve SO a instancia atribuida a ele (users.primary_instance_id) e
// recebe versao saneada — sem api_url, api_key, webhook_secret.
// Se atendente nao tem primary_instance_id: retorna array vazio (frontend mostra banner "Aguarde gerente atribuir").
router.get('/whatsapp', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })

  if (req.user.role === 'atendente') {
    const userRow = db.prepare('SELECT primary_instance_id FROM users WHERE id = ?').get(req.user.id)
    const primaryId = userRow?.primary_instance_id
    if (!primaryId) return res.json({ instances: [] })
    const row = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ? AND account_id = ?').get(primaryId, req.accountId)
    if (!row) return res.json({ instances: [] })
    const { api_url, api_key, webhook_secret, ...safe } = row
    return res.json({ instances: [safe] })
  }

  const rows = db.prepare('SELECT * FROM whatsapp_instances WHERE account_id = ? ORDER BY created_at DESC').all(req.accountId)
  res.json({ instances: rows })
})

// Helper: register webhook on Evolution for a given instance
async function registerEvolutionWebhook(baseUrl, apiKey, instanceName, accountSlug) {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://drosagencia.com.br/crm'
  const webhookUrl = `${publicBaseUrl}/api/webhooks/evolution/${accountSlug}`
  try {
    await fetch(`${baseUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ webhook: { url: webhookUrl, enabled: true, events: ['MESSAGES_UPSERT'] } }),
    })
    console.log(`[Evolution Webhook] Set for ${instanceName} → ${webhookUrl}`)
  } catch (err) {
    console.error('[Evolution Webhook Setup]', err.message)
  }
}

// ─── Create instance on Evolution API + get QR code ──────────────
router.post('/whatsapp', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { instance_name, lead_intake_mode = 'open' } = req.body
  if (!instance_name) return res.status(400).json({ error: 'instance_name obrigatorio' })
  if (!['open', 'restricted'].includes(lead_intake_mode)) return res.status(400).json({ error: 'lead_intake_mode invalido (use open ou restricted)' })

  // Get Evolution API credentials from account config (or fallback to body for backwards compat)
  const account = db.prepare('SELECT evolution_api_url, evolution_api_key, slug FROM accounts WHERE id = ?').get(req.accountId)
  const api_url = req.body.api_url || account?.evolution_api_url
  const api_key = req.body.api_key || account?.evolution_api_key
  if (!api_url || !api_key) return res.status(400).json({ error: 'Configure a Evolution API primeiro em Integracoes' })

  // Normalize api_url (remove trailing slash)
  const baseUrl = api_url.replace(/\/+$/, '')

  // Check if instance already exists in DB — re-register webhook to recover from past failures, then return
  const existing = db.prepare('SELECT id FROM whatsapp_instances WHERE account_id = ? AND instance_name = ?').get(req.accountId, instance_name)
  if (existing) {
    db.prepare("UPDATE whatsapp_instances SET api_url = ?, api_key = ?, updated_at = datetime('now') WHERE id = ?").run(baseUrl, api_key, existing.id)
    await registerEvolutionWebhook(baseUrl, api_key, instance_name, account.slug)
    const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(existing.id)
    return res.json({ instance })
  }

  // Create instance on Evolution API
  let qrCode = null
  try {
    const createRes = await fetch(`${baseUrl}/instance/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: api_key },
      body: JSON.stringify({ instanceName: instance_name, qrcode: true, integration: 'WHATSAPP-BAILEYS' }),
    })
    const createData = await createRes.json()
    qrCode = createData?.qrcode?.base64 || createData?.base64 || null
  } catch (err) {
    console.error('[Evolution Create Instance]', err.message)
  }

  // Save to DB. Anti-ban: nova instancia entra em warm-up de 3 dias (volume gradual).
  const result = db.prepare(
    "INSERT INTO whatsapp_instances (account_id, instance_name, api_url, api_key, status, qr_code, lead_intake_mode, warmup_until) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+3 days'))"
  ).run(req.accountId, instance_name, baseUrl, api_key, qrCode ? 'connecting' : 'disconnected', qrCode, lead_intake_mode)
  const instance = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(result.lastInsertRowid)

  // Se atendente criou, vira dono automatico (seta primary_instance_id + default_attendant_id).
  // Assim ele passa a ver a instancia dele em /integrations e opera sem intervencao do gerente.
  if (req.user.role === 'atendente') {
    db.prepare("UPDATE users SET primary_instance_id = ?, updated_at = datetime('now') WHERE id = ?").run(instance.id, req.user.id)
    db.prepare("UPDATE whatsapp_instances SET default_attendant_id = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, instance.id)
    console.log(`[integrations] Atendente ${req.user.id} virou dono da instancia recem-criada ${instance.id}`)
  }

  // Setup webhook automatically (Evolution v2.3 format)
  await registerEvolutionWebhook(baseUrl, api_key, instance_name, account.slug)

  res.json({ instance })
})

// ─── Connect (get QR code for existing instance) ─────────────────
// Middleware: permite gerente/admin OU atendente DONO da instância (primary_instance_id)
function allowInstanceOwner(req, res, next) {
  if (req.user.role === 'super_admin' || req.user.role === 'gerente') return next()
  // Atendente: tem que ser primary_instance dele
  const userPrimary = db.prepare('SELECT primary_instance_id FROM users WHERE id = ?').get(req.user.id)
  if (userPrimary?.primary_instance_id && Number(req.params.id) === Number(userPrimary.primary_instance_id)) return next()
  return res.status(403).json({ error: 'Sem permissao (so o gerente ou o atendente dono da instancia)' })
}

// PUT /whatsapp/:id/first-msg-template — atendente edita SO o template da PROPRIA inst
router.put('/whatsapp/:id/first-msg-template', allowInstanceOwner, (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const tpl = req.body.first_msg_template != null ? String(req.body.first_msg_template) : null
  db.prepare("UPDATE whatsapp_instances SET first_msg_template = ?, updated_at = datetime('now') WHERE id = ?").run(tpl || null, instance.id)
  const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
  res.json({ instance: updated })
})

router.post('/whatsapp/:id/connect', allowInstanceOwner, async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return

  try {
    const r = await fetch(`${instance.api_url}/instance/connect/${encodeURIComponent(instance.instance_name)}`, {
      headers: { apikey: instance.api_key },
    })
    const data = await r.json()
    // Evolution v2.3 pode retornar QR aninhado (data.qrcode.base64) ou direto (data.base64)
    const qrCode = data?.qrcode?.base64 || data?.base64 || null
    if (!qrCode) console.error('[Evolution Connect] sem QR — payload:', JSON.stringify(data).slice(0, 300))

    db.prepare("UPDATE whatsapp_instances SET qr_code = ?, status = 'connecting', updated_at = datetime('now') WHERE id = ?").run(qrCode, instance.id)

    // Re-register webhook on every connect to recover from any past Evolution-side resets
    const account = db.prepare('SELECT slug FROM accounts WHERE id = ?').get(instance.account_id)
    if (account?.slug) await registerEvolutionWebhook(instance.api_url, instance.api_key, instance.instance_name, account.slug)

    const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
    res.json({ instance: updated })
  } catch (err) {
    console.error('[Evolution Connect]', err.message)
    res.status(500).json({ error: 'Falha ao conectar: ' + err.message })
  }
})

// POST /whatsapp/sync-phones — backfill: popula phone_number de todas as inst connected sem phone (super_admin)
router.post('/whatsapp/sync-phones', requireRole('super_admin'), async (req, res) => {
  const insts = db.prepare("SELECT * FROM whatsapp_instances WHERE status='connected' AND (phone_number IS NULL OR phone_number = '')").all()
  const results = []
  for (const inst of insts) {
    const phone = await syncInstancePhoneIfMissing(inst)
    results.push({ id: inst.id, instance_name: inst.instance_name, phone: phone || '(falhou)' })
  }
  res.json({ ok: true, synced: results.length, results })
})

// Helper: busca + salva phone_number da Evolution se estiver vazio no banco
async function syncInstancePhoneIfMissing(instance) {
  if (instance.phone_number) return instance.phone_number
  try {
    const r = await fetch(`${instance.api_url}/instance/fetchInstances?instanceName=${encodeURIComponent(instance.instance_name)}`, {
      headers: { apikey: instance.api_key },
    })
    const data = await r.json()
    const arr = Array.isArray(data) ? data : (data?.instance ? [data.instance] : [])
    const inst = arr[0] || {}
    // Evolution retorna ownerJid (ex: 554891574922@s.whatsapp.net) — extrai só digitos
    const jid = inst.ownerJid || inst.owner || inst.number || ''
    const phone = String(jid).replace(/@.*$/, '').replace(/[^\d]/g, '')
    if (phone && phone.length >= 10) {
      db.prepare("UPDATE whatsapp_instances SET phone_number = ?, updated_at = datetime('now') WHERE id = ?").run(phone, instance.id)
      console.log(`[Integrations] phone_number sincronizado: inst=${instance.id} (${instance.instance_name}) -> ${phone}`)
      return phone
    }
  } catch (e) {
    console.error('[Integrations] sync phone falhou:', e.message)
  }
  return null
}

// ─── Check connection status ─────────────────────────────────────
router.get('/whatsapp/:id/status', async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return

  try {
    const r = await fetch(`${instance.api_url}/instance/connectionState/${encodeURIComponent(instance.instance_name)}`, {
      headers: { apikey: instance.api_key },
    })
    const data = await r.json()
    const state = data?.instance?.state || data?.state || ''

    let status = 'disconnected'
    if (state === 'open' || state === 'connected') status = 'connected'
    else if (state === 'connecting') status = 'connecting'

    // Auto-popula phone_number se estiver vazio (executado tambem quando o status check roda — frontend pinga)
    if (status === 'connected' && !instance.phone_number) {
      await syncInstancePhoneIfMissing(instance)
    }

    // If connected, clear QR code and save phone number if available
    const updates = { status }
    if (status === 'connected') {
      updates.qr_code = null
    }

    db.prepare(`UPDATE whatsapp_instances SET status = ?, qr_code = ?, updated_at = datetime('now') WHERE id = ?`).run(
      updates.status, updates.qr_code !== undefined ? updates.qr_code : instance.qr_code, instance.id
    )

    const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
    res.json({ instance: updated, state })
  } catch (err) {
    db.prepare("UPDATE whatsapp_instances SET status = 'disconnected' WHERE id = ?").run(instance.id)
    res.json({ instance: db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id), error: err.message })
  }
})

// ─── Anti-ban: health da instancia (delivered_rate, read_rate, risk_score) ──────
// GET /api/integrations/whatsapp/:id/health
// Retorna 3 janelas (1h, 6h, 24h) + risk_score 0-100 baseado em delivered_rate.
router.get('/whatsapp/:id/health', requireRole('super_admin', 'gerente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return

  const windows = [
    { label: '1h', minutes: 60 },
    { label: '6h', minutes: 360 },
    { label: '24h', minutes: 1440 },
  ]
  const stats = windows.map(w => {
    const s = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN delivery_status='sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN delivery_status='delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN delivery_status='read' THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN delivery_status='failed' THEN 1 ELSE 0 END) as failed
      FROM messages
      WHERE instance_id = ? AND direction='outbound'
        AND created_at >= datetime('now', '-${w.minutes} minutes')
    `).get(instance.id)
    // ok_rate = 1 - failed/total. Robusto mesmo se webhook nao promove sent->delivered.
    const total = s.total || 0
    const ok_rate = total > 0 ? (1 - (s.failed || 0) / total) : null
    // delivered_rate so eh calculavel se webhook estiver funcionando (delivered+read > 0)
    const delivered_known = (s.delivered || 0) + (s.read || 0)
    const delivered_rate = delivered_known > 0 ? (delivered_known / total) : null
    const read_rate = delivered_known > 0 ? (s.read / delivered_known) : null
    return { window: w.label, ...s, ok_rate, delivered_rate, read_rate }
  })

  // Risk score 0-100 baseado em ok_rate (% nao-failed). Mais robusto que delivered_rate.
  const riskScore = (() => {
    const w6h = stats.find(s => s.window === '6h') || stats[0]
    if (!w6h.total || w6h.total < 10) return 0  // amostra pequena demais
    const r = w6h.ok_rate
    if (r === null) return 0
    if (r >= 0.95) return 10
    if (r >= 0.85) return 30
    if (r >= 0.70) return 60
    return 90
  })()

  res.json({
    instance: {
      id: instance.id,
      name: instance.instance_name,
      status: instance.status,
      paused_at: instance.paused_at,
      paused_reason: instance.paused_reason,
      warmup_until: instance.warmup_until,
      business_hours_json: instance.business_hours_json,
      lead_daily_msg_cap: instance.lead_daily_msg_cap,
      hourly_send_limit: instance.hourly_send_limit,
      daily_send_limit: instance.daily_send_limit,
    },
    windows: stats,
    risk_score: riskScore,
  })
})

// ─── Refresh QR code ─────────────────────────────────────────────
router.post('/whatsapp/:id/qrcode', allowInstanceOwner, async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return

  try {
    const r = await fetch(`${instance.api_url}/instance/connect/${encodeURIComponent(instance.instance_name)}`, {
      headers: { apikey: instance.api_key },
    })
    const data = await r.json()
    const qrCode = data?.qrcode?.base64 || data?.base64 || null
    if (!qrCode) console.error('[Evolution Refresh QR] sem QR — payload:', JSON.stringify(data).slice(0, 300))

    db.prepare("UPDATE whatsapp_instances SET qr_code = ?, status = 'connecting', updated_at = datetime('now') WHERE id = ?").run(qrCode, instance.id)
    const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
    res.json({ instance: updated })
  } catch (err) {
    res.status(500).json({ error: 'Falha ao gerar QR code: ' + err.message })
  }
})

// ─── Disconnect (logout from WhatsApp) ───────────────────────────
router.post('/whatsapp/:id/disconnect', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return

  try {
    await fetch(`${instance.api_url}/instance/logout/${encodeURIComponent(instance.instance_name)}`, {
      method: 'DELETE',
      headers: { apikey: instance.api_key },
    })
  } catch (err) {
    console.error('[Evolution Logout]', err.message)
  }

  db.prepare("UPDATE whatsapp_instances SET status = 'disconnected', qr_code = NULL, updated_at = datetime('now') WHERE id = ?").run(instance.id)
  res.json({ ok: true })
})

// ─── Delete instance ─────────────────────────────────────────────
router.delete('/whatsapp/:id', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  // Tenta apagar na Evolution tambem (best-effort com timeout de 8s).
  // Se Evolution responder 404 ou timeoutar, segue o jogo e apaga do banco assim mesmo
  // — instancia fantasma (so no CRM) eh um caso valido e nao deve travar o user.
  try {
    const r = await fetch(`${instance.api_url}/instance/delete/${encodeURIComponent(instance.instance_name)}`, {
      method: 'DELETE',
      headers: { apikey: instance.api_key },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '')
      console.error(`[Evolution Delete Instance] ${instance.instance_name} HTTP ${r.status}: ${body.slice(0, 200)}`)
    }
  } catch (err) {
    console.error(`[Evolution Delete Instance] ${instance.instance_name}: ${err.name === 'TimeoutError' ? 'timeout 8s' : err.message}`)
  }
  db.prepare('DELETE FROM whatsapp_instances WHERE id = ?').run(instance.id)
  res.json({ ok: true })
})

// ─── Re-set webhook URL on Evolution API ─────────────────────────
router.post('/whatsapp/:id/setup-webhook', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const account = db.prepare('SELECT slug FROM accounts WHERE id = ?').get(instance.account_id)
  if (!account?.slug) return res.status(404).json({ error: 'Conta nao encontrada' })
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://drosagencia.com.br/crm'
  const webhookUrl = `${publicBaseUrl}/api/webhooks/evolution/${account.slug}`
  try {
    await registerEvolutionWebhook(instance.api_url, instance.api_key, instance.instance_name, account.slug)
    res.json({ ok: true, webhookUrl })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Update lead intake mode (open vs restricted) ─────────────────
router.put('/whatsapp/:id/mode', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const { mode } = req.body
  if (!['open', 'restricted'].includes(mode)) return res.status(400).json({ error: 'mode invalido (use open ou restricted)' })
  db.prepare("UPDATE whatsapp_instances SET lead_intake_mode = ?, updated_at = datetime('now') WHERE id = ?").run(mode, instance.id)
  const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
  res.json({ instance: updated })
})

// ─── Update default attendant for an instance ────────────────────
router.put('/whatsapp/:id/attendant', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const { attendant_id } = req.body
  // null clears the assignment (back to round-robin)
  if (attendant_id !== null && attendant_id !== undefined) {
    const user = db.prepare('SELECT id, account_id, role FROM users WHERE id = ? AND is_active = 1').get(attendant_id)
    if (!user) return res.status(400).json({ error: 'Usuario nao encontrado' })
    if (user.account_id && user.account_id !== instance.account_id) return res.status(400).json({ error: 'Atendente nao pertence a esta conta' })
  }
  db.prepare("UPDATE whatsapp_instances SET default_attendant_id = ?, updated_at = datetime('now') WHERE id = ?").run(attendant_id || null, instance.id)
  const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
  res.json({ instance: updated })
})

// ─── Restart Baileys session on Evolution (fixes "open but no msgs" zombie state) ───
router.post('/whatsapp/:id/restart', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  try {
    const r = await fetch(`${instance.api_url}/instance/restart/${encodeURIComponent(instance.instance_name)}`, {
      method: 'POST',
      headers: { apikey: instance.api_key },
    })
    const data = await r.json()
    res.json({ ok: true, response: data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Force run polling now (catch missed inbound messages immediately) ──
router.post('/whatsapp/sync-now', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  try {
    await runPollNow()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Renomear label da instancia (nao muda instance_name real na Evolution) ──
// Mantem sessao Baileys intacta. So altera o rotulo mostrado no CRM.
router.put('/whatsapp/:id/label', requireRole('super_admin', 'gerente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const label = String(req.body?.label || '').trim()
  if (label.length < 1 || label.length > 60) return res.status(400).json({ error: 'label invalido (1-60 chars)' })
  db.prepare("UPDATE whatsapp_instances SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(label, instance.id)
  const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
  res.json({ instance: updated })
})

// ─── Forward Notification: config por instancia ───────────────────
// Quando lead responde nessa instancia, dispara msg de alerta pra outro telefone (via outra instancia).
// Caso: lead responde no numero de disparos -> dono recebe no celular pelo numero de atendimento.
router.get('/whatsapp/:id/forward-config', requireRole('super_admin', 'gerente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  res.json({
    enabled: !!instance.forward_notif_enabled,
    via_instance_id: instance.forward_notif_via_instance_id,
    to_phone: instance.forward_notif_to_phone,
    label: instance.forward_notif_label,
    move_to_stage_id: instance.forward_notif_move_to_stage_id,
  })
})

router.put('/whatsapp/:id/forward-config', requireRole('super_admin', 'gerente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const { enabled, via_instance_id, to_phone, label, move_to_stage_id } = req.body || {}
  const en = enabled ? 1 : 0
  if (en) {
    if (!via_instance_id) return res.status(400).json({ error: 'via_instance_id obrigatorio quando ativo' })
    if (!to_phone) return res.status(400).json({ error: 'to_phone obrigatorio quando ativo' })
    const via = db.prepare('SELECT id FROM whatsapp_instances WHERE id = ?').get(via_instance_id)
    if (!via) return res.status(400).json({ error: 'via_instance_id invalida' })
    if (move_to_stage_id) {
      const stg = db.prepare('SELECT id FROM funnel_stages WHERE id = ?').get(move_to_stage_id)
      if (!stg) return res.status(400).json({ error: 'move_to_stage_id invalida' })
    }
  }
  const phoneDigits = to_phone ? String(to_phone).replace(/\D/g, '') : null
  if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
    return res.status(400).json({ error: 'to_phone invalido (10-15 digitos)' })
  }
  db.prepare(`
    UPDATE whatsapp_instances SET
      forward_notif_enabled = ?,
      forward_notif_via_instance_id = ?,
      forward_notif_to_phone = ?,
      forward_notif_label = ?,
      forward_notif_move_to_stage_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(en, via_instance_id || null, phoneDigits, label || null, move_to_stage_id || null, instance.id)
  const updated = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instance.id)
  res.json({
    enabled: !!updated.forward_notif_enabled,
    via_instance_id: updated.forward_notif_via_instance_id,
    to_phone: updated.forward_notif_to_phone,
    label: updated.forward_notif_label,
    move_to_stage_id: updated.forward_notif_move_to_stage_id,
  })
})

// Lista instancias CONECTADAS de TODAS as contas (super_admin only) — dropdown pra escolher "via"
router.get('/whatsapp-global-connected', requireRole('super_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT w.id, w.instance_name, w.display_name, w.phone_number, w.account_id, a.name as account_name
    FROM whatsapp_instances w
    LEFT JOIN accounts a ON a.id = w.account_id
    WHERE w.status = 'connected'
    ORDER BY a.name, w.instance_name
  `).all()
  res.json({ instances: rows })
})

// ─── Test connection (legacy, kept for compatibility) ────────────
router.post('/whatsapp/:id/test', requireRole('super_admin', 'gerente', 'atendente'), async (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return

  try {
    const r = await fetch(`${instance.api_url}/instance/connectionState/${encodeURIComponent(instance.instance_name)}`, {
      headers: { apikey: instance.api_key },
    })
    const data = await r.json()
    const status = data.instance?.state === 'open' ? 'connected' : 'disconnected'
    db.prepare("UPDATE whatsapp_instances SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, instance.id)
    res.json({ success: status === 'connected', status, data })
  } catch (err) {
    db.prepare("UPDATE whatsapp_instances SET status = 'disconnected' WHERE id = ?").run(instance.id)
    res.json({ success: false, error: err.message })
  }
})

// ─── Auto-mensagens por instancia ─────────────────────────────────
// GET: carrega config atual da instancia (atendente tb le pra mostrar status na sidebar)
router.get('/whatsapp/:id/auto-messages', (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const cfg = db.prepare('SELECT * FROM instance_auto_messages WHERE instance_id = ?').get(instance.id)
  res.json({ config: cfg || { instance_id: instance.id, greeting_enabled: 0, away_enabled: 0, away_mode: 'manual' } })
})

// PUT: salva config (upsert)
router.put('/whatsapp/:id/auto-messages', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  const instance = getOwnedInstance(req, res)
  if (!instance) return
  const {
    greeting_enabled = 0, greeting_text = null, greeting_cooldown_hours = 24,
    away_enabled = 0, away_text = null, away_schedule_json = null, away_cooldown_hours = 4,
  } = req.body || {}
  // Modo manual descontinuado — sempre salva como 'schedule'
  const away_mode = 'schedule'
  const away_manual_active = 0

  // Valida JSON schedule
  let scheduleStr = null
  if (away_schedule_json) {
    try {
      if (typeof away_schedule_json === 'string') { JSON.parse(away_schedule_json); scheduleStr = away_schedule_json }
      else scheduleStr = JSON.stringify(away_schedule_json)
    } catch { return res.status(400).json({ error: 'away_schedule_json invalido' }) }
  }

  const existing = db.prepare('SELECT id FROM instance_auto_messages WHERE instance_id = ?').get(instance.id)
  if (existing) {
    db.prepare(`
      UPDATE instance_auto_messages SET
        greeting_enabled = ?, greeting_text = ?, greeting_cooldown_hours = ?,
        away_enabled = ?, away_mode = ?, away_manual_active = ?, away_text = ?, away_schedule_json = ?, away_cooldown_hours = ?,
        updated_at = datetime('now')
      WHERE instance_id = ?
    `).run(
      greeting_enabled ? 1 : 0, greeting_text, parseInt(greeting_cooldown_hours) || 24,
      away_enabled ? 1 : 0, away_mode || 'manual', away_manual_active ? 1 : 0, away_text, scheduleStr, parseInt(away_cooldown_hours) || 4,
      instance.id
    )
  } else {
    db.prepare(`
      INSERT INTO instance_auto_messages (
        instance_id, greeting_enabled, greeting_text, greeting_cooldown_hours,
        away_enabled, away_mode, away_manual_active, away_text, away_schedule_json, away_cooldown_hours
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instance.id,
      greeting_enabled ? 1 : 0, greeting_text, parseInt(greeting_cooldown_hours) || 24,
      away_enabled ? 1 : 0, away_mode || 'manual', away_manual_active ? 1 : 0, away_text, scheduleStr, parseInt(away_cooldown_hours) || 4,
    )
  }
  const cfg = db.prepare('SELECT * FROM instance_auto_messages WHERE instance_id = ?').get(instance.id)
  res.json({ config: cfg })
})

// Status da integracao Google Sheets — retorna timestamp do ultimo lead recebido
router.get('/sheets-status', (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const row = db.prepare('SELECT last_sheets_lead_at, sheets_default_tag_id FROM accounts WHERE id = ?').get(req.accountId)
  res.json({
    last_lead_at: row?.last_sheets_lead_at || null,
    default_tag_id: row?.sheets_default_tag_id || null,
  })
})

// Define qual tag aplicar automaticamente em todo lead novo vindo da planilha.
// Body: { tag_id: number | null }. null = remove a tag default.
router.put('/sheets-default-tag', requireRole('super_admin', 'gerente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { tag_id } = req.body || {}
  const tagId = tag_id === null || tag_id === undefined || tag_id === '' ? null : parseInt(tag_id)
  if (tagId !== null) {
    // Valida que a tag pertence a esta conta
    const tag = db.prepare('SELECT id FROM tags WHERE id = ? AND account_id = ?').get(tagId, req.accountId)
    if (!tag) return res.status(400).json({ error: 'Tag nao encontrada nesta conta' })
  }
  db.prepare("UPDATE accounts SET sheets_default_tag_id = ?, updated_at = datetime('now') WHERE id = ?").run(tagId, req.accountId)
  res.json({ ok: true, default_tag_id: tagId })
})

export default router
