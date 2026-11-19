import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useAccount } from '../context/AccountContext'
import { useSSE } from '../context/SSEContext'
import {
  fetchWhatsAppInstances, fetchLeads, fetchLead, fetchFunnels, fetchUsers, fetchTags,
  sendMessage, sendMessageMedia, updateLead, moveLeadStage, assignLead, addLeadNote, addLeadTag, removeLeadTag,
  fetchLeadCadence, advanceLeadCadence, removeLeadCadence, fetchCadences, assignLeadCadence, createTag,
  fetchAvailableGlobalTemplates, applyGlobalCadenceHere, applyGlobalFollowUpHere,
  type GlobalTemplateAvailable, type GlobalFollowUpAvailable,
  fetchLeadFollowUp, fetchFollowUps, assignFollowUp, pauseLeadFollowUp, resumeLeadFollowUp, cancelLeadFollowUp,
  archiveLead, blockLead, createStandaloneTask, fetchLeadTasks, completeStandaloneTask, deleteStandaloneTask, completeTask, skipTask, fetchLeadConversations, forceAiRespond, type LeadConversation,
  fetchReadyMessages, type ReadyMessage,
  createLeadOrFindExisting, markLeadAsRead,
  requestLeadTransfer, acceptTransferRequest, rejectTransferRequest, fetchPendingTransferRequests, grabLead, type TransferRequest,
  type WhatsAppInstance, type Lead, type Message, type StageHistoryEntry, type LeadNote,
  type Funnel, type User as UserType, type Tag, type LeadCadence, type Cadence, type LeadFollowUp, type FollowUp,
} from '../lib/api'
import EditTaskModal from '../components/EditTaskModal'
import FilterDropdown, { type FilterValue } from '../components/FilterDropdown'
import {
  MessageCircle, Search, Send, Phone, PhoneMissed, Video, User, Edit3, Save, X, Plus,
  StickyNote, Tag as TagIcon, GitBranch, Smartphone, ListOrdered, ChevronRight, Check, Clock, Archive, Ban, ListTodo, ChevronDown, ChevronUp, Trash2, Paperclip, FileText, MessageSquarePlus, Copy, Zap, Pause, Play, Bot, MapPin, Users as UsersIcon,
  Menu as MenuIcon, MessagesSquare, Info as InfoIcon, History as HistoryIcon, ChevronLeft,
} from 'lucide-react'
import MessageMedia from '../components/MessageMedia'
import AudioRecorder from '../components/AudioRecorder'
import { BlockedBanner } from '../components/BlockedBanner'
import { applyMessageVars } from '../lib/messageVars'
import { parseSqlDate, formatTime, formatDayLabel, localDayKey } from '../lib/dates'
import { useIsMobile } from '../hooks/useIsMobile'

