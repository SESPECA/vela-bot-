const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────

const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const GHL_KEY     = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const PORT        = process.env.PORT || 3000;

// ── Vela system prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Vela, a client relations rep at SESPECA LLC — a licensed general contractor in Miami, Florida. SESPECA specializes in bathroom remodeling but also does kitchens, flooring, painting, drywall, new construction, and commercial work.

You're texting homeowners who pulled renovation permits. Your only goal is to get them excited about a FREE in-home estimate.

RULES:
- 1-2 sentences max per message. Never more.
- One question at a time. Never two at once.
- Sound like a real person texting. Warm, direct, casual. No corporate speak.
- No lists, no bullet points, no emojis.
- Match the client's energy and language. If they write in Spanish, reply in Spanish.
- Never mention permits unless the client brings it up.
- Never invent prices or timelines.

CONVERSATION FLOW:
1. When they show interest → ask what they're working on (bathroom, kitchen, full remodel, etc.)
2. After they tell you the project → ask if it's a full remodel or specific updates, and mention we handle everything: bathrooms, kitchens, flooring, painting, drywall — whatever they need.
3. Ask timeline: are they looking to start soon or still planning?
4. Once you know both project and timeline → say you'd love to send someone to take a look, free, no commitment, and send: https://book.sespeca.com
5. If hesitant → "No rush, just wanted to put it on your radar."

OTHER SCENARIOS:
- Asking about price → "Can't quote without seeing it — that's what the free estimate is for."
- Comparing contractors → "Makes sense. We're licensed, insured, and we actually show up."
- Not interested → "Totally understand. If anything changes, feel free to reach back out. Good luck with the project!"
- STOP or unsubscribe → Do not reply at all.

Try up to 3 follow-ups if no response. After 3 no-replies, stop.
Never pressure. Never send the booking link before knowing their project and timeline.

CREDENTIALS: Licensed & insured GC. 4.8 stars on Google. Serving all Miami-Dade.
HOW YOU GOT THEIR INFO: "Your renovation permit is public record — we reach out to homeowners with active permits."`;

// ── GHL API helpers ───────────────────────────────────────────────────────────

async function getConversationMessages(conversationId) {
  const res = await fetch(
    `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=40`,
    { headers: { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28' } }
  );
  const data = await res.json();
  // GHL returns { messages: { messages: [...] } } or { messages: [...] }
  const msgs = data?.messages?.messages ?? data?.messages ?? [];
  return msgs
    .filter(m => m.body && m.messageType === 'SMS')
    .sort((a, b) => a.dateAdded - b.dateAdded);
}

async function sendSms(conversationId, text) {
  const res = await fetch(
    `https://services.leadconnectorhq.com/conversations/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'SMS',
        conversationId,
        message: text,
      }),
    }
  );
  return res.json();
}

// ── Claude ────────────────────────────────────────────────────────────────────

async function getVelaReply(messages) {
  // Convert GHL messages to Claude format
  const claudeMessages = messages.map(m => ({
    role: m.direction === 'outbound' ? 'assistant' : 'user',
    content: m.body,
  }));

  // Claude requires first message to be 'user'
  // If history starts with outbound (Vela), add a placeholder
  if (claudeMessages.length === 0 || claudeMessages[0].role === 'assistant') {
    claudeMessages.unshift({ role: 'user', content: '[conversation started]' });
  }

  // Merge consecutive same-role messages (Claude API requirement)
  const merged = [];
  for (const msg of claudeMessages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    system: SYSTEM_PROMPT,
    messages: merged,
  });

  return response.content[0].text.trim();
}

// ── Webhook handler ───────────────────────────────────────────────────────────

app.post('/webhook/inbound', async (req, res) => {
  // Acknowledge GHL immediately (avoid timeout retries)
  res.sendStatus(200);

  try {
    const payload = req.body;

    // GHL sends different event structures — normalize
    const msgBody      = payload.body ?? payload.message ?? '';
    const msgType      = payload.messageType ?? payload.type ?? '';
    const contactId    = payload.contactId ?? '';
    const convId       = payload.conversationId ?? '';
    const direction    = payload.direction ?? 'inbound';

    // Only handle inbound SMS
    if (direction !== 'inbound') return;
    if (msgType && msgType !== 'SMS' && msgType !== 'TYPE_SMS') return;
    if (!convId) return;

    // Never reply to STOP
    if (/^\s*stop\s*$/i.test(msgBody)) return;

    // Fetch full conversation history
    const history = await getConversationMessages(convId);

    // Safety: don't reply if last message was already outbound (avoid double-send)
    if (history.length > 0 && history[history.length - 1].direction === 'outbound') {
      const lastOutbound = history[history.length - 1];
      const timeSince = Date.now() - (lastOutbound.dateAdded ?? 0);
      if (timeSince < 5000) return; // sent less than 5s ago
    }

    // Get Claude's reply
    const reply = await getVelaReply(history);

    // Send via GHL
    await sendSms(convId, reply);

    console.log(`[${new Date().toISOString()}] ${contactId} → replied`);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Vela is running', ts: new Date().toISOString() }));

// Debug endpoint — tests Claude + GHL connectivity
app.get('/debug', async (req, res) => {
  const results = { anthropic: null, ghl: null, env: {} };
  results.env = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'SET (' + process.env.ANTHROPIC_API_KEY.slice(0,10) + '...)' : 'MISSING',
    GHL_API_KEY: process.env.GHL_API_KEY ? 'SET' : 'MISSING',
    GHL_LOCATION_ID: process.env.GHL_LOCATION_ID || 'MISSING',
  };
  try {
    const r = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'say ok' }] });
    results.anthropic = 'OK: ' + r.content[0].text;
  } catch (e) { results.anthropic = 'ERROR: ' + e.message; }
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/locations/${process.env.GHL_LOCATION_ID}`, { headers: { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: '2021-07-28' } });
    results.ghl = 'HTTP ' + r.status;
  } catch (e) { results.ghl = 'ERROR: ' + e.message; }
  res.json(results);
});

app.listen(PORT, () => console.log(`Vela bot listening on port ${PORT}`));
