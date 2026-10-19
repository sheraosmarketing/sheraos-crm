import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = resolve(__dirname, 'data', 'crm.db')

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Schema
db.exec(`
  -- Accounts (client companies)
  CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    logo_url    TEXT,
    timezone    TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Users (super_admin, gerente, atendente)
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('super_admin', 'gerente', 'atendente')),
    avatar_url  TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Funnels (custom pipelines per account)
  CREATE TABLE IF NOT EXISTS funnels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Funnel stages
  CREATE TABLE IF NOT EXISTS funnel_stages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    funnel_id       INTEGER NOT NULL,
    name            TEXT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    color           TEXT NOT NULL DEFAULT '#FFB300',
    is_conversion   INTEGER NOT NULL DEFAULT 0,
    is_terminal     INTEGER NOT NULL DEFAULT 0,
    auto_keywords   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_stages_funnel ON funnel_stages(funnel_id, position);

  -- Tags
  CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#FFB300',
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, name)
  );

  -- Leads
  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    funnel_id       INTEGER NOT NULL,
    stage_id        INTEGER NOT NULL,
    attendant_id    INTEGER,
    name            TEXT,
    phone           TEXT,
    email           TEXT,
    city            TEXT,
    source          TEXT,
    source_detail   TEXT,
    notes           TEXT,
    custom_fields   TEXT,
    wa_remote_jid   TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (funnel_id) REFERENCES funnels(id),
    FOREIGN KEY (stage_id) REFERENCES funnel_stages(id),
    FOREIGN KEY (attendant_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage_id);
  CREATE INDEX IF NOT EXISTS idx_leads_attendant ON leads(attendant_id);
  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  CREATE INDEX IF NOT EXISTS idx_leads_wa_jid ON leads(wa_remote_jid);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
  CREATE INDEX IF NOT EXISTS idx_leads_funnel_active ON leads(funnel_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_leads_account_created ON leads(account_id, created_at DESC);

  -- Lead tags (many-to-many)
  CREATE TABLE IF NOT EXISTS lead_tags (
    lead_id     INTEGER NOT NULL,
    tag_id      INTEGER NOT NULL,
    PRIMARY KEY (lead_id, tag_id),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  -- Messages (WhatsApp conversation)
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER NOT NULL,
    account_id      INTEGER NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content         TEXT,
    media_type      TEXT DEFAULT 'text',
    media_url       TEXT,
    wa_msg_id       TEXT,
    wa_timestamp    TEXT,
    sender_name     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);

  -- Stage history (audit trail)
  CREATE TABLE IF NOT EXISTS stage_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER NOT NULL,
    from_stage_id   INTEGER,
    to_stage_id     INTEGER NOT NULL,
    trigger_type    TEXT NOT NULL DEFAULT 'manual',
    triggered_by    INTEGER,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (from_stage_id) REFERENCES funnel_stages(id),
    FOREIGN KEY (to_stage_id) REFERENCES funnel_stages(id),
    FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_lead ON stage_history(lead_id, created_at);

  -- WhatsApp instances (Evolution API config)
  CREATE TABLE IF NOT EXISTS whatsapp_instances (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    instance_name   TEXT NOT NULL,
    api_url         TEXT NOT NULL,
    api_key         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'disconnected',
    phone_number    TEXT,
    webhook_secret  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Distribution rules (round-robin)
  CREATE TABLE IF NOT EXISTS distribution_rules (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id          INTEGER NOT NULL,
    funnel_id           INTEGER NOT NULL,
    type                TEXT NOT NULL DEFAULT 'manual' CHECK (type IN ('round_robin', 'manual')),
    last_assigned_index INTEGER NOT NULL DEFAULT 0,
    active_attendants   TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (funnel_id) REFERENCES funnels(id) ON DELETE CASCADE,
    UNIQUE(account_id, funnel_id)
  );

  -- Broadcasts (bulk messaging)
  CREATE TABLE IF NOT EXISTS broadcasts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    name            TEXT NOT NULL,
    message_template TEXT NOT NULL,
    media_url       TEXT,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'failed')),
    scheduled_at    TEXT,
    sent_count      INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    total_count     INTEGER NOT NULL DEFAULT 0,
    created_by      INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled ON broadcasts(status, scheduled_at);

  -- Broadcast recipients
  CREATE TABLE IF NOT EXISTS broadcast_recipients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id    INTEGER NOT NULL,
    lead_id         INTEGER NOT NULL,
    phone           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    wa_msg_id       TEXT,
    sent_at         TEXT,
    error           TEXT,
    FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_bcast_recipients ON broadcast_recipients(broadcast_id);

  -- Lead notes (internal comments)
  CREATE TABLE IF NOT EXISTS lead_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_lead ON lead_notes(lead_id, created_at DESC);

  -- Cadences (sequential contact workflows)
  CREATE TABLE IF NOT EXISTS cadences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cadence_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cadence_id  INTEGER NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL CHECK (action_type IN ('mensagem', 'ligacao', 'email', 'reuniao', 'whatsapp', 'visita')),
    description TEXT,
    instructions TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (cadence_id) REFERENCES cadences(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_cadence_attempts_cadence ON cadence_attempts(cadence_id, position);

  CREATE TABLE IF NOT EXISTS lead_cadences (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id               INTEGER NOT NULL,
    cadence_id            INTEGER NOT NULL,
    current_attempt_id    INTEGER,
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
    started_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (cadence_id) REFERENCES cadences(id) ON DELETE CASCADE,
    FOREIGN KEY (current_attempt_id) REFERENCES cadence_attempts(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_cadences_lead ON lead_cadences(lead_id);

  -- Ready messages (quick templates)
  CREATE TABLE IF NOT EXISTS ready_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    image_url   TEXT,
    video_url   TEXT,
    stage_id    INTEGER,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (stage_id) REFERENCES funnel_stages(id) ON DELETE SET NULL
  );

  -- Qualification sequences (lead scoring questions)
  CREATE TABLE IF NOT EXISTS qualification_sequences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL,
    question    TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_qual_seq_account ON qualification_sequences(account_id, position);

  CREATE TABLE IF NOT EXISTS lead_qualifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER NOT NULL,
    sequence_id     INTEGER NOT NULL,
    answer          TEXT,
    answered_at     TEXT,
    answered_by     INTEGER,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (sequence_id) REFERENCES qualification_sequences(id) ON DELETE CASCADE,
    FOREIGN KEY (answered_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(lead_id, sequence_id)
  );

  -- Launches (product/property listings)
  CREATE TABLE IF NOT EXISTS launches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    title           TEXT NOT NULL,
    identification  TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS launch_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    launch_id   INTEGER NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (launch_id) REFERENCES launches(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_launch_messages_launch ON launch_messages(launch_id, position);
`)

// ─── Schema migrations (add columns safely) ─────────────────────
function addColumnIfNotExists(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.length === 0) return // tabela ainda nao existe (DB fresh): pula sem crash
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    console.log(`[DB] Added column ${table}.${column}`)
  }
}
// whatsapp_instances: qr_code for QR code base64
addColumnIfNotExists('whatsapp_instances', 'qr_code', 'TEXT')
// whatsapp_instances: default attendant for new inbound leads (overrides round-robin when set)
addColumnIfNotExists('whatsapp_instances', 'default_attendant_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')
// Anti-ban: quota por instancia + warm-up gradual
addColumnIfNotExists('whatsapp_instances', 'hourly_send_limit', 'INTEGER')  // null = default global 100
addColumnIfNotExists('whatsapp_instances', 'daily_send_limit', 'INTEGER')   // null = default global 800
addColumnIfNotExists('whatsapp_instances', 'warmup_until', 'TEXT')          // datetime fim do warm-up; null = sem warm-up
// Anti-ban Tier 1+2: horario comercial, cap por lead, auto-pause por delivered_rate
addColumnIfNotExists('whatsapp_instances', 'business_hours_json', 'TEXT')                    // {mon:[{start,end}],...}; null = 24/7
addColumnIfNotExists('whatsapp_instances', 'lead_daily_msg_cap', 'INTEGER DEFAULT 50')       // max msgs automaticas pro mesmo lead em 24h
// Migration: sobe instancias que estavam no default antigo (5) pra 50
try {
  const r = db.prepare("UPDATE whatsapp_instances SET lead_daily_msg_cap = 50 WHERE lead_daily_msg_cap = 5").run()
  if (r.changes > 0) console.log(`[db] migration: lead_daily_msg_cap 5->50 em ${r.changes} instancias`)
} catch (e) { console.warn('[db] cap migration:', e.message) }
addColumnIfNotExists('whatsapp_instances', 'paused_at', 'TEXT')                              // datetime pausa (auto ou manual); null = ativa
addColumnIfNotExists('whatsapp_instances', 'paused_reason', 'TEXT')                          // 'delivered_rate_low' | 'manual' | 'ghost_detected'
addColumnIfNotExists('whatsapp_instances', 'health_check_window_min', 'INTEGER DEFAULT 120') // janela pra delivered_rate (default 2h)
// Backfill warm-up retroativo APENAS pra instancias recentes (created_at < 3 dias atras).
// Instancias antigas nao sao afetadas — ja "esquentaram" naturalmente em prod.
try {
  const r = db.prepare(`
    UPDATE whatsapp_instances
       SET warmup_until = datetime(created_at, '+3 days')
     WHERE warmup_until IS NULL
       AND datetime(created_at, '+3 days') > datetime('now')
  `).run()
  if (r.changes > 0) console.log(`[db] migration: warmup_until set for ${r.changes} recent instances`)
} catch (e) { console.warn('[db] warmup backfill:', e.message) }
// leads: instance_id to track which WhatsApp number received this lead
addColumnIfNotExists('leads', 'instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')
// accounts: Evolution API credentials (shared across all instances)
addColumnIfNotExists('accounts', 'evolution_api_url', 'TEXT')
addColumnIfNotExists('accounts', 'evolution_api_key', 'TEXT')
// Tag default pra todo lead novo vindo da planilha (webhook /sheets/:slug). NULL = sem tag automatica.
addColumnIfNotExists('accounts', 'sheets_default_tag_id', 'INTEGER REFERENCES tags(id) ON DELETE SET NULL')

