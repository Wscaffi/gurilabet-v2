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

app.get('/api/jogos', async (req, res) => {
    try {
        // Busca 50 jogos para garantir volume
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', {
            headers: { 
                'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });

        if (!resp.data.response || resp.data.response.length === 0) {
            throw new Error("API retornou vazio");
        }

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: `${j.league.country} - ${j.league.name}`,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            data: new Date(j.fixture.date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
            odds: { 
                casa: (1.4 + Math.random() * 1.5).toFixed(2), 
                empate: (3.1 + Math.random() * 0.8).toFixed(2), 
                fora: (2.2 + Math.random() * 3.5).toFixed(2) 
            }
        }));
        
        res.json(jogos);
    } catch (error) {
        console.error("Erro na busca:", error.message);
        // Backup para o site não ficar morto enquanto você arruma a chave
        res.json([
            {liga: "INGLATERRA - PREMIER LEAGUE", times: "Liverpool x Chelsea", data: "Hoje 17:00", odds: {casa: "1.85", empate: "3.50", fora: "4.20"}},
            {liga: "BRASIL - PAULISTÃO", times: "Palmeiras x Santos", data: "Hoje 20:00", odds: {casa: "1.65", empate: "3.40", fora: "5.50"}}
        ]);
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    } catch (e) {}
    res.json({ codigo, retorno });
});

app.listen(process.env.PORT || 3000);
