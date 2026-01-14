const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Busca jogos reais AO VIVO e PRÓXIMOS
app.get('/api/jogos', async (req, res) => {
    try {
        // Busca jogos de hoje das principais ligas (Inglaterra, Brasil, Espanha, etc)
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=20&status=NS-1H-2H', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            placar: j.goals.home !== null ? `${j.goals.home}-${j.goals.away}` : 'VS',
            status: j.fixture.status.short,
            data: j.fixture.date,
            // Odds simuladas baseadas no ranking ou status (A API de Odds é paga a parte, então simulamos odds realistas aqui)
            odds: {
                casa: (1.50 + Math.random() * 2).toFixed(2),
                empate: (3.00 + Math.random() * 1.5).toFixed(2),
                fora: (2.50 + Math.random() * 4).toFixed(2)
            }
        }));
        
        res.json(jogos);
    } catch (error) {
        console.error("Erro na API:", error.message);
        res.status(500).json({ erro: "Falha ao carregar jogos reais" });
    }
});

app.post('/api/finalizar', async (req, res) => {
    try {
        const { valor, palpite, times, odd } = req.body;
        const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
        const retorno = (valor * odd).toFixed(2);
        await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
        res.json({ codigo, retorno });
    } catch (e) { res.status(500).json({erro: "Erro ao salvar"}); }
});

// Painel administrativo para você ver as apostas
app.get('/api/admin/bilhetes', async (req, res) => {
    const r = await pool.query('SELECT * FROM bilhetes ORDER BY id DESC');
    res.json(r.rows);
});

app.listen(process.env.PORT || 3000);
