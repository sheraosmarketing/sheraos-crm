import { Router } from 'express'
import fetch from 'node-fetch'
import db from '../db.js'
import { requireRole } from '../middleware/auth.js'
import { broadcastSSE } from '../sse.js'
import { triggerCapiForStageChange } from '../services/metaCapi.js'
import { notifyAndOpenLead } from '../services/leadHandoff.js'
import { sendBotWelcomeForSheetsLead, processInboundMessage, diagnoseForceAi } from '../services/aiAgent.js'
import { canAtendenteAccessLead } from '../services/leadAccess.js'

const router = Router()

// Chave canonica pra dedup: DDD + 8 digitos finais (ignora 55 e 9 de celular)
function phoneCompareKey(p) {
  let d = String(p || '').replace(/[^\d]/g, '')
  if (!d) return ''
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2)
  if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)
  return d.length === 10 ? d : d.slice(-10)
}

// Normalize phone to Brazil format (55DDXXXXXXXXX = 13 digits)
// Only normalizes when we have enough info. Never invents DDD.
function normalizePhone(phone) {
  if (!phone) return phone
  phone = phone.replace(/[^\d]/g, '')
  // 13 dig starting with 55 → already correct
  if (phone.startsWith('55') && phone.length === 13) return phone
  // 12 dig starting with 55 (55+DDD+8dig) → add 9 after DDD
  if (phone.startsWith('55') && phone.length === 12) return phone.slice(0, 4) + '9' + phone.slice(4)
  // 11 dig NOT starting with 55 (DDD+9+8dig) → add 55
  if (!phone.startsWith('55') && phone.length === 11) return '55' + phone
  // 10 dig NOT starting with 55 (DDD+8dig) → add 55 + 9 after DDD
  if (!phone.startsWith('55') && phone.length === 10) return '55' + phone.slice(0, 2) + '9' + phone.slice(2)
  // Anything else (9 dig, 11 with 55, etc): return as-is — can't normalize safely, no DDD
  return phone
}

// List leads with filters
router.get('/', (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })

  const { stage_id, attendant_id, instance_id, funnel_id, source, tag, city, search, date_from, date_to, show_archived, anuncio, page = '1', limit: rawLimit = '50' } = req.query
  // Teto generoso pra permitir montar broadcasts gigantes (importados em massa).
  // Payload de 5000 leads magros (~500KB) continua tranquilo. Clamp impede DoS por ?limit=999999.
  const limit = Math.max(1, Math.min(5000, parseInt(rawLimit) || 50))
  const where = ['l.account_id = ?', 'l.is_active = 1', 'l.is_blocked = 0']
  const params = [req.accountId]

  // Archive filter: default hides archived; pass show_archived=1 to list only archived, =all to include both
  if (show_archived === '1') where.push('l.is_archived = 1')
  else if (show_archived !== 'all') where.push('l.is_archived = 0')

  // Atendente ve leads pela UNIAO de 4 criterios (nao rompe historico):
  //   1) l.attendant_id = eu (atribuido direto)
  //   2) lead_instance_assignments (M:N de historico)
  //   3) l.instance_id = minha instancia primaria (lead nasceu na minha inst)
  //   4) l.last_instance_id = minha instancia primaria (ultima conversa foi minha)
  // Se atendente NAO tem primary_instance_id: cai no comportamento antigo (so 1+2), evita perder acesso enquanto gerente nao atribui.
  if (req.user.role === 'atendente') {
    const userRow = db.prepare('SELECT primary_instance_id FROM users WHERE id = ?').get(req.user.id)
    const primaryId = userRow?.primary_instance_id || null
    if (primaryId) {
      where.push('(l.attendant_id = ? OR l.id IN (SELECT lead_id FROM lead_instance_assignments WHERE attendant_id = ?) OR l.instance_id = ? OR l.last_instance_id = ?)')
      params.push(req.user.id, req.user.id, primaryId, primaryId)
    } else {
      where.push('(l.attendant_id = ? OR l.id IN (SELECT lead_id FROM lead_instance_assignments WHERE attendant_id = ?))')
      params.push(req.user.id, req.user.id)
    }
  }

  // Helper: parse CSV de IDs ("1,2,3" → [1,2,3])
  const parseIds = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))

  if (stage_id) {
    const ids = parseIds(stage_id)
    if (ids.length === 1) { where.push('l.stage_id = ?'); params.push(ids[0]) }
    else if (ids.length > 1) { where.push(`l.stage_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids) }
  }
  if (attendant_id) {
    const parts = String(attendant_id).split(',').map(s => s.trim()).filter(Boolean)
    const wantNone = parts.includes('none')
    const ids = parts.filter(p => p !== 'none').map(Number).filter(n => !isNaN(n))
    const conds = []
    if (wantNone) conds.push('l.attendant_id IS NULL')
    if (ids.length > 0) {
      conds.push(`l.attendant_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    if (conds.length > 0) where.push(`(${conds.join(' OR ')})`)
  }
  if (instance_id) {
    const ids = parseIds(instance_id)
    if (ids.length === 1) { where.push('l.instance_id = ?'); params.push(ids[0]) }
    else if (ids.length > 1) { where.push(`l.instance_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids) }
  }
  if (funnel_id) { where.push('l.funnel_id = ?'); params.push(funnel_id) }
  if (source) { where.push('l.source = ?'); params.push(source) }
  // Filtro por origem anuncio: anuncio=sim => veio de ad; anuncio=nao => nao veio
  if (anuncio === 'sim' || anuncio === '1' || anuncio === 'true') { where.push('l.trabalha_anuncio = 1') }
  else if (anuncio === 'nao' || anuncio === '0' || anuncio === 'false') { where.push('(l.trabalha_anuncio = 0 OR l.trabalha_anuncio IS NULL)') }
  if (city) { where.push('l.city LIKE ?'); params.push(`%${city}%`) }
  if (search) { where.push("(l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`) }
  if (date_from) { where.push('l.created_at >= ?'); params.push(date_from) }
  if (date_to) { where.push('l.created_at <= ?'); params.push(date_to + ' 23:59:59') }
  if (tag) {
    const parts = String(tag).split(',').map(s => s.trim()).filter(Boolean)
    const wantUntagged = parts.includes('untagged') || parts.includes('none')
    const ids = parts.filter(p => p !== 'untagged' && p !== 'none').map(Number).filter(n => !isNaN(n))
    const conds = []
    if (wantUntagged) conds.push('l.id NOT IN (SELECT lead_id FROM lead_tags)')
    if (ids.length > 0) {
      conds.push(`l.id IN (SELECT lead_id FROM lead_tags WHERE tag_id IN (${ids.map(() => '?').join(',')}))`)
      params.push(...ids)
    }
    if (conds.length > 0) where.push(`(${conds.join(' OR ')})`)
  }

  const countSql = `SELECT COUNT(*) as total FROM leads l WHERE ${where.join(' AND ')}`
  const total = db.prepare(countSql).get(...params).total

  const offset = (parseInt(page) - 1) * parseInt(limit)
  const sql = `
    SELECT l.*, fs.name as stage_name, fs.color as stage_color, u.name as attendant_name,
      wi.instance_name as instance_name,
      (SELECT content FROM messages WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM messages WHERE lead_id = l.id) as message_count
    FROM leads l
    LEFT JOIN funnel_stages fs ON l.stage_id = fs.id
    LEFT JOIN users u ON l.attendant_id = u.id
    LEFT JOIN whatsapp_instances wi ON l.instance_id = wi.id
    WHERE ${where.join(' AND ')}
    ORDER BY l.updated_at DESC
    LIMIT ? OFFSET ?
  `
  const leads = db.prepare(sql).all(...params, parseInt(limit), offset)

  // Attach tags to all leads in one query (avoid N+1)
  if (leads.length > 0) {
    const placeholders = leads.map(() => '?').join(',')
    const allTags = db.prepare(`SELECT lt.lead_id, t.id, t.name, t.color FROM lead_tags lt JOIN tags t ON lt.tag_id = t.id WHERE lt.lead_id IN (${placeholders})`).all(...leads.map(l => l.id))
    const tagsMap = new Map()
    allTags.forEach(tag => { if (!tagsMap.has(tag.lead_id)) tagsMap.set(tag.lead_id, []); tagsMap.get(tag.lead_id).push({ id: tag.id, name: tag.name, color: tag.color }) })
    for (const lead of leads) lead.tags = tagsMap.get(lead.id) || []
  } else {
    for (const lead of leads) lead.tags = []
  }

  res.json({ leads, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) })
})

