// Servico do Agente de IA: orquestra recebimento de msg -> Haiku -> tool calls -> envio.
// Chamado fire-and-forget pelo webhook depois do lead ser identificado.

import fetch from 'node-fetch'
import db from '../db.js'
import { callHaiku } from './anthropicClient.js'
import { broadcastSSE } from '../sse.js'
import { pickFromRoulette as rouletteUtil } from './roulette.js'
import { notifyAndOpenLead, sendViaInstance, markMessageAsRead } from './leadHandoff.js'
import { transcribeAudio, fetchAudioBuffer } from './deepgramClient.js'
import { maybeForwardInbound } from './forwardNotif.js'

// ─── Helpers ──────────────────────────────────────────────────────────

function getAccount(accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId)
}

function getLead(leadId) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId)
}

function getUser(userId) {
  if (!userId) return null
  return db.prepare('SELECT id, name, is_bot, is_active FROM users WHERE id = ?').get(userId)
}

function leadHasTag(leadId, tagId) {
  return !!db.prepare('SELECT 1 FROM lead_tags WHERE lead_id = ? AND tag_id = ?').get(leadId, tagId)
}

function resetMonthlyTokensIfNeeded(agent) {
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (agent.current_month !== currentMonth) {
    db.prepare("UPDATE ai_agents SET tokens_used_this_month = 0, current_month = ? WHERE id = ?").run(currentMonth, agent.id)
    agent.tokens_used_this_month = 0
    agent.current_month = currentMonth
  }
}

// ─── findAgentForLead ─────────────────────────────────────────────────

export function findAgentForLead(lead, instanceId, _opts = {}) {
  if (!lead) return null
  // Removido modo force — botao "Forcar IA" agora roda o fluxo NORMAL.
  // Bloqueios sao reportados pelo diagnoseForceAi() na rota /force-ai-respond.

  // 0. Account tem feature gate?
  const account = getAccount(lead.account_id)
  if (!account || !account.ai_agents_enabled) return null
  // Sem chave Anthropic propria, o bot nao roda (sem fallback pra chave da agencia)
  if (!account.anthropic_api_key?.trim()) {
    console.warn(`[AI Agent] conta ${lead.account_id} com agentes habilitados mas SEM API Anthropic — bot nao responde lead ${lead.id}`)
    return null
  }

  // 1. Lead pode receber bot?
  if (lead.is_blocked || lead.is_archived || !lead.is_active) return null

  // 2. Lead ja foi handoff'ed por bot? Nao volta a atender.
  if (lead.ai_handed_off_at) return null

  // 3. Lead ja tem atendente HUMANO definido? Bot nao interfere.
  if (lead.attendant_id) {
    const att = getUser(lead.attendant_id)
    if (att && !att.is_bot) return null
  }

  // 4. Busca agentes ativos
  const agents = db.prepare("SELECT * FROM ai_agents WHERE account_id = ? AND is_active = 1 ORDER BY id ASC").all(lead.account_id)

  for (const agent of agents) {
    // Filtro etapa
    const hasStage = db.prepare('SELECT 1 FROM ai_agent_stages WHERE agent_id = ? AND stage_id = ?').get(agent.id, lead.stage_id)
    if (!hasStage) continue
    // Filtro instancia
    if (instanceId) {
      const hasInstance = db.prepare('SELECT 1 FROM ai_agent_instances WHERE agent_id = ? AND instance_id = ?').get(agent.id, instanceId)
      if (!hasInstance) continue
    }
    // Filtro tag obrigatoria
    if (agent.required_tag_id && !leadHasTag(lead.id, agent.required_tag_id)) continue

    // Modo de ativacao
    switch (agent.activation_mode) {
      case 'default_attendant':
        if (lead.attendant_id === agent.user_id || !lead.attendant_id) return agent
        break
      case 'roulette':
        if (lead.attendant_id === agent.user_id) return agent
        break
      case 'conditional':
        return agent
      case 'manual':
        if (lead.attendant_id === agent.user_id) return agent
        break
    }
  }
  return null
}

