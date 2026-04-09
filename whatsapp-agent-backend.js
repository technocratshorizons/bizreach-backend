/**
 * ─────────────────────────────────────────────────────────────────
 *  BizReach AI — WhatsApp Outreach Agent Backend
 *  Handles: WhatsApp Cloud API webhook, AI replies via Claude,
 *           Google Sheets logging, Slack + Email handoff alerts
 * ─────────────────────────────────────────────────────────────────
 *  Stack:  Node.js + Express
 *  Deploy: Railway / Render / any VPS
 *
 *  ENV VARS REQUIRED:
 *    WA_VERIFY_TOKEN       — any string you set in Meta webhook config
 *    WA_ACCESS_TOKEN       — WhatsApp Cloud API permanent token
 *    WA_PHONE_NUMBER_ID    — from Meta Developer Portal
 *    ANTHROPIC_API_KEY     — from console.anthropic.com
 *    GOOGLE_SHEET_ID       — Google Sheet ID (from URL)
 *    GOOGLE_SA_EMAIL       — Service account email
 *    GOOGLE_SA_KEY         — Service account private key (base64 encoded)
 *    SLACK_WEBHOOK_URL     — Slack incoming webhook URL
 *    NOTIFY_EMAIL          — email address for handoff alerts
 *    SENDGRID_API_KEY      — (optional) SendGrid key for email
 * ─────────────────────────────────────────────────────────────────
 */

import express from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────
const CFG = {
  wa_verify_token:     process.env.WA_VERIFY_TOKEN,
  wa_access_token:     process.env.WA_ACCESS_TOKEN,
  wa_phone_number_id:  process.env.WA_PHONE_NUMBER_ID,
  anthropic_key:       process.env.ANTHROPIC_API_KEY,
  sheet_id:            process.env.GOOGLE_SHEET_ID,
  slack_webhook:       process.env.SLACK_WEBHOOK_URL,
  notify_email:        process.env.NOTIFY_EMAIL,
  sendgrid_key:        process.env.SENDGRID_API_KEY,
};

// ── In-memory conversation store (replace with Redis in production) ──
const conversations = new Map(); // phone → { history: [], lead: {}, intentFired: false }

// ── Buying intent keywords ───────────────────────────────────────
const INTENT_KEYWORDS = [
  "how do we start", "send me a proposal", "ready to proceed",
  "let's do this", "i'm interested", "let's move forward",
  "book a call", "sounds good", "want to proceed",
  "how much exactly", "when can you start", "move forward"
];

function hasHighIntent(text) {
  const lower = text.toLowerCase();
  return INTENT_KEYWORDS.some(k => lower.includes(k)) || lower.includes('[intent:high]');
}

// ── System prompt for Claude (BDE brain) ────────────────────────
function buildSystemPrompt(lead) {
  return `You are Arjun, an AI Business Development Executive reaching out via WhatsApp.
Be warm, concise, and natural — this is WhatsApp, so keep replies short (2–3 sentences max).
Never use markdown formatting like bold or bullets in your replies.

LEAD INFO:
- Name: ${lead.name || 'the prospect'}
- Company: ${lead.company || 'their company'}
- Industry: ${lead.industry || 'their industry'}
- Phone: ${lead.phone}

YOUR COMPANY OFFERS:
- AI Agents & Automation (lead gen bots, support AI, workflow automation)
- Custom Software Development (web apps, mobile, SaaS)
- Digital Marketing (SEO, Google/Meta ads, social media)
- LMS / eLearning Platforms
- Ecommerce Solutions (Shopify, WooCommerce, custom)

GOALS:
1. Start a friendly conversation — don't pitch immediately
2. Understand their current challenge
3. Connect it to one of our services
4. Handle any objection naturally
5. Get them to agree to a 20-minute discovery call: calendly.com/yourbusiness

PRICING: Always say "we send a custom quote after a quick 20-min call — no commitment."

BUYING INTENT — when the lead shows strong interest (asks how to start, mentions budget,
wants a proposal, says they're ready), append [INTENT:HIGH] at the very end of your reply.

Keep replies conversational and WhatsApp-friendly. One question at a time.`;
}

