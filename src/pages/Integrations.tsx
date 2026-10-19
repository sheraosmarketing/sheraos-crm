import { useState, useEffect, useRef, useCallback } from 'react'
import { useAccount } from '../context/AccountContext'
import { useAuth } from '../context/AuthContext'
import {
  fetchWhatsAppInstances, createWhatsAppInstance, connectWhatsAppInstance,
  checkWhatsAppStatus, refreshWhatsAppQR, disconnectWhatsApp, deleteWhatsAppInstance,
  fetchEvolutionConfig, saveEvolutionConfig, setupWhatsAppWebhook, restartWhatsAppInstance, syncWhatsAppNow, setInstanceAttendant, setInstanceMode, fetchUsers, apiFetch,
  updateMetaCapi, testMetaCapi, updateAiConfig, testAnthropic, updateInstanceFirstMsgTemplate,
  fetchTags, fetchTagInstanceMappings, upsertTagInstanceMapping, deleteTagInstanceMapping,
  fetchDefaultFormInstance, setDefaultFormInstance, fetchSheetsStatus, setSheetsDefaultTag,
  instanceLabel, renameWhatsAppInstanceLabel,
  type WhatsAppInstance, type User as UserType, type Account, type Tag, type TagInstanceMapping,
} from '../lib/api'
import { Plug, Plus, Wifi, WifiOff, Loader, Trash2, QrCode, Power, PowerOff, RefreshCw, Smartphone, Save, Check, Settings, FileSpreadsheet, Copy, Webhook, RotateCw, Download, User, Eye, EyeOff, Activity, AlertTriangle, MessageSquare, Link as LinkIcon, GitBranch, Edit2, Bell } from 'lucide-react'
import InstanceAutoMessagesModal from '../components/InstanceAutoMessagesModal'
import ForwardNotifModal from '../components/ForwardNotifModal'
import { BlockedBanner } from '../components/BlockedBanner'
import { parseSqlDate } from '../lib/dates'

function sheetsTimeAgo(s: string | null) {
  if (!s) return null
  const d = parseSqlDate(s)
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000))
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins}min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `há ${hrs}h`
  return `há ${Math.floor(hrs / 24)}d`
}

