import {
  pgTable, pgEnum, uuid, text, varchar, timestamp,
  boolean, integer, decimal, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ── Enums ────────────────────────────────────────────

export const accountRoleEnum = pgEnum('app_account_role', [
  'owner', 'admin', 'manager', 'sdr',
]);

export const memberStatusEnum = pgEnum('member_status', [
  'active', 'inactive', 'pending',
]);

export const conversationStatusEnum = pgEnum('conversation_status', [
  'nina', 'human', 'paused', 'closed',
]);

export const messageFromEnum = pgEnum('message_from_type', [
  'user', 'nina', 'human',
]);

export const messageTypeEnum = pgEnum('message_type', [
  'text', 'image', 'audio', 'document', 'video',
]);

export const whatsappProviderEnum = pgEnum('whatsapp_provider', [
  'evolution', 'meta',
]);

export const whatsappSessionStatusEnum = pgEnum('whatsapp_session_status', [
  'connected', 'disconnected', 'connecting',
]);

// ── Auth (Lucia) ─────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  hashedPassword: text('hashed_password').notNull(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  isSuperAdmin: boolean('is_super_admin').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ── Multi-tenant ─────────────────────────────────────

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  plan: varchar('plan', { length: 50 }).default('free').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  fullName: varchar('full_name', { length: 255 }),
  avatarUrl: text('avatar_url'),
  phone: varchar('phone', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const accountMembers = pgTable('account_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: accountRoleEnum('role').default('sdr').notNull(),
  status: memberStatusEnum('status').default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqMember: uniqueIndex('account_members_uniq').on(t.accountId, t.userId),
  accountIdx: index('account_members_account_idx').on(t.accountId),
}));

// ── Contacts & Conversations ─────────────────────────

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  phoneNumber: varchar('phone_number', { length: 20 }).notNull(),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  tags: jsonb('tags').$type<string[]>().default([]),
  clientMemory: jsonb('client_memory').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountPhoneUniq: uniqueIndex('contacts_account_phone_uniq').on(t.accountId, t.phoneNumber),
  phoneIdx: index('contacts_phone_idx').on(t.phoneNumber),
  accountIdx: index('contacts_account_idx').on(t.accountId),
}));

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  status: conversationStatusEnum('status').default('nina').notNull(),
  assignedTo: uuid('assigned_to').references(() => users.id),
  assignedToAt: timestamp('assigned_to_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  // Timestamp da ultima vez que humano (Bia) respondeu - usado pra
  // auto-reativar DANI apos X minutos de inatividade do humano
  lastHumanAt: timestamp('last_human_at', { withTimezone: true }),
  // Sprint 5+6: follow-up agent
  followupState: varchar('followup_state', { length: 20 }).default('idle').notNull(),
  followupAttempts: integer('followup_attempts').default(0).notNull(),
  followupTotalAttempts: integer('followup_total_attempts').default(0).notNull(),
  followupLastAttemptAt: timestamp('followup_last_attempt_at', { withTimezone: true }),
  // Sprint 7: intent + sentiment (placeholder, usado em Sprint 7)
  sentiment: varchar('sentiment', { length: 20 }),
  leadScore: integer('lead_score').default(0).notNull(),
  intentLabel: varchar('intent_label', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('conversations_account_idx').on(t.accountId),
  contactIdx: index('conversations_contact_idx').on(t.contactId),
  statusIdx: index('conversations_status_idx').on(t.status),
  followupIdx: index('conversations_followup_idx').on(t.followupState, t.lastMessageAt),
}));

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  fromType: messageFromEnum('from_type').notNull(),
  messageType: messageTypeEnum('message_type').default('text').notNull(),
  content: text('content'),
  mediaUrl: text('media_url'),
  whatsappMessageId: varchar('whatsapp_message_id', { length: 100 }),
  processedByNina: boolean('processed_by_nina').default(false).notNull(),
  // Sprint 1: tracking de buffer
  bufferWindowId: uuid('buffer_window_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  conversationIdx: index('messages_conversation_idx').on(t.conversationId),
  accountIdx: index('messages_account_idx').on(t.accountId),
  createdAtIdx: index('messages_created_at_idx').on(t.createdAt),
  bufferIdx: index('messages_buffer_idx').on(t.bufferWindowId),
}));

