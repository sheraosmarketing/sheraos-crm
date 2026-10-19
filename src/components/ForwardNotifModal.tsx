import { useState, useEffect } from 'react'
import { X, Bell, Phone, ArrowRight, GitBranch, Save } from 'lucide-react'
import { fetchForwardConfig, saveForwardConfig, fetchGlobalConnectedInstances, fetchFunnels, type ForwardConfig, type GlobalConnectedInstance, type Funnel, type WhatsAppInstance } from '../lib/api'

interface Props {
  instance: WhatsAppInstance
  accountId: number
  onClose: () => void
}

export default function ForwardNotifModal({ instance, accountId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [viaInstanceId, setViaInstanceId] = useState<number | ''>('')
  const [toPhone, setToPhone] = useState('')
  const [label, setLabel] = useState('')
  const [moveToStageId, setMoveToStageId] = useState<number | ''>('')
  const [moveEnabled, setMoveEnabled] = useState(false)
  const [options, setOptions] = useState<GlobalConnectedInstance[]>([])
  const [funnels, setFunnels] = useState<Funnel[]>([])

  useEffect(() => {
    (async () => {
      try {
        const [cfg, insts, funs] = await Promise.all([
          fetchForwardConfig(instance.id, accountId),
          fetchGlobalConnectedInstances(accountId),
          fetchFunnels(accountId),
        ])
        setEnabled(cfg.enabled)
        setViaInstanceId(cfg.via_instance_id || '')
        setToPhone(cfg.to_phone || '')
        setLabel(cfg.label || instance.instance_name || '')
        setMoveToStageId(cfg.move_to_stage_id || '')
        setMoveEnabled(!!cfg.move_to_stage_id)
        setOptions(insts)
        setFunnels(funs)
      } catch (e: any) {
        setErr(e?.message || 'Erro ao carregar config')
      } finally {
        setLoading(false)
      }
    })()
  }, [instance.id, accountId])

  const handleSave = async () => {
    setErr('')
    if (enabled) {
      if (!viaInstanceId) { setErr('Escolha a instancia que envia o alerta'); return }
      const digits = toPhone.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 15) { setErr('Telefone invalido (ex: 5548999001122)'); return }
    }
    setSaving(true)
    try {
      await saveForwardConfig(instance.id, accountId, {
        enabled,
        via_instance_id: viaInstanceId ? Number(viaInstanceId) : null,
        to_phone: toPhone ? toPhone.replace(/\D/g, '') : null,
        label: label || null,
        move_to_stage_id: moveEnabled && moveToStageId ? Number(moveToStageId) : null,
      })
      onClose()
    } catch (e: any) {
      setErr(e?.message || 'Erro ao salvar')
    } finally {
      setSaving(false)
    }
  }

  // Stages flat de todos os funis da conta (opcional mover)
  const allStages = funnels.flatMap(f => (f.stages || []).map(s => ({ id: s.id, name: `${f.name} - ${s.name}` })))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h2><Bell size={18} style={{ marginRight: 8, verticalAlign: 'middle' }} /> Alertas de resposta — {instance.display_name || instance.instance_name}</h2>
          <button className="btn btn-icon" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          {loading ? <div style={{ padding: 20 }}>Carregando...</div> : (
            <>
              <div style={{ padding: 10, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 12, color: '#9B96B0', marginBottom: 16 }}>
                Quando um lead responder nesta instancia, o CRM envia automaticamente uma mensagem de alerta
                pelo numero escolhido abaixo, pro telefone destino, com os dados do lead e link pra abrir conversa.
                Util pra numero de disparos: lead chama no numero da campanha, voce recebe no celular.
              </div>

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                  <span style={{ fontWeight: 600 }}>Encaminhar alertas quando receber resposta aqui</span>
                </label>
              </div>

              {enabled && (
                <>
                  <div className="form-group">
                    <label>Enviar o alerta pela instancia</label>
                    <select className="input" value={viaInstanceId} onChange={e => setViaInstanceId(e.target.value ? Number(e.target.value) : '')}>
                      <option value="">Selecione um numero conectado</option>
                      {options.map(o => (
                        <option key={o.id} value={o.id}>
                          [{o.account_name}] {o.display_name || o.instance_name} {o.phone_number ? `(${o.phone_number})` : ''}
                        </option>
                      ))}
                    </select>
                    <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>
                      So aparecem instancias CONECTADAS (de qualquer conta — super admin).
                    </div>
                  </div>

                  <div className="form-group">
                    <label><Phone size={12} style={{ display: 'inline', marginRight: 4 }} /> Telefone que recebe o alerta</label>
                    <input className="input" value={toPhone} onChange={e => setToPhone(e.target.value)} placeholder="5548999001122" />
                    <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>
                      So digitos, com DDI 55 e DDD. Ex: 5548999001122
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Nome do contexto (aparece no alerta)</label>
                    <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder={instance.instance_name || 'Nome'} />
                  </div>

                  <div className="form-group" style={{ padding: 10, background: 'rgba(96,229,234,0.05)', border: '1px solid rgba(96,229,234,0.2)', borderRadius: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={moveEnabled} onChange={e => setMoveEnabled(e.target.checked)} />
                      <GitBranch size={14} />
                      <span style={{ fontWeight: 600 }}>Mover lead de etapa ao encaminhar (opcional)</span>
                    </label>
                    {moveEnabled && (
                      <div style={{ marginTop: 8 }}>
                        <select className="input" value={moveToStageId} onChange={e => setMoveToStageId(e.target.value ? Number(e.target.value) : '')}>
                          <option value="">Selecione a etapa destino</option>
                          {allStages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <div style={{ fontSize: 11, color: '#9B96B0', marginTop: 4 }}>
                          Quando o alerta for enviado com sucesso, o lead vai pra esta etapa (so se nao estiver ja nela).
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="form-group" style={{ padding: 10, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 11, color: '#9B96B0' }}>
                    <div style={{ color: '#C8C2D8', marginBottom: 4 }}>Preview do alerta:</div>
                    <div style={{ whiteSpace: 'pre-wrap', color: '#C8C2D8' }}>
{`🔔 *Novo lead respondeu em ${label || instance.instance_name}*

👤 Joao da Silva
📞 +55 (48) 99999-1234
💬 "VOLTEI"
📣 Veio do disparo: 15% Desconto
🕒 18/10/2026 15:30

👉 Abrir conversa: https://wa.me/5548999991234`}
                    </div>
                  </div>
                </>
              )}

              {err && <div style={{ color: '#FF6B6B', fontSize: 12, marginTop: 8 }}>{err}</div>}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Salvando...' : <><Save size={14} /> Salvar</>}
          </button>
        </div>
      </div>
    </div>
  )
}