export default function Integrations() {
  const { accountId } = useAccount()
  const { user } = useAuth()
  const isAtendente = user?.role === 'atendente'
  const isGerenteOuAdmin = user?.role === 'gerente' || user?.role === 'super_admin'
  const [instances, setInstances] = useState<WhatsAppInstance[]>([])
  const [loading, setLoading] = useState(true)
  // First msg template editor
  const [tplModal, setTplModal] = useState<{ inst: WhatsAppInstance; value: string } | null>(null)
  const [tplSaving, setTplSaving] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newMode, setNewMode] = useState<'open' | 'restricted'>('open')
  const [creating, setCreating] = useState(false)
  const [activeQR, setActiveQR] = useState<number | null>(null)
  const pollRef = useRef<Record<number, ReturnType<typeof setInterval>>>({})

  // Evolution config
  const [evoUrl, setEvoUrl] = useState('')
  const [evoKey, setEvoKey] = useState('')
  const [evoSaved, setEvoSaved] = useState(false)
  const [evoConfigured, setEvoConfigured] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [accountSlug, setAccountSlug] = useState('')
  const [sheetsCopied, setSheetsCopied] = useState(false)
  const [sheetsTabName, setSheetsTabName] = useState('')
  const [scriptCopied, setScriptCopied] = useState(false)

  // Meta CAPI
  const [account, setAccount] = useState<Account | null>(null)
  const [metaPixelId, setMetaPixelId] = useState('')
  const [metaCapiToken, setMetaCapiToken] = useState('')
  const [metaPageId, setMetaPageId] = useState('')
  const [metaEnabled, setMetaEnabled] = useState(false)
  const [showMetaToken, setShowMetaToken] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  const [metaSaved, setMetaSaved] = useState(false)
  const [testingMeta, setTestingMeta] = useState(false)
  const [metaTestResult, setMetaTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [showTestMetaConfirm, setShowTestMetaConfirm] = useState(false)
  // IA — chave Anthropic por conta + limite
  const [anthropicKey, setAnthropicKey] = useState('')
  const [showAnthropicKey, setShowAnthropicKey] = useState(false)
  const [anthropicLimit, setAnthropicLimit] = useState<number>(200000)
  const [savingAnthropic, setSavingAnthropic] = useState(false)
  const [anthropicSaved, setAnthropicSaved] = useState(false)
  const [testingAnthropic, setTestingAnthropic] = useState(false)
  const [anthropicTestResult, setAnthropicTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [users, setUsers] = useState<UserType[]>([])

  useEffect(() => {
    if (!accountId) return
    fetchUsers(accountId).then(setUsers).catch(() => {})
  }, [accountId])

  const handleAttendantChange = async (inst: WhatsAppInstance, attendantId: number | null) => {
    if (!accountId) return
    try {
      const { instance } = await setInstanceAttendant(inst.id, accountId, attendantId)
      setInstances(prev => prev.map(i => i.id === instance.id ? instance : i))
    } catch (e: any) {
      alert('Erro: ' + e.message)
    }
  }

  const handleModeChange = async (inst: WhatsAppInstance, mode: 'open' | 'restricted') => {
    if (!accountId) return
    if (mode === 'restricted') {
      const ok = confirm(
        'Trocar pra modo RESTRITO?\n\n' +
        'Mensagens de numeros desconhecidos serao IGNORADAS — so processa leads ja cadastrados no CRM (form, planilha, ou Novo chat).\n\n' +
        'Conversas atuais continuam normais. Pra reverter, clica no badge de novo.'
      )
      if (!ok) return
    }
    try {
      const { instance } = await setInstanceMode(inst.id, accountId, mode)
      setInstances(prev => prev.map(i => i.id === instance.id ? instance : i))
    } catch (e: any) {
      alert('Erro: ' + e.message)
    }
  }

  const load = useCallback(() => {
    if (!accountId) return
    setLoading(true)
    Promise.all([
      fetchWhatsAppInstances(accountId),
      fetchEvolutionConfig(accountId),
    ]).then(([insts, config]) => {
      setInstances(insts)
      setEvoUrl(config.api_url || '')
      setEvoKey(config.api_key || '')
      // Prefere a flag `configured` do back (sanitizada pra atendente); fallback pro check antigo.
      setEvoConfigured(typeof config.configured === 'boolean' ? config.configured : !!(config.api_url && config.api_key))
    }).finally(() => setLoading(false))
    // Load account slug for webhook URLs
    apiFetch(`/api/accounts/${accountId}`).then((d: any) => {
      setAccountSlug(d.account?.slug || '')
      setAccount(d.account || null)
      setMetaPixelId(d.account?.meta_pixel_id || '')
      setMetaCapiToken(d.account?.meta_capi_token || '')
      setMetaPageId(d.account?.meta_page_id || '')
      setMetaEnabled(!!d.account?.meta_capi_enabled)
      setAnthropicKey(d.account?.anthropic_api_key || '')
      setAnthropicLimit(d.account?.analysis_token_limit || 200000)
    }).catch(() => {})
  }, [accountId])

  useEffect(() => { load() }, [load])

  // Auto-poll status for connecting instances
  useEffect(() => {
    Object.values(pollRef.current).forEach(clearInterval)
    pollRef.current = {}

    instances.forEach(inst => {
      if (inst.status === 'connecting' && accountId) {
        pollRef.current[inst.id] = setInterval(async () => {
          try {
            const { instance: updated } = await checkWhatsAppStatus(inst.id, accountId)
            setInstances(prev => prev.map(i => i.id === updated.id ? updated : i))
            if (updated.status === 'connected') {
              clearInterval(pollRef.current[updated.id])
              delete pollRef.current[updated.id]
              setActiveQR(null)
            } else if (updated.status === 'connecting' && !updated.qr_code) {
              // Se ainda em connecting sem QR (Evolution recuperando ou 1a tentativa falhou),
              // pede refresh pra garantir que o QR aparece assim que Evolution devolver.
              try {
                const refreshed = await refreshWhatsAppQR(updated.id, accountId)
                setInstances(prev => prev.map(i => i.id === refreshed.id ? refreshed : i))
                if (refreshed.qr_code) setActiveQR(refreshed.id)
              } catch {}
            }
          } catch {}
        }, 5000)
      }
    })

    return () => { Object.values(pollRef.current).forEach(clearInterval); pollRef.current = {} }
  }, [instances.map(i => `${i.id}:${i.status}`).join(','), accountId])

  const handleSaveConfig = async () => {
    if (!accountId || !evoUrl || !evoKey) return
    setSavingConfig(true)
    try {
      await saveEvolutionConfig(accountId, { api_url: evoUrl, api_key: evoKey })
      setEvoConfigured(true)
      setEvoSaved(true)
      setTimeout(() => setEvoSaved(false), 2000)
    } catch (e: any) { alert('Erro: ' + e.message) }
    setSavingConfig(false)
  }

  const handleCreate = async () => {
    if (!accountId || !newName.trim()) return
    setCreating(true)
    try {
      const inst = await createWhatsAppInstance(accountId, { instance_name: newName.trim(), lead_intake_mode: newMode })
      setShowNew(false)
      setNewName('')
      setNewMode('open')
      if (inst.qr_code) setActiveQR(inst.id)
      load()
    } catch (e: any) { alert('Erro: ' + e.message) }
    setCreating(false)
  }

  const handleConnect = async (inst: WhatsAppInstance) => {
    if (!accountId) return
    try {
      const updated = await connectWhatsAppInstance(inst.id, accountId)
      setInstances(prev => prev.map(i => i.id === updated.id ? updated : i))
      // Abre painel imediatamente se ficou em connecting, mesmo sem QR ainda
      // (auto-poll vai pedir refresh e preencher em segundos)
      if (updated.status === 'connecting' || updated.qr_code) setActiveQR(updated.id)
      // Se qr veio null na 1a tentativa, faz refresh imediato pra recuperar
      if (updated.status === 'connecting' && !updated.qr_code) {
        try {
          const refreshed = await refreshWhatsAppQR(inst.id, accountId)
          setInstances(prev => prev.map(i => i.id === refreshed.id ? refreshed : i))
        } catch {}
      }
    } catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handleRefreshQR = async (inst: WhatsAppInstance) => {
    if (!accountId) return
    try {
      const updated = await refreshWhatsAppQR(inst.id, accountId)
      setInstances(prev => prev.map(i => i.id === updated.id ? updated : i))
    } catch (e: any) { alert('Erro: ' + e.message) }
  }

  const handleDisconnect = async (inst: WhatsAppInstance) => {
    if (!accountId) return
    // FASE 1 bloco D — confirm antes de derrubar sessao WhatsApp (evita clique acidental)
    if (!confirm(`Desconectar "${instanceLabel(inst)}"?\n\nO WhatsApp vai sair da sessao e todo cliente que tentar mandar msg NAO vai chegar ate reconectar (leva minutos).`)) return
    await disconnectWhatsApp(inst.id, accountId)
    setActiveQR(null)
    load()
  }

  const [deleteTarget, setDeleteTarget] = useState<WhatsAppInstance | null>(null)
  const [deleting, setDeleting] = useState(false)
  const handleDelete = (inst: WhatsAppInstance) => setDeleteTarget(inst)
  const confirmDelete = async () => {
    if (!accountId || !deleteTarget) return
    setDeleting(true)
    try {
      await deleteWhatsAppInstance(deleteTarget.id, accountId)
      setActiveQR(null)
      setDeleteTarget(null)
      load()
    } catch (e: any) {
      alert('Erro ao deletar: ' + e.message)
    }
    setDeleting(false)
  }

  const [reconfiguring, setReconfiguring] = useState<number | null>(null)
  const handleReconfigureWebhook = async (inst: WhatsAppInstance) => {
    if (!accountId) return
    setReconfiguring(inst.id)
    try {
      await setupWhatsAppWebhook(inst.id, accountId)
      alert('Webhook reconfigurado com sucesso. Os leads voltarao a entrar em tempo real.')
    } catch (e: any) {
      alert('Erro ao reconfigurar webhook: ' + e.message)
    }
    setReconfiguring(null)
  }

  const [restarting, setRestarting] = useState<number | null>(null)
  const [autoMsgInstance, setAutoMsgInstance] = useState<WhatsAppInstance | null>(null)
  const [forwardNotifInstance, setForwardNotifInstance] = useState<WhatsAppInstance | null>(null)
  const [sheetsLastAt, setSheetsLastAt] = useState<string | null>(null)
  const [sheetsDefaultTagId, setSheetsDefaultTagId] = useState<number | null>(null)
  const [sheetsTagSaving, setSheetsTagSaving] = useState(false)

  // Roteamento de leads de formulario (tag → instancia)
  const [routingMappings, setRoutingMappings] = useState<TagInstanceMapping[]>([])
  const [routingDefaultId, setRoutingDefaultId] = useState<number | null>(null)
  const [routingTags, setRoutingTags] = useState<Tag[]>([])
  const [routingEdit, setRoutingEdit] = useState<{ tag_id: string; instance_id: string; attendant_id: string; isNew: boolean } | null>(null)
  const [routingSaving, setRoutingSaving] = useState(false)

  const loadRouting = useCallback(async () => {
    if (!accountId) return
    try {
      const [m, def, ts] = await Promise.all([
        fetchTagInstanceMappings(accountId).then(r => r.mappings).catch(() => []),
        fetchDefaultFormInstance(accountId).then(r => r.instance_id).catch(() => null),
        fetchTags(accountId).catch(() => []),
      ])
      setRoutingMappings(m); setRoutingDefaultId(def); setRoutingTags(ts)
    } catch {}
  }, [accountId])

  useEffect(() => { loadRouting() }, [loadRouting])

  useEffect(() => {
    if (!accountId) return
    fetchSheetsStatus(accountId).then(r => {
      setSheetsLastAt(r.last_lead_at)
      setSheetsDefaultTagId(r.default_tag_id)
    }).catch(() => {})
  }, [accountId])

  const handleChangeSheetsDefaultTag = async (tagId: number | null) => {
    if (!accountId) return
    setSheetsTagSaving(true)
    try {
      await setSheetsDefaultTag(accountId, tagId)
      setSheetsDefaultTagId(tagId)
    } catch (e: any) {
      alert('Erro: ' + (e.message || 'falha ao salvar tag default'))
    }
    setSheetsTagSaving(false)
  }

  const handleChangeDefaultRouting = async (instanceId: number | null) => {
    if (!accountId) return
    try { await setDefaultFormInstance(accountId, instanceId); setRoutingDefaultId(instanceId) }
    catch (e: any) { alert(e.message || 'Erro') }
  }

  const startRoutingEdit = (existing?: TagInstanceMapping) => {
    if (existing) {
      setRoutingEdit({
        tag_id: String(existing.tag_id),
        instance_id: String(existing.instance_id),
        attendant_id: existing.attendant_id ? String(existing.attendant_id) : '',
        isNew: false,
      })
    } else {
      setRoutingEdit({ tag_id: '', instance_id: '', attendant_id: '', isNew: true })
    }
  }

  const handleSaveRouting = async () => {
    if (!accountId || !routingEdit || !routingEdit.tag_id || !routingEdit.instance_id) return
    setRoutingSaving(true)
    try {
      await upsertTagInstanceMapping(accountId, {
        tag_id: Number(routingEdit.tag_id),
        instance_id: Number(routingEdit.instance_id),
        attendant_id: routingEdit.attendant_id ? Number(routingEdit.attendant_id) : null,
      })
      setRoutingEdit(null)
      await loadRouting()
    } catch (e: any) { alert(e.message || 'Erro ao salvar regra') }
    setRoutingSaving(false)
  }

  const handleDeleteRouting = async (tagId: number) => {
    if (!accountId) return
    if (!confirm('Remover essa regra?')) return
    try { await deleteTagInstanceMapping(accountId, tagId); await loadRouting() }
    catch (e: any) { alert(e.message || 'Erro') }
  }
  const handleRestart = async (inst: WhatsAppInstance) => {
    if (!accountId) return
    if (!confirm(`Reiniciar a sessao do WhatsApp "${instanceLabel(inst)}"? Use isso quando a instancia parecer conectada mas nao receber mensagens.`)) return
    setRestarting(inst.id)
    try {
      await restartWhatsAppInstance(inst.id, accountId)
      alert('Sessao reiniciada. Aguarde 10s e teste enviando uma mensagem.')
      load()
    } catch (e: any) {
      alert('Erro ao reiniciar: ' + e.message)
    }
    setRestarting(null)
  }

  const [syncing, setSyncing] = useState(false)
  const handleSyncNow = async () => {
    if (!accountId) return
    setSyncing(true)
    try {
      await syncWhatsAppNow(accountId)
      alert('Sincronizacao executada. Verifique a aba Chat — leads novos devem aparecer.')
    } catch (e: any) {
      alert('Erro ao sincronizar: ' + e.message)
    }
    setSyncing(false)
  }

  const getStatusIcon = (status: string) => {
    if (status === 'connected') return <Wifi size={14} />
    if (status === 'connecting') return <Loader size={14} className="spinning" />
    return <WifiOff size={14} />
  }
  const getStatusColor = (status: string) => status === 'connected' ? '#34C759' : status === 'connecting' ? '#FBBC04' : '#FF6B6B'
  const getStatusLabel = (status: string) => status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Aguardando QR...' : 'Desconectado'

  const qrInstance = instances.find(i => i.id === activeQR)

  if (loading) return <div className="loading-container"><div className="spinner" /></div>

  return (
    <div>
      <div className="page-header">
        <h1><Plug size={20} style={{ marginRight: 8 }} />Integracoes</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {evoConfigured && instances.some(i => i.status === 'connected') && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSyncNow}
              disabled={syncing}
              title="Forca uma busca imediata por mensagens perdidas em todas as instancias conectadas."
            >
              {syncing ? <Loader size={14} className="spinning" /> : <Download size={14} />} Sincronizar agora
            </button>
          )}
          {evoConfigured && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}><Plus size={14} /> Conectar WhatsApp</button>
          )}
        </div>
      </div>

      {isAtendente && !user?.primary_instance_id && (
        <BlockedBanner message="Voce ainda nao tem WhatsApp atribuido. Peca pro gerente atribuir em Equipe > Editar, ou conecte um novo WhatsApp acima (voce vira dono automaticamente)." />
      )}

      {/* Evolution API Config — so-leitura (auto-configurada pela infra Sheraos) */}
      {isGerenteOuAdmin && (
      <section className="dash-section">
        <div className="section-title"><Settings size={14} /> Configuracao Evolution API</div>
        <div className="card">
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            <Check size={12} style={{ verticalAlign: -1, marginRight: 4, color: '#34C759' }} />
            Configurado automaticamente pela infra Sheraos. Voce nao precisa preencher nada aqui.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>URL da API</label>
              <input className="input" value={evoUrl} readOnly style={{ opacity: 0.7, cursor: 'not-allowed' }} />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>API Key</label>
              <input className="input" type="password" value={evoKey ? '••••••••••••••••' : ''} readOnly style={{ opacity: 0.7, cursor: 'not-allowed' }} />
            </div>
          </div>
          {evoConfigured && <div style={{ fontSize: 11, color: '#34C759', marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}><Check size={12} /> Evolution API ativa</div>}
        </div>
      </section>
      )}

      {/* QR Code Panel */}
      {qrInstance && qrInstance.qr_code && qrInstance.status === 'connecting' && (
        <div className="card" style={{ marginBottom: 20, textAlign: 'center', padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 }}>
            <QrCode size={20} style={{ color: '#FFB300' }} />
            <h2 style={{ fontSize: 18, margin: 0 }}>Escaneie o QR Code — {instanceLabel(qrInstance)}</h2>
          </div>
          <div style={{ background: '#fff', display: 'inline-block', padding: 16, borderRadius: 12, marginBottom: 16 }}>
            <img
              src={qrInstance.qr_code.startsWith('data:') ? qrInstance.qr_code : `data:image/png;base64,${qrInstance.qr_code}`}
              alt="QR Code WhatsApp"
              style={{ width: 280, height: 280, display: 'block' }}
            />
          </div>
          <div style={{ fontSize: 13, color: '#9B96B0', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>
            <p><strong>1.</strong> Abra o WhatsApp no celular</p>
            <p><strong>2.</strong> Toque em <strong>Configuracoes → Aparelhos Conectados → Conectar Aparelho</strong></p>
            <p><strong>3.</strong> Aponte a camera para este QR Code</p>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => handleRefreshQR(qrInstance)}><RefreshCw size={12} /> Atualizar QR</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setActiveQR(null)}>Fechar</button>
          </div>
        </div>
      )}

      {/* Instances List */}
      {evoConfigured && (
        <section className="dash-section">
          <div className="section-title"><Smartphone size={14} /> Numeros WhatsApp</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {instances.map(inst => (
              <div key={inst.id} className="card" style={{ padding: '16px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: `${getStatusColor(inst.status)}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Smartphone size={18} style={{ color: getStatusColor(inst.status) }} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {instanceLabel(inst)}
                        <button
                          type="button"
                          title="Renomear (nao afeta a sessao WhatsApp)"
                          onClick={async () => {
                            const current = instanceLabel(inst)
                            const next = window.prompt('Novo nome para exibicao (nao afeta a sessao WhatsApp):', current)
                            if (!next || next.trim() === current) return
                            try {
                              const updated = await renameWhatsAppInstanceLabel(inst.id, accountId!, next.trim())
                              setInstances(prev => prev.map(i => i.id === inst.id ? { ...i, display_name: updated.display_name } : i))
                            } catch (err: any) { alert('Erro ao renomear: ' + (err?.message || 'desconhecido')) }
                          }}
                          style={{ background: 'transparent', border: 'none', color: '#9B96B0', cursor: 'pointer', padding: 2, display: 'inline-flex', alignItems: 'center' }}
                        ><Edit2 size={12} /></button>
                      </div>
                      {inst.phone_number && <div style={{ fontSize: 12, color: 'var(--text-secondary, var(--text-muted))' }}>{inst.phone_number}</div>}
                      {(
                        <>
                          <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <User size={11} /> Leads novos vao para:
                            <select
                              className="select"
                              value={inst.default_attendant_id ?? ''}
                              onChange={e => handleAttendantChange(inst, e.target.value ? parseInt(e.target.value) : null)}
                              style={{ height: 26, fontSize: 11, padding: '2px 8px', minWidth: 180 }}
                              title="Quando uma mensagem chega nesse numero, o lead criado e atribuido a este atendente. Em branco = usa a roleta do funil."
                            >
                              <option value="">Roleta do funil</option>
                              {users.filter(u => u.is_active && (u.role === 'atendente' || u.role === 'gerente')).map(u => (
                                <option key={u.id} value={u.id}>{u.name}</option>
                              ))}
                            </select>
                          </div>
                          <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                            Modo:
                            <select
                              className="select"
                              value={inst.lead_intake_mode || 'open'}
                              onChange={e => handleModeChange(inst, e.target.value as 'open' | 'restricted')}
                              style={{ height: 26, fontSize: 11, padding: '2px 8px', minWidth: 180, color: inst.lead_intake_mode === 'restricted' ? '#FBBC04' : undefined }}
                              title={inst.lead_intake_mode === 'restricted' ? 'Restrito: só processa msgs de leads ja cadastrados (form, planilha, Novo chat). Numeros novos sao ignorados.' : 'Aberto: qualquer mensagem cria lead novo automaticamente.'}
                            >
                              <option value="open">📥 Aberto (recebe todos)</option>
                              <option value="restricted">🔒 Restrito (so leads cadastrados)</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: getStatusColor(inst.status) }}>
                      {getStatusIcon(inst.status)} {getStatusLabel(inst.status)}
                    </span>
                    {inst.status === 'disconnected' && (
                      <button className="btn btn-primary btn-sm" onClick={() => handleConnect(inst)}><Power size={12} /> Conectar</button>
                    )}
                    {inst.status === 'connecting' && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setActiveQR(activeQR === inst.id ? null : inst.id)}>
                        <QrCode size={12} /> {activeQR === inst.id ? 'Ocultar QR' : 'Ver QR'}
                      </button>
                    )}
                    {inst.status === 'connected' && (
                      <>
                        {/* Botao Msg Inicial: visivel pra todos (atendente edita SO se for primary dele — validado no back) */}
                        {(isGerenteOuAdmin || user?.primary_instance_id === inst.id) && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setTplModal({ inst, value: inst.first_msg_template || '' })}
                            title="Mensagem inicial automatica quando lead novo cair com esta inst como atendente"
                          >
                            💬 Msg inicial
                          </button>
                        )}
                        {(
                          <>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleReconfigureWebhook(inst)}
                              disabled={reconfiguring === inst.id}
                              title="Reenvia o webhook pra Evolution. Use se os leads pararem de entrar em tempo real."
                            >
                              {reconfiguring === inst.id ? <Loader size={12} className="spinning" /> : <Webhook size={12} />} Webhook
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleRestart(inst)}
                              disabled={restarting === inst.id}
                              title="Reinicia a sessao Baileys da Evolution. Use quando a instancia mostra Conectada mas nao recebe nem envia mensagens."
                            >
                              {restarting === inst.id ? <Loader size={12} className="spinning" /> : <RotateCw size={12} />} Reiniciar sessao
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => setAutoMsgInstance(inst)}
                              title="Configurar saudacao, ausencia e inatividade"
                            >
                              <MessageSquare size={12} /> Auto-mensagens
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => setForwardNotifInstance(inst)}
                              title="Encaminhar alerta pra outro telefone quando lead responder nesta instancia"
                              style={inst.forward_notif_enabled ? { color: '#FBBC04', borderColor: '#FBBC04' } : undefined}
                            >
                              <Bell size={12} /> Alertas {inst.forward_notif_enabled ? '✓' : ''}
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleDisconnect(inst)}><PowerOff size={12} /> Desconectar</button>
                          </>
                        )}
                      </>
                    )}
                    {(
                      <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(inst)} title="Excluir"><Trash2 size={12} /></button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {instances.length === 0 && (
              <div className="empty-state" style={{ minHeight: 120 }}>
                <h3>Nenhum numero conectado</h3>
                <p>Clique em "Conectar WhatsApp" para adicionar um numero.</p>
              </div>
            )}
          </div>
        </section>
      )}

      {!evoConfigured && (
        <div className="card" style={{ textAlign: 'center', padding: 30 }}>
          <Smartphone size={32} style={{ color: '#6B6580', marginBottom: 8 }} />
          <h3>Configure a Evolution API acima</h3>
          <p style={{ color: '#9B96B0', fontSize: 13 }}>Salve a URL e API Key do servidor Evolution para comecar a conectar numeros de WhatsApp.</p>
        </div>
      )}

      {/* Roteamento de leads de formulario (tag → instancia) — gerente/admin only */}
      {isGerenteOuAdmin && evoConfigured && (() => {
        const connectedInsts = instances.filter(i => i.status === 'connected')
        const attendants = users.filter(u => (u.role === 'atendente' || u.role === 'gerente') && u.is_active)
        if (connectedInsts.length === 0) return null
        return (
          <section className="dash-section" style={{ marginTop: 24 }}>
            <div className="section-title"><GitBranch size={14} /> Roteamento de leads (formulários)</div>
            <div className="card">
              <p style={{ fontSize: 12, color: '#9B96B0', marginBottom: 16 }}>
                Leads que chegam via Google Sheets, Meta Lead Form ou site não tem WhatsApp na origem.
                Configure pra qual número essas conversas vão.
              </p>

              {/* Default — fallback */}
              <div style={{ background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Smartphone size={13} style={{ color: '#FFB300' }} />
                  <strong style={{ fontSize: 13 }}>Número padrão</strong>
                </div>
                <p style={{ fontSize: 11, color: '#9B96B0', marginBottom: 8 }}>
                  Todos os leads de formulário vão pra esse número, exceto os que tiverem regra específica por tag abaixo.
                </p>
                <select
                  className="select"
                  value={routingDefaultId ?? ''}
                  onChange={e => handleChangeDefaultRouting(e.target.value ? Number(e.target.value) : null)}
                  style={{ minWidth: 280, fontSize: 12 }}
                >
                  <option value="">— nenhuma (lead fica sem instância) —</option>
                  {connectedInsts.map(i => (
                    <option key={i.id} value={i.id}>{instanceLabel(i)}{i.phone_number ? ` (${i.phone_number})` : ''}</option>
                  ))}
                </select>
              </div>

              {/* Regras por tag */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <strong style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <LinkIcon size={12} /> Regras especiais por tag
                  </strong>
                  <button className="btn btn-primary btn-sm" onClick={() => startRoutingEdit()} disabled={routingTags.length === 0}>
                    <Plus size={12} /> Nova regra
                  </button>
                </div>
                <p style={{ fontSize: 11, color: '#9B96B0', marginBottom: 8 }}>
                  Quando uma regra bater com a tag do lead, ela tem prioridade sobre o número padrão.
                </p>

                {routingTags.length === 0 ? (
                  <p style={{ fontSize: 11, color: '#9B96B0', textAlign: 'center', padding: 16 }}>
                    Nenhuma tag criada na conta. Crie tags em <strong>Tags</strong> primeiro.
                  </p>
                ) : routingMappings.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#6B6580', textAlign: 'center', padding: 16, background: 'rgba(255,255,255,0.02)', borderRadius: 6 }}>
                    Nenhuma regra configurada. Leads de formulário usam o número padrão acima.
                  </div>
                ) : (
                  <div className="table-card">
                    <table>
                      <thead>
                        <tr>
                          <th>Tag</th>
                          <th>Instância</th>
                          <th>Atendente</th>
                          <th className="right">Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {routingMappings.map(m => (
                          <tr key={m.id}>
                            <td>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: `${m.tag_color}25`, color: m.tag_color, borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.tag_color }} />
                                {m.tag_name}
                              </span>
                            </td>
                            <td style={{ fontSize: 12 }}><Smartphone size={11} style={{ display: 'inline', marginRight: 4, color: '#34C759' }} />{m.instance_name}</td>
                            <td style={{ fontSize: 12 }}>{m.attendant_name || <span style={{ color: '#6B6580' }}>— (roleta)</span>}</td>
                            <td className="right">
                              <button className="btn btn-secondary btn-sm" style={{ fontSize: 10 }} onClick={() => startRoutingEdit(m)}>Editar</button>
                              <button className="btn btn-secondary btn-sm" style={{ fontSize: 10, color: '#FF6B6B', marginLeft: 4 }} onClick={() => handleDeleteRouting(m.tag_id)}><Trash2 size={10} /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </section>
        )
      })()}

      {/* Modal de criar/editar regra de roteamento */}
      {routingEdit && (
        <div className="modal-overlay" onClick={() => setRoutingEdit(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LinkIcon size={16} style={{ color: '#FFB300' }} /> {routingEdit.isNew ? 'Nova regra' : 'Editar regra'}
            </h2>
            <p style={{ fontSize: 12, color: '#9B96B0', marginTop: 4, marginBottom: 12 }}>
              Quando lead de formulário receber a tag escolhida, vai pra esta instância (e atendente, se definido).
            </p>
            <div className="form-group">
              <label>Tag *</label>
              <select
                className="select"
                value={routingEdit.tag_id}
                onChange={e => setRoutingEdit(p => p ? { ...p, tag_id: e.target.value } : null)}
                disabled={!routingEdit.isNew}
              >
                <option value="">— escolha —</option>
                {routingTags
                  .filter(t => routingEdit.isNew ? !routingMappings.some(m => m.tag_id === t.id) : true)
                  .map(t => <option key={t.id} value={t.id}>{t.name}</option>)
                }
              </select>
              {!routingEdit.isNew && <p style={{ fontSize: 10, color: '#6B6580', marginTop: 4 }}>Tag não editável — pra trocar de tag, remove e cria nova.</p>}
            </div>
            <div className="form-group">
              <label>Instância WhatsApp *</label>
              <select
                className="select"
                value={routingEdit.instance_id}
                onChange={e => setRoutingEdit(p => p ? { ...p, instance_id: e.target.value } : null)}
              >
                <option value="">— escolha —</option>
                {instances.filter(i => i.status === 'connected').map(i => (
                  <option key={i.id} value={i.id}>{instanceLabel(i)}{i.phone_number ? ` (${i.phone_number})` : ''}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Atendente padrão (opcional)</label>
              <select
                className="select"
                value={routingEdit.attendant_id}
                onChange={e => setRoutingEdit(p => p ? { ...p, attendant_id: e.target.value } : null)}
              >
                <option value="">— sem atendente fixo (usa roleta) —</option>
                {users.filter(u => (u.role === 'atendente' || u.role === 'gerente') && u.is_active).map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setRoutingEdit(null)} disabled={routingSaving}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleSaveRouting} disabled={routingSaving || !routingEdit.tag_id || !routingEdit.instance_id}>
                <Save size={12} /> {routingSaving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Google Sheets Integration — gerente/admin only */}
      {isGerenteOuAdmin && accountSlug && (
        <section className="dash-section" style={{ marginTop: 24 }}>
          <div className="section-title"><FileSpreadsheet size={14} /> Integracao Google Sheets</div>
          <div className="card">
            {/* Status da integracao */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, background: sheetsLastAt ? 'rgba(52,199,89,0.08)' : 'rgba(255,255,255,0.03)', border: `1px solid ${sheetsLastAt ? 'rgba(52,199,89,0.25)' : 'rgba(255,255,255,0.06)'}`, marginBottom: 12, fontSize: 12 }}>
              {sheetsLastAt ? (
                <>
                  <Check size={14} style={{ color: '#34C759' }} />
                  <strong style={{ color: '#34C759' }}>Conectada</strong>
                  <span style={{ color: '#9B96B0' }}>· Último lead recebido {sheetsTimeAgo(sheetsLastAt)} ({parseSqlDate(sheetsLastAt).toLocaleString('pt-BR')})</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={14} style={{ color: '#9B96B0' }} />
                  <span style={{ color: '#9B96B0' }}>Aguardando primeiro lead — siga as instruções abaixo pra configurar.</span>
                </>
              )}
            </div>

            {/* Tag default — aplicada automaticamente em TODO lead vindo da planilha */}
            <div style={{ background: 'var(--bg-hover)', padding: 12, borderRadius: 8, marginBottom: 12, border: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Tag automática nos leads da planilha</span>
                {sheetsTagSaving && <Loader size={11} className="spinning" style={{ color: 'var(--text-muted)' }} />}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                Todo lead novo que chegar via Google Sheets recebe automaticamente essa tag.
                Útil pra separar leads da planilha (ex: "Lead DROS") e disparar regras de roteamento ou cadências.
              </p>
              <select
                className="select"
                value={sheetsDefaultTagId ?? ''}
                onChange={e => handleChangeSheetsDefaultTag(e.target.value ? Number(e.target.value) : null)}
                style={{ minWidth: 280, fontSize: 12 }}
                disabled={sheetsTagSaving}
              >
                <option value="">— Sem tag automática —</option>
                {routingTags.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {routingTags.length === 0 && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  Crie tags primeiro em <strong>Tags</strong> antes de configurar essa opção.
                </p>
              )}
            </div>

            <p style={{ fontSize: 12, color: '#9B96B0', marginBottom: 12 }}>
              Conecte uma planilha do Google Sheets ao CRM. Leads adicionados na planilha sao criados automaticamente no sistema.
            </p>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>URL do Webhook (cole no Apps Script)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" readOnly value={`https://sheraos.com.br/crm/api/webhooks/sheets/${accountSlug}`} style={{ fontSize: 11 }} />
                <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(`https://sheraos.com.br/crm/api/webhooks/sheets/${accountSlug}`); setSheetsCopied(true); setTimeout(() => setSheetsCopied(false), 2000) }}>
                  {sheetsCopied ? <><Check size={12} /> Copiado</> : <><Copy size={12} /> Copiar</>}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>
                Nome da aba especifica <span style={{ color: '#6B6580' }}>(opcional)</span>
              </label>
              <input
                className="input"
                value={sheetsTabName}
                onChange={e => setSheetsTabName(e.target.value)}
                placeholder="Ex: Leads Formulario (deixe em branco se a planilha tem so 1 aba)"
                style={{ fontSize: 12 }}
              />
              <div style={{ fontSize: 10, color: '#6B6580', marginTop: 4 }}>
                Use isso quando a planilha tem <strong>varias abas</strong> e voce quer que so uma seja monitorada.
                Se deixar em branco, o script usa a aba ativa no momento da edicao (comportamento padrao).
              </div>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Como configurar:</div>
              <ol style={{ fontSize: 11, color: '#9B96B0', lineHeight: 1.8, paddingLeft: 16, margin: 0 }}>
                <li>Abra sua planilha no Google Sheets</li>
                <li>Funciona com qualquer planilha — formato livre ou exportado do Facebook Ads</li>
                <li>Colunas reconhecidas automaticamente: <strong style={{ color: '#FFB300' }}>first_name, phone_number, email, cidade, empresa, instagram</strong></li>
                <li>Perguntas personalizadas do formulario Meta sao salvas nas <strong>observacoes</strong> do lead</li>
                <li>Dados de campanha (campaign_name, ad_name) sao salvos como fonte</li>
                {sheetsTabName.trim() && <li>Script vai monitorar <strong style={{ color: '#FFB300' }}>so a aba "{sheetsTabName.trim()}"</strong> — confira que o nome ta exato (acentos, maiusculas)</li>}
                <li>Menu: <strong>Extensoes → Apps Script</strong> → cole o script abaixo</li>
                <li>Configure o trigger: <strong>relogio → adicionar gatilho → onChange → Da planilha</strong></li>
                <li>Pronto! Cada nova linha cria um lead no CRM automaticamente</li>
              </ol>
            </div>

            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, color: '#FFB300', cursor: 'pointer', fontWeight: 600 }}>Ver script do Apps Script (clique pra expandir)</summary>
              {(() => {
                const trimmedTab = sheetsTabName.trim()
                const sheetSelector = trimmedTab
                  ? `SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)`
                  : `SpreadsheetApp.getActiveSheet()`
                const script = `// Cole este script no Apps Script da sua planilha
// Funciona com planilhas do Facebook Ads e qualquer formato
const WEBHOOK_URL = 'https://sheraos.com.br/crm/api/webhooks/sheets/${accountSlug}';
const SHEET_NAME = ${trimmedTab ? `'${trimmedTab.replace(/'/g, "\\'")}'` : `''`}; // deixe vazio pra usar a aba ativa
const HEADER_ROW = 1;
var SENT_COL = null; // coluna "enviado" (criada automaticamente)

// Normaliza nome de coluna: "First Name" → "first_name", "Cidade?" → "cidade"
function normalizeKey(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '') // remove acentos
    .replace(/\\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function onChange(e) {
  var sheet = SHEET_NAME
    ? SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)
    : SpreadsheetApp.getActiveSheet();
  if (!sheet) {
    Logger.log('Aba "' + SHEET_NAME + '" nao encontrada — verifique o nome no script');
    return;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return;

  var headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];

  // Encontrar ou criar coluna "crm_enviado"
  var sentIdx = headers.indexOf('crm_enviado');
  if (sentIdx === -1) {
    sentIdx = headers.length;
    sheet.getRange(HEADER_ROW, sentIdx + 1).setValue('crm_enviado');
    headers.push('crm_enviado');
  }
  SENT_COL = sentIdx + 1;

  // Processar todas as linhas nao enviadas
  for (var row = HEADER_ROW + 1; row <= lastRow; row++) {
    var sent = sheet.getRange(row, SENT_COL).getValue();
    if (sent) continue; // ja enviado

    var data = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
    var payload = {};

    // Envia TODOS os campos com chave normalizada (mantem original se nao normaliza)
    headers.forEach(function(h, i) {
      if (h && data[i] !== '' && data[i] != null) {
        var key = normalizeKey(h);
        if (key && key !== 'crm_enviado') payload[key] = String(data[i]).trim();
      }
    });

    // Precisa ter pelo menos nome ou telefone
    var hasName = payload.first_name || payload.nome || payload.name || payload.full_name;
    var hasPhone = payload.phone_number || payload.telefone || payload.phone || payload.whatsapp || payload.celular;
    if (!hasName && !hasPhone) continue;

    try {
      var response = UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var result = JSON.parse(response.getContentText());
      if (result.ok) {
        sheet.getRange(row, SENT_COL).setValue('SIM');
      } else {
        sheet.getRange(row, SENT_COL).setValue('ERRO: ' + (result.error || ''));
      }
    } catch (err) {
      sheet.getRange(row, SENT_COL).setValue('ERRO: ' + err.message);
    }
  }
}`
                return (
                  <>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ marginTop: 8, marginBottom: 6 }}
                      onClick={() => { navigator.clipboard.writeText(script); setScriptCopied(true); setTimeout(() => setScriptCopied(false), 2000) }}
                    >
                      {scriptCopied ? <><Check size={12} /> Script copiado</> : <><Copy size={12} /> Copiar script</>}
                    </button>
                    <pre style={{ padding: 12, background: '#0A0118', borderRadius: 8, fontSize: 10, color: 'var(--text-secondary, var(--text-muted))', overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap' }}>{script}</pre>
                  </>
                )
              })()}
            </details>
          </div>
        </section>
      )}

      {/* Meta Pixel / Conversions API — gerente/admin only */}
      {isGerenteOuAdmin && accountId && account && (
        <section className="dash-section" style={{ marginTop: 24 }}>
          <div className="section-title"><Activity size={14} /> Meta Pixel / Conversions API</div>
          <div className="card">
            <p style={{ fontSize: 12, color: '#9B96B0', marginBottom: 12 }}>
              Envia eventos pro Meta quando leads avançam de etapa no funil — otimiza campanhas pra atrair leads que viram cliente real. Dispara pra leads que vieram do Meta: <strong>click-to-WhatsApp ads</strong> ou <strong>Meta Lead Forms</strong> (planilha com ad_id/campaign_id/form_id).
            </p>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={metaEnabled} onChange={e => setMetaEnabled(e.target.checked)} />
              <strong>Ativar envio de eventos pro Meta</strong>
            </label>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>Pixel ID</label>
                <input className="input" value={metaPixelId} onChange={e => setMetaPixelId(e.target.value)} placeholder="Ex: 1234567890123456" disabled={!metaEnabled} />
              </div>
              <div style={{ flex: 2, minWidth: 280 }}>
                <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>Access Token (CAPI)</label>
                <div style={{ position: 'relative' }}>
                  <input className="input" type={showMetaToken ? 'text' : 'password'} value={metaCapiToken} onChange={e => setMetaCapiToken(e.target.value)} placeholder="EAAxxxx..." disabled={!metaEnabled} style={{ paddingRight: 36 }} />
                  <button type="button" onClick={() => setShowMetaToken(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9B96B0', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}>
                    {showMetaToken ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>Page ID <span style={{ color: '#7A7590' }}>(obrigatório para anúncios Click-to-WhatsApp)</span></label>
              <input className="input" value={metaPageId} onChange={e => setMetaPageId(e.target.value)} placeholder="Ex: 728634350338216" disabled={!metaEnabled} />
              <div style={{ fontSize: 10, color: '#7A7590', marginTop: 4 }}>
                ID da Página do Facebook que roda os anúncios. Leads de CTWA só convertem no Meta com esse ID + a Página vinculada ao dataset (Gerenciador de Eventos).
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  if (!accountId) return
                  setSavingMeta(true)
                  try {
                    await updateMetaCapi(accountId, {
                      meta_pixel_id: metaPixelId || null,
                      meta_capi_token: metaCapiToken || null,
                      meta_capi_enabled: metaEnabled ? 1 : 0,
                      meta_page_id: metaPageId || null,
                    })
                    setMetaSaved(true)
                    setTimeout(() => setMetaSaved(false), 2000)
                  } catch (e: any) { alert('Erro: ' + e.message) }
                  setSavingMeta(false)
                }}
                disabled={savingMeta}
              >
                {metaSaved ? <><Check size={14} /> Salvo</> : <><Save size={14} /> Salvar</>}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowTestMetaConfirm(true)}
                disabled={testingMeta || !metaPixelId || !metaCapiToken}
              >
                {testingMeta ? <><Loader size={14} className="spinning" /> Testando...</> : <><RefreshCw size={14} /> Testar conexão</>}
              </button>
              {metaTestResult && (
                <div style={{
                  fontSize: 12,
                  color: metaTestResult.ok ? '#34C759' : '#FF6B6B',
                  display: 'flex', alignItems: 'center', gap: 4,
                  background: metaTestResult.ok ? 'rgba(52,199,89,0.08)' : 'rgba(255,107,107,0.08)',
                  padding: '6px 10px', borderRadius: 6,
                }}>
                  {metaTestResult.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
                  {metaTestResult.msg}
                </div>
              )}
            </div>

            <div style={{ marginTop: 14, padding: 10, background: 'rgba(91,173,226,0.06)', borderRadius: 6, fontSize: 11, color: '#9B96B0' }}>
              💡 Depois de salvar, vai em <strong>Funis → Editar Etapas</strong> pra escolher qual evento Meta cada etapa dispara (ex: "Visita Agendada" → <code>Schedule</code>, "Venda" → <code>Purchase</code>). Confere em <strong>Meta Events Manager → Pixel → Visão geral</strong> (em até 30 minutos).
            </div>
          </div>
        </section>
      )}

      {/* Agentes de IA — API Anthropic por conta (só aparece se a conta tem agentes habilitados) */}
      {isGerenteOuAdmin && accountId && account && !!account.ai_agents_enabled && (
        <section className="dash-section" style={{ marginTop: 24 }}>
          <div className="section-title"><Activity size={14} /> Agentes de IA — API Anthropic</div>
          <div className="card">
            <p style={{ fontSize: 12, color: '#9B96B0', marginBottom: 12 }}>
              Esta conta usa <strong>sua própria conta Anthropic</strong> em todas as funções de IA (agentes no WhatsApp, análise de atendimentos e coaching). <strong>Sem a chave, a IA não funciona</strong> — não há fallback. A transcrição de áudio continua por nossa conta.
            </p>

            {!anthropicKey.trim() && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#FFB300', background: 'rgba(255,179,0,0.08)', padding: '8px 10px', borderRadius: 6, marginBottom: 12 }}>
                <AlertTriangle size={14} /> Agentes habilitados, mas falta cadastrar a API Anthropic. Os agentes não respondem até salvar uma chave válida.
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ flex: 2, minWidth: 280 }}>
                <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>API Key Anthropic</label>
                <div style={{ position: 'relative' }}>
                  <input className="input" type={showAnthropicKey ? 'text' : 'password'} value={anthropicKey} onChange={e => setAnthropicKey(e.target.value)} placeholder="sk-ant-..." style={{ paddingRight: 36 }} />
                  <button type="button" onClick={() => setShowAnthropicKey(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9B96B0', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}>
                    {showAnthropicKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label style={{ fontSize: 11, color: '#9B96B0', display: 'block', marginBottom: 4 }}>Limite mensal de tokens</label>
                <input className="input" type="number" min={0} step={10000} value={anthropicLimit} onChange={e => setAnthropicLimit(Number(e.target.value) || 0)} placeholder="200000" />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  if (!accountId) return
                  setSavingAnthropic(true)
                  try {
                    await updateAiConfig(accountId, { anthropic_api_key: anthropicKey || null, analysis_token_limit: anthropicLimit || 200000 })
                    setAnthropicSaved(true)
                    setTimeout(() => setAnthropicSaved(false), 2000)
                  } catch (e: any) { alert('Erro: ' + e.message) }
                  setSavingAnthropic(false)
                }}
                disabled={savingAnthropic}
              >
                {anthropicSaved ? <><Check size={14} /> Salvo</> : <><Save size={14} /> Salvar</>}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  if (!accountId) return
                  setTestingAnthropic(true)
                  setAnthropicTestResult(null)
                  try {
                    const r = await testAnthropic(accountId, anthropicKey)
                    setAnthropicTestResult({ ok: !!r.ok, msg: r.msg || (r.ok ? 'Conexão OK' : 'Falhou') })
                  } catch (e: any) { setAnthropicTestResult({ ok: false, msg: e.message }) }
                  setTestingAnthropic(false)
                }}
                disabled={testingAnthropic || !anthropicKey.trim()}
              >
                {testingAnthropic ? <><Loader size={14} className="spinning" /> Testando...</> : <><RefreshCw size={14} /> Testar conexão</>}
              </button>
              {anthropicTestResult && (
                <div style={{
                  fontSize: 12,
                  color: anthropicTestResult.ok ? '#34C759' : '#FF6B6B',
                  display: 'flex', alignItems: 'center', gap: 4,
                  background: anthropicTestResult.ok ? 'rgba(52,199,89,0.08)' : 'rgba(255,107,107,0.08)',
                  padding: '6px 10px', borderRadius: 6,
                }}>
                  {anthropicTestResult.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
                  {anthropicTestResult.msg}
                </div>
              )}
            </div>

            <div style={{ marginTop: 14, padding: 10, background: 'rgba(91,173,226,0.06)', borderRadius: 6, fontSize: 11, color: '#9B96B0' }}>
              💡 Crie a chave em <strong>console.anthropic.com → API Keys</strong> (formato <code>sk-ant-...</code>). O <strong>limite mensal</strong> controla quanto a IA pode consumir nas análises/coaching antes de pausar — ajuste conforme seu orçamento. O consumo é todo na sua conta Anthropic.
            </div>
          </div>
        </section>
      )}

      {/* Modal de confirmação — teste de conexão Meta CAPI */}
      {showTestMetaConfirm && (
        <div className="modal-overlay" onClick={() => setShowTestMetaConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Activity size={18} style={{ color: '#FFB300' }} /> Confirmar teste de conexão
            </h2>
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary, var(--text-muted))', lineHeight: 1.6 }}>
              <p style={{ marginBottom: 10 }}>
                Isso vai enviar um evento <strong style={{ color: '#FFB300' }}>"Lead" real</strong> pro seu Pixel da Meta, sem código de teste.
              </p>
              <p style={{ marginBottom: 10 }}>
                O evento aparece em <strong>"Visão geral"</strong> do Pixel em ~30 minutos e conta como uma conversão real (descartável — não afeta otimização com volume normal de leads).
              </p>
              <div style={{ padding: 10, background: 'rgba(91,173,226,0.06)', borderRadius: 6, fontSize: 12, color: '#9B96B0', marginTop: 12 }}>
                💡 Confere depois em <strong>Meta Events Manager → Pixel → Visão geral</strong>. Se aparecer "Lead | API de Conversões" → conexão validada.
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowTestMetaConfirm(false)} disabled={testingMeta}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                disabled={testingMeta}
                onClick={async () => {
                  if (!accountId) return
                  setTestingMeta(true)
                  setMetaTestResult(null)
                  try {
                    await updateMetaCapi(accountId, {
                      meta_pixel_id: metaPixelId || null,
                      meta_capi_token: metaCapiToken || null,
                      meta_capi_enabled: metaEnabled ? 1 : 0,
                      meta_page_id: metaPageId || null,
                    })
                    const r = await testMetaCapi(accountId)
                    setMetaTestResult({
                      ok: !!r.ok,
                      msg: r.ok
                        ? 'Evento Lead enviado! Aparece em Meta Events Manager → Pixel → Visão geral em ~30 minutos.'
                        : (r.error || 'Falha desconhecida'),
                    })
                  } catch (e: any) {
                    setMetaTestResult({ ok: false, msg: e.message })
                  }
                  setTestingMeta(false)
                  setShowTestMetaConfirm(false)
                }}
              >
                {testingMeta ? <><Loader size={14} className="spinning" /> Enviando...</> : <><RefreshCw size={14} /> Enviar evento Lead</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Instance Modal */}
      {showNew && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 560 }}>
            <h2>Conectar WhatsApp</h2>
            <p style={{ fontSize: 12, color: '#9B96B0', marginBottom: 16 }}>De um nome para identificar este numero (ex: Comercial, Suporte, Vendas).</p>
            <div className="form-group">
              <label>Nome do numero</label>
              <input className="input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ex: Comercial" autoFocus onKeyDown={e => e.key === 'Enter' && handleCreate()} />
            </div>

            {/* Modo de recebimento */}
            <div className="form-group" style={{ marginTop: 16 }}>
              <label style={{ display: 'block', marginBottom: 8 }}>Modo de recebimento de leads</label>

              <div
                onClick={() => setNewMode('open')}
                style={{
                  padding: 12,
                  marginBottom: 8,
                  border: `1px solid ${newMode === 'open' ? '#FFB300' : 'rgba(255,255,255,0.08)'}`,
                  background: newMode === 'open' ? 'rgba(255,179,0,0.08)' : 'rgba(255,255,255,0.02)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <input type="radio" checked={newMode === 'open'} onChange={() => setNewMode('open')} style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: newMode === 'open' ? '#FFCB45' : '#fff' }}>Aberto (recomendado)</div>
                    <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>
                      Recebe leads de TODO mundo que mandar mensagem pra esse WhatsApp. Atendimento comercial padrao.
                    </div>
                  </div>
                </div>
              </div>

              <div
                onClick={() => setNewMode('restricted')}
                style={{
                  padding: 12,
                  border: `1px solid ${newMode === 'restricted' ? '#FBBC04' : 'rgba(255,255,255,0.08)'}`,
                  background: newMode === 'restricted' ? 'rgba(251,188,4,0.08)' : 'rgba(255,255,255,0.02)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <input type="radio" checked={newMode === 'restricted'} onChange={() => setNewMode('restricted')} style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: newMode === 'restricted' ? '#FBBC04' : '#fff' }}>Restrito</div>
                    <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>
                      Recebe APENAS msgs de leads ja cadastrados no CRM (via formulario, planilha, ou "Novo chat" pelo atendente). Numeros desconhecidos sao ignorados.
                      <br /><strong style={{ color: '#FBBC04' }}>Ideal pra quem usa WhatsApp pessoal + comercial.</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowNew(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !newName.trim()}>{creating ? 'Criando...' : 'Gerar QR Code'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Messages Modal */}
      {autoMsgInstance && accountId && (
        <InstanceAutoMessagesModal
          instance={autoMsgInstance}
          accountId={accountId}
          onClose={() => setAutoMsgInstance(null)}
        />
      )}

      {/* Forward Notifications Modal */}
      {forwardNotifInstance && accountId && (
        <ForwardNotifModal
          instance={forwardNotifInstance}
          accountId={accountId}
          onClose={() => { setForwardNotifInstance(null); load() }}
        />
      )}

      {/* Modal: editor de mensagem inicial automatica */}
      {tplModal && (
        <div className="modal-overlay" onClick={() => !tplSaving && setTplModal(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              💬 Mensagem inicial — {instanceLabel(tplModal.inst)}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
              Quando um lead novo for atribuido (roleta, bot ou manual) a esta instancia, essa msg sai automaticamente do numero <strong>{tplModal.inst.phone_number || instanceLabel(tplModal.inst)}</strong> pro lead.
              <br />Deixe em branco pra desativar.
            </p>

            <div className="form-group">
              <label>Mensagem (use variáveis abaixo)</label>
              <textarea
                className="input"
                rows={6}
                value={tplModal.value}
                onChange={e => setTplModal({ ...tplModal, value: e.target.value })}
                placeholder="Ex: Olá {{primeiro_nome}}! Sou {{vendedor_primeiro_nome}}. Recebi seu interesse e gostaria de te ajudar..."
                style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                Variáveis: <code>{'{{primeiro_nome}}'}</code>, <code>{'{{nome}}'}</code>, <code>{'{{vendedor}}'}</code>, <code>{'{{vendedor_primeiro_nome}}'}</code>, <code>{'{{cidade}}'}</code>, <code>{'{{etapa}}'}</code>, <code>{'{{funil}}'}</code>
              </small>
            </div>

            <div style={{ marginTop: 14, padding: 10, background: 'rgba(255,179,0,0.08)', border: '1px solid rgba(255,179,0,0.25)', borderRadius: 8, fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              <strong style={{ color: '#FFB300', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>Requisitos pra msg disparar</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                <li>Lead precisa ser <strong>atribuído a um atendente</strong> (via roleta, bot ou manual)</li>
                <li>O atendente precisa ter <strong>esta instância como principal</strong> (config em <strong>Equipe → editar atendente → Instância principal</strong>)</li>
                <li>A instância precisa estar <strong>Conectada</strong> (status verde aqui em Integrações)</li>
                <li>Não dispara se o lead já mandou mensagem inbound antes (evita spam pra quem já iniciou conversa)</li>
              </ul>
            </div>

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setTplModal(null)} disabled={tplSaving}>Cancelar</button>
              <button
                className="btn btn-primary"
                disabled={tplSaving}
                onClick={async () => {
                  setTplSaving(true)
                  try {
                    const updated = await updateInstanceFirstMsgTemplate(tplModal.inst.id, tplModal.value.trim() || null)
                    setInstances(prev => prev.map(i => i.id === updated.id ? updated : i))
                    setTplModal(null)
                  } catch (e: any) {
                    alert('Erro: ' + (e?.message || 'desconhecido'))
                  }
                  setTplSaving(false)
                }}
              >
                {tplSaving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Trash2 size={20} style={{ color: '#ef4444' }} />
              Deletar instância
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.55 }}>
              Tem certeza que quer deletar a instância <strong style={{ color: 'var(--text)' }}>"{instanceLabel(deleteTarget)}"</strong>?
              <br /><br />
              Isso vai remover ela do CRM e da Evolution API. Mensagens antigas continuam no histórico do lead, mas <strong>não vai mais receber nem enviar mensagens por este número</strong>. Essa ação não pode ser desfeita.
            </p>

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancelar</button>
              <button
                className="btn"
                disabled={deleting}
                onClick={confirmDelete}
                style={{ background: '#ef4444', color: 'white', border: 'none' }}
              >
                {deleting ? 'Deletando...' : 'Sim, deletar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
