// Helper de distribuicao de lead: dispara primeira msg + notificacao ao vendedor
// quando lead eh atribuido (por roleta, bot, follow-up reply, ou manual).
//
// Comportamento idempotente: primeira msg sai 1x por lead (lead.first_msg_sent_at).
// Notificacao ao vendedor eh independente: sempre dispara se notification_instance_id configurado.

import db from '../db.js'
import fetch from 'node-fetch'

function getNotifierInstanceId() {
  // 1o: tenta app_settings (configuravel via UI super_admin)
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='notifier_instance_id'").get()
    if (row?.value) {
      const n = parseInt(row.value)
      if (!isNaN(n) && n > 0) return n
    }
  } catch {}
  // 2o: fallback pra env var (back-compat / setup inicial)
  const fromEnv = parseInt(process.env.NOTIFIER_INSTANCE_ID || '0')
  return (!isNaN(fromEnv) && fromEnv > 0) ? fromEnv : null
}

function renderTemplate(tpl, vars) {
  if (!tpl) return ''
  return tpl
    .replace(/\{\{primeiro_nome\}\}/g, vars.lead_first_name || '')
    .replace(/\{\{nome\}\}/g, vars.lead_name || '')
    .replace(/\{\{vendedor\}\}/g, vars.user_name || '')
    .replace(/\{\{vendedor_primeiro_nome\}\}/g, vars.user_first_name || '')
    .replace(/\{\{cidade\}\}/g, vars.city || '')
    .replace(/\{\{phone\}\}/g, vars.phone || '')
    .replace(/\{\{etapa\}\}/g, vars.stage_name || '')
    .replace(/\{\{funil\}\}/g, vars.funnel_name || '')
}

// ─── Pre-flight: valida se numero existe no WhatsApp via Evolution ─────────
// Cache em memoria (5min TTL) pra evitar revalidar mesmo numero em rajada.
// Map<string, { exists: true|false|null, expires: timestamp }>
const _waNumberCache = new Map()
const _CACHE_TTL_MS = 5 * 60 * 1000
const _CACHE_MAX = 2000

function _cachePut(key, exists) {
  if (_waNumberCache.size > _CACHE_MAX) {
    // LRU simples: limpa metade mais antiga
    const half = Math.floor(_CACHE_MAX / 2)
    const keys = Array.from(_waNumberCache.keys()).slice(0, half)
    for (const k of keys) _waNumberCache.delete(k)
  }
  _waNumberCache.set(key, { exists, expires: Date.now() + _CACHE_TTL_MS })
}
function _cacheGet(key) {
  const v = _waNumberCache.get(key)
  if (!v) return undefined
  if (Date.now() > v.expires) { _waNumberCache.delete(key); return undefined }
  return v.exists
}

function _normalizePhone(phone) {
  return (phone || '').replace(/[^\d]/g, '').replace(/^(?!55)(\d{10,11})$/, '55$1')
}

// ─── Anti-ban: horario comercial por instancia ───────────────────────────
// business_hours_json formato: {sun:[{start:"08:00",end:"21:00"}], mon:[...], ...}
// null = 24/7 (compat com instancias antigas). Dia sem slots = fechado.
function isInBusinessHours(instance, now = new Date()) {
  if (!instance.business_hours_json) return true
  let schedule = null
  try { schedule = JSON.parse(instance.business_hours_json) } catch { return true }
  if (!schedule || typeof schedule !== 'object') return true
  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const slots = schedule[dayKeys[now.getDay()]]
  if (!Array.isArray(slots) || slots.length === 0) return false
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return slots.some(s => s?.start && s?.end && cur >= s.start && cur <= s.end)
}

// ─── Anti-ban: cap msgs automaticas pro mesmo lead em 24h ───────────────
// Conta outbound nas ultimas 24h com sent/delivered/read. Chat manual passa
// via opts.skipLeadCap=true.
function checkLeadCap(instance, leadId) {
  if (!leadId) return { ok: true }
  const cap = instance.lead_daily_msg_cap || 5
  const count = db.prepare(`
    SELECT COUNT(*) as n FROM messages
    WHERE lead_id = ? AND direction = 'outbound'
      AND created_at >= datetime('now', '-1 day')
      AND delivery_status IN ('sent', 'delivered', 'read')
  `).get(leadId)?.n || 0
  if (count >= cap) {
    return { ok: false, reason: `lead_daily_cap_${cap}`, count, cap }
  }
  return { ok: true, count, cap }
}

