const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto'); // Nativo, não dá erro de instalação

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicialização das tabelas de Clientes e Bilhetes
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, 
            valor NUMERIC, retorno NUMERIC, detalhes JSONB, status TEXT DEFAULT 'pendente', data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Sistema Gurila Bet Ativo!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// Busca de Jogos Reais (Igual a Gol da Sorte)
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { casa: "1.85", empate: "3.40", fora: "4.20" }
        }));
        res.json(jogos);
    } catch (e) { res.json([]); }
});

// Cadastro de Usuários
app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha } = req.body;
    const hash = crypto.createHash('sha256').update(senha).digest('hex');
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome',
            [nome, email, hash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já existe." }); }
});

app.listen(process.env.PORT || 3000);