// ─── diagnoseForceAi ─────────────────────────────────────────────────
// Diagnostica POR QUE o bot nao atuaria (ou faria handoff silencioso) nesse lead.
// Retorna lista de bloqueios em pt-BR. Vazio = bot atuaria normalmente.
export function diagnoseForceAi(lead, instanceId) {
  const blockers = []
  if (!lead) return { blockers: ['Lead nao encontrado'] }

  const account = getAccount(lead.account_id)
  if (!account) return { blockers: ['Conta nao encontrada'] }
  if (!account.ai_agents_enabled) blockers.push('IA dos agentes esta desativada na conta')
  if (!account.anthropic_api_key?.trim()) blockers.push('Conta sem API Anthropic configurada (cadastre o token em Integracoes)')

  if (lead.is_blocked) blockers.push('Lead esta bloqueado')
  if (lead.is_archived) blockers.push('Lead esta arquivado')
  if (!lead.is_active) blockers.push('Lead esta inativo')

  if (lead.ai_handed_off_at) blockers.push('Lead ja teve handoff anterior (bot transferiu pra humano em ' + lead.ai_handed_off_at + ')')

  if (lead.attendant_id) {
    const att = getUser(lead.attendant_id)
    if (att && !att.is_bot) blockers.push(`Lead tem atendente humano atribuido: ${att.name}`)
  }

  // Verifica agentes
  const agents = db.prepare("SELECT * FROM ai_agents WHERE account_id = ? AND is_active = 1 ORDER BY id ASC").all(lead.account_id)
  if (agents.length === 0) {
    blockers.push('Nenhum agente IA ativo nessa conta')
    return { blockers }
  }

  // Verifica se ALGUM agente bate todos os filtros de config E pode responder
  // (sem cair em handoff silencioso por max_messages ou token limit)
  let anyAgentViable = false
  const issuesPerAgent = []
  for (const agent of agents) {
    const stageOk = !!db.prepare('SELECT 1 FROM ai_agent_stages WHERE agent_id = ? AND stage_id = ?').get(agent.id, lead.stage_id)
    const instanceOk = !instanceId || !!db.prepare('SELECT 1 FROM ai_agent_instances WHERE agent_id = ? AND instance_id = ?').get(agent.id, instanceId)
    const tagOk = !agent.required_tag_id || leadHasTag(lead.id, agent.required_tag_id)
    if (!stageOk || !instanceOk || !tagOk) {
      const why = []
      if (!stageOk) {
        const stageName = db.prepare('SELECT name FROM funnel_stages WHERE id = ?').get(lead.stage_id)?.name || `id=${lead.stage_id}`
        why.push(`etapa "${stageName}" nao configurada`)
      }
      if (!instanceOk) {
        const instName = db.prepare('SELECT instance_name FROM whatsapp_instances WHERE id = ?').get(instanceId)?.instance_name || `id=${instanceId}`
        why.push(`instancia "${instName}" nao configurada`)
      }
      if (!tagOk) {
        const tagName = db.prepare('SELECT name FROM tags WHERE id = ?').get(agent.required_tag_id)?.name || `id=${agent.required_tag_id}`
        why.push(`tag "${tagName}" ausente`)
      }
      issuesPerAgent.push(`"${agent.name}": ${why.join(', ')}`)
      continue
    }

    // Config bate. Agora checa se nao vai cair em handoff silencioso:
    // 1. Limite mensal de tokens estourado -> handoff sem msg
    if ((agent.tokens_used_this_month || 0) >= (agent.monthly_token_limit || 0)) {
      issuesPerAgent.push(`"${agent.name}": limite mensal de tokens estourado (${agent.tokens_used_this_month}/${agent.monthly_token_limit}). Bot faria handoff sem responder`)
      continue
    }
    // 2. Max messages atingido -> handoff sem msg
    const botMsgCount = countBotMessagesInThread(agent, lead.id)
    if (botMsgCount >= (agent.max_messages_before_handoff || 999)) {
      issuesPerAgent.push(`"${agent.name}": ja mandou ${botMsgCount} msgs nesse lead (limite ${agent.max_messages_before_handoff}). Bot faria handoff sem responder. Pra liberar, criar follow-up novo ou aumentar o limite no agente.`)
      continue
    }

    // Esse agente esta viavel — pode atender sem cair em handoff
    anyAgentViable = true
    break
  }

  if (!anyAgentViable && issuesPerAgent.length > 0) {
    blockers.push('Nenhum agente pode atuar: ' + issuesPerAgent.join(' | '))
  }

  return { blockers }
}

// ─── buildSystemPrompt ────────────────────────────────────────────────