// ─── Anti-ban: saude da instancia + auto-pausa por taxa de falha ────────
// Janela default 2h. Minimo 20 msgs pra avaliar (evita amostra ruim).
//
// Metrica: NAO_FAILED rate = (total - failed) / total. Esse calculo eh robusto:
// - Funciona mesmo se webhook messages.update da Evolution nao atualizar
//   sent->delivered (caso comum em algumas instalacoes).
// - Detecta REJEICAO real (Evolution recusou, numero invalido, sessao morta).
//
// Threshold: <70% nao-failed -> auto-pausa. Auto-resume eh tarefa do scheduler.
function checkInstanceHealth(instance) {
  if (instance.paused_at && instance.paused_reason === 'manual') {
    return { ok: false, reason: 'manually_paused' }
  }
  const windowMin = instance.health_check_window_min || 120
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM messages
    WHERE instance_id = ? AND direction = 'outbound'
      AND created_at >= datetime('now', '-${windowMin} minutes')
      AND delivery_status IN ('sent','delivered','read','failed')
  `).get(instance.id)
  if ((stats?.total || 0) < 20) return { ok: true, total: stats?.total || 0 }
  const failedRate = (stats.failed || 0) / stats.total
  const okRate = 1 - failedRate
  if (okRate < 0.70) {
    db.prepare("UPDATE whatsapp_instances SET paused_at = datetime('now'), paused_reason = 'delivered_rate_low' WHERE id = ?").run(instance.id)
    console.warn(`[Health] inst=${instance.instance_name} AUTO-PAUSED ok_rate=${(okRate * 100).toFixed(0)}% (failed=${stats.failed}/${stats.total})`)
    return { ok: false, reason: 'auto_paused_low_delivery', rate: okRate, failed: stats.failed, total: stats.total }
  }
  return { ok: true, rate: okRate, total: stats.total }
}

// ─── Anti-ban: marca a ultima inbound do lead como lida ─────────────────
// Replica humano que abre a conversa antes de responder.
// Best-effort: se Evolution recusar, ignora silenciosamente.
export async function markMessageAsRead(instance, lead) {
  if (!lead || !instance) return
  const lastMsg = db.prepare(`
    SELECT wa_msg_id, wa_remote_jid FROM messages
    WHERE lead_id = ? AND direction = 'inbound' AND wa_msg_id IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(lead.id)
  if (!lastMsg?.wa_msg_id) return
  const remoteJid = lastMsg.wa_remote_jid || (lead.phone ? `${_normalizePhone(lead.phone)}@s.whatsapp.net` : null)
  if (!remoteJid) return
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    await fetch(`${instance.api_url}/chat/markMessageAsRead/${instance.instance_name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: instance.api_key },
      body: JSON.stringify({ read_messages: [{ remoteJid, fromMe: false, id: lastMsg.wa_msg_id }] }),
      signal: controller.signal,
    }).catch(() => {})
    clearTimeout(timer)
  } catch {}
}

// ─── Anti-ban: quota por instancia + warm-up gradual ────────────────────
// Defaults conservadores. Override por instancia via hourly_send_limit/daily_send_limit.
// Warm-up: instancia nova (created_at < 3 dias) usa multiplicador menor.
const QUOTA_DEFAULT_PER_HOUR = 100
const QUOTA_DEFAULT_PER_DAY = 800
const WARMUP_DAYS = 3
// Dia 1 = 5% do quota, dia 2 = 20%, dia 3 = 50%. Dia 4+ = 100%.
const WARMUP_MULTIPLIERS = [0.05, 0.20, 0.50]

function checkSendQuota(instance) {
  const hourlyLimit = instance.hourly_send_limit || QUOTA_DEFAULT_PER_HOUR
  const dailyLimit = instance.daily_send_limit || QUOTA_DEFAULT_PER_DAY

  let effectiveHourly = hourlyLimit
  let effectiveDaily = dailyLimit

  // Aplica warm-up se ainda esta na janela
  if (instance.warmup_until) {
    const warmupEndMs = new Date(instance.warmup_until.replace(' ', 'T') + 'Z').getTime()
    if (warmupEndMs > Date.now()) {
      const refDate = instance.created_at || instance.warmup_until
      const createdMs = new Date(String(refDate).replace(' ', 'T') + 'Z').getTime()
      const daysIn = Math.max(0, Math.floor((Date.now() - createdMs) / 86400000))
      const mult = WARMUP_MULTIPLIERS[Math.min(daysIn, WARMUP_MULTIPLIERS.length - 1)]
      effectiveHourly = Math.max(1, Math.floor(hourlyLimit * mult))
      effectiveDaily = Math.max(1, Math.floor(dailyLimit * mult))
    }
  }

  // Conta envios reais (sent/delivered/read) na ultima hora
  const hourCount = db.prepare(`
    SELECT COUNT(*) as n FROM messages
    WHERE instance_id = ? AND direction = 'outbound'
      AND created_at >= datetime('now', '-1 hour')
      AND delivery_status IN ('sent', 'delivered', 'read')
  `).get(instance.id)?.n || 0
  if (hourCount >= effectiveHourly) {
    return { ok: false, reason: `quota_hourly_${effectiveHourly}`, hourCount, limit: effectiveHourly }
  }

  const dayCount = db.prepare(`
    SELECT COUNT(*) as n FROM messages
    WHERE instance_id = ? AND direction = 'outbound'
      AND created_at >= datetime('now', '-1 day')
      AND delivery_status IN ('sent', 'delivered', 'read')
  `).get(instance.id)?.n || 0
  if (dayCount >= effectiveDaily) {
    return { ok: false, reason: `quota_daily_${effectiveDaily}`, dayCount, limit: effectiveDaily }
  }

  return { ok: true, effectiveHourly, effectiveDaily, hourCount, dayCount }
}

// ─── Anti-ban: typing simulation ─────────────────────────────────────────
// Antes de enviar, manda presence=composing pro Evolution e aguarda tempo
// proporcional ao tamanho do texto. Caps min 1.2s, max 5s. Jitter ±25%.
const TYPING_MIN_MS = 1200
const TYPING_MAX_MS = 5000

async function simulateTyping(instance, phone, text) {
  const number = _normalizePhone(phone)
  if (!number) return
  // ~40 chars/sec digitando humano + base 800ms.
  const baseRaw = 800 + (text || '').length * 25
  const base = Math.max(TYPING_MIN_MS, Math.min(TYPING_MAX_MS, baseRaw))
  const jitter = 0.75 + Math.random() * 0.5  // 0.75x a 1.25x
  const ms = Math.round(base * jitter)

  // Best-effort: cada chamada de presence pode falhar silenciosamente.
  const sendPresence = (presence) => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      return fetch(`${instance.api_url}/chat/sendPresence/${instance.instance_name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: instance.api_key },
        body: JSON.stringify({ number, presence, delay: 100 }),
        signal: controller.signal,
      }).catch(() => {}).finally(() => clearTimeout(timer))
    } catch { return Promise.resolve() }
  }

  // Sequencia humana completa: online -> digitando -> parou de digitar -> envia
  // 1. Online (simula abrir o WhatsApp)
  await sendPresence('available')
  await new Promise(r => setTimeout(r, 300 + Math.random() * 200))  // 300-500ms
  // 2. Digitando
  await sendPresence('composing')
  await new Promise(r => setTimeout(r, ms))
  // 3. Parou de digitar (vai enviar)
  await sendPresence('paused')
  await new Promise(r => setTimeout(r, 100 + Math.random() * 100))  // 100-200ms
}

