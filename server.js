const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// LIBERAÇÃO TOTAL PARA A VERCEL CONECTAR
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ROTA DE JOGOS COM "PLANO B" AUTOMÁTICO
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=10', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });

        let jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            odds: { casa: "2.10", empate: "3.25", fora: "4.00" }
        }));

        // SE A API FALHAR OU VIER VAZIA, MOSTRA JOGOS DE TESTE NA HORA
        if (jogos.length === 0) {
            jogos = [
                { id: 101, times: "Flamengo x Palmeiras", odds: { casa: "2.10", empate: "3.20", fora: "3.80" } },
                { id: 102, times: "Real Madrid x Barcelona", odds: { casa: "1.95", empate: "3.40", fora: "4.10" } }
            ];
        }
        res.json(jogos);
    } catch (error) {
        // SE DER ERRO NA API, MOSTRA OS JOGOS DE TESTE PARA NÃO TRAVAR O SITE
        res.json([
            { id: 101, times: "Flamengo x Palmeiras", odds: { casa: "2.10", empate: "3.20", fora: "3.80" } },
            { id: 102, times: "Real Madrid x Barcelona", odds: { casa: "1.95", empate: "3.40", fora: "4.10" } }
        ]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