// ── Google Sheets auth ───────────────────────────────────────────
async function getSheetsClient() {
  const keyData = Buffer.from(process.env.GOOGLE_SA_KEY, 'base64').toString();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SA_EMAIL,
      private_key: keyData,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Log/update lead in Google Sheets ────────────────────────────
async function logToSheet(phone, lead, update = {}) {
  try {
    const sheets = await getSheetsClient();
    const range = 'Leads!A:Z';

    // Read existing rows to find this phone
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CFG.sheet_id,
      range,
    });

    const rows = res.data.values || [];
    const headers = rows[0] || [];
    const phoneCol = headers.indexOf('phone');
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[phoneCol] === phone);

    const now = new Date().toLocaleString('en-IN');

    if (rowIndex === -1) {
      // New lead — append row
      const newRow = [
        `L${Date.now()}`,           // lead_id
        lead.name || '',            // name
        lead.company || '',         // company
        phone,                      // phone
        lead.industry || '',        // industry
        lead.service || '',         // service_interest
        'whatsapp',                 // source
        now,                        // first_contact
        'active',                   // status
        update.lastMessage || '',   // last_message
        now,                        // last_updated
        update.intent || 'low',     // intent_level
        '',                         // handoff_triggered
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: CFG.sheet_id,
        range: 'Leads!A:M',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [newRow] },
      });
    } else {
      // Update existing row
      const r = rows[rowIndex];
      if (update.lastMessage) r[headers.indexOf('last_message')] = update.lastMessage;
      if (update.intent)      r[headers.indexOf('intent_level')] = update.intent;
      if (update.handoff)     r[headers.indexOf('handoff_triggered')] = now;
      r[headers.indexOf('last_updated')] = now;

      await sheets.spreadsheets.values.update({
        spreadsheetId: CFG.sheet_id,
        range: `Leads!A${rowIndex + 1}:M${rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [r] },
      });
    }
  } catch (err) {
    console.error('[Sheets] Error:', err.message);
  }
}

// ── Send WhatsApp message ─────────────────────────────────────────
async function sendWA(to, text) {
  const url = `https://graph.facebook.com/v18.0/${CFG.wa_phone_number_id}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CFG.wa_access_token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) console.error('[WhatsApp] Send error:', data);
  return data;
}

// ── Claude AI reply ───────────────────────────────────────────────
async function getAIReply(phone, userMessage) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { history: [], lead: { phone }, intentFired: false });
  }
  const conv = conversations.get(phone);
  conv.history.push({ role: 'user', content: userMessage });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CFG.anthropic_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: buildSystemPrompt(conv.lead),
      messages: conv.history,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  let reply = data.content.map(b => b.text || '').join('');
  const intentDetected = reply.includes('[INTENT:HIGH]') || hasHighIntent(userMessage) || hasHighIntent(reply);

  // Strip the tag from the message sent to user
  reply = reply.replace('[INTENT:HIGH]', '').trim();
  conv.history.push({ role: 'assistant', content: reply });

  return { reply, intentDetected };
}

// ── Slack handoff alert ───────────────────────────────────────────
async function notifySlack(lead, phone) {
  if (!CFG.slack_webhook) return;
  const payload = {
    text: '🔔 *HOT LEAD — Buying Intent Detected*',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔥 *HOT LEAD ALERT*\n\n*Name:* ${lead.name || 'Unknown'}\n*Company:* ${lead.company || '—'}\n*Phone:* ${phone}\n*Industry:* ${lead.industry || '—'}\n*Interest:* ${lead.service || '—'}\n*Channel:* WhatsApp\n*Time:* ${new Date().toLocaleString('en-IN')}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '👉 *Action: Call within 30 minutes*' },
      },
    ],
  };

  await fetch(CFG.slack_webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ── Email handoff alert (SendGrid) ───────────────────────────────
async function notifyEmail(lead, phone) {
  if (!CFG.sendgrid_key || !CFG.notify_email) return;
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CFG.sendgrid_key}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: CFG.notify_email }] }],
      from: { email: 'noreply@yourdomain.com', name: 'BizReach AI' },
      subject: `🔥 Hot lead: ${lead.name || phone} — ${lead.company || 'Unknown company'}`,
      content: [{
        type: 'text/plain',
        value: `HOT LEAD ALERT\n\nBuying intent detected via WhatsApp\n\nName: ${lead.name || 'Unknown'}\nCompany: ${lead.company || '—'}\nPhone: ${phone}\nIndustry: ${lead.industry || '—'}\nInterest: ${lead.service || '—'}\nTime: ${new Date().toLocaleString('en-IN')}\n\nRecommended action: Call within 30 minutes.`,
      }],
    }),
  });
}