// ── AI Settings ──────────────────────────────────────

export const ninaSettings = pgTable('nina_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  isActive: boolean('is_active').default(true).notNull(),
  autoResponseEnabled: boolean('auto_response_enabled').default(true).notNull(),
  sdrName: varchar('sdr_name', { length: 100 }).default('DANI').notNull(),
  companyName: varchar('company_name', { length: 255 }),
  systemPromptOverride: text('system_prompt_override'),
  aiModelMode: varchar('ai_model_mode', { length: 50 }).default('flash').notNull(),
  responseDelayMin: integer('response_delay_min').default(1).notNull(),
  responseDelayMax: integer('response_delay_max').default(3).notNull(),
  messageBreakingEnabled: boolean('message_breaking_enabled').default(true).notNull(),
  audioResponseEnabled: boolean('audio_response_enabled').default(false).notNull(),
  elevenlabsApiKey: text('elevenlabs_api_key'),
  elevenlabsVoiceId: varchar('elevenlabs_voice_id', { length: 100 }),
  // Sprint 1: buffer de mensagens
  bufferWindowMs: integer('buffer_window_ms').default(15000).notNull(),
  bufferMaxMs: integer('buffer_max_ms').default(60000).notNull(),
  // Minutos de pausa apos humano responder - DANI nao volta a atender
  // sozinha antes disso. Default 60min.
  pauseAfterHumanMinutes: integer('pause_after_human_minutes').default(60).notNull(),
  // Numero da Bia pra receber notificacao quando DANI transfere.
  // Formato internacional sem + (ex: 5531987654321).
  biaPhone: varchar('bia_phone', { length: 20 }),
  // Mensagem customizada de notificacao pra Bia (null = mensagem padrao).
  biaNotifyMessage: text('bia_notify_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Token usage ──────────────────────────────────────
// Acumulado por account por mes para rastrear custos Gemini
export const tokenUsageLogs = pgTable('token_usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id'), // nullable (pode vir de test chat)
  model: varchar('model', { length: 100 }).notNull(),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  totalTokens: integer('total_tokens').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('token_usage_account_idx').on(t.accountId),
  createdAtIdx: index('token_usage_created_idx').on(t.createdAt),
}));

// ── WhatsApp ─────────────────────────────────────────

export const whatsappSessions = pgTable('whatsapp_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  instanceName: varchar('instance_name', { length: 100 }).notNull(),
  provider: whatsappProviderEnum('provider').default('evolution').notNull(),
  status: whatsappSessionStatusEnum('status').default('disconnected').notNull(),
  phoneNumber: varchar('phone_number', { length: 20 }),
  qrCode: text('qr_code'),
  webhookUrl: text('webhook_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('wa_sessions_account_idx').on(t.accountId),
}));

export const whatsappAccountSettings = pgTable('whatsapp_account_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  apiUrl: text('api_url'),
  apiKey: text('api_key'),
  verifyToken: varchar('verify_token', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── CRM ──────────────────────────────────────────────

export const pipelineStages = pgTable('pipeline_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  position: integer('position').default(0).notNull(),
  color: varchar('color', { length: 7 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('pipeline_stages_account_idx').on(t.accountId),
}));

export const deals = pgTable('deals', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id),
  stageId: uuid('stage_id').notNull().references(() => pipelineStages.id),
  title: varchar('title', { length: 255 }).notNull(),
  value: decimal('value', { precision: 12, scale: 2 }),
  expectedCloseDate: timestamp('expected_close_date', { withTimezone: true }),
  notes: text('notes'),
  // Marcador: deal criado automaticamente pela DANI
  createdByAi: boolean('created_by_ai').default(false).notNull(),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('deals_account_idx').on(t.accountId),
  stageIdx: index('deals_stage_idx').on(t.stageId),
}));

export const tagDefinitions = pgTable('tag_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 50 }).notNull(),
  color: varchar('color', { length: 7 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountNameUniq: uniqueIndex('tag_defs_account_name_uniq').on(t.accountId, t.name),
}));