function timeAgo(dateStr: string) {
  const diff = Date.now() - parseSqlDate(dateStr).getTime()
  const mins = Math.max(0, Math.floor(diff / 60000))
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export default function Chat() {
  const { user } = useAuth()
  const { accountId, accounts } = useAccount()

  // Filtros persistentes via URL (ao voltar do lead ou refresh, filtros mantem).
  const [searchParams, setSearchParams] = useSearchParams()
  const parseFilterList = (str: string | null): FilterValue[] => {
    if (!str) return []
    return str.split(',').filter(Boolean).map(v => (v === 'untagged' || v === 'none') ? v : parseInt(v))
  }
  const setUrlParam = (key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value); else next.delete(key)
      return next
    }, { replace: true })
  }

  const [instances, setInstances] = useState<WhatsAppInstance[]>([])
  const instanceFilter = useMemo(() => parseFilterList(searchParams.get('inst')), [searchParams])
  const setInstanceFilter = (vals: FilterValue[]) => setUrlParam('inst', vals.join(','))
  const anuncioFilter = (searchParams.get('anuncio') || 'todos') as 'todos' | 'sim' | 'nao'
  const setAnuncioFilter = (v: 'todos' | 'sim' | 'nao') => setUrlParam('anuncio', v === 'todos' ? '' : v)
  const [leads, setLeads] = useState<Lead[]>([])
  const selectedLeadId = searchParams.get('lead') ? parseInt(searchParams.get('lead')!) : null
  const setSelectedLeadId = (id: number | null) => setUrlParam('lead', id ? String(id) : '')
  const [showNewChat, setShowNewChat] = useState(false)
  const [newChatName, setNewChatName] = useState('')
  const [newChatPhone, setNewChatPhone] = useState('')
  const [newChatInstanceId, setNewChatInstanceId] = useState<number | null>(null)
  const [creatingNewChat, setCreatingNewChat] = useState(false)
  type NoticeAction = { label: string; onClick: () => void; primary?: boolean; danger?: boolean }
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; title: string; message: string; actions?: NoticeAction[] } | null>(null)
  const [pendingTransfers, setPendingTransfers] = useState<TransferRequest[]>([])

  // Mobile single-pane com bottom nav de 5 tabs
  const isMobile = useIsMobile()
  const [mobileTab, setMobileTab] = useState<'conversas' | 'chat' | 'info' | 'history'>('conversas')
  // Quando seleciona lead em mobile, auto-vai pra tab Chat (UX igual WhatsApp)
  const selectLead = (id: number | null) => {
    setSelectedLeadId(id)
    if (isMobile && id !== null) setMobileTab('chat')
    // Auto mark-as-read otimista: zera badge local + chama API em bg. Outras abas recebem via SSE 'lead:read'.
    // SUPER_ADMIN nao marca como lido — ele audita conversas sem afetar o atendimento do cliente.
    if (id !== null && user?.role !== 'super_admin') {
      const target = leads.find(l => l.id === id)
      if (target && (target.unread_count || 0) > 0) {
        setLeads(prev => prev.map(l => l.id === id ? { ...l, unread_count: 0 } : l))
        markLeadAsRead(id).catch(() => {/* silencioso — re-tentava no proximo click */})
      }
    }
  }
  // Quando vai pra Info/Historico via bottom nav, sincroniza com a rightTab interna
  const switchMobileTab = (tab: 'conversas' | 'chat' | 'info' | 'history') => {
    setMobileTab(tab)
    if (tab === 'info') setRightTab('info')
    if (tab === 'history') setRightTab('history')
  }
  // Pra "Menu" abrir a sidebar — reusa o hamburger button da Sidebar via custom event
  const openSidebarMenu = () => {
    const btn = document.querySelector('.hamburger-btn') as HTMLButtonElement | null
    if (btn) btn.click()
  }
  const [lead, setLead] = useState<Lead | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [history, setHistory] = useState<StageHistoryEntry[]>([])
  const [notes, setNotes] = useState<LeadNote[]>([])
  const [funnels, setFunnels] = useState<Funnel[]>([])
  const [users, setUsers] = useState<UserType[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [leadCadence, setLeadCadence] = useState<LeadCadence | null>(null)
  const [cadences, setCadences] = useState<Cadence[]>([])
  const [globalCadences, setGlobalCadences] = useState<GlobalTemplateAvailable[]>([])
  const [globalFollowUps, setGlobalFollowUps] = useState<GlobalFollowUpAvailable[]>([])
  const [applyingGlobalId, setApplyingGlobalId] = useState<number | null>(null)
  const [applyingGlobalFuId, setApplyingGlobalFuId] = useState<number | null>(null)
  const [showCadenceMenu, setShowCadenceMenu] = useState(false)
  const [leadFollowUp, setLeadFollowUp] = useState<LeadFollowUp | null>(null)
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [showFollowUpMenu, setShowFollowUpMenu] = useState(false)
  const search = searchParams.get('q') || ''
  const setSearch = (v: string) => setUrlParam('q', v)
  const tagFilter = useMemo(() => parseFilterList(searchParams.get('tags')), [searchParams])
  const setTagFilter = (vals: FilterValue[]) => setUrlParam('tags', vals.join(','))
  const attendantFilter = useMemo(() => parseFilterList(searchParams.get('att')), [searchParams])
  const setAttendantFilter = (vals: FilterValue[]) => setUrlParam('att', vals.join(','))
  const stageFilter = useMemo(() => parseFilterList(searchParams.get('stage')), [searchParams])
  const setStageFilter = (vals: FilterValue[]) => setUrlParam('stage', vals.join(','))
  const showArchived = searchParams.get('archived') === '1'
  const setShowArchived = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(showArchived) : v
    setUrlParam('archived', next ? '1' : '')
  }
  const [msgText, setMsgText] = useState('')
  const [readyMessages, setReadyMessages] = useState<ReadyMessage[]>([])
  const [showReadyMsgs, setShowReadyMsgs] = useState(false)
  const [readyMsgFilter, setReadyMsgFilter] = useState('')
  const [readyMsgIdx, setReadyMsgIdx] = useState(0)
  const readyMsgsContainerRef = useRef<HTMLDivElement>(null)
  const msgInputRef = useRef<HTMLInputElement>(null)
  const [noteText, setNoteText] = useState('')
  const [sending, setSending] = useState(false)
  const [attachFile, setAttachFile] = useState<File | null>(null)
  const [attachCaption, setAttachCaption] = useState('')
  const [attachPreview, setAttachPreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [editing, setEditing] = useState(false)
  const [infoCollapsed, setInfoCollapsed] = useState(() => localStorage.getItem('chat_info_collapsed') !== '0')
  const [notesCollapsed, setNotesCollapsed] = useState(() => localStorage.getItem('chat_notes_collapsed') === '1')
  const [tagsCollapsed, setTagsCollapsed] = useState(() => localStorage.getItem('chat_tags_collapsed') === '1')
  const [cadenceCollapsed, setCadenceCollapsed] = useState(() => localStorage.getItem('chat_cadence_collapsed') === '1')
  const [leadTasks, setLeadTasks] = useState<any[]>([])
  const [editingTask, setEditingTask] = useState<any>(null)
  const [sendInstanceOverride, setSendInstanceOverride] = useState<number | null>(null)
  const [showSendInstance, setShowSendInstance] = useState(false)
  const [conversations, setConversations] = useState<LeadConversation[]>([])
  const [activeConvInstance, setActiveConvInstance] = useState<number | null>(null)
  const [editData, setEditData] = useState<Record<string, any>>({ name: '', phone: '', email: '', city: '' })
  const [rightTab, setRightTab] = useState<'info' | 'notes' | 'history'>('info')
  const [showTagMenu, setShowTagMenu] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#FFB300')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskMode, setTaskMode] = useState<'date' | 'duration'>('duration')
  const [taskMinutes, setTaskMinutes] = useState('10')
  const [taskDate, setTaskDate] = useState('')
  const [taskTime, setTaskTime] = useState('')
  const [creatingTask, setCreatingTask] = useState(false)
  const [cadenceMsgText, setCadenceMsgText] = useState('')
  const [scriptModal, setScriptModal] = useState<{ text: string } | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Load instances + globals
  useEffect(() => {
    if (!accountId) return
    fetchWhatsAppInstances(accountId).then(setInstances)
    fetchFunnels(accountId).then(setFunnels)
    fetchUsers(accountId).then(setUsers)
    fetchTags(accountId).then(setTags)
    fetchCadences(accountId).then(setCadences)
    fetchAvailableGlobalTemplates(accountId).then(d => { setGlobalCadences(d.cadences); setGlobalFollowUps(d.follow_ups) }).catch(() => {})
    fetchFollowUps(accountId).then(setFollowUps).catch(() => {})
    fetchReadyMessages(accountId).then(setReadyMessages).catch(() => {})
  }, [accountId])

  // Lista filtrada de mensagens prontas (filtra por filter + ordena por stage_id do lead atual)
  const filteredReadyMsgs = useMemo(() => {
    const term = readyMsgFilter.toLowerCase().trim()
    let list = readyMessages.filter(m => m.is_active)
    if (term) list = list.filter(m => m.title.toLowerCase().includes(term))
    const currentStage = lead?.stage_id
    list = [...list].sort((a, b) => {
      const aStage = a.stage_id === currentStage ? 0 : (a.stage_id ? 2 : 1)
      const bStage = b.stage_id === currentStage ? 0 : (b.stage_id ? 2 : 1)
      return aStage - bStage
    })
    return list.slice(0, 10)
  }, [readyMessages, readyMsgFilter, lead?.stage_id])

  // Fecha popup ao clicar fora
  useEffect(() => {
    if (!showReadyMsgs) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!readyMsgsContainerRef.current?.contains(target)) {
        setShowReadyMsgs(false); setReadyMsgFilter('')
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showReadyMsgs])

  const selectReadyMsg = (m: ReadyMessage) => {
    const filled = applyMessageVars(m.content, {
      leadName: lead?.name,
      leadEmpresa: lead?.empresa,
      leadCity: lead?.city,
      attendantName: user?.name,
    })
    setMsgText(filled)
    setShowReadyMsgs(false)
    setReadyMsgFilter('')
    setTimeout(() => msgInputRef.current?.focus(), 0)
  }

  // FASE 3 PERFORMANCE — search server-side com debounce 300ms.
  // Em conta com 1500+ leads, search client-side era latente e nao achava leads
  // alem do limit. Agora server-side + indice idx_leads_account_updated_desc.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Load leads list — limit reduzido de 500 pra 100 (suficiente pra lista lateral ativa).
  // Quem busca leads especificos usa o campo "Buscar contato" (server-side com debounce).
  const loadLeadsList = useCallback(() => {
    if (!accountId) return
    const filters: any = { limit: 100 }
    if (showArchived) filters.show_archived = '1'
    if (debouncedSearch.length >= 2) filters.search = debouncedSearch

    const toCsv = (arr: FilterValue[]) => arr.filter(v => typeof v === 'number' || v === 'none' || v === 'untagged').join(',')
    const stageCsv = toCsv(stageFilter)
    if (stageCsv) filters.stage_id = stageCsv
    const tagCsv = toCsv(tagFilter)
    if (tagCsv) filters.tag = tagCsv
    const attCsv = toCsv(attendantFilter)
    if (attCsv) filters.attendant_id = attCsv
    const instCsv = toCsv(instanceFilter)
    if (instCsv) filters.instance_id = instCsv
    if (anuncioFilter !== 'todos') filters.anuncio = anuncioFilter

    fetchLeads(accountId, filters).then(data => setLeads(data.leads))
  }, [accountId, instanceFilter, tagFilter, stageFilter, attendantFilter, showArchived, debouncedSearch, anuncioFilter])
  useEffect(() => { loadLeadsList() }, [loadLeadsList])

  // Race token: cada chamada de loadLead recebe um id incremental.
  // Resposta de fetch so eh aplicada se ainda for a chamada "atual" — descarta
  // respostas obsoletas quando user troca de lead rapido.
  const loadLeadTokenRef = useRef(0)
  // Loading flag: true enquanto o lead esta sendo carregado (UI mostra "..." no atendente)
  const [leadLoading, setLeadLoading] = useState(false)

  // Load selected lead detail
  const loadLead = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!selectedLeadId || !accountId) {
      setLead(null); setMessages([]); setLeadTasks([]); setConversations([])
      setActiveConvInstance(null); setLeadLoading(false)
      return
    }
    // 1. Limpa estado do lead anterior IMEDIATAMENTE pra UI nao mostrar dados stale.
    //    Silent=true pula o reset (refresh fluido pra mesma lead — SSE, otimismo, etc).
    if (!opts.silent) {
      setLead(null); setMessages([]); setLeadCadence(null); setLeadFollowUp(null); setLeadTasks([]); setConversations([])
      setLeadLoading(true)
    }
    // 2. Race token pra descartar respostas obsoletas se user trocar de lead rapido
    const myToken = ++loadLeadTokenRef.current
    const reqLeadId = selectedLeadId
    try {
      const data = await fetchLead(reqLeadId, accountId)
      if (myToken !== loadLeadTokenRef.current) return  // outra chamada mais recente — descarta
      setLead(data.lead)
      setMessages(data.messages)
      setHistory(data.stageHistory)
      setNotes(data.notes || [])
      fetchLeadTasks(reqLeadId, accountId).then(r => { if (myToken === loadLeadTokenRef.current) setLeadTasks(r) }).catch(() => {})
      fetchLeadConversations(reqLeadId, accountId).then(convs => {
        if (myToken !== loadLeadTokenRef.current) return
        setConversations(convs)
        if (convs.length > 0) {
          const last = data.lead.last_instance_id && convs.find(c => c.instance_id === data.lead.last_instance_id)
          setActiveConvInstance(last ? last.instance_id : convs[0].instance_id)
        } else setActiveConvInstance(null)
      }).catch(() => {
        if (myToken === loadLeadTokenRef.current) { setConversations([]); setActiveConvInstance(null) }
      })
      setEditData({ name: data.lead.name || '', phone: data.lead.phone || '', email: data.lead.email || '', city: data.lead.city || '', empresa: data.lead.empresa || '', cpf_cnpj: data.lead.cpf_cnpj || '', instagram: data.lead.instagram || '', trabalha_anuncio: data.lead.trabalha_anuncio || 0, investimento_anuncios: data.lead.investimento_anuncios || '' })
      try {
        const lc = await fetchLeadCadence(reqLeadId, accountId)
        if (myToken !== loadLeadTokenRef.current) return
        setLeadCadence(lc)
        if (lc?.attempt_message) {
          setCadenceMsgText(applyMessageVars(lc.attempt_message, {
            leadName: data.lead.name,
            leadEmpresa: data.lead.empresa,
            leadCity: data.lead.city,
            attendantName: user?.name,
          }))
        } else setCadenceMsgText('')
      } catch { if (myToken === loadLeadTokenRef.current) { setLeadCadence(null); setCadenceMsgText('') } }
      try {
        const lfu = await fetchLeadFollowUp(reqLeadId, accountId)
        if (myToken === loadLeadTokenRef.current) setLeadFollowUp(lfu)
      } catch { if (myToken === loadLeadTokenRef.current) setLeadFollowUp(null) }
    } finally {
      if (myToken === loadLeadTokenRef.current) setLeadLoading(false)
    }
  }, [selectedLeadId, accountId])
  useEffect(() => { loadLead() }, [loadLead])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // SSE: new messages / leads
  useSSE('lead:message', useCallback((data: any) => {
    if (data.leadId === selectedLeadId) loadLead({ silent: true })
    loadLeadsList()
  }, [selectedLeadId, loadLead, loadLeadsList]))
  useSSE('lead:created', useCallback(() => loadLeadsList(), [loadLeadsList]))
  useSSE('lead:updated', useCallback((data: any) => {
    if (data.id === selectedLeadId) loadLead({ silent: true })
    loadLeadsList()
  }, [selectedLeadId, loadLead, loadLeadsList]))
  useSSE('lead:archived', useCallback((data: { id: number }) => {
    setLeads(prev => prev.filter(l => l.id !== data.id))
    if (selectedLeadId === data.id) setSelectedLeadId(null)
  }, [selectedLeadId]))
  // Novo: outro tab/atendente abriu o lead → badge some pra todos
  useSSE('lead:read', useCallback((data: { lead_id: number; unread_count: number }) => {
    setLeads(prev => prev.map(l => l.id === data.lead_id ? { ...l, unread_count: data.unread_count } : l))
  }, []))
  // Novo: status WhatsApp da msg outbound atualizou (delivered/read)
  useSSE('message:status', useCallback((data: { message_id: number; lead_id: number; status: 'sent' | 'delivered' | 'read' }) => {
    if (data.lead_id === selectedLeadId) {
      setMessages(prev => prev.map(m => m.id === data.message_id ? { ...m, delivery_status: data.status } : m))
    }
  }, [selectedLeadId]))
  useSSE('lead:unarchived', useCallback(() => loadLeadsList(), [loadLeadsList]))
  // Ao voltar pra aba, forca refetch da lista + do lead aberto (SSE pode ter perdido eventos enquanto suspenso)
  useSSE('leads:resync', useCallback(() => {
    loadLeadsList()
    if (selectedLeadId) loadLead({ silent: true })
  }, [loadLeadsList, loadLead, selectedLeadId]))

  // Pedido de transferencia recebido — filtra por mim e mostra modal de aceite
  useSSE('lead:transfer-requested', useCallback((data: TransferRequest) => {
    if (!user || data.to_attendant_id !== user.id) return
    setPendingTransfers(prev => prev.some(p => p.id === data.id) ? prev : [data, ...prev])
    setNotice({
      kind: 'info',
      title: 'Pedido de transferencia',
      message: `${data.from_attendant_name || 'Um atendente'} quer atender o lead ${data.lead_name || data.lead_phone || '?'}. Aceitar?`,
      actions: [
        {
          label: 'Rejeitar',
          danger: true,
          onClick: async () => {
            try { await rejectTransferRequest(data.id); setPendingTransfers(prev => prev.filter(p => p.id !== data.id)) }
            catch (e: any) { setNotice({ kind: 'error', title: 'Erro', message: e?.message || 'Falha ao rejeitar' }) }
          },
        },
        {
          label: 'Aceitar',
          primary: true,
          onClick: async () => {
            try {
              await acceptTransferRequest(data.id)
              setPendingTransfers(prev => prev.filter(p => p.id !== data.id))
              setNotice({ kind: 'success', title: 'Transferencia feita', message: `Lead transferido pra ${data.from_attendant_name}.` })
              loadLeadsList()
            } catch (e: any) { setNotice({ kind: 'error', title: 'Erro', message: e?.message || 'Falha ao aceitar' }) }
          },
        },
      ],
    })
  }, [user, loadLeadsList]))

  // Pedido aceito — pra quem pediu, atualiza lista e avisa
  useSSE('lead:transfer-accepted', useCallback((data: any) => {
    if (!user || data.newAttendantId !== user.id) return
    loadLeadsList()
    setNotice({ kind: 'success', title: 'Transferencia aprovada', message: `O lead ja esta com voce. Pode comecar o atendimento.` })
  }, [user, loadLeadsList]))

  // Pedido rejeitado — pra quem pediu
  useSSE('lead:transfer-rejected', useCallback((data: any) => {
    if (!user || data.fromUserId !== user.id) return
    setNotice({ kind: 'info', title: 'Transferencia recusada', message: 'O atendente recusou a transferencia. Fale com o gerente se precisar urgente.' })
  }, [user]))

  // Carrega pendings ao montar (so pra atualizar state — modal aparece em /transferencias)
  useEffect(() => {
    if (!user) return
    fetchPendingTransferRequests().then(r => setPendingTransfers(r.requests || [])).catch(() => {})
  }, [user?.id])

  const handleArchiveLead = async (leadId: number, e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.()
    if (!confirm('Arquivar este lead? Ele some do chat e do pipeline, mas o historico fica salvo.')) return
    setLeads(prev => prev.filter(l => l.id !== leadId))
    if (selectedLeadId === leadId) setSelectedLeadId(null)
    try { await archiveLead(leadId) } catch { loadLeadsList() }
  }

  const handleBlockLead = async (leadId: number, leadPhone: string | null, e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.()
    const phoneLabel = leadPhone || 'esse numero'
    const ok = confirm(
      `EXCLUIR este lead e BLOQUEAR o numero ${phoneLabel}?\n\n` +
      `- O lead some do CRM (chat, pipeline, listas)\n` +
      `- Mensagens FUTURAS desse numero serao IGNORADAS pelo CRM (nao gravam, nao criam lead)\n` +
      `- Outros leads NAO sao afetados\n` +
      `- A acao pode ser desfeita por SQL no banco (lead volta com historico intacto)`
    )
    if (!ok) return
    setLeads(prev => prev.filter(l => l.id !== leadId))
    if (selectedLeadId === leadId) setSelectedLeadId(null)
    try {
      await blockLead(leadId)
      setNotice({ kind: 'success', title: 'Lead excluido', message: `Numero ${phoneLabel} bloqueado. Msgs futuras serao ignoradas.` })
    } catch (err: any) {
      setNotice({ kind: 'error', title: 'Erro ao excluir', message: err?.message || 'Falha desconhecida' })
      loadLeadsList()
    }
  }

  // Formata conversa como texto plano otimizado pra analise por LLM (ChatGPT/Claude)
  const formatConversationForLLM = (msgs: Message[]): string => {
    if (!lead) return ''
    const lines: string[] = []
    const phone = lead.phone || 's/ tel'
    const leadName = lead.name || phone
    const companyName = (accounts.find(a => a.id === accountId)?.name || 'Empresa').toUpperCase()
    lines.push(companyName)
    lines.push(`Conversa com ${leadName} (${phone})`)
    const attendantName = attendants.find(a => a.id === lead.attendant_id)?.name
    if (attendantName) lines.push(`Atendente responsavel: ${attendantName}`)
    lines.push(`Total: ${msgs.length} mensagens`)
    lines.push('')
    for (const m of msgs) {
      const d = parseSqlDate(m.created_at)
      const ts = isNaN(d.getTime()) ? '?' : `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
      let sender: string
      if (m.direction === 'inbound') {
        sender = leadName
      } else {
        // Nome da instancia WhatsApp que enviou (ex: "Ramon", "Central ASK")
        const inst = m.instance_id ? instances.find(i => i.id === m.instance_id)?.instance_name : null
        sender = inst || companyName
      }
      const content = (m.content || '').trim().replace(/\n+/g, '\n')
      lines.push(`${sender} enviou (${ts})`)
      lines.push(content)
      lines.push('')
    }
    return lines.join('\n').trim()
  }

  const handleCopyConversation = async () => {
    if (!lead) return
    const text = formatConversationForLLM(visibleMessages)
    if (!text || visibleMessages.length === 0) {
      setNotice({ kind: 'info', title: 'Conversa vazia', message: 'Nao ha mensagens pra copiar.' })
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ kind: 'success', title: 'Conversa copiada', message: `${visibleMessages.length} mensagem${visibleMessages.length !== 1 ? 's' : ''} copiada${visibleMessages.length !== 1 ? 's' : ''}. Cole no ChatGPT/Claude pra analise.` })
    } catch (e: any) {
      setNotice({ kind: 'error', title: 'Erro ao copiar', message: e?.message || 'Browser bloqueou acesso ao clipboard (precisa HTTPS)' })
    }
  }

  const handleForceAi = () => {
    if (!lead) return
    const runForceAi = async () => {
      try {
        // Passa instancia ativa do "Enviar via" pra resposta sair pela mesma que o user
        // tem selecionada no momento (ex: bot welcome veio por inst A mas user quer
        // que resposta saia pela inst B configurada no agente).
        const r = await forceAiRespond(lead.id, resolvedSendInstance?.id)
        if (r.ok) {
          setNotice({ kind: 'success', title: 'IA disparada', message: r.message || 'Resposta deve chegar em segundos.' })
        } else if (r.blockers && r.blockers.length > 0) {
          // Backend retornou lista de bloqueios — formata como bullets
          setNotice({
            kind: 'error',
            title: 'Bot nao pode atuar nesse lead',
            message: '• ' + r.blockers.join('\n• '),
          })
        } else {
          setNotice({ kind: 'error', title: 'Falhou', message: r.error || 'Nao foi possivel disparar' })
        }
      } catch (e: any) {
        setNotice({ kind: 'error', title: 'Erro', message: e?.message || 'Erro de rede' })
      }
    }
    setNotice({
      kind: 'info',
      title: 'Disparar IA?',
      message: 'Roda o bot pra responder a última mensagem do lead. Mesmas regras de uma recepção normal: respeita atendente, handoff anterior, etapa, tag e instância. Se algo bloqueia, eu te aviso o quê.',
      actions: [
        { label: 'Cancelar', onClick: () => setNotice(null) },
        { label: 'Disparar', primary: true, onClick: () => { setNotice(null); runForceAi() } },
      ],
    })
  }

  const connectedInstances = useMemo(() => instances.filter(i => i.status === 'connected'), [instances])

  const handleCreateNewChat = async () => {
    if (!accountId) return
    const phone = newChatPhone.replace(/[^\d]/g, '')
    if (!phone) { setNotice({ kind: 'error', title: 'Telefone obrigatorio', message: 'Informe o telefone do contato.' }); return }
    if (phone.length < 10) { setNotice({ kind: 'error', title: 'Telefone invalido', message: 'Use no minimo 10 digitos (DDD + numero).' }); return }
    if (connectedInstances.length > 1 && !newChatInstanceId) {
      setNotice({ kind: 'error', title: 'Escolha um numero', message: 'Selecione de qual WhatsApp essa conversa vai sair.' })
      return
    }
    const name = newChatName.trim() || phone
    const instanceId = newChatInstanceId || connectedInstances[0]?.id || undefined
    setCreatingNewChat(true)
    try {
      const { lead: targetLead, alreadyExisted } = await createLeadOrFindExisting(accountId, { name, phone, source: 'manual', instance_id: instanceId } as any)
      setShowNewChat(false)
      setNewChatName('')
      setNewChatPhone('')
      setNewChatInstanceId(null)
      loadLeadsList()
      setSelectedLeadId(targetLead.id)
      if (alreadyExisted) {
        setNotice({ kind: 'info', title: 'Contato ja existia', message: `Voce ja tinha conversa com ${targetLead.name || phone}. Abrindo a conversa atual.` })
      }
    } catch (e: any) {
      if (e?.otherAttendant) {
        // Fecha o modal de Novo Chat ANTES de mostrar o notice, senao ele cobre
        setShowNewChat(false)
        setNewChatName('')
        setNewChatPhone('')
        setNewChatInstanceId(null)
        const ownerName = e.ownerName || 'outro atendente'
        const leadId = e.leadId
        const canGrab = !!user?.can_grab_leads || user?.role === 'super_admin' || user?.role === 'gerente'
        const actions: NoticeAction[] = []
        if (leadId && accountId) {
          actions.push({
            label: 'Pedir transferencia',
            onClick: async () => {
              try {
                await requestLeadTransfer(leadId, accountId)
                setNotice({ kind: 'success', title: 'Pedido enviado', message: `${ownerName} foi avisado(a). Quando aceitar, o lead vira seu automaticamente.` })
              } catch (err: any) {
                setNotice({ kind: 'error', title: 'Erro', message: err?.message || 'Falha ao pedir transferencia' })
              }
            },
          })
          if (canGrab) {
            actions.push({
              label: 'Assumir lead',
              primary: true,
              onClick: async () => {
                try {
                  await grabLead(leadId, accountId)
                  setNotice({ kind: 'success', title: 'Lead assumido', message: 'O lead agora esta com voce.' })
                  loadLeadsList()
                  setSelectedLeadId(leadId)
                } catch (err: any) {
                  setNotice({ kind: 'error', title: 'Erro', message: err?.message || 'Falha ao assumir' })
                }
              },
            })
          }
        }
        setNotice({
          kind: 'info',
          title: 'Contato ja em atendimento',
          message: canGrab
            ? `Esse telefone ja esta com ${ownerName}. Voce pode pedir transferencia (${ownerName} aprova) ou assumir direto (sua permissao especial).`
            : `Esse telefone ja esta cadastrado com ${ownerName} da sua empresa. Voce pode pedir transferencia — ${ownerName} sera avisado e pode aceitar.`,
          actions: actions.length > 0 ? actions : undefined,
        })
      } else {
        setNotice({ kind: 'error', title: 'Erro ao criar contato', message: e.message || 'Erro desconhecido' })
      }
    } finally {
      setCreatingNewChat(false)
    }
  }

  const filteredLeads = useMemo(() => {
    let result = leads
    if (tagFilter.length > 0) {
      const wantsUntagged = tagFilter.includes('untagged')
      const wantedTagIds = tagFilter.filter((v): v is number => typeof v === 'number')
      result = result.filter(l => {
        const hasNoTags = !l.tags || l.tags.length === 0
        const hasWantedTag = l.tags?.some(t => wantedTagIds.includes(t.id)) || false
        return (wantsUntagged && hasNoTags) || hasWantedTag
      })
    }
    if (attendantFilter.length > 0) {
      const wantsNoAttendant = attendantFilter.includes('none')
      const wantedAttIds = attendantFilter.filter((v): v is number => typeof v === 'number')
      result = result.filter(l => {
        const isNone = !l.attendant_id
        const matches = l.attendant_id != null && wantedAttIds.includes(l.attendant_id)
        return (wantsNoAttendant && isNone) || matches
      })
    }
    if (stageFilter.length > 0) {
      const wantedStageIds = stageFilter.filter((v): v is number => typeof v === 'number')
      result = result.filter(l => l.stage_id != null && wantedStageIds.includes(l.stage_id))
    }
    if (search.trim()) {
      const s = search.toLowerCase()
      result = result.filter(l => (l.name || '').toLowerCase().includes(s) || (l.phone || '').includes(s))
    }
    // Ordenacao estilo WhatsApp: leads com unread primeiro (badge no topo), depois por updated_at desc
    return [...result].sort((a, b) => {
      const aUnread = (a.unread_count || 0) > 0 ? 1 : 0
      const bUnread = (b.unread_count || 0) > 0 ? 1 : 0
      if (aUnread !== bUnread) return bUnread - aUnread
      return (b.updated_at || '').localeCompare(a.updated_at || '')
    })
  }, [leads, search, tagFilter, attendantFilter, stageFilter])

  // Title da aba: soma total de unread → mostra "(N) Sheraos CRM"
  useEffect(() => {
    const total = leads.reduce((s, l) => s + (l.unread_count || 0), 0)
    const base = 'Sheraos CRM'
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${base}` : base
    return () => { document.title = base }
  }, [leads])

  const handleSendMsg = async () => {
    if (!msgText.trim() || !lead || !accountId) return
    // Bloqueia envio se nao ha instancia escolhida (lead novo sem aba ativa)
    const override = sendInstanceOverride || activeConvInstance || undefined
    if (!override) {
      setNotice({ kind: 'error', title: 'Escolha uma instancia', message: 'Clique em "Enviar via" acima do input pra escolher de qual WhatsApp essa mensagem vai sair.' })
      return
    }
    setSending(true)
    try {
      const result = await sendMessage(lead.id, accountId, msgText, override)
      setMessages(prev => [...prev, result.message])
      setMsgText('')
      if (!result.delivered) setNotice({ kind: 'error', title: 'Mensagem nao entregue', message: 'A mensagem foi salva mas NAO foi enviada no WhatsApp. Verifique a conexao da instancia.' })
      setSendInstanceOverride(null)
      loadLeadsList()
    } catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao enviar', message: e?.message || 'Erro desconhecido' }) }
    setSending(false)
  }

  const MEDIA_LIMITS_MB: Record<string, number> = { image: 5, audio: 16, video: 64, document: 100 }
  const detectMediaType = (mime: string): 'image' | 'video' | 'audio' | 'document' => {
    if (mime.startsWith('image/')) return 'image'
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
    return 'document'
  }

  const handlePickFile = (file: File | null) => {
    if (!file) return
    const type = detectMediaType(file.type || '')
    const maxMb = MEDIA_LIMITS_MB[type]
    if (file.size > maxMb * 1024 * 1024) {
      setNotice({ kind: 'error', title: 'Arquivo muito grande', message: `Limite para ${type}: ${maxMb}MB.` })
      return
    }
    setAttachFile(file)
    setAttachCaption('')
    if (type === 'image') {
      const reader = new FileReader()
      reader.onload = () => setAttachPreview(reader.result as string)
      reader.readAsDataURL(file)
    } else {
      setAttachPreview(null)
    }
  }

  const handleCancelAttach = () => {
    setAttachFile(null)
    setAttachCaption('')
    setAttachPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSendAttach = async () => {
    if (!attachFile || !lead || !accountId) return
    setSending(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.split(',')[1] || '')
        }
        reader.onerror = () => reject(new Error('Falha ao ler arquivo'))
        reader.readAsDataURL(attachFile)
      })
      const override = sendInstanceOverride || activeConvInstance || undefined
      const result = await sendMessageMedia(lead.id, accountId, {
        base64,
        mime: attachFile.type || 'application/octet-stream',
        file_name: attachFile.name,
        caption: attachCaption || undefined,
        instance_id: override,
      })
      setMessages(prev => [...prev, result.message])
      if (!result.delivered) setNotice({ kind: 'error', title: 'Anexo nao entregue', message: 'O anexo foi salvo mas NAO foi enviado no WhatsApp. Verifique a conexao da instancia.' })
      handleCancelAttach()
      setSendInstanceOverride(null)
      loadLeadsList()
    } catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao enviar anexo', message: e?.message || 'Erro desconhecido' }) }
    setSending(false)
  }

  const handleSendAudio = async (blob: Blob, mime: string) => {
    if (!lead || !accountId) return
    setSending(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.split(',')[1] || '')
        }
        reader.onerror = () => reject(new Error('Falha ao ler audio'))
        reader.readAsDataURL(blob)
      })
      const override = sendInstanceOverride || activeConvInstance || undefined
      const ext = (mime.split(';')[0].split('/')[1] || 'webm').toLowerCase()
      const result = await sendMessageMedia(lead.id, accountId, {
        base64,
        mime: mime.split(';')[0] || 'audio/webm',
        file_name: `audio-${Date.now()}.${ext}`,
        instance_id: override,
      })
      setMessages(prev => [...prev, result.message])
      if (!result.delivered) setNotice({ kind: 'error', title: 'Audio nao entregue', message: 'O audio foi salvo mas NAO foi enviado no WhatsApp. Verifique a conexao da instancia.' })
      setSendInstanceOverride(null)
      loadLeadsList()
    } catch (e: any) {
      setNotice({ kind: 'error', title: 'Erro ao enviar audio', message: e?.message || 'Erro desconhecido' })
      throw e
    } finally {
      setSending(false)
    }
  }

  // Tab ativa define a instancia de envio
  const resolvedSendInstance = (() => {
    if (!lead || !instances.length) return null
    if (sendInstanceOverride) return instances.find(i => i.id === sendInstanceOverride)
    if (activeConvInstance) return instances.find(i => i.id === activeConvInstance)
    return null
  })()

  // Filtrar mensagens pela tab ativa
  const visibleMessages = activeConvInstance
    ? messages.filter(m => (m as any).instance_id === activeConvInstance)
    : messages

  const handleSaveEdit = async () => {
    if (!lead) return
    await updateLead(lead.id, editData)
    setEditing(false); loadLead()
  }

  const handleAddNote = async () => {
    if (!noteText.trim() || !lead) return
    const note = await addLeadNote(lead.id, noteText)
    setNotes(prev => [note, ...prev]); setNoteText('')
  }

  const handleStageChange = async (stageId: number) => { if (lead) { await moveLeadStage(lead.id, stageId); loadLead(); loadLeadsList() } }
  // Assign com modal de confirmacao + checkbox 'enviar 1a msg'
  const [assignModal, setAssignModal] = useState<{ attId: number; userName: string } | null>(null)
  const [assignNotify, setAssignNotify] = useState(false)
  const [assignSaving, setAssignSaving] = useState(false)
  const handleAssign = async (attId: number | null) => {
    if (!lead) return
    if (attId == null) { await assignLead(lead.id, null); loadLead(); return }
    if (attId === lead.attendant_id) return
    const u = (users || []).find((x: any) => x.id === attId)
    setAssignNotify(false)
    setAssignModal({ attId, userName: u?.name || `User ${attId}` })
  }
  const confirmAssign = async () => {
    if (!lead || !assignModal) return
    setAssignSaving(true)
    try {
      await assignLead(lead.id, assignModal.attId, assignNotify)
      setAssignModal(null); loadLead()
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'desconhecido'))
    }
    setAssignSaving(false)
  }
  const handleAddTag = async (tagId: number) => { if (lead) { await addLeadTag(lead.id, tagId); loadLead(); setShowTagMenu(false) } }
  const handleRemoveTag = async (tagId: number) => { if (lead) { await removeLeadTag(lead.id, tagId); loadLead() } }
  const handleAdvanceCadence = async () => { if (leadCadence && accountId) { await advanceLeadCadence(leadCadence.id, accountId); loadLead() } }

  const handleAssignFollowUp = async (followUpId: number) => {
    if (!lead || !accountId) return
    try {
      await assignFollowUp(followUpId, accountId, lead.id)
      setShowFollowUpMenu(false)
      loadLead()
    } catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao atribuir follow-up', message: e?.message || '' }) }
  }
  const handleAssignGlobalFollowUp = async (globalId: number) => {
    if (!lead || !accountId) return
    setApplyingGlobalFuId(globalId)
    try {
      const already = globalFollowUps.find(g => g.id === globalId)
      let localFuId: number | undefined = already?.applied_follow_up_id || undefined
      if (!localFuId) {
        // Resolve instance_id (obrigatorio pro apply). Ordem: lead atual → user primary → primeira connected
        const resolvedInstanceId = lead.last_instance_id || lead.instance_id || user?.primary_instance_id || instances.find(i => i.status === 'connected')?.id
        if (!resolvedInstanceId) throw new Error('Nenhuma instancia WhatsApp conectada disponivel')
        const r = await applyGlobalFollowUpHere(globalId, accountId, { instance_id: resolvedInstanceId })
        if (!r.ok || !r.new_follow_up_id) throw new Error(r.error || 'Falha ao aplicar template global')
        localFuId = r.new_follow_up_id
        // Recarrega listas
        const [fus, avail] = await Promise.all([
          fetchFollowUps(accountId).catch(() => followUps),
          fetchAvailableGlobalTemplates(accountId).catch(() => ({ cadences: globalCadences, follow_ups: globalFollowUps })),
        ])
        setFollowUps(fus)
        setGlobalCadences(avail.cadences)
        setGlobalFollowUps(avail.follow_ups)
      }
      await assignFollowUp(localFuId, accountId, lead.id)
      setShowFollowUpMenu(false)
      loadLead()
    } catch (e: any) {
      setNotice({ kind: 'error', title: 'Erro ao atribuir follow-up global', message: e?.message || '' })
    } finally {
      setApplyingGlobalFuId(null)
    }
  }
  const handlePauseFollowUp = async () => {
    if (!leadFollowUp || !accountId) return
    try { await pauseLeadFollowUp(leadFollowUp.id, accountId); loadLead() }
    catch (e: any) { setNotice({ kind: 'error', title: 'Erro', message: e?.message || '' }) }
  }
  const handleResumeFollowUp = async () => {
    if (!leadFollowUp || !accountId) return
    try { await resumeLeadFollowUp(leadFollowUp.id, accountId); loadLead() }
    catch (e: any) { setNotice({ kind: 'error', title: 'Erro', message: e?.message || '' }) }
  }
  const handleCancelFollowUp = async () => {
    if (!leadFollowUp || !accountId) return
    if (!confirm('Cancelar follow-up deste lead? Não enviará mais nenhuma mensagem automática.')) return
    try { await cancelLeadFollowUp(leadFollowUp.id, accountId); loadLead() }
    catch (e: any) { setNotice({ kind: 'error', title: 'Erro', message: e?.message || '' }) }
  }
  const handleViewScript = () => { if (leadCadence?.attempt_script) setScriptModal({ text: leadCadence.attempt_script }) }
  const handleSendCadenceMessage = async () => {
    if (!cadenceMsgText.trim() || !lead || !accountId || !leadCadence) return
    setSending(true)
    try {
      const result = await sendMessage(lead.id, accountId, cadenceMsgText)
      setMessages(prev => [...prev, result.message])
      if (result.delivered) {
        await advanceLeadCadence(leadCadence.id, accountId)
        loadLead()
      } else {
        setNotice({ kind: 'error', title: 'Mensagem nao entregue', message: 'A mensagem NAO foi entregue no WhatsApp. Cadencia mantida na etapa atual. Verifique a conexao e tente novamente.' })
      }
    } catch (err: any) {
      setNotice({ kind: 'error', title: 'Erro ao enviar', message: err?.message || 'Erro desconhecido' })
    }
    setSending(false)
  }
  const handleAssignCadence = async (cadenceId: number) => { if (lead && accountId) { await assignLeadCadence(cadenceId, accountId, lead.id); setShowCadenceMenu(false); loadLead() } }
  const handleAssignGlobalCadence = async (globalId: number) => {
    if (!lead || !accountId) return
    setApplyingGlobalId(globalId)
    try {
      const already = globalCadences.find(g => g.id === globalId)
      let localCadenceId: number | undefined = already?.applied_cadence_id || undefined
      if (!localCadenceId) {
        // Clona pro tenant e usa o id retornado
        const r = await applyGlobalCadenceHere(globalId, accountId, false)
        if (!r.ok || !r.new_cadence_id) throw new Error(r.error || 'Falha ao aplicar template global')
        localCadenceId = r.new_cadence_id
        // Recarrega listas
        const [cads, avail] = await Promise.all([
          fetchCadences(accountId),
          fetchAvailableGlobalTemplates(accountId).then(d => d.cadences).catch(() => []),
        ])
        setCadences(cads)
        setGlobalCadences(avail)
      }
      await assignLeadCadence(localCadenceId, accountId, lead.id)
      setShowCadenceMenu(false)
      loadLead()
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'unknown'))
    } finally {
      setApplyingGlobalId(null)
    }
  }

  const handleCreateTag = async () => {
    if (!accountId || !newTagName.trim() || !lead) return
    try {
      const tag = await createTag(accountId, newTagName.trim(), newTagColor)
      setTags(prev => [...prev, tag])
      await addLeadTag(lead.id, tag.id)
      setNewTagName(''); loadLead()
    } catch (e: any) {
      setNotice({ kind: 'error', title: 'Erro ao criar tag', message: e?.message || 'Falha desconhecida' })
    }
  }

  const allStages = funnels.flatMap(f => f.stages || [])
  const currentStage = lead ? allStages.find(s => s.id === lead.stage_id) : null
  // Gerentes tambem atendem leads — incluir junto com atendentes no dropdown
  const attendants = users.filter(u => (u.role === 'atendente' || u.role === 'gerente') && u.is_active)
  const availableTags = lead ? tags.filter(t => !lead.tags?.some(lt => lt.id === t.id)) : []

  if (user?.role === 'atendente' && !user?.primary_instance_id) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}><MessageCircle size={20} style={{ verticalAlign: -4, marginRight: 6 }} />Chat</h1>
        <BlockedBanner />
      </div>
    )
  }

  return (
    <div className={isMobile ? `chat-page chat-mobile-active mobile-tab-${mobileTab}` : 'chat-page'}>
      {/* Top bar: instance selector */}
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}><MessageCircle size={20} style={{ verticalAlign: -4, marginRight: 6 }} />Chat</h1>
          <FilterDropdown
            label="instancias"
            width={200}
            options={instances.map(i => ({ value: i.id, label: `${i.instance_name}${i.status === 'connected' ? ' ✓' : ' ✗'}` }))}
            selected={instanceFilter}
            onChange={setInstanceFilter}
          />
          <FilterDropdown
            label="tags"
            width={160}
            options={[
              { value: 'untagged', label: '(Sem tag)' },
              ...tags.map(t => ({ value: t.id, label: t.name })),
            ]}
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <FilterDropdown
            label="etapas"
            width={180}
            options={allStages.map(s => ({ value: s.id, label: s.name }))}
            selected={stageFilter}
            onChange={setStageFilter}
          />
          {user?.role !== 'atendente' && (
            <FilterDropdown
              label="atendentes"
              width={180}
              options={[
                { value: 'none', label: '(Sem atendente)' },
                ...attendants.map(a => ({ value: a.id, label: a.name })),
              ]}
              selected={attendantFilter}
              onChange={setAttendantFilter}
            />
          )}
          <select
            value={anuncioFilter}
            onChange={(e) => setAnuncioFilter(e.target.value as 'todos' | 'sim' | 'nao')}
            className="btn btn-sm btn-secondary"
            style={{ fontSize: 11, padding: '4px 8px', cursor: 'pointer' }}
            title="Filtrar por origem de anúncio"
          >
            <option value="todos">Anúncio: todos</option>
            <option value="sim">📢 Só de anúncio</option>
            <option value="nao">Só orgânicos</option>
          </select>
          <button onClick={() => setShowArchived(s => !s)} className={`btn btn-sm ${showArchived ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 11 }} title="Mostrar leads arquivados">
            <Archive size={12} /> {showArchived ? 'Ocultar arquivados' : 'Mostrar arquivados'}
          </button>
        </div>
      </div>

      <div className="chat-layout">
        {/* Column 1: Contacts */}
        <div className="chat-contacts">
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setShowNewChat(true)
                // Pre-seleciona se so tem 1 instancia conectada
                if (connectedInstances.length === 1) setNewChatInstanceId(connectedInstances[0].id)
              }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12 }}
              title="Iniciar conversa com novo contato"
            >
              <MessageSquarePlus size={14} /> Novo chat
            </button>
          </div>
          <div className="chat-search">
            <Search size={14} style={{ color: '#6B6580' }} />
            <input className="input" placeholder="Buscar contato..." value={search} onChange={e => setSearch(e.target.value)} style={{ border: 'none', background: 'transparent', flex: 1 }} />
          </div>
          <div className="chat-contacts-list">
            {filteredLeads.map(l => {
              const active = l.id === selectedLeadId
              const stage = allStages.find(s => s.id === l.stage_id)
              return (
                <div key={l.id} className={`chat-contact-item ${active ? 'active' : ''} ${(l.unread_count || 0) > 0 ? 'has-unread' : ''}`} onClick={() => selectLead(l.id)} style={{ position: 'relative' }}>
                  <div className="chat-contact-avatar" style={{ background: stage ? `${stage.color}25` : '#FFB30025', overflow: 'hidden' }}>
                    {l.profile_pic_url ? (
                      <img src={l.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    ) : (
                      <User size={16} style={{ color: stage?.color || '#FFB300' }} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <span className="chat-contact-name" style={{ fontWeight: (l.unread_count || 0) > 0 ? 700 : 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: (l.unread_count || 0) > 0 ? 'var(--text-primary)' : undefined }}>{l.name || l.phone || 'Sem nome'}</span>
                      <span style={{ fontSize: 10, color: (l.unread_count || 0) > 0 ? 'var(--positive)' : 'var(--text-muted)', fontWeight: (l.unread_count || 0) > 0 ? 700 : 400 }}>{timeAgo(l.updated_at)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 2, alignItems: 'center' }}>
                      <span className="chat-contact-preview" style={{ fontSize: 11, color: (l.unread_count || 0) > 0 ? 'var(--text-secondary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {l.last_message || (l.phone ? `📞 ${l.phone}` : 'Sem mensagens')}
                      </span>
                      {(l.unread_count || 0) > 0 && (
                        <span className="chat-contact-unread">{(l.unread_count || 0) > 99 ? '99+' : l.unread_count}</span>
                      )}
                      {stage && (l.unread_count || 0) === 0 && <span style={{ fontSize: 9, color: stage.color, background: `${stage.color}20`, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap' }}>{stage.name}</span>}
                    </div>
                  </div>
                  <button
                    className="chat-contact-archive"
                    title="Arquivar"
                    onClick={e => handleArchiveLead(l.id, e)}
                    style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.35)', border: 'none', color: 'var(--text-secondary, var(--text-muted))', cursor: 'pointer', padding: 4, borderRadius: 4, display: 'none' }}>
                    <Archive size={11} />
                  </button>
                </div>
              )
            })}
            {filteredLeads.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: '#6B6580', fontSize: 12 }}>Nenhum contato</div>}
          </div>
        </div>

        {/* Column 2: Conversation */}
        <div className="chat-conversation">
          {!lead ? (
            <div className="chat-empty">
              <MessageCircle size={48} style={{ color: '#6B6580', marginBottom: 12 }} />
              <h3 style={{ fontSize: 16, color: '#9B96B0' }}>Selecione um contato</h3>
            </div>
          ) : (
            <>
              <div className="chat-conversation-header">
                <button className="chat-mobile-back" onClick={() => setMobileTab('conversas')} title="Voltar">
                  <ChevronLeft size={16} />
                </button>
                <div className="chat-contact-avatar" style={{ background: `${currentStage?.color || '#FFB300'}25`, overflow: 'hidden' }}>
                  {lead.profile_pic_url ? (
                    <img src={lead.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  ) : (
                    <User size={16} style={{ color: currentStage?.color || '#FFB300' }} />
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{lead.name || 'Sem nome'}</div>
                  {lead.phone && <div style={{ fontSize: 11, color: '#9B96B0', display: 'flex', alignItems: 'center', gap: 4 }}><Phone size={10} />{lead.phone}</div>}
                </div>
                {lead.instance_name && <span style={{ fontSize: 10, color: '#34C759', display: 'flex', alignItems: 'center', gap: 4 }}><Smartphone size={10} />{lead.instance_name}</span>}
                {user?.role === 'super_admin' && (
                  <button className="btn btn-secondary btn-sm" title="Copiar conversa (pra analise por LLM)" onClick={handleCopyConversation} style={{ padding: '4px 8px' }}>
                    <Copy size={12} />
                  </button>
                )}
                {user?.role === 'super_admin' && (
                  <button
                    className="btn btn-secondary btn-sm"
                    title={leadLoading ? 'Carregando dados do lead...' : 'Disparar IA (mesmas regras de uma msg normal)'}
                    onClick={handleForceAi}
                    disabled={leadLoading}
                    style={{ padding: '4px 8px', opacity: leadLoading ? 0.5 : 1 }}
                  >
                    <Bot size={12} />
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" title="Arquivar" onClick={() => handleArchiveLead(lead.id)} style={{ padding: '4px 8px' }}>
                  <Archive size={12} />
                </button>
                <button className="btn btn-danger btn-sm" title="Excluir e bloquear numero (mensagens futuras serao ignoradas)" onClick={() => handleBlockLead(lead.id, lead.phone)} style={{ padding: '4px 8px' }}>
                  <Ban size={12} />
                </button>
              </div>

              {/* Tabs por instancia (uma conversa por numero) */}
              {conversations.length > 0 && (
                <div style={{ display: 'flex', gap: 0, padding: '0 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', overflowX: 'auto' }}>
                  {conversations.map(conv => {
                    const isActive = conv.instance_id === activeConvInstance
                    return (
                      <button key={conv.instance_id} onClick={() => setActiveConvInstance(conv.instance_id)}
                        style={{ padding: '10px 14px', background: 'transparent', border: 'none', borderBottom: `2px solid ${isActive ? '#FFB300' : 'transparent'}`, color: isActive ? '#FFB300' : '#9B96B0', fontSize: 12, fontWeight: isActive ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Smartphone size={11} />
                        {conv.instance_name}
                        <span style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 6px', borderRadius: 8, fontSize: 10 }}>{conv.msg_count}</span>
                        {conv.attendant_name && <span style={{ fontSize: 9, color: '#6B6580' }}>· {conv.attendant_name}</span>}
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="chat-messages">
                {visibleMessages.length === 0 && <div style={{ textAlign: 'center', color: '#6B6580', padding: 40, fontSize: 13 }}>Nenhuma mensagem nesta conversa</div>}
                {(() => {
                  let lastDayKey = ''
                  const elements: React.ReactNode[] = []
                  for (const m of visibleMessages) {
                    const dayKey = localDayKey(m.created_at)
                    if (dayKey && dayKey !== lastDayKey) {
                      elements.push(
                        <div key={`sep-${dayKey}`} className="chat-day-separator">
                          <span>{formatDayLabel(m.created_at)}</span>
                        </div>
                      )
                      lastDayKey = dayKey
                    }
                    elements.push(
                      <div key={m.id} className={`chat-msg-row ${m.direction}`}>
                        <div className={`chat-bubble ${m.direction}`} style={m.direction === 'outbound' && !m.wa_msg_id ? { border: '1px solid #FF6B6B', opacity: 0.8 } : undefined}>
                          {(() => {
                            const t = m.media_type
                            if (t && ['image','video','audio','document','sticker'].includes(t)) {
                              return <MessageMedia message={m} leadId={lead.id} />
                            }
                            // Renderers especiais pra tipos que nao sao midia baixavel
                            if (t === 'call') {
                              const isVideo = (m.content || '').includes('vídeo') || (m.content || '').includes('video')
                              const isMissed = (m.content || '').includes('perdida') || (m.content || '').includes('recusada')
                              const CallIcon = isMissed ? PhoneMissed : (isVideo ? Video : Phone)
                              const color = isMissed ? '#FF6B6B' : '#34C759'
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px' }}>
                                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: `${color}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                    <CallIcon size={16} style={{ color }} />
                                  </div>
                                  <div style={{ fontSize: 13, fontWeight: 500 }}>{(m.content || '').replace(/^📞 |^📹 /, '')}</div>
                                </div>
                              )
                            }
                            if (t === 'location') {
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                                  <MapPin size={16} style={{ color: '#EA4335', flexShrink: 0 }} />
                                  <span style={{ fontSize: 13 }}>{(m.content || '').replace(/^📍 ?/, '')}</span>
                                </div>
                              )
                            }
                            if (t === 'contact') {
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                                  <UsersIcon size={16} style={{ color: '#5DADE2', flexShrink: 0 }} />
                                  <span style={{ fontSize: 13 }}>{(m.content || '').replace(/^👤 ?/, '')}</span>
                                </div>
                              )
                            }
                            return m.content || <em style={{ opacity: 0.5 }}>Sem conteudo</em>
                          })()}
                        </div>
                        <div className="chat-bubble-time">
                          {m.sender_name && <span>{m.sender_name} · </span>}
                          <span>{formatTime(m.created_at)}</span>
                          {(m as any).instance_id && (() => {
                            const inst = instances.find(i => i.id === (m as any).instance_id)
                            return inst ? <span style={{ marginLeft: 4, padding: '0 5px', borderRadius: 3, background: 'rgba(255,179,0,0.12)', color: '#FFB300', fontSize: 9, fontWeight: 600 }}>via {inst.instance_name}</span> : null
                          })()}
                          {m.direction === 'outbound' && (() => {
                            const st = m.delivery_status || (m.wa_msg_id ? 'sent' : 'failed')
                            if (st === 'failed') return <span className="msg-check msg-check-failed" title="Falha no envio">✗</span>
                            if (st === 'read') return <span className="msg-check msg-check-read" title="Lida pelo lead">✓✓</span>
                            if (st === 'delivered') return <span className="msg-check msg-check-delivered" title="Entregue ao aparelho">✓✓</span>
                            return <span className="msg-check msg-check-sent" title="Enviada">✓</span>
                          })()}
                        </div>
                      </div>
                    )
                  }
                  return elements
                })()}
                <div ref={chatEndRef} />
              </div>
              {/* Dropdown 'Enviar via' — sempre visivel quando ha instancias conectadas */}
              {(() => {
                const connected = instances.filter(i => i.status === 'connected')
                if (connected.length === 0) {
                  return (
                    <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#FF6B6B', borderTop: '1px solid rgba(255,107,107,0.2)', background: 'rgba(255,107,107,0.05)' }}>
                      <Smartphone size={11} /> Nenhuma instancia conectada — nao da pra enviar
                    </div>
                  )
                }
                return (
                  <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9B96B0', borderTop: '1px solid rgba(255,255,255,0.04)', background: resolvedSendInstance ? 'transparent' : 'rgba(255,179,0,0.05)', position: 'relative' }}>
                    <Smartphone size={11} style={{ color: resolvedSendInstance ? '#FFB300' : '#FBBC04' }} />
                    <span>Enviar via:</span>
                    <button onClick={() => setShowSendInstance(s => !s)} style={{ background: 'none', border: 'none', color: resolvedSendInstance ? '#FFB300' : '#FBBC04', fontWeight: 600, cursor: 'pointer', padding: 0, fontSize: 11 }}>
                      {resolvedSendInstance ? resolvedSendInstance.instance_name : '— escolha uma instancia —'} ▾
                    </button>
                    {showSendInstance && (
                      <div style={{ position: 'absolute', bottom: '100%', left: 12, marginBottom: 4, background: 'var(--bg-card)', border: '1px solid var(--border-medium)', borderRadius: 6, padding: 4, minWidth: 240, zIndex: 10, boxShadow: 'var(--shadow-md)' }}>
                        {connected.map(i => (
                          <button key={i.id} onClick={() => { setSendInstanceOverride(i.id); setShowSendInstance(false) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', background: i.id === resolvedSendInstance?.id ? 'rgba(255,179,0,0.12)' : 'transparent', color: i.id === resolvedSendInstance?.id ? 'var(--accent)' : 'var(--text-primary)', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>
                            {i.instance_name}{i.phone_number ? <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({i.phone_number})</span> : ''}{i.id === resolvedSendInstance?.id ? ' ✓' : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}
              <div className="chat-input">
                <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={e => handlePickFile(e.target.files?.[0] || null)} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt,.csv" />
                <button
                  className="btn btn-secondary btn-icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                  title="Anexar arquivo (imagem, audio, video ou documento)"
                >
                  <Paperclip size={16} />
                </button>
                <AudioRecorder onSend={handleSendAudio} disabled={sending} />
                <div ref={readyMsgsContainerRef} style={{ position: 'relative', flex: 1, display: 'flex' }}>
                  <input
                    ref={msgInputRef}
                    className="input"
                    style={{ flex: 1 }}
                    placeholder='Mensagem... (digite "/" para usar mensagens prontas)'
                    value={showReadyMsgs ? `/${readyMsgFilter}` : msgText}
                    onChange={e => {
                      const v = e.target.value
                      if (showReadyMsgs) {
                        if (v.startsWith('/')) {
                          setReadyMsgFilter(v.slice(1))
                          setReadyMsgIdx(0)
                        } else {
                          setShowReadyMsgs(false)
                          setReadyMsgFilter('')
                          setMsgText(v)
                        }
                      } else {
                        // Abre popup se digitou "/" com input vazio (cursor no inicio)
                        if (v === '/' && msgText === '') {
                          setShowReadyMsgs(true)
                          setReadyMsgFilter('')
                          setReadyMsgIdx(0)
                        } else {
                          setMsgText(v)
                        }
                      }
                    }}
                    onKeyDown={e => {
                      if (showReadyMsgs) {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          setReadyMsgIdx(i => Math.min(i + 1, Math.max(0, filteredReadyMsgs.length - 1)))
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault()
                          setReadyMsgIdx(i => Math.max(i - 1, 0))
                        } else if (e.key === 'Enter') {
                          e.preventDefault()
                          const selected = filteredReadyMsgs[readyMsgIdx] || filteredReadyMsgs[0]
                          if (selected) selectReadyMsg(selected)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setShowReadyMsgs(false)
                          setReadyMsgFilter('')
                        } else if (e.key === 'Backspace' && readyMsgFilter === '') {
                          // Backspace no filtro vazio fecha popup
                          e.preventDefault()
                          setShowReadyMsgs(false)
                        }
                        return
                      }
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        handleSendMsg()
                      }
                    }}
                    disabled={sending}
                  />

                  {showReadyMsgs && (
                    <div style={{
                      position: 'absolute', bottom: '100%', left: 0, right: 0,
                      background: 'var(--bg-card)', border: '1px solid var(--border-medium)',
                      borderRadius: 8, marginBottom: 6, maxHeight: 360, overflowY: 'auto',
                      zIndex: 100, boxShadow: 'var(--shadow-lg)',
                    }}>
                      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FileText size={12} style={{ color: 'var(--accent)' }} />
                        Mensagens prontas {readyMsgFilter && <span style={{ color: 'var(--accent)' }}>· "{readyMsgFilter}"</span>}
                      </div>
                      {filteredReadyMsgs.length === 0 ? (
                        readyMessages.length === 0 ? (
                          <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                            Nenhuma mensagem cadastrada.<br/>
                            <a href={`${import.meta.env.BASE_URL || ''}ready-messages`} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Criar mensagens prontas →</a>
                          </div>
                        ) : (
                          <div style={{ padding: 20, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                            Nenhuma mensagem com "{readyMsgFilter}"
                          </div>
                        )
                      ) : (
                        filteredReadyMsgs.map((m, i) => {
                          const isCurrent = m.stage_id === lead?.stage_id
                          return (
                            <button
                              key={m.id}
                              onClick={() => selectReadyMsg(m)}
                              onMouseEnter={() => setReadyMsgIdx(i)}
                              style={{
                                width: '100%', textAlign: 'left', padding: '10px 12px',
                                background: i === readyMsgIdx ? 'rgba(255,179,0,0.12)' : 'transparent',
                                border: 'none', cursor: 'pointer', display: 'block',
                                borderBottom: '1px solid var(--border-subtle)',
                              }}
                            >
                              <div style={{ fontSize: 12, fontWeight: 600, color: i === readyMsgIdx ? 'var(--accent)' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                {m.title}
                                {isCurrent && <span style={{ fontSize: 9, color: 'var(--positive)', fontWeight: 500 }}>· nesta etapa</span>}
                                {m.stage_name && !isCurrent && <span style={{ fontSize: 9, color: m.stage_color || 'var(--text-muted)', fontWeight: 500 }}>· {m.stage_name}</span>}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {m.content.substring(0, 90)}{m.content.length > 90 ? '...' : ''}
                              </div>
                            </button>
                          )
                        })
                      )}
                      <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border-subtle)', fontSize: 10, color: 'var(--text-subtle)' }}>
                        ↑↓ navegar · Enter selecionar · Esc cancelar
                      </div>
                    </div>
                  )}
                </div>
                <button className="btn btn-primary btn-icon" onClick={handleSendMsg} disabled={sending || !msgText.trim() || !resolvedSendInstance} title={!resolvedSendInstance ? 'Escolha uma instancia pra enviar' : ''}><Send size={16} /></button>
              </div>
              {attachFile && (
                <div className="modal-overlay" onClick={handleCancelAttach}>
                  <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
                    <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Paperclip size={16} /> Enviar anexo</h2>
                    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                      {attachPreview ? (
                        <img src={attachPreview} alt={attachFile.name} style={{ maxWidth: '100%', maxHeight: 240, display: 'block', borderRadius: 6, margin: '0 auto' }} />
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px' }}>
                          <Paperclip size={20} style={{ color: '#FFB300' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachFile.name}</div>
                            <div style={{ fontSize: 11, color: '#9B96B0' }}>{detectMediaType(attachFile.type || '')} • {(attachFile.size / 1024 / 1024).toFixed(2)} MB</div>
                          </div>
                        </div>
                      )}
                    </div>
                    {detectMediaType(attachFile.type || '') !== 'audio' && (
                      <div className="form-group">
                        <label>Legenda (opcional)</label>
                        <textarea className="input" value={attachCaption} onChange={e => setAttachCaption(e.target.value)} rows={2} placeholder="Texto que vai junto com o arquivo..." />
                      </div>
                    )}
                    <div className="modal-actions">
                      <button className="btn btn-secondary" onClick={handleCancelAttach} disabled={sending}>Cancelar</button>
                      <button className="btn btn-primary" onClick={handleSendAttach} disabled={sending}>{sending ? 'Enviando...' : 'Enviar'}</button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Column 3: Lead details / actions */}
        {lead && (
          <div className="chat-details">
            <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid var(--border-subtle)' }}>
              {(['info', 'notes', 'history'] as const).map(tab => (
                <button key={tab} className={`btn btn-sm ${rightTab === tab ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRightTab(tab)} style={{ flex: 1, fontSize: 11 }}>
                  {tab === 'info' && <><User size={11} /> Info</>}
                  {tab === 'notes' && <><StickyNote size={11} /> Notas ({notes.length})</>}
                  {tab === 'history' && <><GitBranch size={11} /> Historico</>}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {rightTab === 'info' && (
                <>
                  {/* Stage + Attendant */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', marginBottom: 4 }}>Etapa</div>
                    <select className="select" style={{ width: '100%' }} value={lead.stage_id} onChange={e => handleStageChange(+e.target.value)}>
                      {allStages.filter(s => s.funnel_id === lead.funnel_id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>

                  {user?.role !== 'atendente' && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', marginBottom: 4 }}>Atendente</div>
                      <select className="select" style={{ width: '100%' }} value={lead.attendant_id || ''} onChange={e => handleAssign(e.target.value ? +e.target.value : null)}>
                        <option value="">Sem atendente</option>
                        {attendants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Info */}
                  <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: infoCollapsed ? 0 : 8 }}>
                      <div onClick={() => { if (!editing) { setInfoCollapsed(p => { const v = !p; localStorage.setItem('chat_info_collapsed', v ? '1' : '0'); return v }) } }} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: editing ? 'default' : 'pointer', flex: 1 }}>
                        {!editing && (infoCollapsed ? <ChevronDown size={12} style={{ color: '#9B96B0' }} /> : <ChevronUp size={12} style={{ color: '#9B96B0' }} />)}
                        <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase' }}>Informacoes</div>
                      </div>
                      {!editing ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => { setInfoCollapsed(false); setEditing(true) }} style={{ padding: '2px 6px', fontSize: 10 }}><Edit3 size={10} /></button>
                      ) : (
                        <div style={{ display: 'flex', gap: 2 }}>
                          <button className="btn btn-primary btn-sm" onClick={handleSaveEdit} style={{ padding: '2px 6px', fontSize: 10 }}><Save size={10} /></button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)} style={{ padding: '2px 6px', fontSize: 10 }}><X size={10} /></button>
                        </div>
                      )}
                    </div>
                    {!infoCollapsed && (editing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <input className="input" placeholder="Nome" value={editData.name} onChange={e => setEditData(p => ({ ...p, name: e.target.value }))} style={{ fontSize: 12 }} />
                        <input className="input" placeholder="Telefone" value={editData.phone} onChange={e => setEditData(p => ({ ...p, phone: e.target.value }))} style={{ fontSize: 12 }} />
                        <input className="input" placeholder="Email" value={editData.email} onChange={e => setEditData(p => ({ ...p, email: e.target.value }))} style={{ fontSize: 12 }} />
                        <input className="input" placeholder="Cidade" value={editData.city} onChange={e => setEditData(p => ({ ...p, city: e.target.value }))} style={{ fontSize: 12 }} />
                        <input className="input" placeholder="Nome da Empresa" value={editData.empresa} onChange={e => setEditData(p => ({ ...p, empresa: e.target.value }))} style={{ fontSize: 12 }} />
                        <input className="input" placeholder="CPF/CNPJ" value={editData.cpf_cnpj} onChange={e => setEditData(p => ({ ...p, cpf_cnpj: e.target.value }))} style={{ fontSize: 12 }} />
                        <input className="input" placeholder="Instagram (@perfil)" value={editData.instagram} onChange={e => setEditData(p => ({ ...p, instagram: e.target.value }))} style={{ fontSize: 12 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 11, color: '#9B96B0' }}>Anuncio:</span>
                          <select className="select" value={editData.trabalha_anuncio || 0} onChange={e => setEditData(p => ({ ...p, trabalha_anuncio: parseInt(e.target.value) }))} style={{ fontSize: 11, width: 70, padding: '3px 6px' }}>
                            <option value={0}>Nao</option>
                            <option value={1}>Sim</option>
                          </select>
                        </div>
                        <input className="input" placeholder="Investimento Anuncios (R$)" type="number" step="0.01" value={editData.investimento_anuncios} onChange={e => setEditData(p => ({ ...p, investimento_anuncios: e.target.value }))} style={{ fontSize: 12 }} />
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div><span style={{ color: '#6B6580' }}>Nome:</span> {lead.name || '-'}</div>
                        <div><span style={{ color: '#6B6580' }}>Tel:</span> {lead.phone || '-'} {lead.phone && lead.phone.replace(/\D/g,'').length !== 13 && <span style={{ color: '#FF6B6B', fontSize: 9 }}>⚠ numero incompleto</span>}</div>
                        <div><span style={{ color: '#6B6580' }}>Email:</span> {lead.email || '-'}</div>
                        <div><span style={{ color: '#6B6580' }}>Cidade:</span> {lead.city || '-'}</div>
                        {lead.empresa && <div><span style={{ color: '#6B6580' }}>Empresa:</span> {lead.empresa}</div>}
                        {lead.cpf_cnpj && <div><span style={{ color: '#6B6580' }}>CPF/CNPJ:</span> {lead.cpf_cnpj}</div>}
                        {lead.instagram && <div><span style={{ color: '#6B6580' }}>Instagram:</span> {lead.instagram}</div>}
                        <div><span style={{ color: '#6B6580' }}>Anuncio:</span> <span style={{ color: lead.trabalha_anuncio ? '#34C759' : '#9B96B0' }}>{lead.trabalha_anuncio ? 'Sim' : 'Nao'}</span></div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: '#6B6580' }}>Disparos:</span>
                          {!lead.opted_out_at || (lead.opted_in_at && lead.opted_in_at > lead.opted_out_at)
                            ? <span style={{ color: '#34C759', fontSize: 11 }}>Sim</span>
                            : <span style={{ color: '#FF6B6B', fontSize: 11 }}>Bloqueado</span>}
                        </div>
                        {lead.investimento_anuncios && <div><span style={{ color: '#6B6580' }}>Investimento:</span> R$ {Number(lead.investimento_anuncios).toLocaleString('pt-BR')}</div>}
                        <div><span style={{ color: '#6B6580' }}>Fonte:</span> {lead.source || '-'}</div>
                        <div><span style={{ color: '#6B6580' }}>Criado:</span> {parseSqlDate(lead.created_at).toLocaleDateString('pt-BR')}</div>
                      </div>
                    ))}
                  </div>

                  {/* Observacoes */}
                  <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: notesCollapsed ? 0 : 6 }}>
                      <div onClick={() => { if (!editingNotes) { setNotesCollapsed(p => { const v = !p; localStorage.setItem('chat_notes_collapsed', v ? '1' : '0'); return v }) } }} style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3, cursor: editingNotes ? 'default' : 'pointer', flex: 1 }}>
                        {!editingNotes && (notesCollapsed ? <ChevronDown size={12} style={{ color: '#9B96B0' }} /> : <ChevronUp size={12} style={{ color: '#9B96B0' }} />)}
                        <FileText size={10} /> Observacoes
                      </div>
                      {!editingNotes ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => { setNotesCollapsed(false); setNotesDraft(lead.notes || ''); setEditingNotes(true) }} style={{ padding: '2px 6px' }}><Edit3 size={10} /></button>
                      ) : (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-primary btn-sm" disabled={savingNotes} onClick={async () => {
                            setSavingNotes(true)
                            try { await updateLead(lead.id, { notes: notesDraft }); await loadLead(); setEditingNotes(false) }
                            catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao salvar', message: e.message }) }
                            setSavingNotes(false)
                          }} style={{ padding: '2px 6px' }}><Save size={10} /></button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingNotes(false)} style={{ padding: '2px 6px' }}><X size={10} /></button>
                        </div>
                      )}
                    </div>
                    {!notesCollapsed && (editingNotes ? (
                      <textarea className="input" value={notesDraft} onChange={e => setNotesDraft(e.target.value)} rows={4} style={{ width: '100%', resize: 'vertical', fontSize: 11, lineHeight: 1.4 }} placeholder="Anotacoes sobre o lead..." />
                    ) : (
                      lead.notes ? (
                        <div style={{ fontSize: 11, color: 'var(--text-secondary, var(--text-muted))', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{lead.notes}</div>
                      ) : (
                        <div style={{ fontSize: 10, color: '#6B6580' }}>Sem observacoes</div>
                      )
                    ))}
                  </div>

                  {/* Tags */}
                  <div className="card" style={{ padding: 12, marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tagsCollapsed ? 0 : 6 }}>
                      <div onClick={() => setTagsCollapsed(p => { const v = !p; localStorage.setItem('chat_tags_collapsed', v ? '1' : '0'); return v })} style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', flex: 1 }}>
                        {tagsCollapsed ? <ChevronDown size={12} style={{ color: '#9B96B0' }} /> : <ChevronUp size={12} style={{ color: '#9B96B0' }} />}
                        <TagIcon size={10} /> Tags
                      </div>
                      <div style={{ position: 'relative' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => { setTagsCollapsed(false); setShowTagMenu(!showTagMenu) }} style={{ padding: '2px 6px' }}><Plus size={10} /></button>
                        {showTagMenu && (
                          <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-medium)', borderRadius: 8, padding: 6, zIndex: 50, minWidth: 200 }}>
                            {availableTags.length > 0 && (
                              <>
                                {availableTags.map(t => (
                                  <button key={t.id} onClick={() => handleAddTag(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', border: 'none', background: 'none', color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer', width: '100%', textAlign: 'left' }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.color }} />{t.name}
                                  </button>
                                ))}
                                <div style={{ height: 1, background: 'var(--border-subtle)', margin: '6px 0' }} />
                              </>
                            )}
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: 2 }}>
                              <input type="color" value={newTagColor} onChange={e => setNewTagColor(e.target.value)} style={{ width: 22, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                              <input className="input" value={newTagName} onChange={e => setNewTagName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreateTag()} placeholder="Nova tag..." style={{ flex: 1, fontSize: 11, padding: '4px 6px' }} />
                              <button className="btn btn-primary btn-sm" onClick={handleCreateTag} disabled={!newTagName.trim()} style={{ padding: '4px 6px' }}><Plus size={10} /></button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    {!tagsCollapsed && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {lead.tags?.map(t => (
                          <span key={t.id} className="tag-pill" style={{ background: `${t.color}20`, color: t.color, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }} onClick={() => handleRemoveTag(t.id)}>
                            {t.name} <X size={7} />
                          </span>
                        ))}
                        {(!lead.tags || lead.tags.length === 0) && <span style={{ fontSize: 10, color: '#6B6580' }}>Sem tags</span>}
                      </div>
                    )}
                  </div>

                  {/* Cadence */}
                  <div className="card" style={{ padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: cadenceCollapsed ? 0 : 6 }}>
                      <div onClick={() => setCadenceCollapsed(p => { const v = !p; localStorage.setItem('chat_cadence_collapsed', v ? '1' : '0'); return v })} style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', flex: 1 }}>
                        {cadenceCollapsed ? <ChevronDown size={12} style={{ color: '#9B96B0' }} /> : <ChevronUp size={12} style={{ color: '#9B96B0' }} />}
                        <ListOrdered size={10} /> Cadencia
                      </div>
                      <div style={{ position: 'relative' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => { setCadenceCollapsed(false); setShowCadenceMenu(!showCadenceMenu) }} style={{ padding: '2px 8px', fontSize: 10 }}>{leadCadence ? 'Trocar' : 'Atribuir'}</button>
                        {showCadenceMenu && (
                          <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-medium)', borderRadius: 8, padding: 4, zIndex: 50, minWidth: 220, maxHeight: 320, overflowY: 'auto' }}>
                            {cadences.length === 0 && globalCadences.length === 0 && <div style={{ padding: 8, fontSize: 11, color: 'var(--text-muted)' }}>Nenhuma cadencia. Crie em /cadences</div>}
                            {cadences.length > 0 && (
                              <>
                                <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Desta conta</div>
                                {cadences.map(c => (
                                  <button key={c.id} onClick={() => handleAssignCadence(c.id)} style={{ display: 'block', padding: '6px 10px', border: 'none', background: 'none', color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer', borderRadius: 4, width: '100%', textAlign: 'left' }}>
                                    {c.name} <span style={{ color: 'var(--text-muted)' }}>({c.attempts.length} etapas)</span>
                                  </button>
                                ))}
                              </>
                            )}
                            {globalCadences.length > 0 && (
                              <>
                                <div style={{ padding: '6px 10px 4px', fontSize: 9, color: '#7ee787', textTransform: 'uppercase', letterSpacing: 0.5, borderTop: cadences.length > 0 ? '1px dashed var(--border-subtle)' : 'none', marginTop: cadences.length > 0 ? 4 : 0 }}>Templates globais</div>
                                {globalCadences.map(g => (
                                  <button key={`g-${g.id}`} onClick={() => handleAssignGlobalCadence(g.id)} disabled={applyingGlobalId === g.id} style={{ display: 'block', padding: '6px 10px', border: 'none', background: 'none', color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer', borderRadius: 4, width: '100%', textAlign: 'left', opacity: applyingGlobalId === g.id ? 0.5 : 1 }}>
                                    <span style={{ color: '#7ee787', fontSize: 9, marginRight: 4 }}>★</span>
                                    {g.name} <span style={{ color: 'var(--text-muted)' }}>({g.attempts.length} etapas)</span>
                                    {g.applied_here && <span style={{ color: '#7ee787', fontSize: 9, marginLeft: 4 }}>✓</span>}
                                    {applyingGlobalId === g.id && <span style={{ color: 'var(--text-muted)', fontSize: 9, marginLeft: 4 }}>aplicando...</span>}
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {!cadenceCollapsed && (leadCadence ? (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{leadCadence.cadence_name}</div>
                          <div style={{ display: 'flex', gap: 3 }}>
                            <button className="btn btn-secondary btn-sm" style={{ padding: '2px 6px', fontSize: 9 }} onClick={() => { const base = import.meta.env.BASE_URL.replace(/\/$/, ''); window.open(`${base}/cadences`, '_blank') }}>Editar</button>
                            <button className="btn btn-danger btn-sm" style={{ padding: '2px 6px', fontSize: 9 }} onClick={async () => {
                              if (!accountId || !confirm('Remover cadencia deste lead?')) return
                              await removeLeadCadence(leadCadence.id, accountId)
                              loadLead()
                            }}>Remover</button>
                          </div>
                        </div>
                        {leadCadence.status === 'completed' ? (
                          <div style={{ fontSize: 11, color: '#34C759', display: 'flex', alignItems: 'center', gap: 3, marginTop: 4 }}><Check size={10} /> Concluida</div>
                        ) : (
                          <>
                            <div style={{ fontSize: 11, color: '#FFB300', marginTop: 2 }}>Etapa {(leadCadence.attempt_position ?? 0) + 1}/{leadCadence.total_attempts}: {leadCadence.action_type?.toUpperCase()}</div>
                            {leadCadence.attempt_description && <div style={{ fontSize: 11, color: 'var(--text-primary)', marginTop: 2, fontWeight: 500 }}>{leadCadence.attempt_description}</div>}
                            {leadCadence.attempt_instructions && <div style={{ fontSize: 10, color: '#9B96B0', marginTop: 2, fontStyle: 'italic' }}>{leadCadence.attempt_instructions}</div>}
                            {leadCadence.attempt_message ? (
                              <>
                                <textarea className="input" value={cadenceMsgText} onChange={e => setCadenceMsgText(e.target.value)} rows={3} style={{ marginTop: 8, fontSize: 11, resize: 'vertical', background: 'rgba(255,179,0,0.05)', border: '1px solid rgba(255,179,0,0.2)' }} />
                                <button className="btn btn-primary btn-sm" style={{ marginTop: 8, width: '100%', fontSize: 11 }} onClick={handleSendCadenceMessage} disabled={sending || !cadenceMsgText.trim()}><Send size={10} /> Enviar e avancar</button>
                                <button className="btn btn-secondary btn-sm" style={{ marginTop: 6, width: '100%', fontSize: 10 }} onClick={handleAdvanceCadence}><ChevronRight size={10} /> So avancar (sem enviar)</button>
                              </>
                            ) : leadCadence.attempt_script ? (
                              <>
                                <button className="btn btn-primary btn-sm" style={{ marginTop: 8, width: '100%', fontSize: 11 }} onClick={handleViewScript}><FileText size={10} /> Ver script</button>
                                <button className="btn btn-secondary btn-sm" style={{ marginTop: 6, width: '100%', fontSize: 10 }} onClick={handleAdvanceCadence}><ChevronRight size={10} /> Avancar</button>
                              </>
                            ) : (
                              <button className="btn btn-primary btn-sm" style={{ marginTop: 8, width: '100%', fontSize: 11 }} onClick={handleAdvanceCadence}><ChevronRight size={10} /> Avancar</button>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: '#6B6580' }}>Nenhuma cadencia atribuida</div>
                    ))}
                  </div>

                  {/* Follow-up (cadencia automatica) */}
                  <div className="card" style={{ padding: 12, marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Zap size={10} /> Follow-up (auto)
                      </div>
                      <div style={{ position: 'relative' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setShowFollowUpMenu(!showFollowUpMenu)} style={{ padding: '2px 8px', fontSize: 10 }}>
                          {leadFollowUp ? 'Trocar' : 'Atribuir'}
                        </button>
                        {showFollowUpMenu && (() => {
                          const localSeq = followUps.filter(f => f.is_active && (f.type || 'sequence') === 'sequence')
                          const globalSeq = globalFollowUps.filter(g => (g.type || 'sequence') === 'sequence')
                          return (
                            <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-medium)', borderRadius: 8, padding: 4, zIndex: 50, minWidth: 240, maxHeight: 320, overflowY: 'auto' }}>
                              {localSeq.length === 0 && globalSeq.length === 0 && <div style={{ padding: 8, fontSize: 11, color: 'var(--text-muted)' }}>Nenhum follow-up. Crie em /follow-ups</div>}
                              {localSeq.length > 0 && (
                                <>
                                  <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Desta conta</div>
                                  {localSeq.map(f => (
                                    <button key={f.id} onClick={() => handleAssignFollowUp(f.id)} style={{ display: 'block', padding: '6px 10px', border: 'none', background: 'none', color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer', borderRadius: 4, width: '100%', textAlign: 'left' }}>
                                      {f.name} <span style={{ color: 'var(--text-muted)' }}>({f.steps_count} etapas · {f.instance_name})</span>
                                    </button>
                                  ))}
                                </>
                              )}
                              {globalSeq.length > 0 && (
                                <>
                                  <div style={{ padding: '6px 10px 4px', fontSize: 9, color: '#7ee787', textTransform: 'uppercase', letterSpacing: 0.5, borderTop: localSeq.length > 0 ? '1px dashed var(--border-subtle)' : 'none', marginTop: localSeq.length > 0 ? 4 : 0 }}>Templates globais</div>
                                  {globalSeq.map(g => (
                                    <button key={`g-${g.id}`} onClick={() => handleAssignGlobalFollowUp(g.id)} disabled={applyingGlobalFuId === g.id} style={{ display: 'block', padding: '6px 10px', border: 'none', background: 'none', color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer', borderRadius: 4, width: '100%', textAlign: 'left', opacity: applyingGlobalFuId === g.id ? 0.5 : 1 }}>
                                      <span style={{ color: '#7ee787', fontSize: 9, marginRight: 4 }}>★</span>
                                      {g.name} <span style={{ color: 'var(--text-muted)' }}>({g.steps.length} steps)</span>
                                      {g.applied_here && <span style={{ color: '#7ee787', fontSize: 9, marginLeft: 4 }}>✓</span>}
                                      {applyingGlobalFuId === g.id && <span style={{ color: 'var(--text-muted)', fontSize: 9, marginLeft: 4 }}>aplicando...</span>}
                                    </button>
                                  ))}
                                </>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                    {leadFollowUp ? (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{leadFollowUp.follow_up_name}</div>
                        <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 2 }}>
                          <Smartphone size={10} style={{ verticalAlign: -1 }} /> {leadFollowUp.instance_name || '—'}
                        </div>
                        {leadFollowUp.status === 'completed' ? (
                          <div style={{ fontSize: 11, color: '#34C759', marginTop: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Check size={10} /> Concluído (todas etapas enviadas)
                          </div>
                        ) : leadFollowUp.status === 'cancelled' ? (
                          <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>Cancelado</div>
                        ) : leadFollowUp.status === 'paused' ? (
                          <>
                            <div style={{ fontSize: 11, color: '#FBBC04', marginTop: 4 }}>
                              ⏸ Pausado — {leadFollowUp.paused_reason === 'lead_replied' ? 'lead respondeu' :
                                leadFollowUp.paused_reason === 'instance_offline' ? 'instância offline' :
                                leadFollowUp.paused_reason === 'instance_removed' ? 'instância removida' :
                                leadFollowUp.paused_reason === 'manual' ? 'pausado manualmente' :
                                leadFollowUp.paused_reason === 'lead_blocked' ? 'lead bloqueado — desbloqueie pra retomar' :
                                leadFollowUp.paused_reason === 'lead_archived' ? 'lead arquivado — desarquive pra retomar' :
                                leadFollowUp.paused_reason === 'lead_inactive' ? 'lead inativo' :
                                leadFollowUp.paused_reason === 'lead_no_phone' ? 'lead sem telefone' :
                                leadFollowUp.paused_reason === 'send_failed' ? 'envio recusado pela Evolution' :
                                leadFollowUp.paused_reason === 'send_error' ? 'erro de rede no envio' :
                                leadFollowUp.paused_reason === 'follow_up_inactive' ? 'follow-up desativado' :
                                leadFollowUp.paused_reason || ''}
                            </div>
                            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                              <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '3px 8px', flex: 1 }} onClick={handleResumeFollowUp}>
                                <Play size={10} /> Retomar
                              </button>
                              <button className="btn btn-danger btn-sm" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleCancelFollowUp}>
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: 11, color: '#FFB300', marginTop: 4 }}>
                              Etapa {leadFollowUp.current_position}/{leadFollowUp.total_steps}
                            </div>
                            {leadFollowUp.next_run_at && (
                              <div style={{ fontSize: 10, color: '#9B96B0', marginTop: 2 }}>
                                Próximo envio: {parseSqlDate(leadFollowUp.next_run_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                              <button className="btn btn-secondary btn-sm" style={{ fontSize: 10, padding: '3px 8px', flex: 1 }} onClick={handlePauseFollowUp}>
                                <Pause size={10} /> Pausar
                              </button>
                              <button className="btn btn-danger btn-sm" style={{ fontSize: 10, padding: '3px 8px' }} onClick={handleCancelFollowUp}>
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: '#6B6580' }}>Nenhum follow-up ativo</div>
                    )}
                  </div>

                  {/* Lead pending tasks */}
                  {leadTasks.length > 0 && (
                    <div className="card" style={{ padding: 12, marginTop: 12 }}>
                      <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3, marginBottom: 8 }}>
                        <ListTodo size={10} /> Tarefas Pendentes ({leadTasks.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {leadTasks.map((t: any) => {
                          const due = parseSqlDate(t.due_datetime)
                          const overdue = due.getTime() < Date.now()
                          const isCadence = t.type === 'cadence'
                          const accent = isCadence ? '#FFB300' : '#9B59B6'
                          const key = isCadence ? `c-${t.lead_cadence_id}` : `s-${t.id}`
                          const title = isCadence
                            ? `${t.cadence_name} · Etapa ${(t.attempt_position || 0) + 1}/${t.total_attempts}`
                            : t.title
                          const desc = isCadence ? (t.attempt_description || t.auto_message) : t.description
                          return (
                            <div key={key} style={{ padding: '8px 10px', background: overdue ? 'rgba(255,107,107,0.06)' : `${accent}10`, border: `1px solid ${overdue ? 'rgba(255,107,107,0.2)' : `${accent}30`}`, borderLeft: `3px solid ${accent}`, borderRadius: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: `${accent}25`, color: accent, fontWeight: 700, textTransform: 'uppercase' }}>
                                  {isCadence ? 'Cadencia' : 'Avulsa'}
                                </span>
                                <div style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{title}</div>
                              </div>
                              {desc && <div style={{ fontSize: 11, color: '#9B96B0', marginBottom: 4 }}>{desc.substring(0, 100)}{desc.length > 100 ? '...' : ''}</div>}
                              <div style={{ fontSize: 10, color: overdue ? '#FF6B6B' : '#9B96B0', display: 'flex', alignItems: 'center', gap: 3, marginBottom: 6 }}>
                                <Clock size={9} /> {due.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                {!isCadence && t.assigned_name && <span> · {t.assigned_name}</span>}
                                {isCadence && t.action_type && <span> · {t.action_type}</span>}
                              </div>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button className="btn btn-primary btn-sm" onClick={async () => {
                                  if (!accountId || !lead) return
                                  try {
                                    if (isCadence) await completeTask(t.lead_cadence_id, accountId)
                                    else await completeStandaloneTask(t.id, accountId)
                                    fetchLeadTasks(lead.id, accountId).then(setLeadTasks)
                                  } catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao concluir', message: e.message }) }
                                }} style={{ fontSize: 10, padding: '3px 8px', background: '#34C759', borderColor: '#34C759', flex: 1 }}>
                                  <Check size={10} /> Concluir
                                </button>
                                {isCadence ? (
                                  <button className="btn btn-secondary btn-sm" onClick={async () => {
                                    if (!accountId || !lead) return
                                    if (!confirm('Pular esta etapa da cadencia?')) return
                                    try { await skipTask(t.lead_cadence_id, accountId); fetchLeadTasks(lead.id, accountId).then(setLeadTasks) } catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao pular', message: e.message }) }
                                  }} style={{ fontSize: 10, padding: '3px 8px' }} title="Pular etapa">
                                    <ChevronRight size={10} />
                                  </button>
                                ) : (
                                  <>
                                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingTask(t)} style={{ fontSize: 10, padding: '3px 8px' }} title="Editar">
                                      <Edit3 size={10} />
                                    </button>
                                    <button className="btn btn-secondary btn-sm" onClick={async () => { if (!accountId || !lead) return; if (!confirm('Excluir tarefa?')) return; await deleteStandaloneTask(t.id, accountId); fetchLeadTasks(lead.id, accountId).then(setLeadTasks) }} style={{ fontSize: 10, padding: '3px 8px', color: '#FF6B6B' }} title="Excluir">
                                      <Trash2 size={10} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Standalone Task */}
                  <div className="card" style={{ padding: 12, marginTop: 12 }}>
                    <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3, marginBottom: 6 }}><ListTodo size={10} /> Nova Tarefa</div>
                    <input className="input" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Ex: Ligar para o paciente" style={{ fontSize: 11, marginBottom: 6 }} />
                    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                      <button className={`btn btn-sm ${taskMode === 'duration' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTaskMode('duration')} style={{ fontSize: 10, padding: '3px 8px' }}>Tempo</button>
                      <button className={`btn btn-sm ${taskMode === 'date' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTaskMode('date')} style={{ fontSize: 10, padding: '3px 8px' }}>Data</button>
                    </div>
                    {taskMode === 'duration' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                        <input type="number" className="input" value={taskMinutes} onChange={e => setTaskMinutes(e.target.value)} style={{ width: 60, fontSize: 11, textAlign: 'center' }} min={1} />
                        <span style={{ fontSize: 11, color: '#9B96B0' }}>minutos</span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                        <input type="date" className="input" value={taskDate} onChange={e => setTaskDate(e.target.value)} style={{ fontSize: 11, flex: 1 }} />
                        <input type="time" className="input" value={taskTime} onChange={e => setTaskTime(e.target.value)} style={{ fontSize: 11, width: 90 }} />
                      </div>
                    )}
                    <button className="btn btn-primary btn-sm" style={{ width: '100%', fontSize: 11 }} disabled={!taskTitle.trim() || creatingTask} onClick={async () => {
                      if (!accountId || !lead) return
                      setCreatingTask(true)
                      try {
                        await createStandaloneTask(accountId, {
                          lead_id: lead.id,
                          title: taskTitle,
                          due_mode: taskMode,
                          due_minutes: parseInt(taskMinutes) || 10,
                          due_date: taskDate,
                          due_time: taskTime,
                        })
                        setTaskTitle(''); setTaskMinutes('10'); setTaskDate(''); setTaskTime('')
                        if (lead) fetchLeadTasks(lead.id, accountId).then(setLeadTasks)
                        setNotice({ kind: 'success', title: 'Tarefa criada', message: 'A tarefa foi adicionada com sucesso.' })
                      } catch (e: any) { setNotice({ kind: 'error', title: 'Erro ao criar tarefa', message: e?.message || 'Erro desconhecido' }) }
                      setCreatingTask(false)
                    }}>
                      <ListTodo size={10} /> {creatingTask ? 'Criando...' : 'Criar Tarefa'}
                    </button>
                  </div>

                  {/* Archive + Block */}
                  <div className="card" style={{ padding: 12, marginTop: 12 }}>
                    <div style={{ fontSize: 10, color: '#9B96B0', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 3, marginBottom: 6 }}><Archive size={10} /> Arquivar / Excluir</div>
                    <div style={{ fontSize: 11, color: '#6B6580', marginBottom: 4 }}><strong>Arquivar:</strong> some do pipeline/chat. Msgs futuras ainda chegam. Histórico preservado.</div>
                    <button className="btn btn-secondary btn-sm" style={{ width: '100%', fontSize: 11, marginBottom: 8 }} onClick={() => handleArchiveLead(lead.id)}>
                      <Archive size={12} /> Arquivar lead
                    </button>
                    <div style={{ fontSize: 11, color: '#6B6580', marginBottom: 4 }}><strong>Excluir:</strong> some do CRM e msgs futuras desse número são IGNORADAS.</div>
                    <button className="btn btn-danger btn-sm" style={{ width: '100%', fontSize: 11 }} onClick={() => handleBlockLead(lead.id, lead.phone)}>
                      <Ban size={12} /> Excluir lead (bloquear número)
                    </button>
                  </div>
                </>
              )}

              {rightTab === 'notes' && (
                <>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    <input className="input" placeholder="Nota interna..." value={noteText} onChange={e => setNoteText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddNote()} style={{ fontSize: 12 }} />
                    <button className="btn btn-primary btn-icon" onClick={handleAddNote} disabled={!noteText.trim()}><Plus size={14} /></button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {notes.map(n => (
                      <div key={n.id} style={{ padding: '8px 10px', background: 'rgba(255,179,0,0.05)', borderRadius: 6, border: '1px solid rgba(255,179,0,0.1)' }}>
                        <div style={{ fontSize: 12 }}>{n.content}</div>
                        <div style={{ fontSize: 9, color: '#6B6580', marginTop: 2 }}>{n.user_name} · {parseSqlDate(n.created_at).toLocaleString('pt-BR')}</div>
                      </div>
                    ))}
                    {notes.length === 0 && <div style={{ textAlign: 'center', color: '#6B6580', padding: 20, fontSize: 11 }}>Sem notas</div>}
                  </div>
                </>
              )}

              {rightTab === 'history' && (
                <>
                  {history.map((h, i) => (
                    <div key={h.id} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: i < history.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                      <Clock size={10} style={{ color: '#FFB300', marginTop: 3, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: 11 }}>{h.from_stage_name ? `${h.from_stage_name} → ${h.to_stage_name}` : `Entrada: ${h.to_stage_name}`}</div>
                        <div style={{ fontSize: 9, color: '#6B6580' }}>{h.trigger_type}{h.user_name ? ` · ${h.user_name}` : ''}</div>
                        <div style={{ fontSize: 9, color: '#6B6580' }}>{parseSqlDate(h.created_at).toLocaleString('pt-BR')}</div>
                      </div>
                    </div>
                  ))}
                  {history.length === 0 && <div style={{ textAlign: 'center', color: '#6B6580', padding: 20, fontSize: 11 }}>Sem historico</div>}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {editingTask && lead && accountId && (
        <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} onSaved={() => { fetchLeadTasks(lead.id, accountId).then(setLeadTasks); setEditingTask(null) }} />
      )}
      {scriptModal && (
        <div className="modal-overlay" onClick={() => setScriptModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Phone size={16} style={{ color: '#FFB300' }} /> Script de Ligacao</h2>
            <div style={{ background: 'rgba(255,179,0,0.05)', border: '1px solid rgba(255,179,0,0.2)', borderRadius: 8, padding: 16, marginTop: 12, maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}>
              {scriptModal.text}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setScriptModal(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      {/* Notice modal (substitui alert do browser) */}
      {notice && (
        <div className="modal-overlay" onClick={() => setNotice(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {notice.kind === 'error' ? <X size={18} style={{ color: '#FF6B6B' }} /> : notice.kind === 'success' ? <Check size={18} style={{ color: '#34C759' }} /> : <MessageCircle size={18} style={{ color: '#FFB300' }} />}
              {notice.title}
            </h2>
            <p style={{ fontSize: 13, color: '#C8C2D8', marginTop: 8, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{notice.message}</p>
            <div className="modal-actions">
              {notice.actions && notice.actions.length > 0 ? (
                <>
                  <button className="btn btn-secondary" onClick={() => setNotice(null)}>Fechar</button>
                  {notice.actions.map((a, i) => (
                    <button
                      key={i}
                      className={`btn ${a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => { a.onClick(); setNotice(null) }}
                    >
                      {a.label}
                    </button>
                  ))}
                </>
              ) : (
                <button className="btn btn-primary" onClick={() => setNotice(null)} autoFocus>OK</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Novo chat modal */}
      {showNewChat && (
        <div className="modal-overlay" onClick={() => !creatingNewChat && setShowNewChat(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <MessageSquarePlus size={18} style={{ color: '#FFB300' }} /> Novo chat
            </h2>
            <p style={{ fontSize: 12, color: '#9B96B0', marginTop: 4 }}>
              Cria um contato e abre a conversa direto no chat.
            </p>
            <div className="form-group">
              <label>Nome</label>
              <input
                className="input"
                value={newChatName}
                onChange={e => setNewChatName(e.target.value)}
                placeholder="Ex: Joao Silva"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleCreateNewChat() }}
              />
            </div>
            <div className="form-group">
              <label>Telefone (com DDD)</label>
              <input
                className="input"
                value={newChatPhone}
                onChange={e => setNewChatPhone(e.target.value)}
                placeholder="Ex: 11999999999"
                inputMode="numeric"
                onKeyDown={e => { if (e.key === 'Enter') handleCreateNewChat() }}
              />
              <p style={{ fontSize: 10, color: '#6B6580', marginTop: 4 }}>
                Sem precisar de + ou DDI. Use codigo do pais + DDD + numero (11 digitos).
              </p>
            </div>
            {connectedInstances.length > 0 && (
              <div className="form-group">
                <label>Enviar de qual WhatsApp?</label>
                <select
                  className="select"
                  value={newChatInstanceId ?? (connectedInstances.length === 1 ? connectedInstances[0].id : '')}
                  onChange={e => setNewChatInstanceId(e.target.value ? +e.target.value : null)}
                >
                  {connectedInstances.length > 1 && <option value="">— escolha —</option>}
                  {connectedInstances.map(i => (
                    <option key={i.id} value={i.id}>{i.instance_name}{i.phone_number ? ` (${i.phone_number})` : ''}</option>
                  ))}
                </select>
                {connectedInstances.length === 0 && (
                  <p style={{ fontSize: 10, color: '#FF6B6B', marginTop: 4 }}>Nenhum WhatsApp conectado.</p>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowNewChat(false)} disabled={creatingNewChat}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCreateNewChat} disabled={creatingNewChat || !newChatPhone.trim()}>
                {creatingNewChat ? 'Criando...' : 'Criar e abrir chat'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isMobile && (
        <nav className="chat-mobile-bottom-nav">
          <button className="chat-mobile-tab" onClick={openSidebarMenu} title="Menu">
            <MenuIcon size={18} />
            <span>Menu</span>
          </button>
          <button
            className={`chat-mobile-tab ${mobileTab === 'conversas' ? 'active' : ''}`}
            onClick={() => switchMobileTab('conversas')}
            title="Conversas"
          >
            <MessageCircle size={18} />
            <span>Conversas</span>
          </button>
          <button
            className={`chat-mobile-tab ${mobileTab === 'chat' ? 'active' : ''}`}
            onClick={() => switchMobileTab('chat')}
            disabled={!lead}
            title="Chat"
          >
            <MessagesSquare size={18} />
            <span>Chat</span>
          </button>
          <button
            className={`chat-mobile-tab ${mobileTab === 'info' ? 'active' : ''}`}
            onClick={() => switchMobileTab('info')}
            disabled={!lead}
            title="Info"
          >
            <InfoIcon size={18} />
            <span>Info</span>
          </button>
          <button
            className={`chat-mobile-tab ${mobileTab === 'history' ? 'active' : ''}`}
            onClick={() => switchMobileTab('history')}
            disabled={!lead}
            title="Histórico"
          >
            <HistoryIcon size={18} />
            <span>Histórico</span>
          </button>
        </nav>
      )}

      {/* Modal de atribuicao de atendente — pergunta se quer enviar 1a msg automatica */}
      {assignModal && (
        <div className="modal-overlay" onClick={() => !assignSaving && setAssignModal(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginBottom: 8 }}>Atribuir lead pra atendente</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
              Novo atendente: <strong>{assignModal.userName}</strong>
            </p>

            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={assignNotify}
                  onChange={e => setAssignNotify(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ fontSize: 13 }}>
                  <strong>Disparar saudação automática do novo atendente</strong>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                    Se marcado:
                    <ul style={{ margin: '4px 0', paddingLeft: 16 }}>
                      <li>Atendente <strong>humano</strong>: envia a "Mensagem inicial" configurada na instância dele</li>
                      <li>Atendente <strong>bot</strong>: bot se apresenta gerando saudação via IA (Haiku)</li>
                    </ul>
                    Se este lead já recebeu saudação do bot antes, o sistema pula silenciosamente.
                    <br /><strong>A notificação ao vendedor é enviada de qualquer jeito</strong> (mesmo desmarcado).
                  </div>
                </span>
              </label>
            </div>

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setAssignModal(null)} disabled={assignSaving}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmAssign} disabled={assignSaving}>
                {assignSaving ? 'Atribuindo...' : 'Confirmar atribuição'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
