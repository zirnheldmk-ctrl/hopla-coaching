const express = require('express');
const axios = require('axios');
const path = require('path');
const cookieSession = require('cookie-session');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cookieSession({
  name: 'session',
  keys: ['hopla-secret-key-2024'],
  maxAge: 24 * 60 * 60 * 1000 // 24h
}));
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.NOLIO_CLIENT_ID;
const CLIENT_SECRET = process.env.NOLIO_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://hopla-coaching.vercel.app/callback';

// ── OAUTH ──────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = `https://www.nolio.io/api/authorize/?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const code = decodeURIComponent(req.query.code);
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  try {
    const r = await axios.post(
      'https://www.nolio.io/api/token/',
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    req.session.tokens = r.data;
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=auth');
  }
});

app.get('/api/status', (req, res) => res.json({ connected: !!req.session?.tokens?.access_token }));

// ── NOLIO HELPER ───────────────────────────────────────────────────
async function nolioGet(req, endpoint, params = {}) {
  if (!req.session?.tokens?.access_token) throw new Error('Non connecté');
  try {
    const r = await axios.get(`https://www.nolio.io/api${endpoint}`, {
      headers: { 'Authorization': `Bearer ${req.session.tokens.access_token}` }, params
    });
    return r.data;
  } catch (err) {
    if (err.response?.status === 401 && req.session?.tokens?.refresh_token) {
      await refreshToken(req);
      const r = await axios.get(`https://www.nolio.io/api${endpoint}`, {
        headers: { 'Authorization': `Bearer ${req.session.tokens.access_token}` }, params
      });
      return r.data;
    }
    throw err;
  }
}