export const appointments = pgTable('appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id),
  title: varchar('title', { length: 255 }).notNull(),
  date: timestamp('date', { withTimezone: true }).notNull(),
  time: varchar('time', { length: 5 }),
  duration: integer('duration').default(60),
  type: varchar('type', { length: 50 }).default('consultation'),
  description: text('description'),
  googleEventId: varchar('google_event_id', { length: 255 }),
  meetingUrl: text('meeting_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('appointments_account_idx').on(t.accountId),
  dateIdx: index('appointments_date_idx').on(t.date),
}));

// ── Products (Bling mirror) ──────────────────────────

export const produtosCatalogo = pgTable('produtos_catalogo', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  blingId: varchar('bling_id', { length: 50 }),
  nome: varchar('nome', { length: 500 }).notNull(),
  nomeNormalizado: varchar('nome_normalizado', { length: 500 }),
  codigo: varchar('codigo', { length: 100 }),
  preco: decimal('preco', { precision: 12, scale: 2 }),
  precoPromocional: decimal('preco_promocional', { precision: 12, scale: 2 }),
  estoque: integer('estoque').default(0),
  disponivel: boolean('disponivel').default(true).notNull(),
  descricaoCurta: text('descricao_curta'),
  imagemBling: text('imagem_bling'),
  imagemCloudinary: text('imagem_cloudinary'),
  cloudinaryUploadedAt: timestamp('cloudinary_uploaded_at', { withTimezone: true }),
  imagemMinio: text('imagem_minio'),
  imagensMinio: jsonb('imagens_minio').$type<string[]>().default([]),
  minioUploadedAt: timestamp('minio_uploaded_at', { withTimezone: true }),
  marca: varchar('marca', { length: 255 }),
  categoria: varchar('categoria', { length: 255 }),
  situacao: varchar('situacao', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('produtos_account_idx').on(t.accountId),
  blingIdx: index('produtos_bling_idx').on(t.blingId),
  nomeNormIdx: index('produtos_nome_norm_idx').on(t.nomeNormalizado),
}));

// ── Google Calendar integration ───────────────────
export const googleCalendarConnections = pgTable('google_calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' })
    .unique(),
  email: varchar('email', { length: 255 }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  scope: text('scope'),
  calendarId: varchar('calendar_id', { length: 255 }).default('primary').notNull(),
  syncEnabled: boolean('sync_enabled').default(true).notNull(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const blingCredentials = pgTable('bling_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  clientId: varchar('client_id', { length: 255 }),
  clientSecret: text('client_secret'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Knowledge Base (RAG) ─────────────────────────────
// Categorias preset que o prompt LEAN sabe carregar conforme contexto.
export const knowledgeBase = pgTable('knowledge_base', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  category: varchar('category', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content').notNull(),
  tags: jsonb('tags').$type<string[]>().default([]),
  priority: integer('priority').default(50).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  alwaysInclude: boolean('always_include').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountCategoryIdx: index('kb_account_category_idx').on(t.accountId, t.category),
  accountActiveIdx: index('kb_account_active_idx').on(t.accountId, t.isActive),
}));

export const cloudinaryCredentials = pgTable('cloudinary_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  cloudName: varchar('cloud_name', { length: 255 }),
  apiKey: varchar('api_key', { length: 255 }),
  apiSecret: text('api_secret'),
  uploadTag: varchar('upload_tag', { length: 100 }).default('fce_catalogo'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Media ────────────────────────────────────────────

export const mediaLibrary = pgTable('media_library', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  nameNormalized: varchar('name_normalized', { length: 255 }),
  description: text('description'),
  fileUrl: text('file_url').notNull(),
  fileType: varchar('file_type', { length: 50 }).notNull(),
  fileSize: integer('file_size'),
  tags: jsonb('tags').$type<string[]>().default([]),
  useCount: integer('use_count').default(0).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('media_library_account_idx').on(t.accountId),
  nameNormIdx: index('media_library_name_norm_idx').on(t.accountId, t.nameNormalized),
}));

// ── Teams ────────────────────────────────────────────

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('teams_account_idx').on(t.accountId),
}));

export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamUserUniq: uniqueIndex('team_members_uniq').on(t.teamId, t.userId),
}));