// Create lead manually — atendente can create too, but lead is force-assigned to them
router.post('/', (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  let { name, phone, email, city, source, source_detail, notes, funnel_id, attendant_id, instance_id, empresa, cpf_cnpj, instagram, trabalha_anuncio, investimento_anuncios } = req.body

  phone = normalizePhone(phone)

  // Duplicata: chave canonica (DDD + 8 digitos) cobre todos formatos
  if (phone) {
    // 1) match exato
    let existing = db.prepare('SELECT * FROM leads WHERE account_id = ? AND phone = ? ORDER BY is_archived ASC, created_at DESC LIMIT 1').get(req.accountId, phone)
    // 2) fallback: busca por sufixo 8d e compara chave canonica
    if (!existing) {
      const key = phoneCompareKey(phone)
      if (key) {
        const last8 = key.slice(-8)
        const candidates = db.prepare('SELECT * FROM leads WHERE account_id = ? AND phone LIKE ? ORDER BY is_archived ASC, created_at DESC').all(req.accountId, '%' + last8)
        existing = candidates.find(c => phoneCompareKey(c.phone) === key) || null
      }
    }
    if (existing) {
      // Se atendente nao pode acessar (nao eh dono, sem assignment, nao eh da instancia dele), retorna msg especial sem expor dados alheios
      if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, existing)) {
        const owner = existing.attendant_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(existing.attendant_id) : null
        return res.status(409).json({
          error: owner ? `Esse telefone ja esta cadastrado com o atendente ${owner.name} da sua empresa.` : 'Esse telefone ja esta cadastrado com outro atendente da sua empresa.',
          otherAttendant: true,
          ownerName: owner?.name || null,
          leadId: existing.id,
        })
      }
      return res.status(409).json({ error: 'Contato ja existe com esse telefone', existing })
    }
  }

  // Atendente only sees own leads, so creation always self-assigns
  if (req.user.role === 'atendente') attendant_id = req.user.id

  // Get default funnel if not specified
  let fid = funnel_id
  if (!fid) {
    const defaultFunnel = db.prepare('SELECT id FROM funnels WHERE account_id = ? AND is_default = 1 AND is_active = 1').get(req.accountId)
    if (!defaultFunnel) return res.status(400).json({ error: 'Nenhum funil configurado' })
    fid = defaultFunnel.id
  }

  // Get first stage
  const firstStage = db.prepare('SELECT id FROM funnel_stages WHERE funnel_id = ? ORDER BY position LIMIT 1').get(fid)
  if (!firstStage) return res.status(400).json({ error: 'Funil sem etapas' })

  // Default instance_id to the most recently created connected instance for this account
  if (!instance_id) {
    const def = db.prepare("SELECT id FROM whatsapp_instances WHERE account_id = ? AND status = 'connected' ORDER BY id DESC LIMIT 1").get(req.accountId)
    instance_id = def?.id || null
  }

  const result = db.prepare(`
    INSERT INTO leads (account_id, funnel_id, stage_id, attendant_id, instance_id, name, phone, email, city, source, source_detail, notes, empresa, cpf_cnpj, instagram, trabalha_anuncio, investimento_anuncios, opted_in_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(req.accountId, fid, firstStage.id, attendant_id || null, instance_id || null, name, phone, email, city, source || 'manual', source_detail, notes, empresa || null, cpf_cnpj || null, instagram || null, trabalha_anuncio ? 1 : 0, investimento_anuncios || null)

  // Log stage history
  const histRes = db.prepare('INSERT INTO stage_history (lead_id, to_stage_id, trigger_type, triggered_by) VALUES (?, ?, ?, ?)').run(
    result.lastInsertRowid, firstStage.id, 'manual', req.user.id
  )

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid)

  // Cria assignment do lead com a instancia escolhida (necessario pras tabs aparecerem no Chat)
  // Tambem grava last_instance_id pra o envio manual usar essa instancia por padrao
  if (instance_id) {
    db.prepare("UPDATE leads SET last_instance_id = ? WHERE id = ?").run(instance_id, lead.id)
    db.prepare(`
      INSERT OR IGNORE INTO lead_instance_assignments (lead_id, instance_id, attendant_id)
      VALUES (?, ?, ?)
    `).run(lead.id, instance_id, attendant_id || null)
    lead.last_instance_id = instance_id
  }

  // CAPI: dispara evento da etapa inicial
  triggerCapiForStageChange(lead.id, firstStage.id, histRes.lastInsertRowid)
  try { broadcastSSE(req.accountId, 'lead:created', lead) } catch {}
  res.json({ lead })
})

// Archived count (+ count with new activity). Must be declared before `/:id`.
// Lista as fontes distintas de leads da conta (para popular filtro dinamico no frontend).
// Vem ANTES de '/:id' pra nao ser capturada como id.
router.get('/sources', (req, res) => {
  if (!req.accountId) return res.json({ sources: [] })
  const rows = db.prepare(`
    SELECT source, COUNT(*) as n FROM leads
    WHERE account_id = ? AND source IS NOT NULL AND source != ''
    GROUP BY source
    ORDER BY n DESC
  `).all(req.accountId)
  res.json({ sources: rows.map(r => r.source) })
})

router.get('/archived-count', (req, res) => {
  if (!req.accountId) return res.json({ count: 0, withActivity: 0 })
  // Espelha a UNIAO usada em GET /leads pra manter consistencia (atendente conta leads da instancia dele tambem)
  let where = 'account_id = ? AND is_archived = 1'
  const args = [req.accountId]
  if (req.user.role === 'atendente') {
    const userRow = db.prepare('SELECT primary_instance_id FROM users WHERE id = ?').get(req.user.id)
    const primaryId = userRow?.primary_instance_id || null
    if (primaryId) {
      where += ' AND (attendant_id = ? OR id IN (SELECT lead_id FROM lead_instance_assignments WHERE attendant_id = ?) OR instance_id = ? OR last_instance_id = ?)'
      args.push(req.user.id, req.user.id, primaryId, primaryId)
    } else {
      where += ' AND (attendant_id = ? OR id IN (SELECT lead_id FROM lead_instance_assignments WHERE attendant_id = ?))'
      args.push(req.user.id, req.user.id)
    }
  }
  const count = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE ${where}`).get(...args).n
  const withActivity = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE ${where} AND has_new_after_archive = 1`).get(...args).n
  res.json({ count, withActivity })
})

// ─── Pedidos de transferencia de lead entre atendentes ─────────────
// IMPORTANTE: precisam vir ANTES da rota '/:id' pra nao serem capturadas como id

// Lista pedidos pendentes recebidos pelo usuario atual (pra notification badge)
router.get('/transfer-requests/pending', (req, res) => {
  const requests = db.prepare(`
    SELECT tr.id, tr.lead_id, tr.from_attendant_id, tr.message, tr.created_at,
           l.name as lead_name, l.phone as lead_phone,
           u.name as from_attendant_name
    FROM lead_transfer_requests tr
    JOIN leads l ON l.id = tr.lead_id
    JOIN users u ON u.id = tr.from_attendant_id
    WHERE tr.to_attendant_id = ? AND tr.status = 'pending'
    ORDER BY tr.created_at DESC
  `).all(req.user.id)
  res.json({ requests })
})

// Lista TODOS os pedidos relacionados ao usuario (recebidos + enviados, todos status)
router.get('/transfer-requests/all', (req, res) => {
  const received = db.prepare(`
    SELECT tr.*, l.name as lead_name, l.phone as lead_phone,
           uf.name as from_attendant_name,
           ut.name as to_attendant_name
    FROM lead_transfer_requests tr
    JOIN leads l ON l.id = tr.lead_id
    JOIN users uf ON uf.id = tr.from_attendant_id
    LEFT JOIN users ut ON ut.id = tr.to_attendant_id
    WHERE tr.to_attendant_id = ?
    ORDER BY (tr.status = 'pending') DESC, tr.created_at DESC
    LIMIT 100
  `).all(req.user.id)
  const sent = db.prepare(`
    SELECT tr.*, l.name as lead_name, l.phone as lead_phone,
           uf.name as from_attendant_name,
           ut.name as to_attendant_name
    FROM lead_transfer_requests tr
    JOIN leads l ON l.id = tr.lead_id
    JOIN users uf ON uf.id = tr.from_attendant_id
    LEFT JOIN users ut ON ut.id = tr.to_attendant_id
    WHERE tr.from_attendant_id = ?
    ORDER BY (tr.status = 'pending') DESC, tr.created_at DESC
    LIMIT 100
  `).all(req.user.id)
  res.json({ received, sent })
})

// Cancela pedido (so o requester ou gerente/admin pode)
router.post('/transfer-requests/:reqId/cancel', (req, res) => {
  const tr = db.prepare('SELECT * FROM lead_transfer_requests WHERE id = ?').get(req.params.reqId)
  if (!tr) return res.status(404).json({ error: 'Pedido nao encontrado' })
  if (tr.status !== 'pending') return res.status(400).json({ error: 'Pedido ja respondido, nao pode cancelar' })
  const canCancel = tr.from_attendant_id === req.user.id || ['gerente','super_admin'].includes(req.user.role)
  if (!canCancel) return res.status(403).json({ error: 'Sem permissao' })
  db.prepare("UPDATE lead_transfer_requests SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?").run(tr.id)
  try { broadcastSSE(tr.account_id, 'lead:transfer-rejected', { requestId: tr.id, leadId: tr.lead_id, fromUserId: tr.from_attendant_id, cancelled: true }) } catch {}
  res.json({ ok: true })
})

// Assumir lead diretamente (so pra atendentes com permissao can_grab_leads ou gerente/admin)
router.post('/:id/grab', (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (lead.attendant_id === req.user.id) return res.status(400).json({ error: 'Voce ja eh o atendente deste lead' })

  // Permissao: gerente/admin sempre podem; atendente precisa de can_grab_leads=1
  const fresh = db.prepare('SELECT can_grab_leads FROM users WHERE id = ?').get(req.user.id)
  const allowed = ['super_admin','gerente'].includes(req.user.role) || (fresh?.can_grab_leads === 1)
  if (!allowed) return res.status(403).json({ error: 'Voce nao tem permissao pra assumir leads de outros atendentes' })

  const oldAttendantId = lead.attendant_id
  db.prepare("UPDATE leads SET attendant_id = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, lead.id)
  if (oldAttendantId) {
    db.prepare('UPDATE lead_instance_assignments SET attendant_id = ? WHERE lead_id = ? AND attendant_id = ?').run(req.user.id, lead.id, oldAttendantId)
  } else {
    db.prepare('UPDATE lead_instance_assignments SET attendant_id = ? WHERE lead_id = ? AND attendant_id IS NULL').run(req.user.id, lead.id)
  }
  // Cancela quaisquer pedidos pending pra esse lead
  db.prepare("UPDATE lead_transfer_requests SET status = 'cancelled', responded_at = datetime('now') WHERE lead_id = ? AND status = 'pending'").run(lead.id)

  // SSE pra atualizar UIs (atendente antigo perde, novo ganha)
  try { broadcastSSE(req.accountId, 'lead:transfer-accepted', { requestId: null, leadId: lead.id, newAttendantId: req.user.id, newAttendantName: req.user.name, grabbed: true }) } catch {}

  res.json({ ok: true, leadId: lead.id })
})

// Criar pedido de transferencia (Emily pede pra Deivid)
router.post('/:id/transfer-request', (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (lead.attendant_id === req.user.id) return res.status(400).json({ error: 'Voce ja eh o atendente deste lead' })

  // Verifica se ja tem pedido pending do mesmo requester pro mesmo lead — nao duplica
  const existing = db.prepare(`
    SELECT * FROM lead_transfer_requests
    WHERE lead_id = ? AND from_attendant_id = ? AND status = 'pending'
  `).get(lead.id, req.user.id)
  if (existing) return res.json({ request: existing, alreadyExists: true })

  const message = String(req.body?.message || '').trim().substring(0, 500) || null
  const result = db.prepare(`
    INSERT INTO lead_transfer_requests (lead_id, from_attendant_id, to_attendant_id, account_id, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(lead.id, req.user.id, lead.attendant_id || null, req.accountId, message)

  const request = db.prepare(`
    SELECT tr.*, l.name as lead_name, l.phone as lead_phone, u.name as from_attendant_name
    FROM lead_transfer_requests tr
    JOIN leads l ON l.id = tr.lead_id
    JOIN users u ON u.id = tr.from_attendant_id
    WHERE tr.id = ?
  `).get(result.lastInsertRowid)

  // SSE broadcast — frontend filtra pelo to_attendant_id
  try { broadcastSSE(req.accountId, 'lead:transfer-requested', request) } catch {}

  res.json({ request, alreadyExists: false })
})

