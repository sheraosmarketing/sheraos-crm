// Forward Notification Service
// Quando lead responde numa instancia que tem forward_notif_enabled=1,
// envia uma msg de alerta pelo instancia_via pra um telefone destino.
// Caso de uso: lead responde num numero de disparos -> dono recebe alerta no celular.

import db from '../db.js'
import { sendViaInstance } from './leadHandoff.js'

const DEDUP_WINDOW_MS = 30 * 60 * 1000 // 30 min: nao notifica 2x o mesmo lead em pouco tempo

function fmtPhoneBr(digits) {
  if (!digits) return ''
  const d = String(digits).replace(/\D/g, '')
  if (d.startsWith('55') && d.length >= 12) {
    const ddd = d.slice(2, 4)
    const num = d.slice(4)
    if (num.length === 9) return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`
    if (num.length === 8) return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`
  }
  return `+${d}`
}

function fmtDateTime(d = new Date()) {
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Dispara notificacao SE a instancia receptora tem forward ativo.
 * Fire-and-forget: nao bloqueia o webhook, nao propaga erros.
 */
export async function maybeForwardInbound({ lead, instanceId, content, mediaType }) {
  if (!instanceId || !lead) return
  try {
    const receiver = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instanceId)
    if (!receiver || !receiver.forward_notif_enabled) return
    if (!receiver.forward_notif_via_instance_id || !receiver.forward_notif_to_phone) return

    // Dedup: nao notifica o mesmo lead 2x em 30min (evita spam quando lead manda varias msgs seguidas)
    const recentNotif = db.prepare(`
      SELECT 1 FROM messages
      WHERE instance_id = ? AND content LIKE ? AND created_at >= datetime('now', '-30 minutes')
      LIMIT 1
    `).get(receiver.forward_notif_via_instance_id, `%[forward:${lead.id}]%`)
    if (recentNotif) {
      console.log(`[Forward] Skip dedup lead=${lead.id} ja notificado nos ultimos 30min`)
      return
    }

    const via = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(receiver.forward_notif_via_instance_id)
    if (!via) { console.warn(`[Forward] via_instance_id=${receiver.forward_notif_via_instance_id} nao existe`); return }
    if (via.status !== 'connected') {
      console.warn(`[Forward] via_instance ${via.instance_name} nao conectada (status=${via.status})`)
      return
    }

    // Monta a msg
    const label = receiver.forward_notif_label || receiver.instance_name || 'CRM'
    const leadName = lead.name || 'Sem nome'
    const leadPhoneRaw = (lead.phone || '').replace(/\D/g, '')
    const leadPhoneFmt = fmtPhoneBr(leadPhoneRaw)
    const waLink = leadPhoneRaw ? `https://wa.me/${leadPhoneRaw}` : ''

    // Se veio de disparo recente, mostra qual
    let broadcastInfo = ''
    const recentBroadcast = db.prepare(`
      SELECT b.name, br.sent_at
      FROM broadcast_recipients br
      JOIN broadcasts b ON b.id = br.broadcast_id
      WHERE br.lead_id = ? AND br.status = 'sent'
      ORDER BY br.sent_at DESC LIMIT 1
    `).get(lead.id)
    if (recentBroadcast) {
      broadcastInfo = `\n📣 Veio do disparo: ${recentBroadcast.name}`
    }

    const msgPreview = mediaType === 'audio' ? '🎤 (audio)'
      : mediaType === 'image' ? '🖼️ (imagem)'
      : mediaType === 'video' ? '🎥 (video)'
      : mediaType === 'document' ? '📄 (documento)'
      : (content || '').substring(0, 200)

    const text = [
      `🔔 *Novo lead respondeu em ${label}*`,
      ``,
      `👤 ${leadName}`,
      `📞 ${leadPhoneFmt}`,
      `💬 "${msgPreview}"${broadcastInfo}`,
      `🕒 ${fmtDateTime()}`,
      waLink ? `` : null,
      waLink ? `👉 Abrir conversa: ${waLink}` : null,
      ``,
      `[forward:${lead.id}]`, // marker pra dedup
    ].filter(x => x !== null).join('\n')

    const toPhone = receiver.forward_notif_to_phone.replace(/\D/g, '')
    const sendRes = await sendViaInstance(via, toPhone, text, {
      skipValidation: true,
      skipBusinessHours: true,
      skipLeadCap: true,
      skipQuota: true,
      skipTyping: true,
    })

    if (sendRes.ok) {
      console.log(`[Forward] Alerta enviado lead=${lead.id} -> ${toPhone} via ${via.instance_name}`)
      // Registra na tabela messages pra dedup funcionar (sem lead_id)
      try {
        db.prepare(`
          INSERT INTO messages (lead_id, account_id, direction, content, media_type, sender_name, wa_msg_id, instance_id)
          VALUES (?, ?, 'outbound', ?, 'text', 'FORWARD', ?, ?)
        `).run(lead.id, via.account_id, text, sendRes.wamsgId || null, via.id)
      } catch (e) { /* best effort */ }

      // Move lead de etapa se configurado (opcional, so quando notifica com sucesso)
      if (receiver.forward_notif_move_to_stage_id && lead.stage_id !== receiver.forward_notif_move_to_stage_id) {
        try {
          const targetStage = db.prepare('SELECT id, funnel_id FROM funnel_stages WHERE id = ?').get(receiver.forward_notif_move_to_stage_id)
          if (targetStage) {
            db.prepare("UPDATE leads SET stage_id = ?, funnel_id = ?, updated_at = datetime('now') WHERE id = ?")
              .run(targetStage.id, targetStage.funnel_id, lead.id)
            db.prepare('INSERT INTO stage_history (lead_id, from_stage_id, to_stage_id, trigger_type) VALUES (?, ?, ?, ?)')
              .run(lead.id, lead.stage_id || null, targetStage.id, 'forward_notif')
            console.log(`[Forward] Lead ${lead.id} movido pra stage ${targetStage.id}`)
          }
        } catch (e) {
          console.warn(`[Forward] Falha mover lead ${lead.id} de etapa: ${e.message}`)
        }
      }
    } else {
      console.warn(`[Forward] Falha enviar alerta lead=${lead.id}: ${sendRes.reason}`)
    }
  } catch (err) {
    console.error('[Forward] Exception:', err.message)
  }
}