// ── Relations ────────────────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles),
  sessions: many(sessions),
  accountMembers: many(accountMembers),
  teamMembers: many(teamMembers),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  members: many(accountMembers),
  contacts: many(contacts),
  conversations: many(conversations),
  messages: many(messages),
  ninaSettings: one(ninaSettings),
  whatsappSessions: many(whatsappSessions),
  whatsappAccountSettings: one(whatsappAccountSettings),
  pipelineStages: many(pipelineStages),
  deals: many(deals),
  tagDefinitions: many(tagDefinitions),
  appointments: many(appointments),
  produtosCatalogo: many(produtosCatalogo),
  blingCredentials: one(blingCredentials),
  mediaLibrary: many(mediaLibrary),
  teams: many(teams),
}));

export const accountMembersRelations = relations(accountMembers, ({ one }) => ({
  account: one(accounts, { fields: [accountMembers.accountId], references: [accounts.id] }),
  user: one(users, { fields: [accountMembers.userId], references: [users.id] }),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  account: one(accounts, { fields: [contacts.accountId], references: [accounts.id] }),
  conversations: many(conversations),
  deals: many(deals),
  appointments: many(appointments),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  account: one(accounts, { fields: [conversations.accountId], references: [accounts.id] }),
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  assignee: one(users, { fields: [conversations.assignedTo], references: [users.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  account: one(accounts, { fields: [messages.accountId], references: [accounts.id] }),
}));

export const ninaSettingsRelations = relations(ninaSettings, ({ one }) => ({
  account: one(accounts, { fields: [ninaSettings.accountId], references: [accounts.id] }),
}));

export const whatsappSessionsRelations = relations(whatsappSessions, ({ one }) => ({
  account: one(accounts, { fields: [whatsappSessions.accountId], references: [accounts.id] }),
}));

export const whatsappAccountSettingsRelations = relations(whatsappAccountSettings, ({ one }) => ({
  account: one(accounts, { fields: [whatsappAccountSettings.accountId], references: [accounts.id] }),
}));

export const pipelineStagesRelations = relations(pipelineStages, ({ one, many }) => ({
  account: one(accounts, { fields: [pipelineStages.accountId], references: [accounts.id] }),
  deals: many(deals),
}));

export const dealsRelations = relations(deals, ({ one }) => ({
  account: one(accounts, { fields: [deals.accountId], references: [accounts.id] }),
  contact: one(contacts, { fields: [deals.contactId], references: [contacts.id] }),
  stage: one(pipelineStages, { fields: [deals.stageId], references: [pipelineStages.id] }),
}));

export const tagDefinitionsRelations = relations(tagDefinitions, ({ one }) => ({
  account: one(accounts, { fields: [tagDefinitions.accountId], references: [accounts.id] }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  account: one(accounts, { fields: [appointments.accountId], references: [accounts.id] }),
  contact: one(contacts, { fields: [appointments.contactId], references: [contacts.id] }),
}));

export const produtosCatalogoRelations = relations(produtosCatalogo, ({ one }) => ({
  account: one(accounts, { fields: [produtosCatalogo.accountId], references: [accounts.id] }),
}));

export const blingCredentialsRelations = relations(blingCredentials, ({ one }) => ({
  account: one(accounts, { fields: [blingCredentials.accountId], references: [accounts.id] }),
}));

export const cloudinaryCredentialsRelations = relations(cloudinaryCredentials, ({ one }) => ({
  account: one(accounts, { fields: [cloudinaryCredentials.accountId], references: [accounts.id] }),
}));

export const knowledgeBaseRelations = relations(knowledgeBase, ({ one }) => ({
  account: one(accounts, { fields: [knowledgeBase.accountId], references: [accounts.id] }),
}));

export const mediaLibraryRelations = relations(mediaLibrary, ({ one }) => ({
  account: one(accounts, { fields: [mediaLibrary.accountId], references: [accounts.id] }),
  uploader: one(users, { fields: [mediaLibrary.uploadedBy], references: [users.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  account: one(accounts, { fields: [teams.accountId], references: [accounts.id] }),
  members: many(teamMembers),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));