// Deivid aceita o pedido
router.post('/transfer-requests/:reqId/accept', (req, res) => {
  const tr = db.prepare('SELECT * FROM lead_transfer_requests WHERE id = ?').get(req.params.reqId)
  if (!tr) return res.status(404).json({ error: 'Pedido nao encontrado' })
  if (tr.status !== 'pending') return res.status(400).json({ error: 'Pedido ja respondido' })
  // FIX #4 (multi-tenant) — transfer request de outra conta nao pode ser aceito
  if (req.accountId && tr.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  // Quem pode aceitar: o destinatario (to_attendant_id) OU gerente/super_admin da conta
  const canAccept = tr.to_attendant_id === req.user.id || ['gerente','super_admin'].includes(req.user.role)
  if (!canAccept) return res.status(403).json({ error: 'Sem permissao pra aceitar este pedido' })

  // Transfere o lead
  db.prepare("UPDATE leads SET attendant_id = ?, updated_at = datetime('now') WHERE id = ?").run(tr.from_attendant_id, tr.lead_id)
  // Atualiza assignments pra new atendente onde antigo era atendente
  if (tr.to_attendant_id) {
    db.prepare('UPDATE lead_instance_assignments SET attendant_id = ? WHERE lead_id = ? AND attendant_id = ?').run(tr.from_attendant_id, tr.lead_id, tr.to_attendant_id)
  } else {
    db.prepare('UPDATE lead_instance_assignments SET attendant_id = ? WHERE lead_id = ? AND attendant_id IS NULL').run(tr.from_attendant_id, tr.lead_id)
  }
  // Marca pedido como aceito
  db.prepare("UPDATE lead_transfer_requests SET status = 'accepted', responded_at = datetime('now') WHERE id = ?").run(tr.id)
  // Cancela outros pedidos pendentes pro mesmo lead (de outros atendentes que tambem queriam)
  db.prepare("UPDATE lead_transfer_requests SET status = 'cancelled', responded_at = datetime('now') WHERE lead_id = ? AND status = 'pending'").run(tr.lead_id)

  const requester = db.prepare('SELECT name FROM users WHERE id = ?').get(tr.from_attendant_id)
  const payload = {
    requestId: tr.id,
    leadId: tr.lead_id,
    newAttendantId: tr.from_attendant_id,
    newAttendantName: requester?.name || null,
    accountId: tr.account_id,
  }
  try { broadcastSSE(tr.account_id, 'lead:transfer-accepted', payload) } catch {}

  res.json({ ok: true })
})

// Deivid rejeita
router.post('/transfer-requests/:reqId/reject', (req, res) => {
  const tr = db.prepare('SELECT * FROM lead_transfer_requests WHERE id = ?').get(req.params.reqId)
  if (!tr) return res.status(404).json({ error: 'Pedido nao encontrado' })
  if (tr.status !== 'pending') return res.status(400).json({ error: 'Pedido ja respondido' })
  // FIX #4 (multi-tenant)
  if (req.accountId && tr.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  const canReject = tr.to_attendant_id === req.user.id || ['gerente','super_admin'].includes(req.user.role)
  if (!canReject) return res.status(403).json({ error: 'Sem permissao' })

  db.prepare("UPDATE lead_transfer_requests SET status = 'rejected', responded_at = datetime('now') WHERE id = ?").run(tr.id)
  try { broadcastSSE(tr.account_id, 'lead:transfer-rejected', { requestId: tr.id, leadId: tr.lead_id, fromUserId: tr.from_attendant_id }) } catch {}

  res.json({ ok: true })
})

// Get lead detail
router.get('/:id', (req, res) => {
  const lead = db.prepare(`
    SELECT l.*, fs.name as stage_name, fs.color as stage_color, u.name as attendant_name, wi.instance_name as instance_name
    FROM leads l LEFT JOIN funnel_stages fs ON l.stage_id = fs.id LEFT JOIN users u ON l.attendant_id = u.id LEFT JOIN whatsapp_instances wi ON l.instance_id = wi.id
    WHERE l.id = ?
  `).get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // FIX #4 (multi-tenant) — gerente/atendente da conta A nao pode ver lead da conta B trocando ID na URL
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })

  // Opening an archived lead acknowledges any new activity — clear the badge
  if (lead.is_archived && lead.has_new_after_archive) {
    db.prepare('UPDATE leads SET has_new_after_archive = 0 WHERE id = ?').run(lead.id)
    lead.has_new_after_archive = 0
  }

  lead.tags = db.prepare('SELECT t.id, t.name, t.color FROM lead_tags lt JOIN tags t ON lt.tag_id = t.id WHERE lt.lead_id = ?').all(lead.id)
  const messages = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50').all(lead.id)
  const stageHistory = db.prepare(`
    SELECT sh.*, fs_from.name as from_stage_name, fs_to.name as to_stage_name, u.name as user_name
    FROM stage_history sh
    LEFT JOIN funnel_stages fs_from ON sh.from_stage_id = fs_from.id
    LEFT JOIN funnel_stages fs_to ON sh.to_stage_id = fs_to.id
    LEFT JOIN users u ON sh.triggered_by = u.id
    WHERE sh.lead_id = ? ORDER BY sh.created_at DESC
  `).all(lead.id)

  const notes = db.prepare('SELECT n.*, u.name as user_name FROM lead_notes n LEFT JOIN users u ON n.user_id = u.id WHERE n.lead_id = ? ORDER BY n.created_at DESC').all(lead.id)
  res.json({ lead, messages: messages.reverse(), stageHistory, notes })
})

