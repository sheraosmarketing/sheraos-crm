// Substituicao de placeholders em templates de mensagem — versao BACKEND (Node runtime).
// Espelha src/lib/messageVars.ts pra garantir mesma logica entre frontend e backend.
// Se atualizar tokens aqui, atualiza no TS tambem (single source of truth logica; arquivos duplicados por runtime).

const TOKENS = ['{{name}}', '{{nome}}', '{{primeiro_nome}}', '{{first_name}}', '{{empresa}}', '{{cidade}}', '{{atendente}}', '{{atendente_nome}}']

function firstName(full) {
  if (!full) return ''
  return String(full).split(' ')[0] || String(full)
}

// ctx: { leadName, leadEmpresa, leadCity, attendantName }
export function applyMessageVars(template, ctx = {}) {
  if (!template) return template
  const leadName = ctx.leadName || 'Cliente'
  return String(template)
    .replace(/\{\{name\}\}/g, leadName)
    .replace(/\{\{nome\}\}/g, leadName)
    .replace(/\{\{primeiro_nome\}\}/g, firstName(ctx.leadName) || 'Cliente')
    .replace(/\{\{first_name\}\}/g, firstName(ctx.leadName) || 'Cliente')
    .replace(/\{\{empresa\}\}/g, ctx.leadEmpresa || '')
    .replace(/\{\{cidade\}\}/g, ctx.leadCity || '')
    .replace(/\{\{atendente\}\}/g, ctx.attendantName || '')
    .replace(/\{\{atendente_nome\}\}/g, firstName(ctx.attendantName))
}

// Retorna true se o template usa placeholder de atendente (util pra decidir se precisa de attendant_id).
export function templateNeedsAttendant(template) {
  if (!template) return false
  const s = String(template)
  return s.includes('{{atendente}}') || s.includes('{{atendente_nome}}')
}

// Resolve spintax inline tipo {oi|ola|e ai} escolhendo um dos termos aleatoriamente.
// Suporta aninhamento ate 4 niveis: {ei {joao|jose}|opa}. Placeholders {{...}}
// (duas chaves) NAO sao tocados porque o regex exige um pipe '|' dentro.
export function resolveSpintax(text) {
  if (!text || typeof text !== 'string') return text
  let out = text
  for (let i = 0; i < 4; i++) {
    const prev = out
    out = out.replace(/\{([^{}|]*\|[^{}]*)\}/g, (_, group) => {
      const parts = group.split('|')
      return parts[Math.floor(Math.random() * parts.length)]
    })
    if (out === prev) break
  }
  return out
}

// Helper: constroi VarContext a partir do lead + attendant (rows do DB).
export function buildVarContext(lead, attendant) {
  return {
    leadName: lead?.name || null,
    leadEmpresa: lead?.empresa || null,
    leadCity: lead?.city || null,
    attendantName: attendant?.name || null,
  }
}