function buildSystemPrompt(agent, lead, availableTags, availableStages) {
  const parts = []
  parts.push(`Voce e ${agent.name}, assistente atendendo leads no WhatsApp.`)
  if (agent.persona) parts.push(`Tom de voz: ${agent.persona}`)
  if (agent.identifies_as_bot) parts.push('Voce e uma IA assistente. Pode mencionar isso se perguntado.')
  parts.push('')

  if (agent.knowledge_base) {
    parts.push('CONTEXTO DA EMPRESA:')
    parts.push(agent.knowledge_base)
    parts.push('')
  }

  parts.push('REGRAS RIGIDAS:')
  parts.push('- Responda em PT-BR, MAXIMO 2 frases curtas.')
  parts.push('- Use linguagem natural, evite parecer robotico.')
  parts.push('- UMA pergunta por mensagem. NUNCA dispare 2+ perguntas no mesmo turno.')
  parts.push('- SEMPRE QUE coletar um dado (chamar update_lead_info ou outra tool), a SUA mensagem de texto DEVE conter (a) breve confirmacao + (b) a PROXIMA pergunta. NUNCA encerre com "anotei" ou "ok" sem fazer a proxima pergunta — voce e quem conduz a conversa.')
  parts.push('- Quando o lead informar info pessoal (nome, cidade, empresa, cargo, etc), chame update_lead_info ANTES de responder. Para "cargo" use field="empresa" com valor formatado "Cargo: X - Setor".')
  parts.push('- Se o lead mandar uma mensagem vazia, "ola" ou similar sem contexto novo, NAO encerre — retome de onde parou e pergunte o proximo dado faltante.')
  if (agent.never_mention) parts.push(`- NUNCA mencione: ${agent.never_mention}`)
  if (agent.handoff_keywords) {
    parts.push(`- Se o lead disser uma das palavras "${agent.handoff_keywords}" -> chame transfer_to_human(reason="keyword").`)
  }
  parts.push('- So chame transfer_to_human(reason="unknown") se REALMENTE nao tiver como continuar (ex: lead pergunta algo completamente fora do escopo da empresa). NAO use "unknown" so porque precisa de mais info — pergunte!')
  parts.push('')

  if (agent.qualification_criteria) {
    parts.push('QUALIFICACAO:')
    parts.push(`Considere o lead qualificado quando: ${agent.qualification_criteria}`)
    let requiredFields = []
    try { requiredFields = JSON.parse(agent.required_fields || '[]') } catch {}
    if (requiredFields.length > 0) {
      parts.push(`Campos obrigatorios pra qualificar: ${requiredFields.join(', ')}.`)
      const collected = []
      if (requiredFields.includes('name') && lead.name) collected.push(`nome=${lead.name}`)
      if (requiredFields.includes('email') && lead.email) collected.push(`email=${lead.email}`)
      if (requiredFields.includes('phone') && lead.phone) collected.push(`phone=${lead.phone}`)
      if (requiredFields.includes('city') && lead.city) collected.push(`cidade=${lead.city}`)
      if (requiredFields.includes('empresa') && lead.empresa) collected.push(`empresa=${lead.empresa}`)
      if (requiredFields.includes('instagram') && lead.instagram) collected.push(`instagram=${lead.instagram}`)
      if (collected.length > 0) parts.push(`Ja coletados: ${collected.join('; ')}.`)
    }
    parts.push('Quando qualificar, chame transfer_to_human(reason="qualified") imediatamente.')
    parts.push('')
  }

  if (availableStages && availableStages.length > 0) {
    parts.push('ETAPAS DO FUNIL DISPONIVEIS: ' + availableStages.map(s => `"${s.name}"`).join(', '))
  }
  if (availableTags && availableTags.length > 0) {
    parts.push('TAGS DISPONIVEIS: ' + availableTags.map(t => `"${t.name}"`).join(', '))
  }

  // Anti-ban: variacao humana pra parecer menos previsivel
  parts.push('')
  parts.push('VARIACAO HUMANA (importante pra parecer natural, nao robotico):')
  parts.push('- Varie saudacoes: "Oi!", "Opa!", "E ai!", "Ola"... ou comece DIRETO sem saudacao se ja deu bom dia antes na conversa')
  parts.push('- Nem sempre comece com o nome do lead — humano nao faz isso toda msg')
  parts.push('- Varie comprimento: as vezes 1 frase curta, as vezes 2 frases')
  parts.push('- Use coloquialismos leves quando o tom permitir: "ta", "pra", "ne", "blz", "tmj"')
  parts.push('- Pontuacao natural OK: pode terminar sem ponto final, usar "..." pra pausa')
  parts.push('- NAO use emoji em toda msg — so quando faz sentido (alegria, confirmacao etc)')
  parts.push('- Pode escrever em minuscula ocasionalmente, como humano apressado')

  return parts.filter(Boolean).join('\n')
}

// ─── buildConversationHistory ────────────────────────────────────────

function buildConversationHistory(leadId, limit = 10) {
  // Pega ultimas N msgs (excluindo as do bot pra historico mais limpo? Nao, inclui ambas)
  const msgs = db.prepare(`
    SELECT direction, content, ai_agent_id
    FROM messages
    WHERE lead_id = ? AND content IS NOT NULL AND content != ''
    ORDER BY id DESC LIMIT ?
  `).all(leadId, limit).reverse()

  return msgs.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }))
}

// ─── countBotMessagesInThread ─────────────────────────────────────────