// List conversations (instancias) of a lead — uma "tab" por instancia
router.get('/:id/conversations', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })

  // Todas as instancias que conversaram com este lead. Se atendente ja passou o gate acima,
  // ele pode ler o historico completo do lead (ler != enviar; envio e restringido em messages.js).
  const convs = db.prepare(`
    SELECT
      wi.id as instance_id,
      wi.instance_name,
      wi.status,
      lia.attendant_id,
      u.name as attendant_name,
      (SELECT COUNT(*) FROM messages WHERE lead_id = ? AND instance_id = wi.id) as msg_count,
      (SELECT MAX(created_at) FROM messages WHERE lead_id = ? AND instance_id = wi.id) as last_msg_at
    FROM whatsapp_instances wi
    LEFT JOIN lead_instance_assignments lia ON lia.instance_id = wi.id AND lia.lead_id = ?
    LEFT JOIN users u ON u.id = lia.attendant_id
    WHERE wi.account_id = ?
      AND EXISTS (SELECT 1 FROM messages WHERE lead_id = ? AND instance_id = wi.id)
    ORDER BY last_msg_at DESC
  `).all(lead.id, lead.id, lead.id, lead.account_id, lead.id)
  res.json({ conversations: convs })
})

// Update lead
router.put('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // FIX #4 (multi-tenant)
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })

  let { name, phone, email, city, notes, custom_fields, empresa, cpf_cnpj, instagram, trabalha_anuncio, investimento_anuncios } = req.body

  phone = normalizePhone(phone)

  const sets = []; const params = []
  if (name !== undefined) { sets.push('name = ?'); params.push(name) }
  if (phone !== undefined) { sets.push('phone = ?'); params.push(phone) }
  if (email !== undefined) { sets.push('email = ?'); params.push(email) }
  if (city !== undefined) { sets.push('city = ?'); params.push(city) }
  if (notes !== undefined) { sets.push('notes = ?'); params.push(notes) }
  if (custom_fields !== undefined) { sets.push('custom_fields = ?'); params.push(JSON.stringify(custom_fields)) }
  if (empresa !== undefined) { sets.push('empresa = ?'); params.push(empresa || null) }
  if (cpf_cnpj !== undefined) { sets.push('cpf_cnpj = ?'); params.push(cpf_cnpj || null) }
  if (instagram !== undefined) { sets.push('instagram = ?'); params.push(instagram || null) }
  if (trabalha_anuncio !== undefined) { sets.push('trabalha_anuncio = ?'); params.push(trabalha_anuncio ? 1 : 0) }
  if (investimento_anuncios !== undefined) { sets.push('investimento_anuncios = ?'); params.push(investimento_anuncios || null) }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada pra atualizar' })
  sets.push("updated_at = datetime('now')")
  params.push(req.params.id)
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  try { broadcastSSE(lead.account_id, 'lead:updated', updated) } catch {}
  res.json({ lead: updated })
})

