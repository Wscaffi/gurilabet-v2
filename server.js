const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Libera o acesso para a Vercel

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Cria a tabela de bilhetes se não existir
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL, codigo TEXT, valor NUMERIC, retorno NUMERIC, times TEXT, palpite TEXT, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Banco pronto!");
    } catch (e) { console.error("Erro banco:", e.message); }
}
initDb();

// Busca jogos reais ou carrega testes se der erro
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=10', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            odds: { casa: "2.15", empate: "3.10", fora: "3.90" }
        }));
        res.json(jogos.length > 0 ? jogos : [
            {id: 1, times: "Flamengo x Palmeiras", odds: {casa: "2.10", empate: "3.20", fora: "3.80"}},
            {id: 2, times: "Real Madrid x Barcelona", odds: {casa: "1.95", empate: "3.40", fora: "4.10"}}
        ]);
    } catch {
        res.json([
            {id: 1, times: "Flamengo x Palmeiras", odds: {casa: "2.10", empate: "3.20", fora: "3.80"}},
            {id: 2, times: "Real Madrid x Barcelona", odds: {casa: "1.95", empate: "3.40", fora: "4.10"}}
        ]);
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

app.get('/api/admin/bilhetes', async (req, res) => {
    const r = await pool.query('SELECT * FROM bilhetes ORDER BY data DESC');
    res.json(r.rows);
});

app.listen(process.env.PORT || 3000);