function countBotMessagesInThread(agent, leadId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM messages WHERE lead_id = ? AND ai_agent_id = ?
  `).get(leadId, agent.id).c
}

// ─── pickFromRoulette (wrapper do util — handoff sempre exclui bots) ─────

function pickFromRoulette(accountId, instanceId, excludeUserId) {
  return rouletteUtil(accountId, instanceId, { excludeUserId, excludeBots: true })
}

// ─── executeHandoff ───────────────────────────────────────────────────

function executeHandoff(agent, lead, reason, instanceId) {
  const rule = db.prepare('SELECT * FROM ai_agent_handoff_rules WHERE agent_id = ? AND reason = ?').get(agent.id, reason)

  // Resolve target user
  let targetUserId = null
  if (rule?.target_type === 'specific_user' && rule.target_user_id) {
    const u = getUser(rule.target_user_id)
    if (u && u.is_active) targetUserId = u.id
    else if (rule.fallback_to_roulette) targetUserId = pickFromRoulette(lead.account_id, instanceId, agent.user_id)
  } else {
    // Default: roleta humana
    targetUserId = pickFromRoulette(lead.account_id, instanceId, agent.user_id)
  }

  // FIX #9 — Se roleta nao achou ninguem, NAO marca handoff (bot continua respondendo).
  // Antes: marcava ai_handed_off_at mesmo sem atendente, bot parava e ninguem via —
  // lead virava buraco negro. Agora: sem atendente = bot continua + alerta interno.
  if (targetUserId) {
    db.prepare("UPDATE leads SET attendant_id = ?, updated_at = datetime('now') WHERE id = ?").run(targetUserId, lead.id)
    db.prepare("UPDATE leads SET ai_handed_off_at = datetime('now') WHERE id = ?").run(lead.id)
  } else {
    // Alerta pra gestor investigar (nenhum atendente disponivel)
    console.warn(`[AI Agent] Handoff FALHOU lead=${lead.id} reason=${reason} — nenhum atendente ativo disponivel. Bot continua respondendo.`)
    try {
      db.prepare(`INSERT INTO analyst_alerts (account_id, lead_id, type, severity, title, description, status, created_at)
                  VALUES (?, ?, 'handoff_failed', 'high', ?, ?, 'open', datetime('now'))`)
        .run(lead.account_id, lead.id, 'Handoff sem atendente', `Bot tentou entregar lead pra humano (reason=${reason}) mas roleta nao achou ninguem ativo. Bot continua respondendo. Configure atendente ativo com primary_instance_id.`)
    } catch (e) { console.warn('[AI Agent] Falha ao criar analyst_alert:', e.message) }
  }

  // Move etapa (se configurado)
  if (rule?.move_to_stage_id) {
    const prev = lead.stage_id
    db.prepare("UPDATE leads SET stage_id = ?, updated_at = datetime('now') WHERE id = ?").run(rule.move_to_stage_id, lead.id)
    db.prepare('INSERT INTO stage_history (lead_id, from_stage_id, to_stage_id, trigger_type) VALUES (?, ?, ?, ?)').run(lead.id, prev, rule.move_to_stage_id, 'ai_handoff')
  }

  // Add tag (se configurado)
  if (rule?.add_tag_id) {
    db.prepare('INSERT OR IGNORE INTO lead_tags (lead_id, tag_id) VALUES (?, ?)').run(lead.id, rule.add_tag_id)
  }

  console.log(`[AI Agent] Handoff lead=${lead.id} reason=${reason} target_user=${targetUserId}`)
  try { broadcastSSE(lead.account_id, 'lead:updated', { id: lead.id }) } catch {}

  // Dispara handoff de primeira msg + notif (se target eh humano valido)
  if (targetUserId) {
    setImmediate(() => {
      notifyAndOpenLead(lead.id, targetUserId, { source: 'bot_handoff' })
        .catch(e => console.error('[Handoff bot]', e.message))
    })
  }
}

// ─── Tools (function calling) ─────────────────────────────────────────

function getToolsForAgent(availableTags, availableStages) {
  return [
    {
      name: 'update_lead_info',
      description: 'Salva informacao que o lead informou (nome, email, cidade, empresa, instagram). Use SEMPRE que o lead disser esses dados.',
      input_schema: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['name', 'email', 'city', 'empresa', 'instagram'] },
          value: { type: 'string', description: 'Valor informado pelo lead' },
        },
        required: ['field', 'value'],
      },
    },
    {
      name: 'add_tag',
      description: 'Marca o lead com uma tag (use apenas tags listadas no system).',
      input_schema: {
        type: 'object',
        properties: {
          tag_name: { type: 'string', enum: availableTags.map(t => t.name) },
        },
        required: ['tag_name'],
      },
    },
    {
      name: 'move_stage',
      description: 'Move o lead pra outra etapa do funil (use apenas etapas listadas).',
      input_schema: {
        type: 'object',
        properties: {
          stage_name: { type: 'string', enum: availableStages.map(s => s.name) },
        },
        required: ['stage_name'],
      },
    },
    {
      name: 'transfer_to_human',
      description: 'Transfere o lead pra atendente humano. Use quando: lead pediu humano (reason=keyword), lead esta qualificado (reason=qualified), voce nao soube responder (reason=unknown), ou conversou demais sem qualificar (reason=max_messages).',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['qualified', 'keyword', 'unknown', 'max_messages', 'audio_received', 'other'] },
        },
        required: ['reason'],
      },
    },
  ]
}

// ─── executeTool ──────────────────────────────────────────────────────

async function executeTool(toolUse, agent, lead, instanceId, availableTags, availableStages) {
  const { name, input } = toolUse
  try {
    if (name === 'update_lead_info') {
      const allowed = ['name', 'email', 'city', 'empresa', 'instagram']
      if (allowed.includes(input.field) && input.value) {
        db.prepare(`UPDATE leads SET ${input.field} = ? WHERE id = ?`).run(String(input.value).substring(0, 200), lead.id)
        console.log(`[AI Agent] update_lead_info lead=${lead.id} ${input.field}="${input.value}"`)
      }
    } else if (name === 'add_tag') {
      const tag = availableTags.find(t => t.name === input.tag_name)
      if (tag) {
        db.prepare('INSERT OR IGNORE INTO lead_tags (lead_id, tag_id) VALUES (?, ?)').run(lead.id, tag.id)
        console.log(`[AI Agent] add_tag lead=${lead.id} tag="${input.tag_name}"`)
      }
    } else if (name === 'move_stage') {
      const stage = availableStages.find(s => s.name === input.stage_name)
      if (stage && stage.id !== lead.stage_id) {
        const prev = lead.stage_id
        db.prepare("UPDATE leads SET stage_id = ?, updated_at = datetime('now') WHERE id = ?").run(stage.id, lead.id)
        db.prepare('INSERT INTO stage_history (lead_id, from_stage_id, to_stage_id, trigger_type) VALUES (?, ?, ?, ?)').run(lead.id, prev, stage.id, 'ai_agent')
        console.log(`[AI Agent] move_stage lead=${lead.id} -> "${input.stage_name}"`)
      }
    } else if (name === 'transfer_to_human') {
      const reason = input.reason || 'other'
      executeHandoff(agent, lead, reason, instanceId)
      return { handoff: true, reason }
    }
  } catch (e) {
    console.error(`[AI Agent] Erro tool ${name}:`, e.message)
  }
  return { handoff: false }
}

// (sendEvolutionText removido — agora usa sendViaInstance do leadHandoff.js, que tem pre-flight + cache)

// ─── processInboundMessage ────────────────────────────────────────────

export async function processInboundMessage(lead, msgContent, mediaType, instanceId, _opts = {}) {
  // Fire-and-forget: encaminha notificacao pro telefone configurado (se instancia tem forward on).
  // Roda independente do bot AI; se nao tem config, maybeForwardInbound retorna sem fazer nada.
  if (lead && instanceId) {
    maybeForwardInbound({ lead, instanceId, content: msgContent, mediaType }).catch(e => console.error('[Forward] err:', e.message))
  }
  try {
    console.log(`[AI Agent DEBUG] processInboundMessage chamado lead=${lead?.id} instance=${instanceId} mediaType=${mediaType} content="${(msgContent||'').substring(0,30)}"`)
    // 1. Encontra agente (respeita todos os filtros — bloqueios sao reportados pelo diagnoseForceAi na rota)
    const agent = findAgentForLead(lead, instanceId)
    if (!agent) {
      return { ok: false, reason: 'no_matching_agent' }
    }
    console.log(`[AI Agent DEBUG] agente encontrado: id=${agent.id} name=${agent.name}`)

    // 2. Reset mensal de tokens se mes virou
    resetMonthlyTokensIfNeeded(agent)

    // 3. Checa limite de tokens
    if (agent.tokens_used_this_month >= agent.monthly_token_limit) {
      console.log(`[AI Agent] Limite mensal estourado agent=${agent.id}, fazendo handoff silencioso`)
      executeHandoff(agent, lead, 'unknown', instanceId)
      return
    }

    // 4. Audio: flag OFF = recusa + handoff; flag ON = transcreve via Deepgram e segue
    let sttSec = 0
    let sttCost = 0
    let sttProvider = null

    if (mediaType === 'audio') {
      const declineAndHandoff = async (reason) => {
        const inst = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instanceId)
        if (inst && inst.status === 'connected') {
          const declineMsg = agent.audio_decline_message || 'Oi! Por enquanto so leio mensagens de texto. Pode digitar pra mim?'
          const sendRes = await sendViaInstance(inst, lead.phone, declineMsg, { leadId: lead.id })
          if (sendRes.ok) {
            db.prepare(`
              INSERT INTO messages (lead_id, account_id, direction, content, media_type, sender_name, wa_msg_id, wa_timestamp, instance_id, ai_agent_id, delivery_status)
              VALUES (?, ?, 'outbound', ?, 'text', 'AI', ?, datetime('now'), ?, ?, 'sent')
            `).run(lead.id, lead.account_id, declineMsg, sendRes.wamsgId, instanceId, agent.id)
            try { broadcastSSE(lead.account_id, 'lead:message', { lead_id: lead.id }) } catch {}
          } else {
            console.warn(`[AI Agent] declineMsg falhou agent=${agent.id} lead=${lead.id}: ${sendRes.reason}`)
          }
        }
        executeHandoff(agent, lead, reason, instanceId)
      }

      if (!agent.responds_to_audio) {
        // Flag OFF — comportamento atual preservado
        await declineAndHandoff('audio_received')
        return
      }

      // Flag ON — baixa audio da Evolution + transcreve via Deepgram + injeta texto
      const inst = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instanceId)
      if (!inst || inst.status !== 'connected') {
        console.error(`[AI Agent] STT: instancia ${instanceId} indisponivel`)
        await declineAndHandoff('stt_failed')
        return
      }

      // Pega wa_msg_id da ultima msg de audio inbound do lead
      const lastAudio = db.prepare(`
        SELECT wa_msg_id FROM messages
        WHERE lead_id = ? AND direction = 'inbound' AND media_type = 'audio' AND wa_msg_id IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(lead.id)

      if (!lastAudio?.wa_msg_id) {
        console.error(`[AI Agent] STT: wa_msg_id nao encontrado pra lead=${lead.id}`)
        await declineAndHandoff('stt_failed')
        return
      }

      try {
        const { buffer, mimetype } = await fetchAudioBuffer(inst, lastAudio.wa_msg_id)
        const result = await transcribeAudio(buffer, { mimetype, language: 'pt-BR' })
        if (!result.ok) throw new Error(result.reason || 'unknown')

        if (!result.transcript.trim()) {
          console.warn(`[AI Agent] STT vazio lead=${lead.id} — handoff`)
          await declineAndHandoff('audio_received')
          return
        }

        sttSec = result.durationSec
        sttCost = result.costUsd
        sttProvider = 'deepgram'
        console.log(`[AI Agent] STT lead=${lead.id} dur=${sttSec.toFixed(1)}s cost=$${sttCost.toFixed(4)} txt="${result.transcript.slice(0, 80)}${result.transcript.length > 80 ? '...' : ''}"`)

        // Reassign msgContent (parametro) pro Haiku ver o texto transcrito
        msgContent = `[Audio transcrito] ${result.transcript}`
      } catch (e) {
        console.error(`[AI Agent] STT falhou lead=${lead.id}:`, e.message)
        await declineAndHandoff('stt_failed')
        return
      }
    }

    // 5. Checa max_messages
    const botMsgCount = countBotMessagesInThread(agent, lead.id)
    if (botMsgCount >= agent.max_messages_before_handoff) {
      console.log(`[AI Agent] Max messages atingido agent=${agent.id} lead=${lead.id}`)
      executeHandoff(agent, lead, 'max_messages', instanceId)
      return
    }

    // 6. Carrega tags e etapas disponiveis (pra tools enum)
    const availableTags = db.prepare('SELECT id, name FROM tags WHERE account_id = ?').all(lead.account_id)
    const availableStages = db.prepare(`
      SELECT s.id, s.name FROM funnel_stages s
      JOIN funnels f ON f.id = s.funnel_id
      WHERE f.account_id = ? AND f.is_default = 1
      ORDER BY s.position
    `).all(lead.account_id)

    // 7. Monta system prompt
    const systemPrompt = buildSystemPrompt(agent, lead, availableTags, availableStages)

    // 8. Monta history (ultimas 10 msgs)
    const history = buildConversationHistory(lead.id, 10)
    // Garante que a ultima msg eh do lead (user)
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      history.push({ role: 'user', content: msgContent || '(mensagem vazia)' })
    } else if (mediaType === 'audio' && sttProvider) {
      // Audio foi transcrito (sttProvider setado) — substitui o '[Audio]' que veio do
      // historico DB pela transcricao, senao Haiku ve '[Audio]' e dispara handoff sem motivo.
      history[history.length - 1] = { role: 'user', content: msgContent }
    }

    // 9. Define tools
    const tools = getToolsForAgent(availableTags, availableStages)

    // 10-12. Multi-turn loop: chama Haiku, executa tools, se nao houver texto e teve tool, chama de novo com tool_results
    const MAX_ITERATIONS = 4
    let workingMessages = [...history]
    let finalText = ''
    let totalToolsExecuted = 0
    let totalTokens = 0
    let totalCost = 0
    let handoffTriggered = false
    let iterationsRun = 0

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      iterationsRun++
      let result
      try {
        result = await callHaiku({
          systemPrompt,
          messages: workingMessages,
          tools,
          maxTokens: 400,
          toolChoice: 'auto',
          accountId: agent.account_id,
        })
      } catch (e) {
        console.error(`[AI Agent] Erro chamando Haiku agent=${agent.id} iter=${i}:`, e.message)
        break
      }

      // Log de uso (cada chamada). STT loga so na primeira iteracao pra nao duplicar.
      const logSttSec = i === 0 ? sttSec : 0
      const logSttCost = i === 0 ? sttCost : 0
      const logSttProvider = i === 0 ? sttProvider : null
      db.prepare(`
        INSERT INTO ai_agent_token_log (agent_id, account_id, lead_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, stt_seconds, stt_cost_usd, stt_provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(agent.id, agent.account_id, lead.id, result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.cacheCreation, result.costUsd, logSttSec, logSttCost, logSttProvider)
      const iterTokens = result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheCreation
      totalTokens += iterTokens
      totalCost += result.costUsd
      db.prepare("UPDATE ai_agents SET tokens_used_this_month = tokens_used_this_month + ? WHERE id = ?").run(iterTokens, agent.id)

      // Acumula texto
      if (result.content && result.content.trim()) finalText += (finalText ? ' ' : '') + result.content.trim()

      // Sem tool_uses -> termina
      if (!result.toolUses || result.toolUses.length === 0) break

      // Executa tools e monta tool_results pra proxima iteracao
      const toolResults = []
      for (const tu of result.toolUses) {
        totalToolsExecuted++
        const tr = await executeTool(tu, agent, lead, instanceId, availableTags, availableStages)
        if (tr.handoff) handoffTriggered = true
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: tr.handoff ? `Handoff executado (reason=${tr.reason}). Termine a conversa.` : 'OK',
        })
      }

      // Se handoff foi disparado, nao precisa continuar pedindo mais output
      if (handoffTriggered) break

      // Monta a proxima rodada: adiciona resposta do assistant (text + tool_uses) e o tool_result
      const assistantContent = []
      if (result.content && result.content.trim()) assistantContent.push({ type: 'text', text: result.content })
      for (const tu of result.toolUses) assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      workingMessages = [
        ...workingMessages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResults },
      ]
    }

    // 13. Envia resposta texto (se houver)
    if (finalText && finalText.trim()) {
      // Anti-ban: espaca msg do bot se houve outbound recente (<10s) pro mesmo lead.
      // Evita rajada quando lead manda varias inbounds seguidas que disparam respostas em sequencia.
      const lastBotMsg = db.prepare(`
        SELECT created_at FROM messages
        WHERE lead_id = ? AND direction = 'outbound' AND ai_agent_id = ?
        ORDER BY id DESC LIMIT 1
      `).get(lead.id, agent.id)
      if (lastBotMsg?.created_at) {
        const lastMs = new Date(String(lastBotMsg.created_at).replace(' ', 'T') + 'Z').getTime()
        const secondsSince = (Date.now() - lastMs) / 1000
        if (secondsSince < 10) {
          const wait = 2000 + Math.random() * 2000  // 2-4s
          console.log(`[AI Agent] espacando msg do bot lead=${lead.id} wait=${Math.round(wait)}ms (last=${secondsSince.toFixed(1)}s)`)
          await new Promise(r => setTimeout(r, wait))
        }
      }
      const inst = db.prepare('SELECT * FROM whatsapp_instances WHERE id = ?').get(instanceId)
      if (inst && inst.status === 'connected') {
        // Anti-ban: marca msg como lida ANTES de responder (humano abre conversa antes)
        try { await markMessageAsRead(inst, lead) } catch {}
        const sendRes = await sendViaInstance(inst, lead.phone, finalText.trim(), { leadId: lead.id })
        if (sendRes.ok) {
          db.prepare(`
            INSERT INTO messages (lead_id, account_id, direction, content, media_type, sender_name, wa_msg_id, wa_timestamp, instance_id, ai_agent_id, delivery_status)
            VALUES (?, ?, 'outbound', ?, 'text', 'AI', ?, datetime('now'), ?, ?, 'sent')
          `).run(lead.id, lead.account_id, finalText.trim(), sendRes.wamsgId, instanceId, agent.id)
          try { broadcastSSE(lead.account_id, 'lead:message', { lead_id: lead.id }) } catch {}
        } else {
          console.error(`[AI Agent] Falha envio agent=${agent.id} lead=${lead.id}: ${sendRes.reason}`)
          return { ok: false, reason: 'send_blocked', sendReason: sendRes.reason }
        }
      } else if (inst && inst.status !== 'connected') {
        return { ok: false, reason: 'instance_disconnected' }
      } else {
        return { ok: false, reason: 'instance_not_found' }
      }
    }

    console.log(`[AI Agent] Processed lead=${lead.id} agent=${agent.id} iters=${iterationsRun} tokens=${totalTokens} cost_usd=${totalCost.toFixed(6)} tools=${totalToolsExecuted} handoff=${handoffTriggered} text_len=${finalText.length}`)
    return { ok: true }
  } catch (err) {
    console.error('[AI Agent] processInboundMessage erro:', err.message)
    return { ok: false, reason: 'exception', detail: err.message }
  }
}

// ─── sendBotWelcomeForSheetsLead ──────────────────────────────────────
// Saudacao automatica gerada pelo Haiku quando lead novo cair via planilha (source='sheets').
// Opt-in por agente (ai_agents.send_welcome_for_sheets_leads). Idempotente via leads.ai_first_msg_sent_at.
// Fire-and-forget: qualquer erro so loga, nao quebra o webhook que ja respondeu 200.

export async function sendBotWelcomeForSheetsLead(leadId, instanceId) {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId)
    if (!lead) return

    // (Sem filtro de source — funcao so eh chamada do webhook /sheets/:slug que ja garante
    // origem. Source string varia muito por integracao: 'sheets', 'google_sheets', 'LP_*', etc.)

    // FILTRO 2: idempotencia — so 1x por lead (protege Apps Script retry)
    if (lead.ai_first_msg_sent_at) {
      console.log(`[Bot Welcome] SKIP lead=${leadId} — ja enviado em ${lead.ai_first_msg_sent_at}`)
      return
    }

    // FILTRO 3: precisa phone
    if (!lead.phone) {
      console.log(`[Bot Welcome] SKIP lead=${leadId} — sem phone`)
      return
    }

    // FILTRO 4: agente elegivel (reusa toda logica de findAgentForLead)
    const agent = findAgentForLead(lead, instanceId)
    if (!agent) {
      console.log(`[Bot Welcome] SKIP lead=${leadId} — sem agente elegivel`)
      return
    }

    // FILTRO 5: agente tem opt-in pra welcome?
    if (!agent.send_welcome_for_sheets_leads) {
      console.log(`[Bot Welcome] SKIP lead=${leadId} agent=${agent.id} — flag off`)
      return
    }

    // FILTRO 6: limite de tokens do agente?
    resetMonthlyTokensIfNeeded(agent)
    if (agent.monthly_token_limit && agent.tokens_used_this_month >= agent.monthly_token_limit) {
      console.log(`[Bot Welcome] SKIP lead=${leadId} agent=${agent.id} — limite mensal atingido`)
      return
    }

    // Resolve instancia: prefere lead.instance_id, fallback pro arg
    const targetInstId = lead.instance_id || instanceId
    if (!targetInstId) {
      console.log(`[Bot Welcome] SKIP lead=${leadId} — sem instancia`)
      return
    }
    const inst = db.prepare("SELECT * FROM whatsapp_instances WHERE id = ? AND status = 'connected'").get(targetInstId)
    if (!inst) {
      console.warn(`[Bot Welcome] inst offline/inexistente lead=${leadId} inst=${targetInstId}`)
      return
    }

    // Tags do lead pra contextualizar
    const tags = db.prepare(`
      SELECT t.name FROM tags t
      JOIN lead_tags lt ON lt.tag_id = t.id
      WHERE lt.lead_id = ?
    `).all(leadId).map(r => r.name)

    // System prompt customizado pra geracao de saudacao (NAO usa buildSystemPrompt normal porque
    // aquele assume conversa em andamento; este aqui e' o primeiro toque).
    const systemPrompt = `Voce e ${agent.name}${agent.persona ? `, ${agent.persona}` : ', assistente'} atendendo leads via WhatsApp.

CONTEXTO DESTE TURNO: um lead acabou de chegar via planilha (Google Sheets). Ele AINDA NAO mandou mensagem nenhuma. Sua tarefa e fazer o PRIMEIRO contato.

Dados do lead:
- Nome: ${lead.name || '(sem nome)'}
- Telefone: ${lead.phone}
- Cidade: ${lead.city || 'desconhecida'}
- Empresa: ${lead.empresa || 'desconhecida'}
- Tags: ${tags.join(', ') || 'nenhuma'}
${agent.welcome_extra_instructions ? `\nINSTRUCOES EXTRAS DO GERENTE:\n${agent.welcome_extra_instructions}\n` : ''}
REGRAS:
1. Cumprimente o lead pelo PRIMEIRO nome (se tiver nome completo, use so o primeiro)
2. Apresente-se brevemente (voce e o atendimento da empresa)
3. Faca UMA pergunta aberta pra iniciar a conversa
4. Mantenha tom natural da sua persona — nao pareca robo
5. Texto curto: 2-4 linhas no maximo
6. Portugues brasileiro coloquial
7. SEM markdown, SEM listas, SEM emojis (excecao: 👋 opcional no inicio)
8. Nao invente informacoes que nao tem`

    const result = await callHaiku({
      systemPrompt,
      messages: [{ role: 'user', content: 'Gere AGORA a saudacao pra esse lead. Apenas o texto da mensagem, sem aspas, sem cabecalhos.' }],
      maxTokens: 250,
      accountId: lead.account_id,
    })

    const msgText = (result.content || '').trim()
    if (!msgText) {
      console.warn(`[Bot Welcome] Haiku retornou vazio lead=${leadId}`)
      return
    }

    // Envia via Evolution
    const sendResult = await sendViaInstance(inst, lead.phone, msgText, { leadId: lead.id })
    if (!sendResult.ok) {
      console.warn(`[Bot Welcome] envio falhou lead=${leadId}: ${sendResult.reason || 'unknown'}`)
      return
    }

    // Salva msg no historico (sender_name = agente, ai_agent_id = agente).
    // delivery_status='sent' — webhook messages.update do Evolution vai promover pra 'delivered'/'read' depois.
    // Se ficar 'sent' por >10min sem confirmacao, cron marca como 'failed' (fidelidade).
    db.prepare(`
      INSERT INTO messages (lead_id, account_id, direction, content, media_type, sender_name, wa_msg_id, instance_id, ai_agent_id, delivery_status)
      VALUES (?, ?, 'outbound', ?, 'text', ?, ?, ?, ?, 'sent')
    `).run(lead.id, lead.account_id, msgText, agent.name, sendResult.wamsgId, inst.id, agent.id)

    // Atualiza last_instance_id + marca idempotencia
    db.prepare("UPDATE leads SET ai_first_msg_sent_at = datetime('now'), last_instance_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(inst.id, leadId)

    // Loga custo (mesma tabela do fluxo reativo, source='welcome_sheets' pra filtrar dashboard)
    db.prepare(`
      INSERT INTO ai_agent_token_log (agent_id, lead_id, account_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'welcome_sheets')
    `).run(
      agent.id, leadId, lead.account_id,
      result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.cacheCreation,
      result.costUsd
    )

    // Atualiza contador mensal do agente
    db.prepare("UPDATE ai_agents SET tokens_used_this_month = tokens_used_this_month + ? WHERE id = ?")
      .run(result.usage.total, agent.id)

    console.log(`[Bot Welcome] OK lead=${leadId} agent=${agent.id} cost=$${result.costUsd.toFixed(6)} txt="${msgText.slice(0, 70).replace(/\n/g, ' ')}..."`)
  } catch (err) {
    console.error(`[Bot Welcome] exception lead=${leadId}:`, err.message)
  }
}

// ─── replayLastMessagesForAgent ──────────────────────────────────────────
// Apos reativar agente, processa a ULTIMA msg inbound pendente de cada lead
// que ficou sem resposta durante a pausa. Fire-and-forget com setTimeout
// espacado 500ms entre cada chamada (evita burst de Haiku/Evolution).
//
// Lead considerado pendente:
//  - attendant_id aponta pro user-bot do agente
//  - ativo, nao arquivado, nao bloqueado
//  - ai_handed_off_at IS NULL (bot ainda eh responsavel)
//  - tem msg inbound depois de pausedAt
//  - nao houve outbound depois da ultima inbound
//
// Limite: 30 leads por reativacao (protege budget Haiku contra avalanche).
export async function replayLastMessagesForAgent(agentId, pausedAt) {
  const agent = db.prepare('SELECT id, account_id, user_id FROM ai_agents WHERE id = ?').get(agentId)
  if (!agent || !agent.user_id) return { ok: false, reason: 'no_agent_user' }
  if (!pausedAt) return { ok: false, reason: 'no_paused_at' }

  const pendingLeads = db.prepare(`
    SELECT l.id as lead_id, l.instance_id,
      (SELECT content FROM messages WHERE lead_id = l.id AND direction = 'inbound' ORDER BY id DESC LIMIT 1) as last_content,
      (SELECT media_type FROM messages WHERE lead_id = l.id AND direction = 'inbound' ORDER BY id DESC LIMIT 1) as last_media_type
    FROM leads l
    WHERE l.account_id = ?
      AND l.attendant_id = ?
      AND l.is_active = 1
      AND COALESCE(l.is_archived, 0) = 0
      AND COALESCE(l.is_blocked, 0) = 0
      AND l.ai_handed_off_at IS NULL
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.lead_id = l.id AND m.direction = 'inbound'
          AND m.created_at >= ?
          AND m.id > COALESCE(
            (SELECT MAX(id) FROM messages WHERE lead_id = l.id AND direction = 'outbound'),
            0
          )
      )
    ORDER BY (SELECT MAX(created_at) FROM messages WHERE lead_id = l.id) DESC
    LIMIT 30
  `).all(agent.account_id, agent.user_id, pausedAt)

  console.log(`[Bot Replay] agent=${agentId} leadsPendentes=${pendingLeads.length}`)

  let dispatched = 0
  for (const row of pendingLeads) {
    if (!row.last_content && row.last_media_type !== 'audio') continue
    const freshLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id)
    if (!freshLead) continue
    const delayMs = dispatched * 500
    setTimeout(() => {
      processInboundMessage(freshLead, row.last_content || '', row.last_media_type, row.instance_id)
        .catch(e => console.error(`[Bot Replay] err lead=${row.lead_id}:`, e.message))
    }, delayMs)
    dispatched++
  }

  return { ok: true, dispatched, total: pendingLeads.length }
}