// Marca todas msgs inbound como lidas + zera unread_count. Chamado quando vendedor abre a conversa.
// Idempotente: chamar 2x nao quebra (so seta unread_count=0 que ja era 0).
router.patch('/:id/read', (req, res) => {
  const leadId = parseInt(req.params.id)
  if (!leadId) return res.status(400).json({ error: 'lead id invalido' })
  const lead = db.prepare('SELECT id, account_id, unread_count FROM leads WHERE id = ?').get(leadId)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // Scope por conta: super_admin pode qualquer; outros so da propria
  if (req.user.role !== 'super_admin' && lead.account_id !== req.accountId) {
    return res.status(403).json({ error: 'Sem permissao' })
  }
  if (lead.unread_count > 0) {
    db.prepare("UPDATE leads SET unread_count = 0, updated_at = datetime('now') WHERE id = ?").run(leadId)
    try { broadcastSSE(lead.account_id, 'lead:read', { lead_id: leadId, unread_count: 0 }) } catch {}
  }
  res.json({ ok: true, lead_id: leadId, unread_count: 0 })
})

// Move lead stage
router.put('/:id/stage', (req, res) => {
  const { stage_id } = req.body
  if (!stage_id) return res.status(400).json({ error: 'stage_id required' })

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // FIX #4 (multi-tenant)
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })

  const oldStageId = lead.stage_id
  // Mudanca de etapa MANUAL (via UI) trava bot pra esse lead — gerente/atendente assumiu controle.
  // Se quiser reativar bot, atribuir bot como atendente OU usar botao "Forcar IA" (super_admin).
  // Bot interno (aiAgent) muda stage via SQL direto, NAO passa por essa rota — entao nao afeta o fluxo natural do bot.
  db.prepare("UPDATE leads SET stage_id = ?, ai_handed_off_at = COALESCE(ai_handed_off_at, datetime('now')), updated_at = datetime('now') WHERE id = ?").run(stage_id, lead.id)
  const histRes = db.prepare('INSERT INTO stage_history (lead_id, from_stage_id, to_stage_id, trigger_type, triggered_by) VALUES (?, ?, ?, ?, ?)').run(
    lead.id, oldStageId, stage_id, 'manual', req.user.id
  )
  // CAPI: dispara evento da nova etapa (service filtra se nao tiver ctwa_clid)
  triggerCapiForStageChange(lead.id, stage_id, histRes.lastInsertRowid)

  const updated = db.prepare('SELECT l.*, fs.name as stage_name, fs.color as stage_color, wi.instance_name as instance_name FROM leads l LEFT JOIN funnel_stages fs ON l.stage_id = fs.id LEFT JOIN whatsapp_instances wi ON l.instance_id = wi.id WHERE l.id = ?').get(lead.id)
  try { broadcastSSE(lead.account_id, 'lead:updated', updated) } catch {}
  res.json({ lead: updated })
})

// Archive lead — hides from pipeline/chat; messages still stored but don't broadcast
router.patch('/:id/archive', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // FIX #4 (multi-tenant)
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })
  db.prepare("UPDATE leads SET is_archived = 1, archived_at = datetime('now'), has_new_after_archive = 0, updated_at = datetime('now') WHERE id = ?").run(lead.id)
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  try { broadcastSSE(lead.account_id, 'lead:archived', { id: lead.id }) } catch {}
  res.json({ lead: updated })
})

// Unarchive lead — returns it to the active pipeline/chat
router.patch('/:id/unarchive', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // FIX #4 (multi-tenant)
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })
  db.prepare("UPDATE leads SET is_archived = 0, archived_at = NULL, has_new_after_archive = 0, updated_at = datetime('now') WHERE id = ?").run(lead.id)
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  try { broadcastSSE(lead.account_id, 'lead:unarchived', updated) } catch {}
  res.json({ lead: updated })
})

// Block lead — soft-delete: lead some do CRM e mensagens futuras desse numero sao ignoradas pelo webhook.
// Historico (msgs, tags, etc) e preservado pra eventual unblock futuro.
router.post('/:id/block', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })
  db.prepare("UPDATE leads SET is_blocked = 1, blocked_at = datetime('now'), blocked_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, lead.id)
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  try { broadcastSSE(lead.account_id, 'lead:archived', { id: lead.id }) } catch {}
  res.json({ lead: updated })
})

// Unblock lead — restaura visibilidade e processamento de mensagens
router.post('/:id/unblock', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  if (req.user.role === 'atendente' && !canAtendenteAccessLead(req.user.id, lead)) return res.status(403).json({ error: 'Sem permissao' })
  db.prepare("UPDATE leads SET is_blocked = 0, blocked_at = NULL, blocked_by = NULL, updated_at = datetime('now') WHERE id = ?").run(lead.id)
  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  try { broadcastSSE(lead.account_id, 'lead:unarchived', updated) } catch {}
  res.json({ lead: updated })
})

