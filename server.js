require('dotenv').config();

const express = require('express');
const { GoogleGenAI } = require('@google/genai');

if (!process.env.GEMINI_API_KEY) {
  console.error('ERREUR : clé Gemini absente du fichier .env');
  process.exit(1);
}

const app = express();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '32kb' }));

// Limitation simple : 10 questions par adresse IP et par minute.
const requestCounts = new Map();
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 10;

app.use('/api/chat', (req, res, next) => {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let record = requestCounts.get(ip);

  if (!record || now - record.start >= RATE_WINDOW) {
    record = { start: now, count: 0 };
  }

  record.count++;
  requestCounts.set(ip, record);

  if (requestCounts.size > 1000) {
    for (const [key, value] of requestCounts) {
      if (now - value.start >= RATE_WINDOW) requestCounts.delete(key);
    }
  }

  if (record.count > RATE_LIMIT) {
    return res.status(429).json({
      error: 'Trop de questions. Attends une minute avant de réessayer.'
    });
  }

  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NIMBA IA' });
});

async function askGemini(history, preferences = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: history,
        config: {
          systemInstruction: (() => {
            const language = preferences.language === 'en' ? 'en' : 'fr';
            const styles = {
              simple: 'Utilise des mots simples.',
              detailed: 'Donne des explications détaillées et des exemples.',
              pedagogical: 'Explique étape par étape et montre la méthode.'
            };
            const lengths = {
              short: 'Réponds brièvement.',
              normal: 'Donne une réponse de longueur normale.',
              long: 'Donne une réponse développée et structurée.'
            };
            return 'Tu es NIMBA IA, un assistant utile, rapide et précis. ' +
              'Réponds directement, sans introduction inutile. ' +
              'Organise tes réponses avec des titres courts, des paragraphes aérés et des listes numérotées. ' +
              'Pour les devoirs, explique les étapes et présente clairement le résultat final. ' +
              'Écris proprement pour faciliter la lecture et la copie. ' +
              (language === 'en' ? 'Answer in clear English. ' : 'Réponds en français clair. ') +
              (styles[preferences.style] || styles.simple) + ' ' +
              (lengths[preferences.length] || lengths.normal) +
              ' N’invente pas les faits.';
          })()
        }
      });
    } catch (error) {
      console.error(`Tentative Gemini ${attempt}/3 :`, error.message);

      if (attempt === 3) throw error;

      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
}

app.post('/api/chat', async (req, res) => {
  console.log('📩 QUESTION REÇUE DEPUIS NIMBA IA');
  try {
    const messages = req.body.messages;
    const preferences = req.body.preferences || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Écris une question.' });
    }

    const history = messages.slice(-10).map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.text || '').slice(0, 4000) }]
    }));

    const result = await askGemini(history, preferences);

    res.json({
      answer: result.text || 'Je n’ai pas pu formuler une réponse.'
    });
  } catch (error) {
    console.error('Erreur finale Gemini :', error.message);
    res.status(503).json({
      error: 'Gemini est temporairement indisponible. Réessaie dans un instant.'
    });
  }
});

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
app.listen(PORT, HOST, () => {
  console.log(`NIMBA IA prêt sur le port ${PORT}`);
});
