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

// Criar tabela
async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL, codigo TEXT, valor NUMERIC, retorno NUMERIC, times TEXT, palpite TEXT, status TEXT DEFAULT 'pendente', data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}
init();

// ROTA JOGOS
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=10', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            odds: { casa: "1.90", empate: "3.20", fora: "4.50" }
        }));
        res.json(jogos.length > 0 ? jogos : [{times: "FLAMENGO x PALMEIRAS", odds: {casa: "2.10", empate: "3.20", fora: "3.80"}}]);
    } catch {
        res.json([{times: "FLAMENGO x PALMEIRAS", odds: {casa: "2.10", empate: "3.20", fora: "3.80"}}]);
    }
});

// ROTA FINALIZAR
app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    const retorno = (valor * odd).toFixed(2);
    await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    res.json({ codigo, retorno });
});

// ROTA SECRETA ADMIN (PARA VER BILHETES)
app.get('/api/admin/bilhetes', async (req, res) => {
    const result = await pool.query('SELECT * FROM bilhetes ORDER BY data DESC');
    res.json(result.rows);
});

app.listen(process.env.PORT || 3000);