// Assign attendant
router.put('/:id/assign', requireRole('super_admin', 'gerente'), (req, res) => {
  const { attendant_id, notify_attendant } = req.body
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  // FIX #4 (multi-tenant) — gerente da Alpha nao pode sequestrar lead da Sheraos trocando ID
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })

  // Se novo atendente eh um bot (is_bot=1), limpa ai_handed_off_at pra bot voltar a atender
  let clearHandoff = false
  let isBot = false
  if (attendant_id) {
    const newAttendant = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(attendant_id)
    if (newAttendant?.is_bot === 1) { clearHandoff = true; isBot = true }
  }

  if (clearHandoff) {
    // Atribuiu bot: bot pode voltar a atender
    db.prepare("UPDATE leads SET attendant_id = ?, ai_handed_off_at = NULL, updated_at = datetime('now') WHERE id = ?").run(attendant_id, lead.id)
  } else {
    // Atribuiu humano OU removeu atendente (NULL = "Sem atendente"): trava bot pra esse lead
    // ai_handed_off_at impede que o agente conditional volte a pegar o lead automaticamente.
    // Pra reativar, atribuir bot de novo OU usar botao "Forcar IA" (super_admin).
    db.prepare("UPDATE leads SET attendant_id = ?, ai_handed_off_at = COALESCE(ai_handed_off_at, datetime('now')), updated_at = datetime('now') WHERE id = ?").run(attendant_id || null, lead.id)
  }

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id)
  try { broadcastSSE(lead.account_id, 'lead:updated', updated) } catch {}

  // Atribuicao: dispara saudacao do atendente conforme tipo (humano ou bot).
  // checkbox "notify_attendant" controla envio da msg inicial em ambos os casos.
  if (attendant_id) {
    setImmediate(() => {
      if (isBot) {
        // Bot atribuido + checkbox marcado -> dispara welcome Haiku (mesma funcao da planilha).
        // Idempotencia via ai_first_msg_sent_at dentro de sendBotWelcomeForSheetsLead.
        if (notify_attendant) {
          sendBotWelcomeForSheetsLead(lead.id, updated.instance_id || lead.instance_id || null)
            .catch(e => console.error('[Bot Welcome manual_assign]', e.message))
        }
        // Checkbox desmarcado: so atribui, bot fica esperando lead falar (sem msg disparada).
      } else {
        // Humano: fluxo existente intocado — first_msg_template da instancia do vendedor.
        notifyAndOpenLead(lead.id, attendant_id, {
          source: 'manual_assign',
          skipFirstMsg: !notify_attendant,
        }).catch(e => console.error('[Handoff manual]', e.message))
      }
    })
  }

  res.json({ lead: updated })
})

// Refresh profile picture from Evolution API
router.post('/:id/refresh-profile-pic', async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead || !lead.phone) return res.status(404).json({ error: 'Lead nao encontrado ou sem telefone' })
  const instance = lead.instance_id
    ? db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(lead.instance_id)
    : db.prepare("SELECT * FROM whatsapp_instances WHERE account_id = ? AND status = 'connected' LIMIT 1").get(lead.account_id)
  if (!instance) return res.status(400).json({ error: 'Sem instancia WhatsApp' })
  try {
    const r = await fetch(`${instance.api_url}/chat/fetchProfilePictureUrl/${instance.instance_name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: instance.api_key },
      body: JSON.stringify({ number: lead.phone }),
    })
    const data = await r.json()
    const url = data?.profilePictureUrl || null
    db.prepare("UPDATE leads SET profile_pic_url = ?, profile_pic_updated_at = datetime('now') WHERE id = ?").run(url, lead.id)
    res.json({ profile_pic_url: url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Add tag
router.post('/:id/tags', (req, res) => {
  const { tag_id } = req.body
  if (!tag_id) return res.status(400).json({ error: 'tag_id required' })
  // FIX #4 (multi-tenant) — checar ownership do lead E da tag
  const lead = db.prepare('SELECT account_id FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  const tag = db.prepare('SELECT account_id FROM tags WHERE id = ?').get(tag_id)
  if (!tag) return res.status(404).json({ error: 'Tag nao encontrada' })
  if (req.accountId && tag.account_id !== req.accountId) return res.status(403).json({ error: 'Tag de outra conta' })
  try {
    db.prepare('INSERT OR IGNORE INTO lead_tags (lead_id, tag_id) VALUES (?, ?)').run(req.params.id, tag_id)
  } catch {}
  res.json({ ok: true })
})

// Remove tag
router.delete('/:id/tags/:tagId', (req, res) => {
  // FIX #4 (multi-tenant)
  const lead = db.prepare('SELECT account_id FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (req.accountId && lead.account_id !== req.accountId) return res.status(403).json({ error: 'Sem permissao' })
  db.prepare('DELETE FROM lead_tags WHERE lead_id = ? AND tag_id = ?').run(req.params.id, req.params.tagId)
  res.json({ ok: true })
})

// Export CSV
router.get('/export', requireRole('super_admin', 'gerente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { date_from, date_to, funnel_id } = req.query
  const where = ['l.account_id = ?', 'l.is_blocked = 0']
  const params = [req.accountId]
  if (date_from) { where.push('l.created_at >= ?'); params.push(date_from) }
  if (date_to) { where.push('l.created_at <= ?'); params.push(date_to + ' 23:59:59') }
  if (funnel_id) { where.push('l.funnel_id = ?'); params.push(funnel_id) }

  const leads = db.prepare(`
    SELECT l.name, l.phone, l.email, l.city, l.source, fs.name as etapa, u.name as atendente, l.notes, l.created_at, l.updated_at
    FROM leads l LEFT JOIN funnel_stages fs ON l.stage_id = fs.id LEFT JOIN users u ON l.attendant_id = u.id
    WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC
  `).all(...params)

  const header = 'Nome,Telefone,Email,Cidade,Fonte,Etapa,Atendente,Notas,Criado em,Atualizado em'
  const rows = leads.map(l => [l.name, l.phone, l.email, l.city, l.source, l.etapa, l.atendente, `"${(l.notes || '').replace(/"/g, '""')}"`, l.created_at, l.updated_at].join(','))
  const csv = [header, ...rows].join('\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename=leads-${new Date().toISOString().slice(0, 10)}.csv`)
  res.send('\uFEFF' + csv) // BOM for Excel UTF-8
})

// =============================================
// NOTES
// =============================================

router.get('/:id/notes', (req, res) => {
  const notes = db.prepare(`
    SELECT n.*, u.name as user_name FROM lead_notes n LEFT JOIN users u ON n.user_id = u.id
    WHERE n.lead_id = ? ORDER BY n.created_at DESC
  `).all(req.params.id)
  res.json({ notes })
})

router.post('/:id/notes', (req, res) => {
  const { content } = req.body
  if (!content) return res.status(400).json({ error: 'content required' })
  const result = db.prepare('INSERT INTO lead_notes (lead_id, user_id, content) VALUES (?, ?, ?)').run(req.params.id, req.user.id, content)
  const note = db.prepare('SELECT n.*, u.name as user_name FROM lead_notes n LEFT JOIN users u ON n.user_id = u.id WHERE n.id = ?').get(result.lastInsertRowid)
  res.json({ note })
})

// =============================================
// TAGS CRUD
// =============================================

router.get('/tags/list', (req, res) => {
  if (!req.accountId) return res.json({ tags: [] })
  const tags = db.prepare('SELECT * FROM tags WHERE account_id = ? ORDER BY name').all(req.accountId)
  res.json({ tags })
})

