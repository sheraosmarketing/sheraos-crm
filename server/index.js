import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../.env') })

import db from './db.js'
import authRoutes from './routes/auth.js'
import accountRoutes from './routes/accounts.js'
import userRoutes from './routes/users.js'
import funnelRoutes from './routes/funnels.js'
import leadRoutes from './routes/leads.js'
import tagMappingRoutes from './routes/tag-mapping.js'
import messageRoutes from './routes/messages.js'
import dashboardRoutes from './routes/dashboard.js'
import webhookRoutes from './routes/webhooks.js'
import integrationRoutes from './routes/integrations.js'
import broadcastRoutes from './routes/broadcasts.js'
import cadenceRoutes from './routes/cadences.js'
import readyMessageRoutes from './routes/ready-messages.js'
import qualificationRoutes from './routes/qualifications.js'
import launchRoutes from './routes/launches.js'
import taskRoutes from './routes/tasks.js'
import proposalRoutes, { publicProposalHandler } from './routes/proposals.js'
import contractRoutes from './routes/contracts.js'
import followUpRoutes from './routes/follow-ups.js'
import agentRoutes from './routes/agents.js'
import adminRoutes from './routes/admin.js'
import appSettingsRoutes from './routes/app-settings.js'
import globalTemplatesRoutes from './routes/globalTemplates.js'
import { authenticate, scopeToAccount } from './middleware/auth.js'
import { addSSEClient, removeSSEClient } from './sse.js'
import { startScheduler } from './scheduler.js'
import { recoverPendingBroadcasts } from './routes/broadcasts.js'

const app = express()
// Atras de Apache reverse proxy — confia no X-Forwarded-For pra req.ip funcionar
app.set('trust proxy', 1)
app.use(cors())
app.use(express.json({ limit: '25mb' }))

const PORT = 3002

// Strip /crm prefix so /crm/api/* maps to /api/*
app.use((req, res, next) => {
  if (req.url.startsWith('/crm/api/')) req.url = req.url.slice(4)
  else if (req.url === '/crm/api') req.url = '/api'
  next()
})

// Public routes
app.use('/api/auth', authRoutes)
app.use('/api/webhooks', webhookRoutes)

// Public proposal viewer (sem auth) — /crm/proposta/:slug ou /proposta/:slug
app.get('/proposta/:slug', publicProposalHandler)
app.get('/crm/proposta/:slug', publicProposalHandler)

// Protected routes (all require auth)
app.use('/api/accounts', authenticate, accountRoutes)
app.use('/api/users', authenticate, userRoutes)
app.use('/api/funnels', authenticate, scopeToAccount, funnelRoutes)
app.use('/api/leads', authenticate, scopeToAccount, leadRoutes)
app.use('/api/tag-mapping', authenticate, scopeToAccount, tagMappingRoutes)
app.use('/api/messages', authenticate, scopeToAccount, messageRoutes)
app.use('/api/dashboard', authenticate, scopeToAccount, dashboardRoutes)
app.use('/api/integrations', authenticate, scopeToAccount, integrationRoutes)
app.use('/api/broadcasts', authenticate, scopeToAccount, broadcastRoutes)
app.use('/api/cadences', authenticate, scopeToAccount, cadenceRoutes)
app.use('/api/ready-messages', authenticate, scopeToAccount, readyMessageRoutes)
app.use('/api/qualifications', authenticate, scopeToAccount, qualificationRoutes)
app.use('/api/launches', authenticate, scopeToAccount, launchRoutes)
app.use('/api/tasks', authenticate, scopeToAccount, taskRoutes)
app.use('/api/proposals', authenticate, proposalRoutes)
app.use('/api/contracts', authenticate, contractRoutes)
// FASE 1 — Health check publico (sem auth) pro Docker healthcheck.
// Retorna 200 se DB responde + Evolution API responde. Retorna 503 se algo tá down.
app.get('/api/health', async (req, res) => {
  const health = { status: 'ok', db: false, evolution: false, timestamp: new Date().toISOString() }
  try {
    db.prepare('SELECT 1').get()
    health.db = true
  } catch (e) { health.db_error = e.message }
  try {
    const evoUrl = process.env.EVOLUTION_API_URL || 'http://evolution:8080'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const r = await fetch(evoUrl, { signal: controller.signal })
    clearTimeout(timeout)
    health.evolution = r.ok
  } catch (e) { health.evolution_error = e.message }
  const ok = health.db && health.evolution
  res.status(ok ? 200 : 503).json(health)
})