// Defaults centralizados da Evolution API (ja preenche em todas contas — auto-setup, user nao configura nada).
// FIX #2 — remove fallback publico da EVOLUTION_API_KEY. URL pode ter fallback docker interno.
// Se .env.production nao setar EVOLUTION_API_KEY, aplicacao FALHA imediatamente (fail-safe visivel).
export const DEFAULT_EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://evolution:8080'
if (!process.env.EVOLUTION_API_KEY || process.env.EVOLUTION_API_KEY.length < 16) {
  throw new Error('[FATAL] EVOLUTION_API_KEY nao setada ou muito curta (min 16 chars). Verifique .env.production.')
}
export const DEFAULT_EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY

// Backfill + self-heal: aplica defaults em contas sem credenciais OU com credenciais antigas hardcoded.
// Assim se usuario apagar por engano OU se rotacionamos chave via env, todas as contas sao atualizadas na inicializacao.
db.prepare("UPDATE accounts SET evolution_api_url = ? WHERE evolution_api_url IS NULL OR evolution_api_url = ''").run(DEFAULT_EVOLUTION_API_URL)
db.prepare("UPDATE accounts SET evolution_api_key = ? WHERE evolution_api_key IS NULL OR evolution_api_key = '' OR evolution_api_key = 'sheraos-evo-key-2026'").run(DEFAULT_EVOLUTION_API_KEY)
// cadence_attempts: D+N days from lead creation + scheduled time
addColumnIfNotExists('cadence_attempts', 'delay_days', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('cadence_attempts', 'scheduled_time', 'TEXT')
// cadence_attempts: auto-send message template (for WhatsApp auto)
addColumnIfNotExists('cadence_attempts', 'auto_message', 'TEXT')
// cadence_attempts: schedule mode ('date' = D+N HH:MM, 'duration' = delay_minutes from anchor)
addColumnIfNotExists('cadence_attempts', 'schedule_mode', "TEXT NOT NULL DEFAULT 'date'")
addColumnIfNotExists('cadence_attempts', 'delay_minutes', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('cadence_attempts', 'call_script', 'TEXT')
// lead_cadences: track when each attempt was executed/skipped
addColumnIfNotExists('lead_cadences', 'last_executed_at', 'TEXT')
addColumnIfNotExists('lead_cadences', 'last_executed_attempt_id', 'INTEGER')
// leads: WhatsApp profile picture URL (cached, expires periodically)
addColumnIfNotExists('leads', 'profile_pic_url', 'TEXT')
addColumnIfNotExists('leads', 'profile_pic_updated_at', 'TEXT')
// leads: archive flag + unread marker for messages that arrived after archiving
addColumnIfNotExists('leads', 'is_archived', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('leads', 'archived_at', 'TEXT')
addColumnIfNotExists('leads', 'has_new_after_archive', 'INTEGER NOT NULL DEFAULT 0')

// Accounts: extra business fields
addColumnIfNotExists('accounts', 'cnpj', 'TEXT')
addColumnIfNotExists('accounts', 'razao_social', 'TEXT')
addColumnIfNotExists('accounts', 'segmento', 'TEXT')
addColumnIfNotExists('accounts', 'website', 'TEXT')
addColumnIfNotExists('accounts', 'instagram', 'TEXT')
addColumnIfNotExists('accounts', 'whatsapp_comercial', 'TEXT')
addColumnIfNotExists('accounts', 'valor_mensal', 'REAL')
addColumnIfNotExists('accounts', 'contrato_inicio', 'TEXT')
addColumnIfNotExists('accounts', 'cidade', 'TEXT')
addColumnIfNotExists('accounts', 'estado', 'TEXT')
addColumnIfNotExists('accounts', 'observacoes', 'TEXT')
addColumnIfNotExists('accounts', 'trabalha_anuncio', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('accounts', 'investimento_anuncios', 'REAL')

// Meta Pixel + Conversions API (CAPI) — envio de eventos pra Meta otimizar campanhas
addColumnIfNotExists('accounts', 'meta_pixel_id', 'TEXT')
addColumnIfNotExists('accounts', 'meta_capi_token', 'TEXT')
addColumnIfNotExists('accounts', 'meta_capi_test_event_code', 'TEXT')
addColumnIfNotExists('accounts', 'meta_capi_enabled', 'INTEGER NOT NULL DEFAULT 0')
// Page ID da Pagina do Facebook que roda os anuncios de CTWA — exigido pra eventos business_messaging
addColumnIfNotExists('accounts', 'meta_page_id', 'TEXT')
// Ultimo lead recebido via webhook Google Sheets (pra UI mostrar status da integração)
addColumnIfNotExists('accounts', 'last_sheets_lead_at', 'TEXT')

// Normaliza configs antigas que tinham modo manual (feature descontinuada — agora so schedule)
try {
  db.prepare("UPDATE instance_auto_messages SET away_mode = 'schedule', away_manual_active = 0 WHERE away_mode = 'manual'").run()
} catch {}

// Funnel stages: evento Meta enviado quando lead entra nessa etapa (CAPI)
addColumnIfNotExists('funnel_stages', 'meta_event_name', 'TEXT')

// Leads: ctwa_clid capturado do click-to-WhatsApp ad (pra correlacionar com campanha Meta via CAPI)
addColumnIfNotExists('leads', 'ctwa_clid', 'TEXT')
// Leads: ids de Meta Lead Form (campanha/anuncio/formulario) — usado pra disparar CAPI pra leads vindos de forms
addColumnIfNotExists('leads', 'meta_ad_id', 'TEXT')
addColumnIfNotExists('leads', 'meta_campaign_id', 'TEXT')
addColumnIfNotExists('leads', 'meta_form_id', 'TEXT')

// stage_history: auditoria de envios CAPI
addColumnIfNotExists('stage_history', 'capi_event_id', 'TEXT')
addColumnIfNotExists('stage_history', 'capi_status', 'TEXT')

// Leads: campos extras pra elevar Event Match Quality (EMQ) no Meta CAPI
addColumnIfNotExists('leads', 'fbp', 'TEXT')                  // _fbp cookie do browser (plaintext)
addColumnIfNotExists('leads', 'fbc', 'TEXT')                  // _fbc cookie ou montado a partir de fbclid (plaintext)
addColumnIfNotExists('leads', 'client_ip_address', 'TEXT')    // IP do lead na 1a interacao
addColumnIfNotExists('leads', 'client_user_agent', 'TEXT')    // UA do navegador (so faz sentido em forms web)
addColumnIfNotExists('leads', 'lead_form_lead_id', 'TEXT')    // leadgen_id do Meta Lead Form (NAO confundir com leads.id)
addColumnIfNotExists('leads', 'state', 'TEXT')                // estado (UF) — pra hash st no CAPI
addColumnIfNotExists('leads', 'zip', 'TEXT')                  // CEP — pra hash zp no CAPI
addColumnIfNotExists('leads', 'birthdate', 'TEXT')            // YYYY-MM-DD — pra hash db no CAPI
addColumnIfNotExists('leads', 'gender', 'TEXT')               // 'f' ou 'm' — pra hash ge no CAPI

// Leads: extra business fields
addColumnIfNotExists('leads', 'empresa', 'TEXT')
addColumnIfNotExists('leads', 'cpf_cnpj', 'TEXT')
addColumnIfNotExists('leads', 'instagram', 'TEXT')
addColumnIfNotExists('leads', 'trabalha_anuncio', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('leads', 'investimento_anuncios', 'REAL')
// Opt-in/opt-out for WhatsApp broadcasts (Meta compliance)
addColumnIfNotExists('leads', 'opted_in_at', 'TEXT')
addColumnIfNotExists('leads', 'opted_out_at', 'TEXT')
addColumnIfNotExists('leads', 'last_broadcast_at', 'TEXT')

// Broadcasts: message variations (JSON array) + delay between sends
addColumnIfNotExists('broadcasts', 'message_variations', 'TEXT')
addColumnIfNotExists('broadcasts', 'delay_seconds', 'INTEGER NOT NULL DEFAULT 3')
addColumnIfNotExists('broadcasts', 'instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')
addColumnIfNotExists('broadcasts', 'paused_at', 'TEXT')
addColumnIfNotExists('broadcasts', 'paused_reason', 'TEXT')
addColumnIfNotExists('broadcasts', 'started_at', 'TEXT')
addColumnIfNotExists('broadcasts', 'media_base64', 'TEXT')
addColumnIfNotExists('broadcasts', 'media_mime', 'TEXT')
addColumnIfNotExists('broadcasts', 'media_filename', 'TEXT')

// Forward notification: quando lead responde numa instancia, notifica outro telefone
// (ex: Pousada Di Venezia - lead responde no numero de disparos, celular do dono recebe alerta)
addColumnIfNotExists('whatsapp_instances', 'forward_notif_enabled', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('whatsapp_instances', 'forward_notif_via_instance_id', 'INTEGER')
addColumnIfNotExists('whatsapp_instances', 'forward_notif_to_phone', 'TEXT')
addColumnIfNotExists('whatsapp_instances', 'forward_notif_label', 'TEXT')
addColumnIfNotExists('whatsapp_instances', 'forward_notif_move_to_stage_id', 'INTEGER')

// Migracao: broadcasts.status CHECK precisa incluir 'cancelled' (botao Parar no UI).
// SQLite nao permite ALTER CHECK — recria tabela. Idempotente: so roda se 'cancelled' nao for aceito.
try {
  const testCancel = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='broadcasts'").get()
  if (testCancel && !testCancel.sql.includes("'cancelled'")) {
    console.log("[DB] Migracao: broadcasts.status CHECK + 'cancelled'")
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE broadcasts_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      INTEGER NOT NULL,
        name            TEXT NOT NULL,
        message_template TEXT NOT NULL,
        media_url       TEXT,
        status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'completed', 'failed', 'cancelled')),
        scheduled_at    TEXT,
        sent_count      INTEGER NOT NULL DEFAULT 0,
        failed_count    INTEGER NOT NULL DEFAULT 0,
        total_count     INTEGER NOT NULL DEFAULT 0,
        created_by      INTEGER,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at    TEXT,
        message_variations TEXT,
        delay_seconds   INTEGER NOT NULL DEFAULT 3,
        instance_id     INTEGER,
        paused_at       TEXT,
        paused_reason   TEXT,
        started_at      TEXT,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE SET NULL
      );
      INSERT INTO broadcasts_new
        (id, account_id, name, message_template, media_url, status, scheduled_at, sent_count, failed_count, total_count, created_by, created_at, completed_at, message_variations, delay_seconds, instance_id, paused_at, paused_reason, started_at)
      SELECT id, account_id, name, message_template, media_url, status, scheduled_at, sent_count, failed_count, total_count, created_by, created_at, completed_at, message_variations, COALESCE(delay_seconds, 3), instance_id, paused_at, paused_reason, started_at
      FROM broadcasts;
      DROP TABLE broadcasts;
      ALTER TABLE broadcasts_new RENAME TO broadcasts;
      CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled ON broadcasts(status, scheduled_at);
    `)
    db.pragma('foreign_keys = ON')
    console.log("[DB] Migracao broadcasts concluida")
  }
} catch (e) {
  console.error("[DB] Migracao broadcasts FALHOU:", e.message)
  try { db.pragma('foreign_keys = ON') } catch {}
}

// ─── Multi-instance routing (decide which WhatsApp number to use when sending)
// leads.last_instance_id: ultima instancia que conversou com este lead (origem ou recepcao)
addColumnIfNotExists('leads', 'last_instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')
// users.primary_instance_id: instancia padrao do usuario para envios manuais quando lead nao tem instancia
addColumnIfNotExists('users', 'primary_instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')
// users.can_manage_proposals: permissao granular pra acessar a area de Propostas (super_admin sempre tem)
addColumnIfNotExists('users', 'can_manage_proposals', 'INTEGER NOT NULL DEFAULT 0')
// users.can_manage_contracts: permite ao atendente gerenciar contratos (igual proposals)
addColumnIfNotExists('users', 'can_manage_contracts', 'INTEGER NOT NULL DEFAULT 0')
// instance_auto_messages.greeting_cooldown_hours: cooldown configuravel da saudacao (default 24h, comportamento anterior)
addColumnIfNotExists('instance_auto_messages', 'greeting_cooldown_hours', 'INTEGER NOT NULL DEFAULT 24')
// proposals.has_comissao + comissao_percent: comissao sobre faturamento (opcional, alguns clientes tem)
addColumnIfNotExists('proposals', 'has_comissao', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('proposals', 'comissao_percent', 'REAL NOT NULL DEFAULT 0')

// Follow-ups v2: tipo (sequence/inactivity) + campos especificos de inactivity + datas absolutas em steps
addColumnIfNotExists('follow_ups', 'type', "TEXT NOT NULL DEFAULT 'sequence'")
addColumnIfNotExists('follow_ups', 'inactivity_stage_id', 'INTEGER REFERENCES funnel_stages(id) ON DELETE SET NULL')
addColumnIfNotExists('follow_ups', 'inactivity_days', 'INTEGER NOT NULL DEFAULT 2')
addColumnIfNotExists('follow_ups', 'variation_delay_seconds', 'INTEGER NOT NULL DEFAULT 30')
addColumnIfNotExists('follow_up_steps', 'schedule_mode', "TEXT NOT NULL DEFAULT 'relative'")
addColumnIfNotExists('follow_up_steps', 'scheduled_at', 'TEXT')

// Follow-ups v3: inactivity multi-step (cadência) + variações por step + on-reply action
addColumnIfNotExists('follow_ups', 'inactivity_minutes', 'INTEGER')
addColumnIfNotExists('follow_ups', 'inactivity_mode', "TEXT NOT NULL DEFAULT 'rotation'")
addColumnIfNotExists('follow_ups', 'on_reply_action', "TEXT NOT NULL DEFAULT 'pause'")
addColumnIfNotExists('follow_ups', 'on_reply_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')
addColumnIfNotExists('follow_up_steps', 'variations', 'TEXT')
// Follow-ups v3.1: on-reply move stage + add tag
addColumnIfNotExists('follow_ups', 'on_reply_move_to_stage_id', 'INTEGER REFERENCES funnel_stages(id) ON DELETE SET NULL')
addColumnIfNotExists('follow_ups', 'on_reply_add_tag_id', 'INTEGER REFERENCES tags(id) ON DELETE SET NULL')
// Follow-up vinculado ao agente IA (lead atendido pelo bot parou de responder).
// NULL pra follow-ups stage-based existentes (intocados).
addColumnIfNotExists('follow_ups', 'agent_id', 'INTEGER REFERENCES ai_agents(id) ON DELETE CASCADE')
// Sem WHERE clause: sqlite3 CLI do CentOS 7 nao parseia partial index, quebra inspecao manual.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_follow_ups_agent_id ON follow_ups(agent_id)') } catch (e) { console.warn('[db] idx_follow_ups_agent_id:', e.message) }

// ─── Dashboard de Análise de Atendimentos ───
// 1. Insights extraídos por Haiku por conversa (lead) — 1 linha por lead
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_id INTEGER,
    summary TEXT,
    lead_intent TEXT,
    lost_sale_signals TEXT,
    attendant_errors TEXT,
    attendant_score INTEGER,
    score_reasoning TEXT,
    suggested_next_step TEXT,
    last_message_quality TEXT,
    attendant_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    tokens_used INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    UNIQUE (lead_id)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_insights_account_attendant ON conversation_insights(account_id, attendant_user_id, analyzed_at)') } catch (e) { console.warn('[db] idx_insights:', e.message) }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_insights_score ON conversation_insights(account_id, attendant_score)') } catch (e) {}

// 2. Métricas operacionais pré-calculadas por dia (agregador SQL noturno)
db.exec(`
  CREATE TABLE IF NOT EXISTS attendant_metrics_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    leads_assigned INTEGER DEFAULT 0,
    leads_responded INTEGER DEFAULT 0,
    leads_converted INTEGER DEFAULT 0,
    ttfr_avg_seconds REAL,
    tmr_avg_seconds REAL,
    leads_under_5min INTEGER DEFAULT 0,
    leads_under_30min INTEGER DEFAULT 0,
    leads_under_1h INTEGER DEFAULT 0,
    open_conversations INTEGER DEFAULT 0,
    abandoned_leads INTEGER DEFAULT 0,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, user_id, date)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_metrics_daily_lookup ON attendant_metrics_daily(account_id, date, user_id)') } catch (e) {}

// Rate limit do "Analisar agora" + limite mensal de tokens p/ análise + timestamp do último cron noturno
addColumnIfNotExists('accounts', 'last_analysis_at', 'TEXT')
addColumnIfNotExists('accounts', 'last_nightly_at', 'TEXT')
addColumnIfNotExists('accounts', 'analysis_token_limit', 'INTEGER NOT NULL DEFAULT 200000')
// Feature flag — gerente da conta só vê /atendimentos se super_admin ativou.
// Cron noturno + analyzeAllAccounts SO processam contas com flag = 1 (economiza custo).
addColumnIfNotExists('accounts', 'attendant_analytics_enabled', 'INTEGER NOT NULL DEFAULT 0')
// Timestamp do último coaching weekly run (segunda 3h05 UTC). Idempotencia weekly.
addColumnIfNotExists('accounts', 'last_weekly_coaching_at', 'TEXT')

// ─── Conversation Intelligence V2 ───
// Tudo aditivo: V1 continua funcionando, V2 estende quando insights_version = 2.

// Autoria humana de mensagens (V1 só sabia "humano vs bot" via ai_agent_id).
// Backfill best-effort via script de migração; novas msgs preenchem direto no send-flow.
addColumnIfNotExists('messages', 'sent_by_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')
addColumnIfNotExists('messages', 'follow_up_id', 'INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL')
try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sent_by ON messages(sent_by_user_id)') } catch (e) {}

// Receita em risco + tempo até proposta/qualificação por lead.
addColumnIfNotExists('leads', 'value_estimated', 'REAL')
addColumnIfNotExists('leads', 'proposal_sent_at', 'TEXT')
addColumnIfNotExists('leads', 'qualified_at', 'TEXT')

// Flag em funnel_stages: marca stages "qualificado+" (gerente configura).
addColumnIfNotExists('funnel_stages', 'is_qualified', 'INTEGER NOT NULL DEFAULT 0')

// Extender conversation_insights (V1 colunas permanecem; V2 adiciona em cima).
addColumnIfNotExists('conversation_insights', 'insights_version', 'INTEGER NOT NULL DEFAULT 1')
addColumnIfNotExists('conversation_insights', 'conversation_score', 'INTEGER')         // 0-100
addColumnIfNotExists('conversation_insights', 'score_velocidade_sla', 'INTEGER')       // /15
addColumnIfNotExists('conversation_insights', 'score_abertura', 'INTEGER')             // /10
addColumnIfNotExists('conversation_insights', 'score_diagnostico', 'INTEGER')          // /20
addColumnIfNotExists('conversation_insights', 'score_qualificacao', 'INTEGER')         // /15
addColumnIfNotExists('conversation_insights', 'score_conducao', 'INTEGER')             // /15
addColumnIfNotExists('conversation_insights', 'score_objecoes', 'INTEGER')             // /10
addColumnIfNotExists('conversation_insights', 'score_proximo_passo', 'INTEGER')        // /10
addColumnIfNotExists('conversation_insights', 'score_organizacao_crm', 'INTEGER')      // /5
addColumnIfNotExists('conversation_insights', 'temperatura_lead', 'TEXT')              // frio|morno|quente
addColumnIfNotExists('conversation_insights', 'fit_icp', 'INTEGER')                    // 0-100
addColumnIfNotExists('conversation_insights', 'chance_conversao', 'INTEGER')           // 0-100
addColumnIfNotExists('conversation_insights', 'status_recomendado', 'TEXT')
addColumnIfNotExists('conversation_insights', 'mensagem_retomada', 'TEXT')
addColumnIfNotExists('conversation_insights', 'objecoes_detectadas', 'TEXT')           // JSON array
addColumnIfNotExists('conversation_insights', 'motivos_perda', 'TEXT')                 // JSON array
addColumnIfNotExists('conversation_insights', 'riscos_detectados', 'TEXT')             // JSON array
addColumnIfNotExists('conversation_insights', 'prioridade_revisao', 'TEXT')            // baixa|media|alta|critica
addColumnIfNotExists('conversation_insights', 'confidence_score', 'REAL')              // 0..1
addColumnIfNotExists('conversation_insights', 'bot_analysis_json', 'TEXT')
addColumnIfNotExists('conversation_insights', 'handoff_analysis_json', 'TEXT')
addColumnIfNotExists('conversation_insights', 'coaching_recomendado', 'TEXT')
// Incremental analysis: checkpoint por msg.id + counters anti-drift
addColumnIfNotExists('conversation_insights', 'incremental_count', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('conversation_insights', 'last_full_analysis_at', 'TEXT')          // datetime do ultimo FULL
addColumnIfNotExists('conversation_insights', 'last_full_message_id', 'INTEGER')         // msg.id que delimitou o ultimo FULL
try { db.exec('CREATE INDEX IF NOT EXISTS idx_insights_version ON conversation_insights(account_id, insights_version)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_insights_temperatura ON conversation_insights(account_id, temperatura_lead, chance_conversao)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_insights_checkpoint ON conversation_insights(account_id, last_message_id)') } catch (e) {}

// Migration leve idempotente: popula last_message_id e last_full_* em insights v2 que nao tinham
try {
  const migrated = db.prepare(`
    UPDATE conversation_insights
       SET last_message_id = COALESCE(last_message_id, (SELECT MAX(id) FROM messages WHERE lead_id = conversation_insights.lead_id)),
           last_full_analysis_at = COALESCE(last_full_analysis_at, analyzed_at),
           last_full_message_id = COALESCE(last_full_message_id, last_message_id, (SELECT MAX(id) FROM messages WHERE lead_id = conversation_insights.lead_id))
     WHERE insights_version >= 2
       AND (last_message_id IS NULL OR last_full_analysis_at IS NULL OR last_full_message_id IS NULL)
  `).run()
  if (migrated.changes > 0) console.log(`[db] migration: last_message_id/last_full_* populated for ${migrated.changes} v2 insights`)
} catch (e) { console.warn('[db] migration last_message_id:', e.message) }

// Extender attendant_metrics_daily (V1 colunas permanecem).
addColumnIfNotExists('attendant_metrics_daily', 'ttfr_human_avg_seconds', 'REAL')
addColumnIfNotExists('attendant_metrics_daily', 'ttfr_human_p90_seconds', 'REAL')
addColumnIfNotExists('attendant_metrics_daily', 'ttfr_bot_avg_seconds', 'REAL')
addColumnIfNotExists('attendant_metrics_daily', 'tmr_human_avg_seconds', 'REAL')
addColumnIfNotExists('attendant_metrics_daily', 'leads_without_human_response', 'INTEGER DEFAULT 0')
addColumnIfNotExists('attendant_metrics_daily', 'leads_idle_24h', 'INTEGER DEFAULT 0')
addColumnIfNotExists('attendant_metrics_daily', 'leads_idle_72h', 'INTEGER DEFAULT 0')
addColumnIfNotExists('attendant_metrics_daily', 'time_to_qualified_avg_seconds', 'REAL')
addColumnIfNotExists('attendant_metrics_daily', 'time_to_proposal_avg_seconds', 'REAL')

// 3. Catálogo padronizado de erros (populado via seed abaixo).
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_error_catalog (
    code TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    label_pt TEXT NOT NULL,
    default_gravity TEXT NOT NULL,
    default_how_to_fix TEXT
  )
`)

// 4. Erros detectados pela IA (1 linha por (insight, erro)). FK fraca ao catálogo (code sem REFERENCES).
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insight_id INTEGER NOT NULL REFERENCES conversation_insights(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    attendant_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_type TEXT NOT NULL,
    code TEXT,
    category TEXT,
    gravity TEXT,
    description TEXT NOT NULL,
    impact TEXT,
    how_to_fix TEXT,
    evidence_message_ids TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_errors_account_attendant ON conversation_errors(account_id, attendant_user_id, created_at)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_errors_code ON conversation_errors(code)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_errors_insight ON conversation_errors(insight_id)') } catch (e) {}
addColumnIfNotExists('conversation_errors', 'created_via', "TEXT DEFAULT 'full'")        // 'full' | 'incremental'

// 5. Acertos.
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_strengths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insight_id INTEGER NOT NULL REFERENCES conversation_insights(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    attendant_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_type TEXT NOT NULL,
    code TEXT,
    description TEXT NOT NULL,
    impact TEXT,
    evidence_message_ids TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_strengths_account_attendant ON conversation_strengths(account_id, attendant_user_id, created_at)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_strengths_insight ON conversation_strengths(insight_id)') } catch (e) {}
addColumnIfNotExists('conversation_strengths', 'created_via', "TEXT DEFAULT 'full'")     // 'full' | 'incremental'

// 6. Análise por participante (bot/atendente/gerente — 1 linha por insight × actor).
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_participant_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insight_id INTEGER NOT NULL REFERENCES conversation_insights(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_ai_agent_id INTEGER,
    actor_name TEXT,
    score INTEGER,
    acertos_summary TEXT,
    erros_summary TEXT,
    recomendacao TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_participant_lookup ON conversation_participant_analysis(account_id, actor_type, actor_user_id, created_at)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_conv_participant_insight ON conversation_participant_analysis(insight_id)') } catch (e) {}

// 7. Alertas operacionais (lead quente abandonado, proposta sem retorno, erro crítico, bot falhou).
db.exec(`
  CREATE TABLE IF NOT EXISTS analyst_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    insight_id INTEGER REFERENCES conversation_insights(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    suggested_action TEXT,
    assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_account_status ON analyst_alerts(account_id, status, severity)') } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_lead ON analyst_alerts(lead_id)') } catch (e) {}

// 8. Coaching semanal (1 linha por user × semana). Cron toda segunda 3h05 UTC.
db.exec(`
  CREATE TABLE IF NOT EXISTS attendant_coaching_weekly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    summary TEXT,
    strengths TEXT,
    improvements TEXT,
    conversations_to_review TEXT,
    training_recommended TEXT,
    suggested_script TEXT,
    goal_next_week TEXT,
    ai_score_avg_week REAL,
    tokens_used INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, user_id, week_start)
  )
`)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_coaching_week ON attendant_coaching_weekly(account_id, week_start)') } catch (e) {}

// Seed inicial do catálogo de erros (idempotente via INSERT OR IGNORE).
const errorCatalogSeed = [
  // velocidade
  { code: 'velocidade.demorou_resposta_inicial', category: 'velocidade', label_pt: 'Demorou para responder o lead', default_gravity: 'alta', default_how_to_fix: 'Responder em até 5 min após chegar o lead.' },
  { code: 'velocidade.abandonou_meio_conversa', category: 'velocidade', label_pt: 'Respondeu rápido no começo mas abandonou', default_gravity: 'alta', default_how_to_fix: 'Manter ritmo de resposta consistente até o fechamento.' },
  { code: 'velocidade.demorou_apos_interesse', category: 'velocidade', label_pt: 'Demorou após lead demonstrar interesse', default_gravity: 'critica', default_how_to_fix: 'Tratar pedido de preço/proposta como prioridade imediata.' },
  // diagnostico
  { code: 'diagnostico.nao_perguntou_necessidade', category: 'diagnostico', label_pt: 'Não perguntou a necessidade real', default_gravity: 'alta', default_how_to_fix: 'Fazer 2-3 perguntas abertas antes de apresentar preço.' },
  { code: 'diagnostico.pulou_para_preco', category: 'diagnostico', label_pt: 'Pulou direto para preço sem qualificar', default_gravity: 'alta', default_how_to_fix: 'Entender contexto e dor antes de enviar valor.' },
  { code: 'diagnostico.nao_identificou_decisor', category: 'diagnostico', label_pt: 'Não identificou o decisor da compra', default_gravity: 'media', default_how_to_fix: 'Perguntar quem mais participa da decisão.' },
  { code: 'diagnostico.pergunta_generica', category: 'diagnostico', label_pt: 'Fez pergunta genérica demais', default_gravity: 'baixa', default_how_to_fix: 'Personalizar perguntas conforme contexto da empresa/produto.' },
  // conducao
  { code: 'conducao.nao_pediu_proximo_passo', category: 'conducao', label_pt: 'Não definiu o próximo passo', default_gravity: 'alta', default_how_to_fix: 'Terminar toda mensagem com convite a uma ação concreta.' },
  { code: 'conducao.mensagem_robotica', category: 'conducao', label_pt: 'Mensagem fria/robótica/sem personalização', default_gravity: 'media', default_how_to_fix: 'Usar nome do lead, citar contexto, adaptar tom.' },
  { code: 'conducao.nao_explicou_valor', category: 'conducao', label_pt: 'Não conectou produto com a dor do cliente', default_gravity: 'alta', default_how_to_fix: 'Mostrar como o produto resolve a dor mencionada antes do preço.' },
  { code: 'conducao.nao_ofereceu_proposta', category: 'conducao', label_pt: 'Não ofereceu proposta no momento certo', default_gravity: 'alta', default_how_to_fix: 'Quando o lead demonstrar interesse, enviar proposta objetiva.' },
  { code: 'conducao.mensagem_muito_longa', category: 'conducao', label_pt: 'Mensagem muito longa / cansativa', default_gravity: 'baixa', default_how_to_fix: 'Dividir em mensagens curtas e diretas.' },
  // objecao
  { code: 'objecao.ignorou_objecao_preco', category: 'objecao', label_pt: 'Ignorou objeção de preço', default_gravity: 'critica', default_how_to_fix: 'Reconhecer a objeção, mostrar ROI, oferecer alternativa.' },
  { code: 'objecao.aceitou_vou_pensar', category: 'objecao', label_pt: 'Aceitou "vou pensar" sem follow-up', default_gravity: 'alta', default_how_to_fix: 'Combinar data e horário pra retornar antes de encerrar.' },
  { code: 'objecao.defensivo', category: 'objecao', label_pt: 'Respondeu objeção de forma defensiva', default_gravity: 'media', default_how_to_fix: 'Reformular como benefício, mostrar empatia.' },
  // crm
  { code: 'crm.nao_mudou_etapa', category: 'crm', label_pt: 'Não atualizou a etapa do funil', default_gravity: 'baixa', default_how_to_fix: 'Mover o lead conforme avança na conversa.' },
  { code: 'crm.nao_registrou_motivo_perda', category: 'crm', label_pt: 'Não registrou motivo da perda', default_gravity: 'media', default_how_to_fix: 'Sempre registrar tag/motivo ao mover pra "perdido".' },
  // handoff/bot
  { code: 'bot.nao_transferiu', category: 'crm', label_pt: 'Bot não transferiu pra humano quando devia', default_gravity: 'critica', default_how_to_fix: 'Configurar gatilho de handoff (palavra-chave, intent forte).' },
  { code: 'bot.entendeu_errado', category: 'crm', label_pt: 'Bot interpretou mal a mensagem', default_gravity: 'media', default_how_to_fix: 'Revisar treinamento do bot e adicionar exemplos.' },
  { code: 'handoff.sem_contexto', category: 'crm', label_pt: 'Transferência sem contexto', default_gravity: 'alta', default_how_to_fix: 'Resumir conversa e dor do lead antes de transferir.' },
]
const insertCatalogStmt = db.prepare(`
  INSERT OR IGNORE INTO conversation_error_catalog (code, category, label_pt, default_gravity, default_how_to_fix)
  VALUES (?, ?, ?, ?, ?)
`)
for (const e of errorCatalogSeed) {
  try { insertCatalogStmt.run(e.code, e.category, e.label_pt, e.default_gravity, e.default_how_to_fix) } catch (err) {}
}

// Agentes de IA (Claude Haiku 4.5) — F0+1 schema
addColumnIfNotExists('accounts', 'ai_agents_enabled', 'INTEGER NOT NULL DEFAULT 0')
// API key Anthropic POR CONTA — cada cliente usa a propria conta Anthropic em todas as chamadas Claude.
// Sem fallback pra chave da agencia: conta sem chave nao roda IA (texto). Audio (Deepgram) segue global.
addColumnIfNotExists('accounts', 'anthropic_api_key', 'TEXT')
addColumnIfNotExists('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('messages', 'ai_agent_id', 'INTEGER')
addColumnIfNotExists('leads', 'ai_handed_off_at', 'TEXT')
// Auto-rescue do bot: cooldown pra evitar disparar 2x mesmo lead em ticks consecutivos
addColumnIfNotExists('leads', 'last_rescue_attempt_at', 'TEXT')

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_agents (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id                  INTEGER NOT NULL,
    user_id                     INTEGER NOT NULL,
    name                        TEXT NOT NULL,
    is_active                   INTEGER NOT NULL DEFAULT 1,
    identifies_as_bot           INTEGER NOT NULL DEFAULT 1,
    persona                     TEXT,
    knowledge_base              TEXT,
    never_mention               TEXT,
    qualification_criteria      TEXT,
    required_fields             TEXT,
    responds_to_audio           INTEGER NOT NULL DEFAULT 0,
    audio_decline_message       TEXT DEFAULT 'Oi! Por enquanto só leio mensagens de texto. Pode digitar pra mim?',
    max_messages_before_handoff INTEGER NOT NULL DEFAULT 15,
    handoff_keywords            TEXT DEFAULT 'humano,atendente,vendedor,corretor,pessoa',
    activation_mode             TEXT NOT NULL DEFAULT 'conditional',
    required_tag_id             INTEGER,
    monthly_token_limit         INTEGER NOT NULL DEFAULT 500000,
    tokens_used_this_month      INTEGER NOT NULL DEFAULT 0,
    current_month               TEXT,
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (required_tag_id) REFERENCES tags(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS ai_agent_stages (
    agent_id INTEGER NOT NULL,
    stage_id INTEGER NOT NULL,
    PRIMARY KEY (agent_id, stage_id),
    FOREIGN KEY (agent_id) REFERENCES ai_agents(id) ON DELETE CASCADE,
    FOREIGN KEY (stage_id) REFERENCES funnel_stages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ai_agent_instances (
    agent_id    INTEGER NOT NULL,
    instance_id INTEGER NOT NULL,
    PRIMARY KEY (agent_id, instance_id),
    FOREIGN KEY (agent_id) REFERENCES ai_agents(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ai_agent_handoff_rules (
    agent_id              INTEGER NOT NULL,
    reason                TEXT NOT NULL,
    target_type           TEXT NOT NULL,
    target_user_id        INTEGER,
    fallback_to_roulette  INTEGER NOT NULL DEFAULT 1,
    move_to_stage_id      INTEGER,
    add_tag_id            INTEGER,
    PRIMARY KEY (agent_id, reason),
    FOREIGN KEY (agent_id) REFERENCES ai_agents(id) ON DELETE CASCADE,
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (move_to_stage_id) REFERENCES funnel_stages(id) ON DELETE SET NULL,
    FOREIGN KEY (add_tag_id) REFERENCES tags(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS ai_agent_token_log (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id              INTEGER NOT NULL,
    account_id            INTEGER NOT NULL,
    lead_id               INTEGER,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd              REAL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES ai_agents(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ai_agents_account ON ai_agents(account_id, is_active);
  CREATE INDEX IF NOT EXISTS idx_ai_token_log_month ON ai_agent_token_log(agent_id, created_at);
`)

// STT (speech-to-text) — colunas pra rastrear custo de transcricao de audio (Deepgram)
addColumnIfNotExists('ai_agent_token_log', 'stt_seconds', 'REAL DEFAULT 0')
addColumnIfNotExists('ai_agent_token_log', 'stt_cost_usd', 'REAL DEFAULT 0')
addColumnIfNotExists('ai_agent_token_log', 'stt_provider', 'TEXT')
// 'source' identifica de onde veio a chamada (default null = msg reativa do lead; 'welcome_sheets' = sauda
// cao auto pra lead novo de planilha). Permite filtrar custos por tipo no dashboard.
addColumnIfNotExists('ai_agent_token_log', 'source', 'TEXT')

// Migração: ai_agent_token_log.agent_id NOT NULL bloqueia analise V2 e coaching (que nao tem agente conversacional).
// SQLite nao permite ALTER COLUMN — recria tabela + copia dados.
try {
  const cols = db.prepare("PRAGMA table_info(ai_agent_token_log)").all()
  const agentIdCol = cols.find(c => c.name === 'agent_id')
  // notnull pode vir como Number 1 ou string "1" dependendo do driver — usa truthy check
  if (agentIdCol && Number(agentIdCol.notnull) === 1) {
    console.log('[DB] Migracao ai_agent_token_log.agent_id NOT NULL -> NULL iniciando...')
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE ai_agent_token_log_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id              INTEGER,
        account_id            INTEGER NOT NULL,
        lead_id               INTEGER,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd              REAL,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        stt_seconds           REAL DEFAULT 0,
        stt_cost_usd          REAL DEFAULT 0,
        stt_provider          TEXT,
        source                TEXT,
        FOREIGN KEY (agent_id) REFERENCES ai_agents(id) ON DELETE CASCADE
      );
      INSERT INTO ai_agent_token_log_new
        (id, agent_id, account_id, lead_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at, stt_seconds, stt_cost_usd, stt_provider, source)
      SELECT
        id, agent_id, account_id, lead_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at,
        COALESCE(stt_seconds, 0), COALESCE(stt_cost_usd, 0), stt_provider, source
      FROM ai_agent_token_log;
      DROP TABLE ai_agent_token_log;
      ALTER TABLE ai_agent_token_log_new RENAME TO ai_agent_token_log;
      CREATE INDEX IF NOT EXISTS idx_ai_token_log_month ON ai_agent_token_log(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_token_log_source ON ai_agent_token_log(account_id, source, created_at);
    `)
    db.pragma('foreign_keys = ON')
    console.log('[DB] Migracao ai_agent_token_log concluida')
  } else {
    console.log(`[DB] ai_agent_token_log.agent_id ja eh nullable (notnull=${agentIdCol?.notnull}) — migracao pulada`)
  }
} catch (e) {
  console.error('[DB] Migracao ai_agent_token_log FALHOU:', e.message, e.stack)
  try { db.pragma('foreign_keys = ON') } catch {}
}

// Welcome msg pra leads novos de planilha (Haiku-gerada) — opt-in por agente.
addColumnIfNotExists('ai_agents', 'send_welcome_for_sheets_leads', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('ai_agents', 'welcome_extra_instructions', 'TEXT')
// Timestamp da pausa (toggle do bot). NULL = ativo. Usado pra replay da ultima msg quando reativa.
addColumnIfNotExists('ai_agents', 'paused_at', 'TEXT')

// Status WhatsApp por msg (estilo WhatsApp Web — sent/delivered/read).
// `delivery_status` default 'sent' eh compativel com msgs antigas (que ja sao consideradas enviadas).
addColumnIfNotExists('messages', 'delivery_status', "TEXT NOT NULL DEFAULT 'sent'")
addColumnIfNotExists('messages', 'delivered_at', 'TEXT')
addColumnIfNotExists('messages', 'read_at', 'TEXT')

// Contador denormalizado de msgs inbound nao lidas por lead — zerado quando vendedor abre o chat.
addColumnIfNotExists('leads', 'unread_count', 'INTEGER NOT NULL DEFAULT 0')

// Indexes pra lookup de status (webhook update por wa_msg_id) e badge sidebar.
// Sem WHERE clause: sqlite3 CLI do CentOS 7 nao parseia partial index, quebra inspecao manual.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_wa_msg_id ON messages(wa_msg_id)') } catch (e) { console.warn('[db] idx_messages_wa_msg_id:', e.message) }
// FIX B — UNIQUE constraint em wa_msg_id: elimina duplicidade por retry do webhook Evolution.
// Se webhook chegar 2x muito rapido (antes do primeiro INSERT commitar), o segundo falha por
// constraint violation e o try/catch no handler ignora — msg fica salva 1x apenas.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_wa_msg_id ON messages(wa_msg_id) WHERE wa_msg_id IS NOT NULL') } catch (e) { console.warn('[db] uniq_messages_wa_msg_id:', e.message) }

// FASE 3+ Opcao 1 — historico de JIDs por lead (nao refatora lookup, so registra).
// Toda vez que um lead recebe/envia msg com um JID, registramos aqui. Assim:
// - Consulta consegue ver todos os JIDs historicos que um lead ja usou (@lid1, @lid2, @s.whatsapp.net)
// - Se futuro precisar merge complexo, os dados historicos ja estao la
// - UNIQUE(lead_id, jid) evita duplicata do mesmo par
// - jid_type facilita analise: 'lid' | 's.whatsapp.net' | 'c.us' | 'unknown'
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_wa_jids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      jid TEXT NOT NULL,
      jid_type TEXT NOT NULL DEFAULT 'unknown',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (lead_id, jid)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_lead_wa_jids_jid ON lead_wa_jids(jid)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_lead_wa_jids_lead ON lead_wa_jids(lead_id, last_seen_at DESC)')
  // Backfill inicial (idempotente): pra cada lead com wa_remote_jid, registra 1 linha
  db.exec(`
    INSERT OR IGNORE INTO lead_wa_jids (lead_id, jid, jid_type)
    SELECT id, wa_remote_jid,
      CASE
        WHEN wa_remote_jid LIKE '%@lid' THEN 'lid'
        WHEN wa_remote_jid LIKE '%@s.whatsapp.net' THEN 's.whatsapp.net'
        WHEN wa_remote_jid LIKE '%@c.us' THEN 'c.us'
        ELSE 'unknown'
      END
    FROM leads WHERE wa_remote_jid IS NOT NULL AND wa_remote_jid != ''
  `)
} catch (e) { console.warn('[db] lead_wa_jids:', e.message) }

// FASE 1 — UNIQUE parcial em leads pra bloquear duplicidade estrutural.
// Combinado com retry logic no getOrCreateLead (webhooks.js), garante zero perda:
// se webhook race criar 2 INSERT, o 2o falha por UNIQUE, retry-SELECT acha o 1o, msg cai no lead certo.
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leads_account_phone ON leads(account_id, phone) WHERE phone IS NOT NULL') } catch (e) { console.warn('[db] uniq_leads_account_phone:', e.message) }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leads_account_wajid ON leads(account_id, wa_remote_jid) WHERE wa_remote_jid IS NOT NULL') } catch (e) { console.warn('[db] uniq_leads_account_wajid:', e.message) }

// FIX D — Dead-letter table: guarda payload de msgs que NAO conseguimos linkar a lead.
// Quando o webhook cai em algum early-return silencioso (sem phone, sem lead, normalize failed),
// ao inves de descartar, grava aqui pra investigacao/replay futuro.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_orphan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      account_slug TEXT,
      reason TEXT NOT NULL,
      wa_msg_id TEXT,
      remote_jid TEXT,
      push_name TEXT,
      from_me INTEGER,
      payload_raw TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_msgs_orphan_reason ON messages_orphan(reason, received_at DESC)')
} catch (e) { console.warn('[db] messages_orphan:', e.message) }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_unread ON leads(account_id, unread_count)') } catch (e) { console.warn('[db] idx_leads_unread:', e.message) }

// ─── FASE 1 PERFORMANCE — indices compostos pra contas grandes (1500+ leads) ───
// Aditivos / idempotentes. Aceleram queries do Chat/Pipeline/Leads.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_account_active_archived_stage ON leads(account_id, is_active, is_archived, stage_id)') } catch (e) { console.warn('[db] idx_leads_account_active_archived_stage:', e.message) }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_account_updated_desc ON leads(account_id, updated_at DESC)') } catch (e) { console.warn('[db] idx_leads_account_updated_desc:', e.message) }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_lead_tags_tag_lead ON lead_tags(tag_id, lead_id)') } catch (e) { console.warn('[db] idx_lead_tags_tag_lead:', e.message) }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_lead_instance ON messages(lead_id, instance_id)') } catch (e) { console.warn('[db] idx_messages_lead_instance:', e.message) }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_archived_count ON leads(account_id, is_archived, has_new_after_archive)') } catch (e) { console.warn('[db] idx_leads_archived_count:', e.message) }

// Follow-ups (cadencias automaticas — diferentes das cadencias manuais ja existentes)
db.exec(`
  CREATE TABLE IF NOT EXISTS follow_ups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    instance_id     INTEGER NOT NULL,
    stop_on_reply   INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_by      INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS follow_up_steps (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    follow_up_id      INTEGER NOT NULL,
    position          INTEGER NOT NULL,
    delay_minutes     INTEGER NOT NULL DEFAULT 0,
    message_template  TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (follow_up_id) REFERENCES follow_ups(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_followup_steps ON follow_up_steps(follow_up_id, position);

  CREATE TABLE IF NOT EXISTS lead_follow_ups (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id                  INTEGER NOT NULL,
    follow_up_id             INTEGER NOT NULL,
    current_step_id          INTEGER,
    status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    next_run_at              TEXT,
    last_executed_at         TEXT,
    last_executed_step_id    INTEGER,
    paused_at                TEXT,
    paused_reason            TEXT,
    started_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_by              INTEGER,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (follow_up_id) REFERENCES follow_ups(id) ON DELETE CASCADE,
    FOREIGN KEY (current_step_id) REFERENCES follow_up_steps(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_followups_pending ON lead_follow_ups(status, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_lead_followups_by_lead ON lead_follow_ups(lead_id, status);
`)
// whatsapp_instances.lead_intake_mode: 'open' (atual, qualquer msg cria lead) | 'restricted' (so processa leads ja cadastrados no CRM)
addColumnIfNotExists('whatsapp_instances', 'lead_intake_mode', "TEXT NOT NULL DEFAULT 'open'")
// leads.is_blocked: bloqueio total (lead some do CRM e mensagens futuras sao silenciosamente ignoradas pelo webhook)
addColumnIfNotExists('leads', 'is_blocked', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('leads', 'blocked_at', 'TEXT')
addColumnIfNotExists('leads', 'blocked_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')
// Indice composto pra query O(1) do gate no webhook (account + phone + flag)
db.exec('CREATE INDEX IF NOT EXISTS idx_leads_blocked_phone ON leads(account_id, phone, is_blocked)')
// contracts: quantidade de videos/imagens por mes (so aparece quando Frente 4 - Linha Editorial esta ativa)
addColumnIfNotExists('contracts', 'videos_por_mes', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfNotExists('contracts', 'imagens_por_mes', 'INTEGER NOT NULL DEFAULT 0')

// Contracts v2: aprovacao (cria account/user) - 2026-05-26
addColumnIfNotExists('contracts', 'approved_at', 'TEXT')
addColumnIfNotExists('contracts', 'approved_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL')
addColumnIfNotExists('contracts', 'account_id', 'INTEGER REFERENCES accounts(id) ON DELETE SET NULL')
addColumnIfNotExists('contracts', 'approved_email', 'TEXT')
// Contracts v3: integracao com HUB ao aprovar
addColumnIfNotExists('contracts', 'hub_client_id', 'INTEGER')

// Label editavel de instancia (nao afeta instance_name real usado na Evolution).
// Preserva sessao Baileys ao renomear no CRM.
addColumnIfNotExists('whatsapp_instances', 'display_name', 'TEXT')
// Lead handoff v1: primeira msg automatica do vendedor + notificacao
addColumnIfNotExists('whatsapp_instances', 'first_msg_template', 'TEXT')
addColumnIfNotExists('users', 'notification_instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')
addColumnIfNotExists('leads', 'first_msg_sent_at', 'TEXT')
// Bot IA marca quando enviou a primeira saudacao (separado de first_msg_sent_at do template estatico).
addColumnIfNotExists('leads', 'ai_first_msg_sent_at', 'TEXT')
addColumnIfNotExists('funnels', 'first_msg_template', 'TEXT')

// Tabela de configs globais (notifier instance configuravel via UI super_admin)
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)
// users.can_grab_leads: permite ao atendente "tomar" leads de outros sem precisar aprovacao
addColumnIfNotExists('users', 'can_grab_leads', 'INTEGER NOT NULL DEFAULT 0')
// messages.instance_id: qual instancia enviou/recebeu cada mensagem (mostrado internamente no chat)
addColumnIfNotExists('messages', 'instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')

// ─── Multi-conversation: cada lead pode ter conversa com varias instancias
// e cada conversa tem seu proprio atendente
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_instance_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id       INTEGER NOT NULL,
    instance_id   INTEGER NOT NULL,
    attendant_id  INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(lead_id, instance_id),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE,
    FOREIGN KEY (attendant_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lia_lead ON lead_instance_assignments(lead_id);
  CREATE INDEX IF NOT EXISTS idx_lia_instance ON lead_instance_assignments(instance_id);
  CREATE INDEX IF NOT EXISTS idx_lia_attendant ON lead_instance_assignments(attendant_id);
`)

// Backfill: pra cada lead com instance_id, cria assignment se nao existir
try {
  db.prepare(`
    INSERT OR IGNORE INTO lead_instance_assignments (lead_id, instance_id, attendant_id)
    SELECT id, instance_id, attendant_id FROM leads WHERE instance_id IS NOT NULL
  `).run()
  // Tambem cria assignments pra cada lead com last_instance_id != instance_id
  db.prepare(`
    INSERT OR IGNORE INTO lead_instance_assignments (lead_id, instance_id, attendant_id)
    SELECT id, last_instance_id, attendant_id FROM leads
    WHERE last_instance_id IS NOT NULL AND last_instance_id != COALESCE(instance_id, -1)
  `).run()
} catch (e) { console.log('[DB] Backfill lead_instance_assignments:', e.message) }

// Standalone tasks (not tied to cadences)
db.exec(`
  CREATE TABLE IF NOT EXISTS standalone_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL,
    lead_id         INTEGER,
    assigned_to     INTEGER,
    title           TEXT NOT NULL,
    description     TEXT,
    due_datetime    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
    created_by      INTEGER,
    completed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (assigned_to) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )
`)

// Pedidos de transferencia de lead entre atendentes (Emily pede o lead que esta com Deivid)
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_transfer_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id           INTEGER NOT NULL,
    from_attendant_id INTEGER NOT NULL,
    to_attendant_id   INTEGER,
    account_id        INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
    message           TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at      TEXT,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (from_attendant_id) REFERENCES users(id),
    FOREIGN KEY (to_attendant_id) REFERENCES users(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_transfer_pending ON lead_transfer_requests(to_attendant_id, status);
  CREATE INDEX IF NOT EXISTS idx_transfer_from ON lead_transfer_requests(from_attendant_id, status);
`)

// Auto-mensagens por instância (saudação, ausência)
db.exec(`
  CREATE TABLE IF NOT EXISTS instance_auto_messages (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id                 INTEGER NOT NULL UNIQUE,
    greeting_enabled            INTEGER NOT NULL DEFAULT 0,
    greeting_text               TEXT,
    away_enabled                INTEGER NOT NULL DEFAULT 0,
    away_mode                   TEXT NOT NULL DEFAULT 'manual',
    away_manual_active          INTEGER NOT NULL DEFAULT 0,
    away_text                   TEXT,
    away_schedule_json          TEXT,
    away_cooldown_hours         INTEGER NOT NULL DEFAULT 4,
    greeting_cooldown_hours     INTEGER NOT NULL DEFAULT 24,
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE
  );

  -- Log de auto-mensagens enviadas (anti-flood + auditoria)
  -- type aceita 'greeting' e 'away' (outros tipos legados ficam no CHECK pra compat)
  CREATE TABLE IF NOT EXISTS auto_messages_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    instance_id INTEGER NOT NULL,
    account_id  INTEGER NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('greeting','away','inactivity_lead','inactivity_agent')),
    message_id  INTEGER,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_auto_log_lead ON auto_messages_log(lead_id, type, sent_at);
  CREATE INDEX IF NOT EXISTS idx_auto_log_instance ON auto_messages_log(instance_id, type);

  CREATE TABLE IF NOT EXISTS tag_instance_mapping (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    INTEGER NOT NULL,
    tag_id        INTEGER NOT NULL,
    instance_id   INTEGER NOT NULL,
    attendant_id  INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, tag_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE,
    FOREIGN KEY (attendant_id) REFERENCES users(id) ON DELETE SET NULL
  );
`)

// Instância padrão pra leads de formulário
addColumnIfNotExists('accounts', 'default_form_instance_id', 'INTEGER REFERENCES whatsapp_instances(id) ON DELETE SET NULL')

// Proposals (proposta comercial gerada pelo super_admin)
db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    slug              TEXT NOT NULL UNIQUE,
    client_name       TEXT NOT NULL,
    phone             TEXT,
    segmento          TEXT,
    has_production    INTEGER NOT NULL DEFAULT 1,
    num_videos        INTEGER NOT NULL DEFAULT 0,
    num_images        INTEGER NOT NULL DEFAULT 0,
    valor             REAL NOT NULL DEFAULT 0,
    contrato_meses    INTEGER NOT NULL DEFAULT 3,
    observacoes       TEXT,
    created_by        INTEGER,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_slug ON proposals(slug);
`)

// Contracts (contrato de prestacao de servicos — gerenciado por super_admin OU users.can_manage_contracts=1)
db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    numero                TEXT NOT NULL UNIQUE,
    razao_social          TEXT NOT NULL,
    cnpj                  TEXT NOT NULL,
    inscricao_estadual    TEXT,
    endereco_logradouro   TEXT NOT NULL,
    endereco_bairro       TEXT NOT NULL,
    endereco_cep          TEXT NOT NULL,
    endereco_cidade       TEXT NOT NULL,
    endereco_estado       TEXT NOT NULL,
    fee_mensal            REAL NOT NULL DEFAULT 3500,
    comissao_percent      REAL NOT NULL DEFAULT 1.0,
    vigencia_meses        INTEGER NOT NULL DEFAULT 3,
    data_inicio           TEXT NOT NULL,
    data_fim              TEXT NOT NULL,
    renovacao_meses       INTEGER NOT NULL DEFAULT 12,
    aviso_previo_dias     INTEGER NOT NULL DEFAULT 30,
    reajuste_indice       TEXT NOT NULL DEFAULT 'IGPM/FGV',
    frente_diagnostico    INTEGER NOT NULL DEFAULT 1,
    frente_estruturacao   INTEGER NOT NULL DEFAULT 1,
    frente_aquisicao      INTEGER NOT NULL DEFAULT 1,
    frente_editorial      INTEGER NOT NULL DEFAULT 1,
    exclusoes_extras      TEXT,
    fat_mes1_ref          TEXT,
    fat_mes1_valor        REAL,
    fat_mes2_ref          TEXT,
    fat_mes2_valor        REAL,
    fat_mes3_ref          TEXT,
    fat_mes3_valor        REAL,
    fat_base              REAL,
    local_assinatura      TEXT NOT NULL DEFAULT 'Sombrio/SC',
    data_assinatura       TEXT NOT NULL,
    created_by            INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contracts_created_at ON contracts(created_at DESC);
`)

// ─── Global templates (Plano C) ─────────────────────────────────────────
// Templates de cadences e follow-ups criados pelo super_admin, sem account_id.
// Ao "aplicar" numa conta, e feito um SNAPSHOT (INSERT em cadences/follow_ups com cloned_from_global_id).
// Editar template global NAO propaga pras contas — precisa "Reaplicar".
db.exec(`
  CREATE TABLE IF NOT EXISTS global_cadences (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS global_cadence_attempts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    global_cadence_id  INTEGER NOT NULL REFERENCES global_cadences(id) ON DELETE CASCADE,
    position           INTEGER NOT NULL DEFAULT 1,
    action_type        TEXT NOT NULL DEFAULT 'mensagem',
    description        TEXT,
    instructions       TEXT,
    delay_days         INTEGER NOT NULL DEFAULT 0,
    delay_minutes      INTEGER,
    scheduled_time     TEXT,
    auto_message       TEXT,
    schedule_mode      TEXT NOT NULL DEFAULT 'date',
    call_script        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gca_cadence ON global_cadence_attempts(global_cadence_id, position);

  CREATE TABLE IF NOT EXISTS global_follow_ups (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    name                      TEXT NOT NULL,
    description               TEXT,
    stop_on_reply             INTEGER NOT NULL DEFAULT 1,
    is_active                 INTEGER NOT NULL DEFAULT 1,
    type                      TEXT NOT NULL DEFAULT 'sequence',
    inactivity_days           INTEGER,
    inactivity_minutes        INTEGER,
    inactivity_mode           TEXT DEFAULT 'rotation',
    variation_delay_seconds   INTEGER NOT NULL DEFAULT 30,
    on_reply_action           TEXT NOT NULL DEFAULT 'pause',
    created_by                INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
    -- Sem instance_id/agent_id/inactivity_stage_id/on_reply_*_id: resolvidos no apply() por conta
  );
  CREATE TABLE IF NOT EXISTS global_follow_up_steps (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    global_follow_up_id   INTEGER NOT NULL REFERENCES global_follow_ups(id) ON DELETE CASCADE,
    position              INTEGER NOT NULL DEFAULT 1,
    delay_minutes         INTEGER NOT NULL DEFAULT 60,
    message_template      TEXT NOT NULL DEFAULT '',
    schedule_mode         TEXT NOT NULL DEFAULT 'relative',
    scheduled_at          TEXT,
    variations            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gfs_followup ON global_follow_up_steps(global_follow_up_id, position);
`)

// Audit: qual template global originou uma cadence/follow-up numa conta (nullable — nao migra dados antigos)
addColumnIfNotExists('cadences', 'cloned_from_global_id', 'INTEGER REFERENCES global_cadences(id) ON DELETE SET NULL')
addColumnIfNotExists('follow_ups', 'cloned_from_global_id', 'INTEGER REFERENCES global_follow_ups(id) ON DELETE SET NULL')

// Seed super_admin if not exists
const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@sheraos.com')
if (!adminExists) {
  db.prepare(`
    INSERT INTO users (name, email, password, role, account_id) VALUES (?, ?, ?, 'super_admin', NULL)
  `).run('Sheraos Admin', 'admin@sheraos.com', bcrypt.hashSync('sheraos2026', 10))
  console.log('[DB] Super admin created: admin@sheraos.com')
}

console.log('[DB] SQLite ready at', dbPath)

export default db