router.post('/tags/create', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { name, color } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  try {
    const result = db.prepare('INSERT INTO tags (account_id, name, color) VALUES (?, ?, ?)').run(req.accountId, name, color || '#FFB300')
    const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid)
    res.json({ tag })
  } catch { res.status(400).json({ error: 'Tag ja existe' }) }
})

router.put('/tags/:tagId', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const tag = db.prepare('SELECT * FROM tags WHERE id = ? AND account_id = ?').get(req.params.tagId, req.accountId)
  if (!tag) return res.status(404).json({ error: 'Tag nao encontrada' })
  const { name, color } = req.body
  const sets = []
  const params = []
  if (name !== undefined && name.trim()) { sets.push('name = ?'); params.push(name.trim()) }
  if (color !== undefined) { sets.push('color = ?'); params.push(color) }
  if (!sets.length) return res.status(400).json({ error: 'Nada pra atualizar' })
  params.push(req.params.tagId)
  try {
    db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const updated = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.tagId)
    res.json({ tag: updated })
  } catch { res.status(400).json({ error: 'Nome ja existe' }) }
})

router.delete('/tags/:tagId', requireRole('super_admin', 'gerente', 'atendente'), (req, res) => {
  db.prepare('DELETE FROM lead_tags WHERE tag_id = ?').run(req.params.tagId)
  db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.tagId)
  res.json({ ok: true })
})

// (rotas de tag-mapping movidas pra /api/tag-mapping em routes/tag-mapping.js
//  por causa de conflito com /:id e /tags/:tagId neste mesmo router)

// =============================================
// OPT-IN / OPT-OUT (WhatsApp broadcast consent)
// =============================================

router.post('/:id/opt-in', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  db.prepare("UPDATE leads SET opted_in_at = datetime('now'), opted_out_at = NULL WHERE id = ?").run(lead.id)
  res.json({ ok: true })
})

router.post('/:id/opt-out', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  db.prepare("UPDATE leads SET opted_out_at = datetime('now') WHERE id = ?").run(lead.id)
  res.json({ ok: true })
})

// Forca IA a responder a ultima msg inbound do lead, ignorando filtros normais
// (etapa, tag, handoff previo, atendente humano). Super admin only — usado pra desbloquear
// casos onde o lead caiu fora dos filtros (ex: lead em "Perdido" mas agente so atende "Em Atendimento").
router.post('/:id/force-ai-respond', requireRole('super_admin'), async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' })
  if (req.accountId && lead.account_id !== req.accountId) {
    return res.status(403).json({ error: 'Lead pertence a outra conta' })
  }

  // Pega a ultima msg inbound do lead pra simular trigger
  const lastInbound = db.prepare(`
    SELECT content, media_type, instance_id
    FROM messages
    WHERE lead_id = ? AND direction = 'inbound'
    ORDER BY id DESC LIMIT 1
  `).get(lead.id)
  if (!lastInbound) return res.status(400).json({ error: 'Lead nao tem mensagem inbound pra responder' })

  // Instancia: prioridade
  // 1. body.instance_id (front passa a inst ativa do "Enviar via")
  // 2. ultima msg inbound (caso comum: bot responde na inst onde recebeu)
  // 3. lead.last_instance_id
  // 4. primeira instancia conectada que algum agente cobre
  let instanceId = (req.body?.instance_id ? Number(req.body.instance_id) : null)
                || lastInbound.instance_id
                || lead.last_instance_id
                || null
  if (!instanceId) {
    // Procura instancia que algum agente cobre (em vez da primeira qualquer)
    const inst = db.prepare(`
      SELECT wi.id FROM whatsapp_instances wi
      WHERE wi.account_id = ? AND wi.status = 'connected'
        AND EXISTS (
          SELECT 1 FROM ai_agent_instances aai
          JOIN ai_agents ag ON ag.id = aai.agent_id
          WHERE aai.instance_id = wi.id AND ag.is_active = 1 AND ag.account_id = wi.account_id
        )
      ORDER BY wi.id LIMIT 1
    `).get(lead.account_id)
    instanceId = inst?.id || null
  }
  if (!instanceId) return res.status(400).json({ error: 'Nenhuma instancia disponivel pra essa conta' })

  console.log(`[ForceAI] super_admin=${req.user?.id} tentou disparar IA pra lead=${lead.id} instance=${instanceId}`)

  // Diagnostica bloqueios ANTES de tentar disparar. Botao roda o fluxo NORMAL —
  // se algo bloqueia (atendente humano, handoff anterior, etapa/tag/instancia
  // nao bate, lead bloqueado, etc), retorna mensagem especifica. Nao dispara
  // bot em lead onde ele nao deveria atuar.
  const diag = diagnoseForceAi(lead, instanceId)
  if (diag.blockers.length > 0) {
    console.log(`[ForceAI] bloqueios lead=${lead.id}: ${diag.blockers.join(' | ')}`)
    return res.status(400).json({
      error: 'Bot nao pode atuar nesse lead.',
      blockers: diag.blockers,
      message: diag.blockers.join('\n'),
    })
  }

  // Passou no diagnostico — dispara normal. processInboundMessage faz o mesmo
  // fluxo de uma msg inbound chegando agora.
  // Snapshot ANTES: msg.id max + attendant_id atual. Se DEPOIS o bot nao gerou
  // msg outbound (max_id nao subiu) mas o atendente mudou ou ai_handed_off_at
  // foi setado, eh handoff silencioso — reporta como erro.
  const beforeMaxMsgId = db.prepare("SELECT COALESCE(MAX(id), 0) as m FROM messages WHERE lead_id = ?").get(lead.id)?.m || 0
  const beforeAttendantId = lead.attendant_id
  const beforeHandoffAt = lead.ai_handed_off_at

  try {
    const result = await processInboundMessage(
      lead,
      lastInbound.content || '',
      lastInbound.media_type || 'text',
      instanceId
    )
    if (result && result.ok === false) {
      // Traduz reason interno em msg legivel
      const reason = result.reason || 'unknown'
      const sendReason = result.sendReason || ''
      let humanMsg = 'Bot nao pode atuar nesse lead'
      if (reason === 'no_matching_agent') humanMsg = 'Nenhum agente compativel com o lead'
      else if (reason === 'instance_disconnected') humanMsg = 'Instancia esta desconectada'
      else if (reason === 'instance_not_found') humanMsg = 'Instancia nao encontrada'
      else if (reason === 'send_blocked') {
        if (sendReason.startsWith('lead_daily_cap_')) {
          const cap = sendReason.replace('lead_daily_cap_', '')
          humanMsg = `Lead ja recebeu ${cap} msgs automaticas em 24h (limite atingido). Aumente lead_daily_msg_cap da instancia ou aguarde 24h.`
        } else if (sendReason.startsWith('quota_hourly_')) humanMsg = `Quota horaria da instancia atingida (${sendReason})`
        else if (sendReason.startsWith('quota_daily_')) humanMsg = `Quota diaria da instancia atingida (${sendReason})`
        else if (sendReason === 'outside_business_hours') humanMsg = 'Fora do horario comercial configurado pra essa instancia'
        else if (sendReason.startsWith('instance_paused_')) humanMsg = `Instancia esta pausada (${sendReason.replace('instance_paused_', '')})`
        else if (sendReason === 'auto_paused_low_delivery') humanMsg = 'Instancia foi auto-pausada por taxa de falha alta. Aguarde 4h ou libere manualmente.'
        else if (sendReason === 'number_not_on_whatsapp') humanMsg = 'Numero do lead nao tem WhatsApp'
        else humanMsg = `Envio bloqueado: ${sendReason}`
      } else if (reason === 'exception') humanMsg = `Erro interno: ${result.detail || 'sem detalhes'}`
      return res.status(400).json({ error: humanMsg, blockers: [humanMsg], message: humanMsg, reason, sendReason })
    }

    // Verifica se houve realmente envio de msg pelo bot
    const after = db.prepare("SELECT COALESCE(MAX(m.id), 0) as max_id FROM messages m WHERE m.lead_id = ?").get(lead.id)
    const newLeadState = db.prepare("SELECT attendant_id, ai_handed_off_at FROM leads WHERE id = ?").get(lead.id)
    const wasMsgSent = (after?.max_id || 0) > beforeMaxMsgId
    const wasHandoff = (newLeadState?.ai_handed_off_at && newLeadState.ai_handed_off_at !== beforeHandoffAt)
                     || (newLeadState?.attendant_id !== beforeAttendantId && newLeadState?.attendant_id)

    if (!wasMsgSent && wasHandoff) {
      // Bot fez handoff silencioso (max_messages, token limit, etc) — atribuiu humano sem responder
      const newAtt = newLeadState?.attendant_id
        ? db.prepare('SELECT name FROM users WHERE id = ?').get(newLeadState.attendant_id)?.name || 'humano'
        : null
      const msg = newAtt
        ? `Bot fez handoff silencioso pra ${newAtt} sem responder. Provavel limite atingido (max_messages ou tokens).`
        : 'Bot fez handoff silencioso sem responder. Provavel limite atingido.'
      return res.status(400).json({
        error: msg,
        blockers: [msg],
        message: msg,
      })
    }
    if (!wasMsgSent) {
      const m = 'Bot processou mas nao enviou mensagem. Verifique logs do servidor (PM2).'
      return res.status(400).json({ error: m, blockers: [m], message: m })
    }
    res.json({ ok: true, message: 'IA disparada — resposta deve chegar em alguns segundos.' })
  } catch (e) {
    console.error('[ForceAI]', e.message)
    res.status(500).json({ error: 'Erro disparando IA', detail: e.message })
  }
})