app.use('/api/follow-ups', authenticate, scopeToAccount, followUpRoutes)
app.use('/api/agents', authenticate, scopeToAccount, agentRoutes)
app.use('/api/admin', authenticate, adminRoutes)
app.use('/api/app-settings', authenticate, appSettingsRoutes)
// Templates globais (super_admin only) — sem scopeToAccount pq nao sao presos a conta
app.use('/api/global-templates', authenticate, globalTemplatesRoutes)

// Settings: distribution rules
app.get('/api/settings/distribution', authenticate, scopeToAccount, (req, res) => {
  if (!req.accountId) return res.json({ rules: [] })
  const rules = db.prepare('SELECT * FROM distribution_rules WHERE account_id = ?').all(req.accountId)
  res.json({ rules })
})

app.post('/api/settings/distribution', authenticate, scopeToAccount, (req, res) => {
  if (!req.accountId) return res.status(400).json({ error: 'account_id required' })
  const { funnel_id, type, active_attendants } = req.body
  if (!funnel_id || !type) return res.status(400).json({ error: 'funnel_id and type required' })

  const existing = db.prepare('SELECT id FROM distribution_rules WHERE account_id = ? AND funnel_id = ?').get(req.accountId, funnel_id)
  const attsJson = JSON.stringify(active_attendants || [])

  if (existing) {
    db.prepare("UPDATE distribution_rules SET type = ?, active_attendants = ?, updated_at = datetime('now') WHERE id = ?").run(type, attsJson, existing.id)
  } else {
    db.prepare('INSERT INTO distribution_rules (account_id, funnel_id, type, active_attendants) VALUES (?, ?, ?, ?)').run(req.accountId, funnel_id, type, attsJson)
  }
  res.json({ ok: true })
})

// SSE endpoint for real-time updates
app.get('/api/events', async (req, res) => {
  const token = req.query.token
  if (!token) return res.status(401).end()

  let user
  try {
    const jwtMod = await import('jsonwebtoken')
    // FIX #1 — sem fallback. Se JWT_SECRET falhou, o auth.js ja terminou o processo na inicializacao.
    user = jwtMod.default.verify(token, process.env.JWT_SECRET)
  } catch { return res.status(401).end() }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  res.write('data: {"type":"connected"}\n\n')

  const accountId = user.account_id || 'admin'
  addSSEClient(accountId, res)
  req.on('close', () => removeSSEClient(accountId, res))
})

// ─── Production: serve built frontend ────────────────────────────
const distPath = resolve(__dirname, '../dist')
if (fs.existsSync(distPath)) {
  app.use('/crm', (req, res, next) => {
    // Cache immutable assets for 1 year
    if (req.path.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else if (req.path.endsWith('.html') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
    next()
  }, express.static(distPath))

  // SPA fallback: any /crm/* route that doesn't match API → serve index.html
  app.get('/crm/*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(resolve(distPath, 'index.html'))
  })
  console.log('[Sheraos CRM] Serving frontend from /crm/')
}

app.listen(PORT, () => {
  console.log(`[Sheraos CRM API] Running on http://localhost:${PORT}`)
  startScheduler()
  // Retoma disparos que estavam enviando quando o servidor caiu
  setTimeout(() => recoverPendingBroadcasts(), 2000)
})