// ── WEBHOOK VERIFICATION (GET) ────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === CFG.wa_verify_token) {
    console.log('[Webhook] Verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── INCOMING MESSAGES (POST) ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from = message.from;        // sender's phone number
    const text = message.text.body;   // message content

    console.log(`[WhatsApp] From: ${from} | Text: ${text}`);

    // Rate limiting — skip if same sender within 2 seconds
    const conv = conversations.get(from);
    const now = Date.now();
    if (conv?.lastMsg && now - conv.lastMsg < 2000) return;
    if (conv) conv.lastMsg = now;

    // Get AI reply
    const { reply, intentDetected } = await getAIReply(from, text);

    // Add delay (1.5–3s) to feel human
    const delay = 1500 + Math.random() * 1500;
    await new Promise(r => setTimeout(r, delay));

    // Send reply
    await sendWA(from, reply);

    // Log to Google Sheets
    const convData = conversations.get(from);
    await logToSheet(from, convData.lead, {
      lastMessage: text,
      intent: intentDetected ? 'high' : 'medium',
      handoff: intentDetected && !convData.intentFired,
    });

    // Fire handoff alerts once
    if (intentDetected && !convData.intentFired) {
      convData.intentFired = true;
      console.log(`[Handoff] Intent detected for ${from}`);
      await Promise.all([
        notifySlack(convData.lead, from),
        notifyEmail(convData.lead, from),
      ]);
    }

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
  }
});

// ── LEAD ENRICHMENT ENDPOINT ─────────────────────────────────────
// Called by n8n when it finds more info about a lead
app.post('/enrich', async (req, res) => {
  const { phone, name, company, industry, service } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  if (!conversations.has(phone)) {
    conversations.set(phone, { history: [], lead: { phone }, intentFired: false });
  }
  const conv = conversations.get(phone);
  conv.lead = { ...conv.lead, name, company, industry, service };

  console.log(`[Enrich] Updated lead for ${phone}:`, conv.lead);
  res.json({ success: true, lead: conv.lead });
});

// ── OUTBOUND BLAST ENDPOINT ──────────────────────────────────────
// Called by n8n to send the first outreach message to a lead
app.post('/outreach', async (req, res) => {
  const { phone, name, company, industry, service } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  // Store lead data
  conversations.set(phone, {
    history: [],
    lead: { phone, name, company, industry, service },
    intentFired: false,
    lastMsg: Date.now(),
  });

  // Generate personalized opening message via Claude
  try {
    const openingPrompt = `Write a friendly WhatsApp opening message for a cold outreach to:
Name: ${name || 'the business owner'}
Company: ${company}
Industry: ${industry}
We offer: AI Automation, Software Development, Digital Marketing, LMS, Ecommerce

Rules: Under 100 words. Conversational. Mention ONE pain point specific to ${industry}. 
End with a soft question. No emojis except max 1 at the start. No markdown.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CFG.anthropic_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: openingPrompt }],
      }),
    });
    const d = await r.json();
    const msg = d.content[0].text.trim();

    // Random delay 30–90 seconds before sending (avoids spam flags)
    const delay = 30000 + Math.random() * 60000;
    setTimeout(async () => {
      await sendWA(phone, msg);
      await logToSheet(phone, { phone, name, company, industry, service }, {
        lastMessage: msg,
        intent: 'low',
      });
    }, delay);

    res.json({ success: true, scheduledIn: Math.round(delay / 1000) + 's', preview: msg });
  } catch (err) {
    console.error('[Outreach] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ BizReach AI backend running on port ${PORT}`);
  console.log(`   Webhook:  POST /webhook`);
  console.log(`   Outreach: POST /outreach`);
  console.log(`   Enrich:   POST /enrich`);
});
