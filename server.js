const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Conexão com Banco de Dados (Mantida)
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicializa Tabelas
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, 
            valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', 
            detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Banco Gurila Bet Conectado!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// Rota de Jogos (Com Mercados e Segurança de Status)
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const hoje = new Date().toISOString().split('T')[0];
        const resp = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${hoje}`, { headers, timeout: 10000 });

        let fixtures = resp.data.response;
        if (!fixtures || fixtures.length === 0) {
            const backup = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers });
            fixtures = backup.data.response;
        }

        res.json(formatar(fixtures));
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// Formatação Inteligente
function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        // Libera apostas para: Não Iniciado, 1º Tempo, Intervalo, 2º Tempo
        const ativo = ['NS', '1H', 'HT', '2H'].includes(status);
        
        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            odds: { 
                casa: ativo ? (1.5 + Math.random
