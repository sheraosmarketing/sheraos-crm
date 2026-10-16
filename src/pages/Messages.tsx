import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccount } from '../context/AccountContext'
import { fetchBroadcasts, fetchLeads, createBroadcast, sendBroadcast, cancelScheduledBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast, fetchTags, fetchFunnels, fetchWhatsAppInstances, fetchBroadcastCloneData, fetchUsers, fetchLeadSources, type Broadcast, type Lead, type Tag, type Funnel, type WhatsAppInstance, type User } from '../lib/api'
import { MessageCircle, Plus, Send, CheckCircle, Clock, Trash2, Filter, Tag as TagIcon, GitBranch, Smartphone, AlertTriangle, Eye, PauseCircle, Copy, UserCog, Pause, Play, XCircle, Square, Image as ImageIcon, Paperclip, X } from 'lucide-react'
import { parseSqlDate } from '../lib/dates'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft: { label: 'Rascunho', color: '#9B96B0' },
  scheduled: { label: 'Agendado', color: '#FBBC04' },
  sending: { label: 'Enviando', color: '#5DADE2' },
  paused: { label: 'Pausado', color: '#FBBC04' },
  completed: { label: 'Concluido', color: '#34C759' },
  failed: { label: 'Falhou', color: '#FF6B6B' },
  cancelled: { label: 'Cancelado', color: '#FF6B6B' },
}