/**
 * Valida 1 numero via Evolution. Cache 5min.
 * Retorna: true (existe), false (nao existe), null (timeout/erro — assume valido pra nao bloquear envio).
 */
export async function checkWhatsAppNumber(instance, phone) {
  const number = _normalizePhone(phone)
  if (!number) return false
  const cacheKey = `${instance.id}:${number}`
  const cached = _cacheGet(cacheKey)
  if (cached !== undefined) return cached

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000) // 3s timeout
    const res = await fetch(`${instance.api_url}/chat/whatsappNumbers/${instance.instance_name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': instance.api_key },
      body: JSON.stringify({ numbers: [number] }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      // 400/500 da Evolution = nao consegui validar; cacheia null curto pra evitar spam
      _cachePut(cacheKey, null)
      return null
    }
    const data = await res.json().catch(() => null)
    // Evolution retorna array: [{ exists: bool, jid, number }]
    if (Array.isArray(data) && data.length > 0) {
      const exists = !!data[0].exists
      _cachePut(cacheKey, exists)
      return exists
    }
    _cachePut(cacheKey, null)
    return null
  } catch (e) {
    // Timeout/network — assume valido (null) pra nao bloquear envio
    return null
  }
}

/**
 * Valida lista de numeros de uma vez. Pra broadcasts.
 * Retorna Map<phone_original, true|false|null>.
 */
export async function checkWhatsAppNumbersBulk(instance, phones) {
  const result = new Map()
  if (!phones || phones.length === 0) return result

  // Dedup + normaliza
  const normalizedToOriginal = new Map()
  for (const p of phones) {
    const n = _normalizePhone(p)
    if (n && !normalizedToOriginal.has(n)) normalizedToOriginal.set(n, p)
  }
  const allNormalized = [...normalizedToOriginal.keys()]

  // Pega o que ja ta em cache; consulta o resto
  const toQuery = []
  for (const n of allNormalized) {
    const cached = _cacheGet(`${instance.id}:${n}`)
    if (cached !== undefined) {
      result.set(normalizedToOriginal.get(n), cached)
    } else {
      toQuery.push(n)
    }
  }

  if (toQuery.length === 0) return result

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000) // 15s pra lista grande
    const res = await fetch(`${instance.api_url}/chat/whatsappNumbers/${instance.instance_name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': instance.api_key },
      body: JSON.stringify({ numbers: toQuery }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      // Nao consegui validar nenhum — marca todos como null
      for (const n of toQuery) {
        _cachePut(`${instance.id}:${n}`, null)
        result.set(normalizedToOriginal.get(n), null)
      }
      return result
    }
    const data = await res.json().catch(() => null)
    if (Array.isArray(data)) {
      // Cria index por number normalizado
      const byNumber = new Map()
      for (const item of data) {
        const num = String(item.number || '').replace(/[^\d]/g, '')
        if (num) byNumber.set(num, !!item.exists)
      }
      for (const n of toQuery) {
        const exists = byNumber.has(n) ? byNumber.get(n) : null
        _cachePut(`${instance.id}:${n}`, exists)
        result.set(normalizedToOriginal.get(n), exists)
      }
    } else {
      for (const n of toQuery) {
        _cachePut(`${instance.id}:${n}`, null)
        result.set(normalizedToOriginal.get(n), null)
      }
    }
    return result
  } catch (e) {
    for (const n of toQuery) result.set(normalizedToOriginal.get(n), null)
    return result
  }
}