async function refreshToken(req) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(
    'https://www.nolio.io/api/token/',
    `grant_type=refresh_token&refresh_token=${req.session.tokens.refresh_token}`,
    { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  req.session.tokens = r.data;
}

// ── API ROUTES ─────────────────────────────────────────────────────
app.get('/api/athletes', async (req, res) => {
  try { res.json(await nolioGet(req, '/get/athletes/')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/workouts/:id', async (req, res) => {
  try {
    res.json(await nolioGet(req, '/get/training/', {
      user_id: req.params.id, start_date: req.query.start, end_date: req.query.end
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/planned/:id', async (req, res) => {
  try {
    res.json(await nolioGet(req, '/get/planned/training/', {
      user_id: req.params.id, start_date: req.query.start, end_date: req.query.end
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notes/:id', async (req, res) => {
  try {
    res.json(await nolioGet(req, '/get/note/', {
      user_id: req.params.id, start_date: req.query.start, end_date: req.query.end
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANALYSE IA ─────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { athlete, workouts, planned, notes, history } = req.body;

  const athleteName = athlete.name || `${athlete.first_name||''} ${athlete.last_name||''}`.trim() || athlete.username || 'Athlète';

  // Séances semaine actuelle
  const seances = (workouts||[]).filter(w => !w.is_competition);
  const competsRealisees = (workouts||[]).filter(w => w.is_competition);

  // Compétitions futures planifiées
  const today = new Date().toISOString().split('T')[0];
  const competsAVenir = (planned||[]).filter(w => w.is_competition && (w.date_start||w.date) > today);

  // Résumé historique (8 semaines précédentes)
  const histSeances = (history||[]).filter(w => !w.is_competition);
  const avgRPEHist = histSeances.filter(w=>w.rpe>0).length
    ? (histSeances.filter(w=>w.rpe>0).reduce((s,w)=>s+w.rpe,0) / histSeances.filter(w=>w.rpe>0).length).toFixed(1)
    : null;
  const avgFeelingHist = histSeances.filter(w=>w.feeling>0).length
    ? (histSeances.filter(w=>w.feeling>0).reduce((s,w)=>s+w.feeling,0) / histSeances.filter(w=>w.feeling>0).length).toFixed(1)
    : null;
  const totalKmHist = histSeances.reduce((s,w)=>s+(w.distance||0),0).toFixed(0);

  // Résumé semaine actuelle
  const totalKmSem = seances.reduce((s,w)=>s+(w.distance||0),0).toFixed(1);
  const totalDenivSem = seances.reduce((s,w)=>s+(w.elevation_gain||0),0);
  const totalDurSem = seances.reduce((s,w)=>s+(w.duration||0),0);
  const avgRPESem = seances.filter(w=>w.rpe>0).length
    ? (seances.filter(w=>w.rpe>0).reduce((s,w)=>s+w.rpe,0) / seances.filter(w=>w.rpe>0).length).toFixed(1)
    : 'N/A';
  const avgFeel = seances.filter(w=>w.feeling>0).length
    ? (seances.filter(w=>w.feeling>0).reduce((s,w)=>s+w.feeling,0) / seances.filter(w=>w.feeling>0).length).toFixed(1)
    : 'N/A';

  const cmts = (notes||[]).map(n=>n.content||n.text||n.body||'').filter(Boolean);
  const seanceCmts = seances.filter(w=>w.description).map(w=>`${w.sport} (${w.date_start}): ${w.description}`);
  const allCmts = [...seanceCmts, ...cmts];

  const prompt = `Tu es un coach trail expert. Génère un rapport hebdomadaire concis pour cet athlète en JSON pur (sans markdown).

ATHLÈTE: ${athleteName}

── SEMAINE ÉCOULÉE (7 derniers jours) ──
Séances réalisées: ${seances.length}
Distance totale: ${totalKmSem}km
Dénivelé+: ${totalDenivSem}m
Durée totale: ${Math.floor(totalDurSem/3600)}h${Math.floor((totalDurSem%3600)/60)}min
RPE moyen: ${avgRPESem}/10
Feeling moyen: ${avgFeel}/5
Compétitions réalisées: ${competsRealisees.length > 0 ? competsRealisees.map(c=>`${c.name||c.sport} (RPE:${c.rpe}, Feeling:${c.feeling})`).join(', ') : 'aucune'}
Commentaires de séances: ${allCmts.length > 0 ? allCmts.join(' | ') : 'aucun'}

── CONTEXTE 8 SEMAINES PRÉCÉDENTES ──
Volume moyen: ${totalKmHist}km total sur la période
RPE moyen historique: ${avgRPEHist||'N/A'}/10
Feeling moyen historique: ${avgFeelingHist||'N/A'}/5

── COMPÉTITIONS À VENIR ──
${competsAVenir.length > 0
  ? competsAVenir.map(c=>`- ${c.name||c.sport} le ${c.date_start||c.date} (${c.distance?c.distance+'km':'distance inconnue'})`).join('\n')
  : 'Aucune compétition planifiée prochainement'}

INSTRUCTIONS:
- Le résumé porte UNIQUEMENT sur les 7 derniers jours
- L'avis met en relation RPE + feeling + volume de la semaine avec la tendance des semaines précédentes
- Si compétition à venir: adapter les axes de travail en conséquence
- Sois direct et pratique, pas de généralités
- 2-3 phrases max par champ

Réponds UNIQUEMENT avec ce JSON:
{
  "resume": "résumé factuel des 7 derniers jours: nb séances, km, D+, RPE moyen, feeling moyen. Mets en gras les chiffres clés avec <strong>",
  "commentsSummary": "synthèse des commentaires et sensations de l'athlète cette semaine (ou 'Aucun commentaire cette semaine' si vide)",
  "avis": "analyse coach: comparaison RPE/feeling semaine vs historique, fatigue ou forme, avec emoji ✅ ⚠️ ou 🚨 en début",
  "axes": ["axe travail 1 lié aux données", "axe 2", "axe 3 lié à compét si applicable", "axe 4"]
}`;

  try {
    const r = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 800,
        messages: [
          { role: 'system', content: 'Tu es un coach trail expert. Tu réponds uniquement en JSON valide, sans markdown, sans texte avant ou après.' },
          { role: 'user', content: prompt }
        ]
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY}` } }
    );
    const text = r.data.choices[0].message.content;
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('Erreur IA:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur analyse IA: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// ── START ───────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log('\n🏔  Trail Coach démarré !');
  console.log('👉 Ouvre ton navigateur sur : http://localhost:3000\n');
});