// Bulk opt-in
router.post('/bulk/opt-in', (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { lead_ids } = req.body
  if (!lead_ids?.length) return res.status(400).json({ error: 'lead_ids required' })
  const stmt = db.prepare("UPDATE leads SET opted_in_at = datetime('now'), opted_out_at = NULL WHERE id = ? AND account_id = ?")
  let count = 0
  for (const id of lead_ids) { stmt.run(id, req.accountId); count++ }
  res.json({ ok: true, count })
})

// =============================================
// BULK ACTIONS
// =============================================

router.post('/bulk/assign', requireRole('super_admin', 'gerente'), (req, res) => {
  const { lead_ids, attendant_id } = req.body
  if (!lead_ids || !Array.isArray(lead_ids)) return res.status(400).json({ error: 'lead_ids required' })
  // Detecta se o novo atendente eh bot pra decidir se limpa ai_handed_off_at
  let isBotBulk = false
  if (attendant_id) {
    const u = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(attendant_id)
    if (u?.is_bot === 1) isBotBulk = true
  }
  const sql = isBotBulk
    ? "UPDATE leads SET attendant_id = ?, ai_handed_off_at = NULL, updated_at = datetime('now') WHERE id = ?"
    : "UPDATE leads SET attendant_id = ?, ai_handed_off_at = COALESCE(ai_handed_off_at, datetime('now')), updated_at = datetime('now') WHERE id = ?"
  const stmt = db.prepare(sql)
  const transaction = db.transaction(() => { for (const id of lead_ids) stmt.run(attendant_id || null, id) })
  transaction()
  res.json({ ok: true, count: lead_ids.length })
})

router.post('/bulk/stage', requireRole('super_admin', 'gerente'), (req, res) => {
  const { lead_ids, stage_id } = req.body
  if (!lead_ids || !Array.isArray(lead_ids) || !stage_id) return res.status(400).json({ error: 'lead_ids and stage_id required' })
  const stmtUpdate = db.prepare("UPDATE leads SET stage_id = ?, updated_at = datetime('now') WHERE id = ?")
  const stmtHistory = db.prepare('INSERT INTO stage_history (lead_id, from_stage_id, to_stage_id, trigger_type, triggered_by) VALUES (?, (SELECT stage_id FROM leads WHERE id = ?), ?, ?, ?)')
  const histIds = []
  const transaction = db.transaction(() => {
    for (const id of lead_ids) {
      const histRes = stmtHistory.run(id, id, stage_id, 'manual', req.user.id)
      histIds.push({ leadId: id, histId: histRes.lastInsertRowid })
      stmtUpdate.run(stage_id, id)
    }
  })
  transaction()
  // CAPI: fire-and-forget pra cada lead (service filtra os sem ctwa_clid)
  for (const { leadId, histId } of histIds) {
    triggerCapiForStageChange(leadId, stage_id, histId)
  }
  res.json({ ok: true, count: lead_ids.length })
})

// =============================================
// PIPELINE METRICS
// =============================================

router.get('/pipeline/metrics', (req, res) => {
  if (!req.accountId) return res.json({ metrics: [] })
  const { funnel_id } = req.query
  if (!funnel_id) return res.json({ metrics: [] })

  const metrics = db.prepare(`
    SELECT fs.id as stage_id, fs.name, fs.color, fs.position, fs.is_conversion,
      COUNT(l.id) as lead_count,
      AVG(CASE WHEN l.updated_at != l.created_at THEN (julianday(l.updated_at) - julianday(l.created_at)) * 24 ELSE NULL END) as avg_hours_in_stage
    FROM funnel_stages fs
    LEFT JOIN leads l ON l.stage_id = fs.id AND l.is_active = 1 AND l.is_archived = 0 AND l.is_blocked = 0
    WHERE fs.funnel_id = ?
    GROUP BY fs.id
    ORDER BY fs.position
  `).all(funnel_id)

  // Calculate conversion rates between stages
  let totalLeads = metrics.reduce((s, m) => s + m.lead_count, 0)
  const result = metrics.map((m, i) => ({
    ...m,
    avg_hours_in_stage: m.avg_hours_in_stage ? Math.round(m.avg_hours_in_stage * 10) / 10 : null,
    pct_of_total: totalLeads > 0 ? ((m.lead_count / totalLeads) * 100) : 0,
    conversion_from_prev: i > 0 && metrics[i - 1].lead_count > 0 ? ((m.lead_count / metrics[i - 1].lead_count) * 100) : null,
  }))

  res.json({ metrics: result, totalLeads })
})

export default router