/**
 * Envia msg via Evolution com pre-flight de validacao de numero e protecoes anti-ban.
 *
 * @param {Object} instance
 * @param {string} phone
 * @param {string} text
 * @param {Object} [opts]
 * @param {number} [opts.leadId] - lead.id pra cap diario (recomendado se disponivel)
 * @param {boolean} [opts.skipValidation=false] - pula pre-flight de numero
 * @param {boolean} [opts.skipTyping=false] - pula sequencia de presence (chat humano)
 * @param {boolean} [opts.skipQuota=false] - pula quota por instancia (chat humano)
 * @param {boolean} [opts.skipBusinessHours=false] - pula horario comercial (chat humano + auto-msgs)
 * @param {boolean} [opts.skipLeadCap=false] - pula cap por lead/dia (chat humano)
 * @param {boolean} [opts.skipHealthCheck=false] - pula check de delivered_rate (chat humano)
 * @returns {Promise<{ok: boolean, wamsgId: string|null, reason?: string, validationFailed?: boolean, raw?: object}>}
 */
export async function sendViaInstance(instance, phone, text, opts = {}) {
  const number = _normalizePhone(phone)
  if (!number) return { ok: false, reason: 'phone vazio' }

  // Instancia pausada (auto ou manual) — bloqueia tudo exceto chat humano
  if (instance.paused_at && !opts.skipHealthCheck) {
    return { ok: false, reason: `instance_paused_${instance.paused_reason || 'unknown'}` }
  }

  // Horario comercial (skip pra chat manual humano e auto-mensagens de ausencia)
  if (!opts.skipBusinessHours) {
    if (!isInBusinessHours(instance)) {
      return { ok: false, reason: 'outside_business_hours' }
    }
  }

  // Cap por lead/dia (skip pra chat manual humano)
  if (!opts.skipLeadCap && opts.leadId) {
    const c = checkLeadCap(instance, opts.leadId)
    if (!c.ok) {
      console.warn(`[LeadCap] inst=${instance.instance_name} lead=${opts.leadId} bloqueado: ${c.reason} (count=${c.count}/${c.cap})`)
      return { ok: false, reason: c.reason }
    }
  }

  // Saude da instancia (delivered_rate) — pode auto-pausar
  if (!opts.skipHealthCheck) {
    const h = checkInstanceHealth(instance)
    if (!h.ok) return { ok: false, reason: h.reason }
  }

  // Pre-flight: valida numero (a menos que caller diga pra pular)
  if (!opts.skipValidation) {
    const exists = await checkWhatsAppNumber(instance, phone)
    if (exists === false) {
      console.log(`[Pre-flight] phone=${number} inst=${instance.instance_name} exists=false — bloqueando envio`)
      return { ok: false, reason: 'number_not_on_whatsapp', validationFailed: true }
    }
    // exists === null (timeout/erro de validacao): segue mesmo assim
  }

  // Quota check (skip pra chat manual humano)
  if (!opts.skipQuota) {
    const q = checkSendQuota(instance)
    if (!q.ok) {
      console.warn(`[Quota] inst=${instance.instance_name} bloqueado: ${q.reason} (count=${q.hourCount ?? q.dayCount}/${q.limit})`)
      return { ok: false, reason: q.reason }
    }
  }

  // Anti-ban: typing simulation antes do envio (skip pra chat manual humano)
  if (!opts.skipTyping) await simulateTyping(instance, phone, text)

  try {
    let endpoint, body
    if (opts.media && opts.media.base64 && opts.media.mime) {
      // Envio de midia com legenda. mediatype deduzido do mime (image/video/document/audio).
      // text vira caption (preserva \n). Audio nao suporta caption no WhatsApp (ignora).
      const mt = opts.media.mime.startsWith('image/') ? 'image'
        : opts.media.mime.startsWith('video/') ? 'video'
        : opts.media.mime.startsWith('audio/') ? 'audio'
        : 'document'
      endpoint = `${instance.api_url}/message/sendMedia/${encodeURIComponent(instance.instance_name)}`
      body = {
        number,
        mediatype: mt,
        media: opts.media.base64,
        mimetype: opts.media.mime,
        fileName: opts.media.fileName || `arquivo.${opts.media.mime.split('/')[1] || 'bin'}`,
        caption: text || undefined,
      }
    } else {
      endpoint = `${instance.api_url}/message/sendText/${encodeURIComponent(instance.instance_name)}`
      body = { number, text }
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': instance.api_key },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.key?.id) {
      // Evolution recusou — capta motivo se vier
      const reason = data?.response?.message?.[0]?.exists === false
        ? 'number_not_on_whatsapp'
        : (data?.error || data?.message || `http_${res.status}`)
      return { ok: false, reason: String(reason).substring(0, 200), raw: data }
    }
    return { ok: true, wamsgId: data.key.id, raw: data }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

const SOURCE_LABELS = {
  webhook: 'novo lead',
  bot_handoff: 'transferido do bot',
  followup_reply: 'respondeu follow-up',
  manual_assign: 'atribuido manualmente',
}

/**
 * Dispara primeira msg + notificacao ao atribuir lead a um vendedor.
 *
 * @param {number} leadId
 * @param {number} attendantUserId
 * @param {Object} [opts]
 * @param {string} [opts.source] - 'webhook'|'bot_handoff'|'followup_reply'|'manual_assign' (log + label notif)
 * @param {boolean} [opts.forceFirstMsg] - se true, ignora flag idempotencia
 */
export async function notifyAndOpenLead(leadId, attendantUserId, opts = {}) {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId)
    if (!lead || !lead.phone) return

    const user = db.prepare('SELECT id, name, primary_instance_id, notification_instance_id, is_bot, is_active FROM users WHERE id=?').get(attendantUserId)
    if (!user || user.is_bot || !user.is_active) return

    // Pega etapa + funil atual do lead (pra mostrar na notif)
    const stageInfo = lead.stage_id ? db.prepare(`
      SELECT s.name as stage_name, f.name as funnel_name
      FROM funnel_stages s LEFT JOIN funnels f ON f.id = s.funnel_id
      WHERE s.id = ?
    `).get(lead.stage_id) : null

    const vars = {
      lead_name: lead.name || '',
      lead_first_name: (lead.name || '').split(' ')[0],
      user_name: user.name || '',
      user_first_name: (user.name || '').split(' ')[0],
      city: lead.city || '',
      phone: lead.phone || '',
      stage_name: stageInfo?.stage_name || '',
      funnel_name: stageInfo?.funnel_name || '',
    }

    // ETAPA 1: Primeira msg pro lead via primary_instance do vendedor
    // Skip se: opts.skipFirstMsg (manual sem checkbox), vendedor sem primary, ja foi enviada,
    // OU se mesma instancia E lead ja interagiu (caso Oxi: lead mandou inbound antes).
    // Box Paper: mesma instancia MAS sem inbound (lead novo via planilha) → continua.
    const hasInbound = db.prepare("SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'inbound' LIMIT 1").get(lead.id)
    const sameInstActiveLead = user.primary_instance_id === lead.instance_id && !!hasInbound
    const shouldSendFirstMsg = (
      !opts.skipFirstMsg &&
      user.primary_instance_id &&
      !sameInstActiveLead &&
      (!lead.first_msg_sent_at || opts.forceFirstMsg)
    )

    if (shouldSendFirstMsg) {
      const vendInst = db.prepare("SELECT * FROM whatsapp_instances WHERE id=? AND status='connected'").get(user.primary_instance_id)
      if (vendInst) {
        // Template resolution: funnel.template (override) > instance.template
        const funnelTpl = lead.funnel_id ? db.prepare('SELECT first_msg_template FROM funnels WHERE id=?').get(lead.funnel_id) : null
        const tpl = funnelTpl?.first_msg_template || vendInst.first_msg_template
        if (tpl && tpl.trim()) {
          const text = renderTemplate(tpl, vars)
          if (text.trim()) {
            const r = await sendViaInstance(vendInst, lead.phone, text, { leadId: lead.id })
            if (r.ok) {
              db.prepare(`INSERT INTO messages (lead_id, account_id, direction, content, media_type, sender_name, wa_msg_id, instance_id)
                          VALUES (?, ?, 'outbound', ?, 'text', ?, ?, ?)`)
                .run(lead.id, lead.account_id, text, user.name, r.wamsgId, vendInst.id)
              // CRITICO: muda last_instance_id pro chat abrir na inst certa
              db.prepare("UPDATE leads SET last_instance_id=?, first_msg_sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
                .run(vendInst.id, lead.id)
              db.prepare(`INSERT OR IGNORE INTO lead_instance_assignments (lead_id, instance_id, attendant_id) VALUES (?, ?, ?)`)
                .run(lead.id, vendInst.id, user.id)
              console.log(`[Handoff] 1a msg lead=${lead.id} via ${vendInst.instance_name} (vendedor=${user.name}) source=${opts.source || '?'}`)
            } else {
              console.error(`[Handoff] 1a msg FALHOU lead=${lead.id}:`, r.reason || JSON.stringify(r.raw).substring(0, 150))
            }
          }
        }
      }
    } else if (sameInstActiveLead) {
      console.log(`[Handoff] 1a msg SKIP lead=${lead.id} — mesma inst com inbound previo (caso Oxi) source=${opts.source || '?'}`)
    }

    // ETAPA 2: Notificacao pro vendedor (INDEPENDENTE da primeira msg)
    const NOTIFIER_ID = getNotifierInstanceId()
    if (NOTIFIER_ID && user.notification_instance_id) {
      const notifier = db.prepare("SELECT * FROM whatsapp_instances WHERE id=? AND status='connected'").get(NOTIFIER_ID)
      const userInst = db.prepare('SELECT phone_number FROM whatsapp_instances WHERE id=?').get(user.notification_instance_id)
      if (notifier && userInst?.phone_number) {
        const cityPart = vars.city ? ` • ${vars.city}` : ''
        const stagePart = vars.stage_name
          ? `\n🎯 ${vars.funnel_name ? vars.funnel_name + ' → ' : ''}${vars.stage_name}`
          : ''
        const sourceLabel = SOURCE_LABELS[opts.source] || 'novo lead'
        const text = `📩 ${sourceLabel.charAt(0).toUpperCase() + sourceLabel.slice(1)}: ${vars.lead_name || vars.phone} (${vars.phone})${cityPart}${stagePart}\n\nAbra o CRM pra continuar a conversa.`
        // Notifier eh msg interna pro vendedor (nao pro lead). Skip tudo anti-ban.
        const r = await sendViaInstance(notifier, userInst.phone_number, text, {
          skipBusinessHours: true, skipLeadCap: true, skipQuota: true, skipHealthCheck: true,
        })
        if (r.ok) console.log(`[Handoff] Notif lead=${lead.id} -> ${user.name} source=${opts.source || '?'}`)
        else console.error(`[Handoff] Notif FALHOU lead=${lead.id}:`, r.reason || JSON.stringify(r.raw).substring(0, 150))
      }
    }
  } catch (err) {
    console.error('[Handoff] notifyAndOpenLead erro:', err.message)
  }
}
