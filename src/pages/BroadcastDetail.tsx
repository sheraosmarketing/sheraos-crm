import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAccount } from '../context/AccountContext'
import { fetchBroadcast, sendBroadcast, resumeBroadcast, type Broadcast, type BroadcastRecipient } from '../lib/api'
import { ArrowLeft, Send, Smartphone, Clock, CheckCircle, XCircle, AlertTriangle, PauseCircle, RefreshCw, Calendar } from 'lucide-react'
import { parseSqlDate, formatDateTime as formatDateTimeUtc } from '../lib/dates'

const STATUS_COLOR: Record<string, string> = {
  pending: '#9B96B0',
  sent: '#34C759',
  delivered: '#34C759',
  read: '#34C759',
  failed: '#FF6B6B',
}
const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendente', sent: 'Enviado', delivered: 'Entregue', read: 'Lido', failed: 'Falhou',
}

function formatDateTime(s: string | null | undefined) {
  if (!s) return '—'
  return formatDateTimeUtc(s)
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${h}h${mm}min` : `${h}h`
}

export default function BroadcastDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { accountId } = useAccount()
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null)
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [filter, setFilter] = useState<'all' | 'pending' | 'sent' | 'failed'>('all')

  const load = useCallback(async () => {
    if (!accountId || !id) return
    try {
      const data = await fetchBroadcast(Number(id), accountId)
      setBroadcast(data.broadcast); setRecipients(data.recipients)
    } catch (e: any) {
      alert('Erro: ' + e.message); navigate('/messages')
    } finally { setLoading(false) }
  }, [accountId, id, navigate])

  useEffect(() => { load() }, [load])

  // Auto-refresh enquanto enviando ou pausado
  useEffect(() => {
    if (!broadcast) return
    if (broadcast.status !== 'sending' && !broadcast.paused_at) return
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [broadcast?.status, broadcast?.paused_at, load])

  if (loading) return <div className="loading-container"><div className="spinner" /></div>
  if (!broadcast) return null

  const handleSend = async () => {
    if (!accountId || !confirm('Enviar disparo agora?')) return
    setSending(true)
    try { await sendBroadcast(broadcast.id, accountId); load() }
    catch (e: any) { alert('Erro: ' + e.message) }
    setSending(false)
  }
  const handleResume = async () => {
    if (!accountId || !broadcast) return
    setSending(true)
    try { await resumeBroadcast(broadcast.id, accountId); setTimeout(load, 1000) }
    catch (e: any) { alert('Erro: ' + e.message) }
    setSending(false)
  }

  const isPaused = !!broadcast.paused_at
  const total = broadcast.total_count || 0
  const processed = (broadcast.sent_count || 0) + (broadcast.failed_count || 0)
  const remaining = total - processed
  const pct = total > 0 ? Math.round(processed / total * 100) : 0

  // Tempo estimado restante
  const delay = broadcast.delay_seconds || 15
  const estRemainingSec = remaining * delay
  const estTotalSec = total * delay

  // Tempo decorrido (se started_at existe)
  let elapsedSec = 0
  if (broadcast.started_at) {
    elapsedSec = Math.floor((Date.now() - parseSqlDate(broadcast.started_at).getTime()) / 1000)
    if (elapsedSec < 0) elapsedSec = 0
  }

  const filtered = filter === 'all' ? recipients : recipients.filter(r => r.status === filter)
  const counts = {
    all: recipients.length,
    pending: recipients.filter(r => r.status === 'pending').length,
    sent: recipients.filter(r => r.status === 'sent' || r.status === 'delivered' || r.status === 'read').length,
    failed: recipients.filter(r => r.status === 'failed').length,
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button className="btn btn-secondary btn-sm btn-icon" onClick={() => navigate('/messages')}><ArrowLeft size={14} /></button>
        <h1 style={{ margin: 0 }}>{broadcast.name}</h1>
      </div>

      {/* Cards superiores: status + numero + criacao */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: '#9B96B0', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Smartphone size={11} /> Numero de saida
          </div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{broadcast.instance_name || '—'}</div>
          {broadcast.instance_status && (
            <div style={{ fontSize: 11, color: broadcast.instance_status === 'connected' ? '#34C759' : '#FF6B6B', marginTop: 2 }}>
              {broadcast.instance_status === 'connected' ? '✓ conectado' : '✗ desconectado'}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: '#9B96B0', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Calendar size={11} /> Criado em
          </div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{formatDateTime(broadcast.created_at)}</div>
          {broadcast.created_by_name && <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 2 }}>por {broadcast.created_by_name}</div>}
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: '#9B96B0', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Clock size={11} /> Delay configurado
          </div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{delay}s entre envios</div>
          <div style={{ fontSize: 11, color: '#9B96B0' }}>variacao ±30%</div>
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: '#9B96B0', marginBottom: 4 }}>Status</div>
          {broadcast.status === 'draft' && <div style={{ color: '#9B96B0', fontWeight: 600 }}>Rascunho</div>}
          {broadcast.status === 'sending' && !isPaused && <div style={{ color: '#5DADE2', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} className="spinning" /> Enviando</div>}
          {isPaused && (
            <>
              <div style={{ color: '#FBBC04', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}><PauseCircle size={12} /> Pausado</div>
              {broadcast.paused_reason && <div style={{ fontSize: 10, color: '#FBBC04', marginTop: 2 }}>{broadcast.paused_reason}</div>}
            </>
          )}
          {broadcast.status === 'completed' && <div style={{ color: '#34C759', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle size={12} /> Concluido</div>}
          {broadcast.status === 'failed' && <div style={{ color: '#FF6B6B', fontWeight: 600 }}>Falhou</div>}
        </div>
      </div>

      {/* Acoes draft */}
      {broadcast.status === 'draft' && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'rgba(255,179,0,0.06)', border: '1px solid rgba(255,179,0,0.2)' }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Disparo pronto pra enviar. Tempo estimado: <strong>~{formatDuration(estTotalSec)}</strong> ({total} leads × {delay}s)
          </div>
          {(!broadcast.instance_id || broadcast.instance_status !== 'connected') && (
            <div style={{ fontSize: 12, color: '#FF6B6B', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={12} /> {!broadcast.instance_id ? 'Sem instancia configurada' : `Instancia "${broadcast.instance_name}" desconectada — conecte antes de enviar`}
            </div>
          )}
          <button className="btn btn-primary" onClick={handleSend} disabled={sending || !broadcast.instance_id || broadcast.instance_status !== 'connected'}>
            <Send size={14} /> {sending ? 'Iniciando...' : 'Enviar Agora'}
          </button>
        </div>
      )}

      {/* Progresso */}
      {(broadcast.status === 'sending' || broadcast.status === 'completed') && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Progresso</div>
            <div style={{ fontSize: 13, color: '#9B96B0' }}>{processed}/{total} ({pct}%)</div>
          </div>
          {/* Barra */}
          <div style={{ height: 8, background: 'rgba(255,255,255,0.05)', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{
              height: '100%',
              width: `${pct}%`,
              background: broadcast.status === 'completed' ? '#34C759' : isPaused ? '#FBBC04' : '#5DADE2',
              transition: 'width 0.5s ease',
            }} />
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#9B96B0' }}>
            <span>✓ Enviados: <strong style={{ color: '#34C759' }}>{broadcast.sent_count}</strong></span>
            <span>✗ Falhas: <strong style={{ color: '#FF6B6B' }}>{broadcast.failed_count}</strong></span>
            <span>⏳ Pendentes: <strong>{remaining}</strong></span>
          </div>
          {broadcast.status === 'sending' && !isPaused && remaining > 0 && (
            <div style={{ fontSize: 11, color: '#5DADE2', marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={11} /> Tempo restante estimado: ~{formatDuration(estRemainingSec)}
              {broadcast.started_at && <span style={{ color: '#9B96B0', marginLeft: 8 }}>· decorrido: {formatDuration(elapsedSec)}</span>}
            </div>
          )}
          {broadcast.status === 'sending' && remaining > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={handleResume} disabled={sending} style={{ marginTop: 8, fontSize: 11 }}>
              <RefreshCw size={11} /> {sending ? 'Retomando...' : 'Retomar (caso esteja travado)'}
            </button>
          )}
          {broadcast.status === 'completed' && broadcast.completed_at && (
            <div style={{ fontSize: 11, color: '#34C759', marginTop: 8 }}>
              Concluido em {formatDateTime(broadcast.completed_at)}
            </div>
          )}
          {isPaused && (
            <div style={{ fontSize: 12, color: '#FBBC04', marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
              <PauseCircle size={12} /> Sera retomado automaticamente quando a instancia reconectar.
            </div>
          )}
        </div>
      )}

      {/* Mensagem */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        {broadcast.media_base64 && broadcast.media_mime && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#9B96B0', marginBottom: 6 }}>Anexo {broadcast.media_filename ? `· ${broadcast.media_filename}` : ''}</div>
            {broadcast.media_mime.startsWith('image/') ? (
              <img src={`data:${broadcast.media_mime};base64,${broadcast.media_base64}`} alt="anexo" style={{ maxWidth: 240, maxHeight: 200, borderRadius: 6, display: 'block' }} />
            ) : broadcast.media_mime.startsWith('video/') ? (
              <video src={`data:${broadcast.media_mime};base64,${broadcast.media_base64}`} controls style={{ maxWidth: 280, maxHeight: 200, borderRadius: 6 }} />
            ) : (
              <div style={{ fontSize: 12, color: '#9B96B0' }}>📄 {broadcast.media_mime}</div>
            )}
          </div>
        )}
        <div style={{ fontSize: 12, color: '#9B96B0', marginBottom: 6 }}>{broadcast.media_base64 ? 'Legenda (vai junto com o anexo)' : 'Mensagem principal'}</div>
        <div style={{ background: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>{broadcast.message_template}</div>
        {broadcast.message_variations && (() => {
          try {
            const vars = JSON.parse(broadcast.message_variations) as string[]
            if (!vars.length) return null
            return (
              <>
                <div style={{ fontSize: 12, color: '#9B96B0', marginTop: 12, marginBottom: 6 }}>{vars.length} variacoes (rotacionadas no envio)</div>
                {vars.map((v, i) => (
                  <div key={i} style={{ background: 'rgba(255,255,255,0.03)', padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 4, whiteSpace: 'pre-wrap' }}>{v}</div>
                ))}
              </>
            )
          } catch { return null }
        })()}
      </div>

      {/* Lista de destinatarios com filtro */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <button className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter('all')} style={{ fontSize: 11 }}>Todos ({counts.all})</button>
        <button className={`btn btn-sm ${filter === 'pending' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter('pending')} style={{ fontSize: 11 }}>Pendentes ({counts.pending})</button>
        <button className={`btn btn-sm ${filter === 'sent' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter('sent')} style={{ fontSize: 11 }}>Enviados ({counts.sent})</button>
        <button className={`btn btn-sm ${filter === 'failed' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter('failed')} style={{ fontSize: 11 }}>Falhas ({counts.failed})</button>
        <button className="btn btn-secondary btn-sm btn-icon" onClick={load} title="Atualizar" style={{ marginLeft: 'auto' }}><RefreshCw size={12} /></button>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Telefone</th>
              <th>Status</th>
              <th>Enviado em</th>
              <th>Erro</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id}>
                <td className="name">{r.lead_name || '—'}</td>
                <td style={{ fontSize: 12, color: '#9B96B0' }}>{r.phone}</td>
                <td>
                  <span className="stage-badge" style={{ background: `${STATUS_COLOR[r.status]}20`, color: STATUS_COLOR[r.status], fontSize: 10 }}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: '#9B96B0' }}>{r.sent_at ? formatDateTime(r.sent_at) : '—'}</td>
                <td style={{ fontSize: 10, color: '#FF6B6B', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error || ''}>
                  {r.error ? <XCircle size={11} style={{ display: 'inline', marginRight: 4 }} /> : null}
                  {r.error || ''}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 30, color: '#6B6580' }}>Nenhum destinatario neste filtro</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