const MIN_VARIATIONS = 3 // total messages (principal + 2 variations)
const MIN_DELAY = 8
const DEFAULT_DELAY = 15

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${h}h${mm}min` : `${h}h`
}

export default function Messages() {
  const navigate = useNavigate()
  const { accountId } = useAccount()
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTemplate, setNewTemplate] = useState('')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('') // datetime-local string (local time)
  const [newVariations, setNewVariations] = useState<string[]>(['', ''])
  const [newDelay, setNewDelay] = useState(DEFAULT_DELAY)
  const [newInstanceId, setNewInstanceId] = useState<number | ''>('')
  const [selectedLeads, setSelectedLeads] = useState<Lead[]>([])
  const [leadSearch, setLeadSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Lead[]>([])
  const [step, setStep] = useState(1)
  const [tags, setTags] = useState<Tag[]>([])
  const [funnels, setFunnels] = useState<Funnel[]>([])
  const [instances, setInstances] = useState<WhatsAppInstance[]>([])
  const [filterTags, setFilterTags] = useState<number[]>([])
  const [filterStages, setFilterStages] = useState<number[]>([])
  const [filterAttendants, setFilterAttendants] = useState<number[]>([])
  const [filterSources, setFilterSources] = useState<string[]>([])
  const [sources, setSources] = useState<string[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [creating, setCreating] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [cloneNotice, setCloneNotice] = useState<string | null>(null)
  const [showSelectedList, setShowSelectedList] = useState(false)
  const [mediaBase64, setMediaBase64] = useState<string>('')
  const [mediaMime, setMediaMime] = useState<string>('')
  const [mediaFilename, setMediaFilename] = useState<string>('')
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string>('')
  const [mediaError, setMediaError] = useState<string>('')

  const load = () => { if (accountId) { setLoading(true); fetchBroadcasts(accountId).then(setBroadcasts).finally(() => setLoading(false)) } }
  useEffect(load, [accountId])

  // Auto-refresh enquanto tiver disparos em andamento
  useEffect(() => {
    if (!accountId) return
    const hasActive = broadcasts.some(b => b.status === 'sending' || b.status === 'paused')
    if (!hasActive) return
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [broadcasts.map(b => `${b.id}:${b.status}:${b.sent_count}`).join(','), accountId])

  // Carrega tags, funis, instancias ao abrir modal
  useEffect(() => {
    if (showNew && accountId) {
      fetchTags(accountId).then(setTags).catch(() => {})
      fetchFunnels(accountId).then(setFunnels).catch(() => {})
      fetchUsers(accountId).then(us => setUsers(us.filter(u => u.is_active && (u.role === 'atendente' || u.role === 'gerente' || u.is_bot)))).catch(() => {})
      fetchWhatsAppInstances(accountId).then(insts => {
        setInstances(insts)
        const connected = insts.find(i => i.status === 'connected')
        if (connected && !newInstanceId) setNewInstanceId(connected.id)
      }).catch(() => {})
      fetchLeadSources(accountId).then(setSources).catch(() => {})
    }
  }, [showNew, accountId])

  const searchLeads = async () => {
    if (!accountId) return
    const queries: Promise<{ leads: Lead[] }>[] = []

    // Combina resultados: para cada filtro selecionado faz uma query, depois dedupe.
    // Limit 3000: cobre bases grandes de import (ex: Pousada Di Venezia tem 2.668).
    const LIMIT_PER_QUERY = 3000
    if (filterTags.length > 0) {
      queries.push(...filterTags.map(tagId => fetchLeads(accountId, { tag: tagId, limit: LIMIT_PER_QUERY })))
    }
    if (filterStages.length > 0) {
      queries.push(...filterStages.map(stageId => fetchLeads(accountId, { stage_id: stageId, limit: LIMIT_PER_QUERY })))
    }
    if (filterSources.length > 0) {
      queries.push(...filterSources.map(s => fetchLeads(accountId, { source: s, limit: LIMIT_PER_QUERY })))
    }
    if (filterAttendants.length > 0 && queries.length === 0) {
      // Se SO atendente esta filtrado, pede leads desse atendente direto.
      // Se houver outros filtros, atendente vira filtro client-side no merged abaixo.
      queries.push(...filterAttendants.map(uid => fetchLeads(accountId, { attendant_id: uid, limit: LIMIT_PER_QUERY })))
    }
    if (queries.length === 0 && leadSearch.length > 1) {
      queries.push(fetchLeads(accountId, { search: leadSearch, limit: LIMIT_PER_QUERY }))
    } else if (queries.length > 0 && leadSearch.length > 1) {
      // Filtra texto sobre o resultado depois (busca client-side)
    }

    if (queries.length === 0) { setSearchResults([]); return }

    try {
      const all = await Promise.all(queries)
      // Dedup por id
      const map = new Map<number, Lead>()
      all.forEach(r => r.leads.forEach(l => map.set(l.id, l)))
      let merged = Array.from(map.values()).filter(l => l.phone)
      // Filtro de atendente client-side quando ha outros filtros (intersecao)
      if (filterAttendants.length > 0 && (filterTags.length > 0 || filterStages.length > 0 || filterSources.length > 0)) {
        merged = merged.filter(l => l.attendant_id != null && filterAttendants.includes(l.attendant_id))
      }
      // Aplica busca de texto sobre o set unificado quando ha filtros
      if (leadSearch.length > 1 && (filterTags.length > 0 || filterStages.length > 0 || filterAttendants.length > 0 || filterSources.length > 0)) {
        const q = leadSearch.toLowerCase()
        merged = merged.filter(l => (l.name || '').toLowerCase().includes(q) || (l.phone || '').includes(q))
      }
      setSearchResults(merged)
    } catch { setSearchResults([]) }
  }

  useEffect(() => {
    if (!accountId) return
    if (leadSearch.length > 1 || filterTags.length > 0 || filterStages.length > 0 || filterAttendants.length > 0 || filterSources.length > 0) searchLeads()
    else setSearchResults([])
  }, [leadSearch, filterTags.join(','), filterStages.join(','), filterAttendants.join(','), filterSources.join(','), accountId])

  const toggleLead = (lead: Lead) => {
    setSelectedLeads(prev => prev.some(l => l.id === lead.id) ? prev.filter(l => l.id !== lead.id) : [...prev, lead])
  }
  // Adiciona ao ja selecionado, nao substitui
  const selectAll = () => {
    setSelectedLeads(prev => {
      const existing = new Set(prev.map(l => l.id))
      const additions = searchResults.filter(l => l.phone && !existing.has(l.id))
      return [...prev, ...additions]
    })
  }
  const toggleTag = (id: number) => setFilterTags(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const toggleStage = (id: number) => setFilterStages(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const toggleAttendant = (id: number) => setFilterAttendants(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const toggleSource = (s: string) => setFilterSources(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])

  const totalMessagesCount = 1 + newVariations.filter(v => v.trim()).length
  const enoughVariations = totalMessagesCount >= MIN_VARIATIONS
  const validDelay = newDelay >= MIN_DELAY

  // Estimativa: leads × delay médio (delay com jitter ±30% = mesmo delay médio)
  const estimatedSeconds = selectedLeads.length * newDelay
  const estimatedDuration = formatDuration(estimatedSeconds)

  const resetForm = () => {
    setShowNew(false); setStep(1); setNewName(''); setNewTemplate('')
    setNewVariations(['', '']); setNewDelay(DEFAULT_DELAY); setNewInstanceId('')
    setScheduleEnabled(false); setScheduledAt('')
    setSelectedLeads([]); setLeadSearch(''); setFilterTags([]); setFilterStages([]); setFilterSources([]); setFilterAttendants([])
    setCloneNotice(null)
    setMediaBase64(''); setMediaMime(''); setMediaFilename(''); setMediaPreviewUrl(''); setMediaError('')
  }

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5MB real
  const MAX_VIDEO_BYTES = 16 * 1024 * 1024 // 16MB real (limite WhatsApp)
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMediaError('')
    const f = e.target.files?.[0]
    if (!f) return
    const isImg = f.type.startsWith('image/')
    const isVid = f.type.startsWith('video/')
    const isPdf = f.type === 'application/pdf'
    if (!isImg && !isVid && !isPdf) {
      setMediaError('Tipo nao permitido. Use imagem, video ou PDF.'); return
    }
    const max = isVid ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    if (f.size > max) {
      setMediaError(`Arquivo acima do limite (${Math.floor(max / 1024 / 1024)}MB)`); return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      // dataUrl: "data:image/jpeg;base64,XXXXX"
      const base64 = dataUrl.split(',')[1] || ''
      setMediaBase64(base64)
      setMediaMime(f.type)
      setMediaFilename(f.name)
      setMediaPreviewUrl(dataUrl)
    }
    reader.onerror = () => setMediaError('Erro lendo arquivo')
    reader.readAsDataURL(f)
  }
  const clearMedia = () => {
    setMediaBase64(''); setMediaMime(''); setMediaFilename(''); setMediaPreviewUrl(''); setMediaError('')
  }

  // Valida agendamento: precisa ser parsable e >= agora+1min (margem pra evitar race com scheduler)
  const validSchedule = !scheduleEnabled || (() => {
    if (!scheduledAt) return false
    const d = new Date(scheduledAt)
    return !isNaN(d.getTime()) && d.getTime() >= Date.now() + 60_000
  })()

  const handleCreate = async () => {
    if (!accountId || !newName || !newTemplate || selectedLeads.length === 0 || !newInstanceId) return
    if (!enoughVariations) { alert(`Adicione pelo menos ${MIN_VARIATIONS - 1} variacoes (total ${MIN_VARIATIONS} mensagens diferentes).`); return }
    if (!validDelay) { alert(`Delay minimo: ${MIN_DELAY}s. Valores menores aumentam risco de bloqueio no WhatsApp.`); return }
    if (scheduleEnabled && !validSchedule) { alert('Agendamento invalido. Use uma data e hora pelo menos 1min no futuro.'); return }
    // Converte datetime-local (horario local do navegador) pra ISO UTC pro backend
    const scheduledISO = scheduleEnabled && scheduledAt ? new Date(scheduledAt).toISOString() : null
    setCreating(true)
    try {
      await createBroadcast(accountId, {
        name: newName, message_template: newTemplate,
        message_variations: newVariations.filter(v => v.trim()),
        delay_seconds: newDelay, lead_ids: selectedLeads.map(l => l.id),
        instance_id: Number(newInstanceId),
        scheduled_at: scheduledISO,
        media_base64: mediaBase64 || undefined,
        media_mime: mediaMime || undefined,
        media_filename: mediaFilename || undefined,
      })
      resetForm(); load()
    } catch (e: any) { alert('Erro: ' + e.message) }
    setCreating(false)
  }

  const handleSend = async (id: number) => {
    if (!accountId || !confirm('Enviar disparo agora?')) return
    try { await sendBroadcast(id, accountId); load() }
    catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handleCancelSchedule = async (b: Broadcast) => {
    if (!accountId) return
    const when = b.scheduled_at ? new Date(b.scheduled_at).toLocaleString('pt-BR') : ''
    if (!confirm(`Cancelar agendamento de "${b.name}"${when ? ` (${when})` : ''}?\n\nO disparo volta pra rascunho e voce pode editar ou re-agendar.`)) return
    try { await cancelScheduledBroadcast(b.id, accountId); load() }
    catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handlePause = async (b: Broadcast) => {
    if (!accountId) return
    if (!confirm(`Pausar "${b.name}"?\n\nO disparo para imediatamente. Voce pode retomar depois clicando no botao Play.`)) return
    try { await pauseBroadcast(b.id, accountId); load() }
    catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handleResume = async (b: Broadcast) => {
    if (!accountId) return
    try { await resumeBroadcast(b.id, accountId); load() }
    catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handleCancel = async (b: Broadcast) => {
    if (!accountId) return
    if (!confirm(`Cancelar "${b.name}"?\n\nO disparo para definitivamente. Os ${b.sent_count} contatos ja enviados nao sao afetados, mas os ${b.total_count - b.sent_count - b.failed_count} restantes NAO recebem a msg. O disparo fica marcado como Cancelado.`)) return
    try { await cancelBroadcast(b.id, accountId); load() }
    catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handleDuplicate = async (id: number) => {
    if (!accountId) return
    setDuplicating(true)
    setCloneNotice(null)
    try {
      const data = await fetchBroadcastCloneData(id, accountId)
      // Pre-preenche state do modal
      setNewName(data.clone.name)
      setNewTemplate(data.clone.message_template)
      // Garante minimo 2 slots de variacao (mesmo se original tinha 0)
      const vars = [...data.clone.message_variations]
      while (vars.length < 2) vars.push('')
      setNewVariations(vars)
      setNewDelay(data.clone.delay_seconds || DEFAULT_DELAY)
      setNewInstanceId(data.clone.instance_id || '')
      // Pre-popula anexo se o original tinha
      if (data.clone.media_base64 && data.clone.media_mime) {
        setMediaBase64(data.clone.media_base64)
        setMediaMime(data.clone.media_mime)
        setMediaFilename(data.clone.media_filename || '')
        setMediaPreviewUrl(`data:${data.clone.media_mime};base64,${data.clone.media_base64}`)
      } else {
        clearMedia()
      }
      setSelectedLeads(data.clone.leads)
      setShowSelectedList(true) // ja abre a lista expandida no step 2
      // Reseta filtros e busca pra evitar confusao no step 2
      setLeadSearch(''); setFilterTags([]); setFilterStages([]); setSearchResults([])
      setStep(1)
      setShowNew(true)
      // Aviso se algum lead foi arquivado/deletado desde o original
      if (data.original.valid_leads_now < data.original.total_count) {
        const sumiu = data.original.total_count - data.original.valid_leads_now
        setCloneNotice(`${sumiu} lead${sumiu > 1 ? 's' : ''} do disparo original nao existe${sumiu > 1 ? 'm' : ''} mais (arquivado${sumiu > 1 ? 's' : ''} ou removido${sumiu > 1 ? 's' : ''}). ${data.clone.leads.length} lead${data.clone.leads.length !== 1 ? 's' : ''} pre-selecionado${data.clone.leads.length !== 1 ? 's' : ''}.`)
      }
    } catch (e: any) {
      alert('Erro ao duplicar: ' + (e?.message || 'desconhecido'))
    } finally {
      setDuplicating(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1><MessageCircle size={20} style={{ marginRight: 8 }} /> Disparos</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}><Plus size={14} /> Novo Disparo</button>
      </div>

      {loading ? <div className="loading-container"><div className="spinner" /></div> : (
        <div className="table-card">
          <table>
            <thead><tr><th>Nome</th><th>Numero</th><th>Status</th><th className="right">Progresso</th><th className="right">Falhas</th><th className="right">Criado</th><th className="right">Acoes</th></tr></thead>
            <tbody>
              {broadcasts.map(b => {
                const st = STATUS_MAP[b.status] || { label: b.status, color: '#9B96B0' }
                const isPaused = !!b.paused_at
                const displayStatus = isPaused ? STATUS_MAP.paused : st
                const pct = b.total_count > 0 ? Math.round((b.sent_count + b.failed_count) / b.total_count * 100) : 0
                return (
                  <tr key={b.id}>
                    <td className="name">{b.name}</td>
                    <td style={{ fontSize: 11, color: '#9B96B0' }}>
                      {b.instance_name || '—'}
                      {b.instance_status && b.instance_status !== 'connected' && <span style={{ color: '#FF6B6B', marginLeft: 4 }}>⚠</span>}
                    </td>
                    <td>
                      <span className="stage-badge" style={{ background: `${displayStatus.color}20`, color: displayStatus.color }}>
                        {displayStatus.label}
                      </span>
                      {b.status === 'scheduled' && b.scheduled_at && (
                        <div style={{ fontSize: 10, color: '#FBBC04', marginTop: 2 }}>
                          📅 {parseSqlDate(b.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      )}
                    </td>
                    <td className="right" style={{ fontSize: 12 }}>
                      {b.status === 'completed'
                        ? <span style={{ color: '#34C759' }}>{b.sent_count}/{b.total_count}</span>
                        : <span>{b.sent_count + b.failed_count}/{b.total_count} ({pct}%)</span>}
                    </td>
                    <td className="right" style={{ color: b.failed_count > 0 ? '#FF6B6B' : undefined }}>{b.failed_count}</td>
                    <td className="right" style={{ fontSize: 11 }}>{parseSqlDate(b.created_at).toLocaleDateString('pt-BR')}</td>
                    <td className="right">
                      <div style={{ display: 'inline-flex', gap: 4 }}>
                        <button className="btn btn-secondary btn-sm btn-icon" onClick={() => navigate(`/messages/${b.id}`)} title="Ver detalhes"><Eye size={12} /></button>
                        <button className="btn btn-secondary btn-sm btn-icon" onClick={() => handleDuplicate(b.id)} disabled={duplicating} title="Duplicar disparo"><Copy size={12} /></button>
                        {b.status === 'draft' && <button className="btn btn-primary btn-sm" onClick={() => handleSend(b.id)} style={{ fontSize: 11 }}><Send size={11} /> Enviar</button>}
                        {b.status === 'scheduled' && <button className="btn btn-secondary btn-sm" onClick={() => handleCancelSchedule(b)} style={{ fontSize: 11 }} title="Cancelar agendamento (volta pra rascunho)">Cancelar</button>}
                        {b.status === 'completed' && <CheckCircle size={14} style={{ color: '#34C759' }} />}
                        {b.status === 'cancelled' && <XCircle size={14} style={{ color: '#FF6B6B' }} title="Cancelado" />}
                        {b.status === 'sending' && !isPaused && (
                          <>
                            <Clock size={14} style={{ color: '#5DADE2' }} className="spinning" />
                            <button className="btn btn-sm btn-icon" onClick={() => handlePause(b)}
                              style={{ background: 'rgba(251,188,4,0.15)', border: '1px solid rgba(251,188,4,0.4)', color: '#FBBC04' }}
                              title="Pausar disparo">
                              <Pause size={12} />
                            </button>
                            <button className="btn btn-sm btn-icon" onClick={() => handleCancel(b)}
                              style={{ background: 'rgba(255,107,107,0.15)', border: '1px solid rgba(255,107,107,0.4)', color: '#FF6B6B' }}
                              title="Parar disparo (cancela definitivamente)">
                              <Square size={12} />
                            </button>
                          </>
                        )}
                        {b.status === 'sending' && isPaused && (
                          <>
                            <PauseCircle size={14} style={{ color: '#FBBC04' }} />
                            <button className="btn btn-sm btn-icon" onClick={() => handleResume(b)}
                              style={{ background: 'rgba(52,199,89,0.15)', border: '1px solid rgba(52,199,89,0.4)', color: '#34C759' }}
                              title="Retomar disparo">
                              <Play size={12} />
                            </button>
                            <button className="btn btn-sm btn-icon" onClick={() => handleCancel(b)}
                              style={{ background: 'rgba(255,107,107,0.15)', border: '1px solid rgba(255,107,107,0.4)', color: '#FF6B6B' }}
                              title="Parar disparo (cancela definitivamente)">
                              <Square size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {broadcasts.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6B6580' }}>Nenhum disparo criado</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* New broadcast modal */}
      {showNew && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 620 }}>
            <h2>Novo Disparo — Etapa {step}/3</h2>

            {cloneNotice && (
              <div style={{ background: 'rgba(251,188,4,0.1)', border: '1px solid rgba(251,188,4,0.3)', borderRadius: 6, padding: 10, marginTop: 8, marginBottom: 8, fontSize: 12, color: '#FBBC04', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{cloneNotice}</span>
              </div>
            )}

            {step === 1 && (
              <>
                {/* Numero de saida (instancia) */}
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Smartphone size={12} /> Numero de saida do disparo
                  </label>
                  {instances.length === 0 && (
                    <div style={{ padding: 10, background: 'rgba(255,107,107,0.08)', borderRadius: 6, fontSize: 12, color: '#FF6B6B', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertTriangle size={14} /> Nenhuma instancia WhatsApp cadastrada. Cadastre uma em Integracoes antes de criar disparos.
                    </div>
                  )}
                  {instances.length === 1 && (
                    <div style={{ padding: 10, background: instances[0].status === 'connected' ? 'rgba(52,199,89,0.08)' : 'rgba(255,107,107,0.08)', borderRadius: 6, fontSize: 12, color: instances[0].status === 'connected' ? '#34C759' : '#FF6B6B', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Smartphone size={14} /> Disparando de <strong>{instances[0].instance_name}</strong>
                      {instances[0].status === 'connected' ? ' (conectado)' : ' — DESCONECTADO. Conecte antes de enviar.'}
                    </div>
                  )}
                  {instances.length > 1 && (
                    <select className="select" value={newInstanceId} onChange={e => setNewInstanceId(Number(e.target.value))} style={{ width: '100%' }}>
                      <option value="">Selecione um numero...</option>
                      {instances.map(i => (
                        <option key={i.id} value={i.id} disabled={i.status !== 'connected'}>
                          {i.instance_name} {i.status === 'connected' ? '✓ conectado' : '✗ desconectado'}
                        </option>
                      ))}
                    </select>
                  )}
                  {instances.length > 1 && newInstanceId && instances.find(i => i.id === newInstanceId)?.status !== 'connected' && (
                    <div style={{ fontSize: 11, color: '#FF6B6B', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangle size={11} /> Esta instancia nao esta conectada. Voce pode criar como rascunho mas o envio sera bloqueado.
                    </div>
                  )}
                </div>

                <div className="form-group"><label>Nome do disparo</label><input className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ex: Promo Marco 2026" /></div>
                <div className="form-group">
                  <label>Mensagem principal {mediaBase64 && <span style={{ fontSize: 11, color: '#FBBC04', marginLeft: 6 }}>(vira legenda do anexo)</span>}</label>
                  <textarea className="input" rows={5} value={newTemplate} onChange={e => setNewTemplate(e.target.value)} placeholder="Ola {{nome}}, temos uma oferta especial... (pode usar quebras de linha com Enter)" />
                  <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>
                    Variaveis disponiveis: <code style={{ color: '#FFB300' }}>{'{{nome}}'}</code> <code style={{ color: '#FFB300' }}>{'{{primeiro_nome}}'}</code> <code style={{ color: '#FFB300' }}>{'{{empresa}}'}</code> <code style={{ color: '#FFB300' }}>{'{{cidade}}'}</code> <code style={{ color: '#FFB300' }}>{'{{telefone}}'}</code>
                  </div>
                </div>

                {/* Anexo (imagem, video ou PDF) */}
                <div className="form-group" style={{ marginTop: 8 }}>
                  <label>Anexo (opcional)</label>
                  {!mediaBase64 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                        <Paperclip size={14} /> Anexar imagem, video ou PDF
                        <input type="file" accept="image/*,video/*,application/pdf" onChange={handleFileSelect} style={{ display: 'none' }} />
                      </label>
                      <span style={{ fontSize: 11, color: '#9B96B0' }}>imagem ate 5MB · video ate 16MB</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 10, background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)' }}>
                      {mediaMime.startsWith('image/') ? (
                        <img src={mediaPreviewUrl} alt="preview" style={{ maxWidth: 120, maxHeight: 120, borderRadius: 6, objectFit: 'cover' }} />
                      ) : mediaMime.startsWith('video/') ? (
                        <video src={mediaPreviewUrl} style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6 }} controls />
                      ) : (
                        <div style={{ width: 80, height: 80, background: '#2a2a3e', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>📄</div>
                      )}
                      <div style={{ flex: 1, fontSize: 12 }}>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>{mediaFilename}</div>
                        <div style={{ color: '#9B96B0' }}>{mediaMime}</div>
                        <div style={{ color: '#9B96B0', marginTop: 2 }}>
                          ~{Math.round((mediaBase64.length * 0.75) / 1024)} KB
                        </div>
                      </div>
                      <button className="btn btn-danger btn-sm btn-icon" onClick={clearMedia} title="Remover anexo"><X size={14} /></button>
                    </div>
                  )}
                  {mediaError && <div style={{ fontSize: 11, color: '#FF6B6B', marginTop: 4 }}>{mediaError}</div>}
                </div>

                {/* Variacoes — minimo MIN_VARIATIONS - 1 = 2 */}
                <div className="form-group" style={{ marginTop: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    Variacoes da mensagem (minimo {MIN_VARIATIONS - 1})
                    {enoughVariations && <CheckCircle size={12} style={{ color: '#34C759' }} />}
                  </label>
                  <div style={{ fontSize: 11, color: '#9B96B0', marginBottom: 6 }}>
                    Sistema rotaciona entre principal + variacoes pra parecer humano. Quanto mais variacao, menor o risco de bloqueio.
                  </div>
                  {newVariations.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                      <textarea className="input" rows={2} value={v} onChange={e => setNewVariations(prev => prev.map((x, j) => j === i ? e.target.value : x))} placeholder={`Variacao ${i + 2}... (reescreva a msg principal de outro jeito)`} style={{ flex: 1 }} />
                      <button className="btn btn-danger btn-sm btn-icon" onClick={() => setNewVariations(prev => prev.filter((_, j) => j !== i))} style={{ alignSelf: 'flex-start', marginTop: 4 }}><Trash2 size={12} /></button>
                    </div>
                  ))}
                  <button className="btn btn-secondary btn-sm" onClick={() => setNewVariations(prev => [...prev, ''])} style={{ marginTop: 4 }}>
                    <Plus size={12} /> Adicionar variacao
                  </button>
                  <div style={{ fontSize: 11, color: enoughVariations ? '#34C759' : '#FF6B6B', marginTop: 4, fontWeight: 500 }}>
                    Total: {totalMessagesCount}/{MIN_VARIATIONS} mensagens diferentes {enoughVariations ? '✓' : `— faltam ${MIN_VARIATIONS - totalMessagesCount}`}
                  </div>
                </div>

                {/* Delay */}
                <div className="form-group" style={{ marginTop: 8 }}>
                  <label>Delay entre envios (segundos)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="number" className="input" value={newDelay} onChange={e => setNewDelay(parseInt(e.target.value) || DEFAULT_DELAY)} min={MIN_DELAY} max={120} style={{ width: 90 }} />
                    <span style={{ fontSize: 11, color: validDelay ? '#9B96B0' : '#FF6B6B' }}>
                      segundos · sistema aplica variacao aleatoria ±30% pra parecer humano
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#FBBC04', marginTop: 4 }}>
                    💡 Recomendado: <strong>15-30s</strong>. Minimo {MIN_DELAY}s. Valores baixos = ban no WhatsApp.
                  </div>
                </div>

                {newTemplate && (
                  <div style={{ marginTop: 8, padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 12 }}>
                    <div style={{ color: '#9B96B0', marginBottom: 4 }}>Preview (msg principal):</div>
                    {mediaPreviewUrl && mediaMime.startsWith('image/') && (
                      <img src={mediaPreviewUrl} alt="preview" style={{ display: 'block', maxWidth: 220, maxHeight: 180, borderRadius: 6, marginBottom: 8 }} />
                    )}
                    <div style={{ whiteSpace: 'pre-wrap' }}>
                      {newTemplate
                        .replace(/\{\{nome\}\}/g, 'Joao Silva')
                        .replace(/\{\{name\}\}/g, 'Joao Silva')
                        .replace(/\{\{primeiro_nome\}\}/g, 'Joao')
                        .replace(/\{\{first_name\}\}/g, 'Joao')
                        .replace(/\{\{empresa\}\}/g, 'Empresa X')
                        .replace(/\{\{cidade\}\}/g, 'Sua Cidade')
                        .replace(/\{\{telefone\}\}/g, '(48) 99999-0000')
                        .replace(/\{\{phone\}\}/g, '(48) 99999-0000')}
                    </div>
                  </div>
                )}

                {/* Agendamento */}
                <div className="form-group" style={{ marginTop: 12, padding: 12, background: scheduleEnabled ? 'rgba(255,179,0,0.05)' : 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,179,0,0.15)', borderRadius: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />
                    <span style={{ fontWeight: 600 }}>📅 Agendar disparo pra data/hora futura</span>
                  </label>
                  {scheduleEnabled && (
                    <div style={{ marginTop: 8 }}>
                      <input
                        type="datetime-local"
                        className="input"
                        value={scheduledAt}
                        onChange={e => setScheduledAt(e.target.value)}
                        min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                        style={{ width: 240 }}
                      />
                      <p style={{ fontSize: 11, color: validSchedule ? '#9B96B0' : '#FF6B6B', marginTop: 4 }}>
                        {validSchedule
                          ? 'Horario local do seu navegador. Disparo inicia automaticamente.'
                          : 'Escolha uma data/hora pelo menos 1 minuto no futuro.'}
                      </p>
                    </div>
                  )}
                </div>

                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={resetForm}>Cancelar</button>
                  <button className="btn btn-primary" onClick={() => setStep(2)} disabled={!newName || !newTemplate || !enoughVariations || !validDelay || !newInstanceId || (scheduleEnabled && !validSchedule)}>Proximo</button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                {/* Tags como chips multi-select */}
                {tags.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: '#9B96B0', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                      <TagIcon size={11} /> Filtrar por tag {filterTags.length > 0 && <span style={{ color: '#FFB300' }}>({filterTags.length} ativa{filterTags.length > 1 ? 's' : ''})</span>}
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {tags.map(t => {
                        const active = filterTags.includes(t.id)
                        return (
                          <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
                            style={{
                              padding: '4px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
                              border: `1px solid ${active ? (t.color || '#FFB300') : 'rgba(255,255,255,0.1)'}`,
                              background: active ? `${t.color || '#FFB300'}25` : 'rgba(255,255,255,0.03)',
                              color: active ? (t.color || '#FFB300') : '#9B96B0',
                              fontWeight: active ? 600 : 400,
                            }}>
                            {active ? '✓ ' : ''}{t.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Etapas como chips multi-select, agrupadas por funil */}
                {funnels.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: '#9B96B0', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                      <GitBranch size={11} /> Filtrar por etapa {filterStages.length > 0 && <span style={{ color: '#FFB300' }}>({filterStages.length} ativa{filterStages.length > 1 ? 's' : ''})</span>}
                    </label>
                    {funnels.map(f => (
                      <div key={f.id} style={{ marginBottom: 6 }}>
                        {funnels.length > 1 && <div style={{ fontSize: 10, color: '#6B6580', marginBottom: 3 }}>{f.name}</div>}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {(f.stages || []).map(s => {
                            const active = filterStages.includes(s.id)
                            return (
                              <button key={s.id} type="button" onClick={() => toggleStage(s.id)}
                                style={{
                                  padding: '4px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
                                  border: `1px solid ${active ? (s.color || '#FFB300') : 'rgba(255,255,255,0.1)'}`,
                                  background: active ? `${s.color || '#FFB300'}25` : 'rgba(255,255,255,0.03)',
                                  color: active ? (s.color || '#FFB300') : '#9B96B0',
                                  fontWeight: active ? 600 : 400,
                                }}>
                                {active ? '✓ ' : ''}{s.name}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Atendentes como chips multi-select */}
                {users.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: '#9B96B0', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                      <UserCog size={11} /> Filtrar por atendente {filterAttendants.length > 0 && <span style={{ color: '#FFB300' }}>({filterAttendants.length} ativo{filterAttendants.length > 1 ? 's' : ''})</span>}
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {users.map(u => {
                        const active = filterAttendants.includes(u.id)
                        const isBot = u.is_bot === 1
                        const color = isBot ? '#9B6DFF' : u.role === 'gerente' ? '#FFB300' : '#34C759'
                        return (
                          <button key={u.id} type="button" onClick={() => toggleAttendant(u.id)}
                            style={{
                              padding: '4px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
                              border: `1px solid ${active ? color : 'rgba(255,255,255,0.1)'}`,
                              background: active ? `${color}25` : 'rgba(255,255,255,0.03)',
                              color: active ? color : '#9B96B0',
                              fontWeight: active ? 600 : 400,
                            }}>
                            {active ? '✓ ' : ''}{isBot ? '🤖 ' : ''}{u.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Fontes como chips multi-select */}
                {sources.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: '#9B96B0', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                      <TagIcon size={11} /> Filtrar por fonte {filterSources.length > 0 && <span style={{ color: '#FFB300' }}>({filterSources.length} ativa{filterSources.length > 1 ? 's' : ''})</span>}
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {sources.map(s => {
                        const active = filterSources.includes(s)
                        return (
                          <button key={s} type="button" onClick={() => toggleSource(s)}
                            style={{
                              padding: '4px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
                              border: `1px solid ${active ? '#60E5EA' : 'rgba(255,255,255,0.1)'}`,
                              background: active ? 'rgba(96,229,234,0.15)' : 'rgba(255,255,255,0.03)',
                              color: active ? '#60E5EA' : '#9B96B0',
                              fontWeight: active ? 600 : 400,
                            }}>
                            {active ? '✓ ' : ''}{s}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {(filterTags.length > 0 || filterStages.length > 0 || filterAttendants.length > 0 || filterSources.length > 0) && (
                  <button className="btn btn-secondary btn-sm" onClick={() => { setFilterTags([]); setFilterStages([]); setFilterAttendants([]); setFilterSources([]) }} style={{ fontSize: 10, marginBottom: 8 }}>
                    <Filter size={10} /> Limpar filtros
                  </button>
                )}

                <div className="form-group">
                  <label>Buscar leads (apenas com telefone)</label>
                  <input className="input" value={leadSearch} onChange={e => setLeadSearch(e.target.value)} placeholder="Buscar por nome, telefone... (ou use os filtros acima)" />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0' }}>
                  <span style={{ fontSize: 12, color: '#9B96B0' }}>
                    <strong style={{ color: '#FFB300' }}>{selectedLeads.length} selecionados</strong>
                    {searchResults.length > 0 && ` · ${searchResults.length} no filtro atual`}
                  </span>
                  {searchResults.length > 0 && <button className="btn btn-primary btn-sm" onClick={selectAll}>Adicionar todos do filtro ({searchResults.filter(l => !selectedLeads.some(s => s.id === l.id)).length})</button>}
                </div>
                <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {searchResults.map(l => (
                    <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, background: selectedLeads.some(s => s.id === l.id) ? 'rgba(255,179,0,0.08)' : 'transparent', cursor: 'pointer', fontSize: 12 }}>
                      <input type="checkbox" checked={selectedLeads.some(s => s.id === l.id)} onChange={() => toggleLead(l)} />
                      <span style={{ fontWeight: 500 }}>{l.name || 'Sem nome'}</span>
                      <span style={{ color: '#9B96B0' }}>{l.phone}</span>
                      {l.stage_name && <span style={{ fontSize: 10, color: l.stage_color || '#FFB300', marginLeft: 'auto' }}>{l.stage_name}</span>}
                    </label>
                  ))}
                  {searchResults.length === 0 && (leadSearch.length > 1 || filterTags.length > 0 || filterStages.length > 0 || filterAttendants.length > 0 || filterSources.length > 0) && <div style={{ padding: 20, textAlign: 'center', color: '#6B6580' }}>Nenhum lead encontrado neste filtro</div>}
                  {searchResults.length === 0 && leadSearch.length <= 1 && filterTags.length === 0 && filterStages.length === 0 && filterAttendants.length === 0 && filterSources.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: '#6B6580' }}>Selecione tags, etapas, atendentes, fontes, ou digite pra buscar...</div>}
                </div>
                {selectedLeads.length > 0 && (
                  <div style={{ marginTop: 6, padding: '6px 10px', background: 'rgba(255,179,0,0.05)', borderRadius: 6, fontSize: 11, color: '#9B96B0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Total acumulado: <strong style={{ color: '#FFB300' }}>{selectedLeads.length} leads</strong></span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setShowSelectedList(v => !v)} style={{ fontSize: 10, padding: '2px 8px' }}>
                          {showSelectedList ? 'Ocultar lista' : `Ver selecionados (${selectedLeads.length})`}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setSelectedLeads([])} style={{ fontSize: 10, padding: '2px 8px' }}>Limpar selecao</button>
                      </div>
                    </div>
                    {showSelectedList && (
                      <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                        {selectedLeads.map(l => (
                          <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 4, fontSize: 11, color: '#C8C2D8' }}>
                            <span style={{ fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || 'Sem nome'}</span>
                            <span style={{ color: '#9B96B0' }}>{l.phone}</span>
                            <button onClick={() => toggleLead(l)} title="Remover" style={{ background: 'transparent', border: 'none', color: '#FF6B6B', cursor: 'pointer', padding: 2, display: 'flex' }}>
                              <Trash2 size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setStep(1)}>Voltar</button>
                  <button className="btn btn-primary" onClick={() => setStep(3)} disabled={selectedLeads.length === 0}>Proximo ({selectedLeads.length} leads)</button>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="card" style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#9B96B0', marginBottom: 8 }}>Resumo</div>
                  <div style={{ fontSize: 13 }}><strong>Nome:</strong> {newName}</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}><strong>Numero de saida:</strong> {instances.find(i => i.id === newInstanceId)?.instance_name || '—'}</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}><strong>Destinatarios:</strong> {selectedLeads.length} leads</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}><strong>Mensagens diferentes:</strong> {totalMessagesCount} (rotacionadas)</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}><strong>Delay entre envios:</strong> ~{newDelay}s (variacao ±30%)</div>
                  {scheduleEnabled && scheduledAt && (
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      <strong>📅 Agendado pra:</strong> {new Date(scheduledAt).toLocaleString('pt-BR')}
                    </div>
                  )}
                </div>

                <div style={{ padding: 12, background: 'rgba(91,173,226,0.08)', borderRadius: 8, fontSize: 12, color: '#5DADE2', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Clock size={14} /> Tempo estimado de envio: <strong>~{estimatedDuration}</strong> ({selectedLeads.length} × {newDelay}s)
                </div>

                <div style={{ padding: 10, background: 'rgba(255,179,0,0.08)', borderRadius: 8, fontSize: 12, color: '#FFB300' }}>
                  {scheduleEnabled
                    ? 'Disparo criado como agendado. Vai iniciar automaticamente na data/hora escolhida.'
                    : 'Disparo criado como rascunho. Voce envia depois clicando no botao "Enviar".'}
                </div>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setStep(2)}>Voltar</button>
                  <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>{creating ? 'Criando...' : (scheduleEnabled ? 'Agendar Disparo' : 'Criar Disparo')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
