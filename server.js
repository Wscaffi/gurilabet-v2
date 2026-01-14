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

// Banco de dados automático
async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL, codigo TEXT, valor NUMERIC, retorno NUMERIC, times TEXT, palpite TEXT, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}
init();

// Motor de Jogos Reais
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=15&status=NS-1H-2H', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            status: j.fixture.status.short,
            odds: { casa: "1.95", empate: "3.20", fora: "4.10" }
        }));
        res.json(jogos.length > 0 ? jogos : [{times: "Aguardando Jogos...", odds: {casa: "1.00", empate: "1.00", fora: "1.00"}}]);
    } catch (e) {
        res.json([{times: "Erro na API - Verifique sua Chave", odds: {casa: "0.00", empate: "0.00", fora: "0.00"}}]);
    }
});

// Registrar Apostas
app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    const retorno = (valor * odd).toFixed(2);
    await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    res.json({ codigo, retorno });
});

app.listen(process.env.PORT || 3000);
