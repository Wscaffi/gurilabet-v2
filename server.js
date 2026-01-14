const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- INICIALIZAÇÃO DO BANCO (MANTIDA) ---
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, 
            valor NUMERIC, retorno NUMERIC, detalhes JSONB, status TEXT DEFAULT 'pendente', data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Banco Gurila Bet Conectado!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS COM NOVOS MERCADOS (CORRIGIDA) ---
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers, timeout: 10000 });

        if (!resp.data.response) return res.json([]);

        const formatados = resp.data.response.map(j => {
            // Lógica de "Casa de Aposta Inteligente":
            // Só geramos odds se o jogo ainda não começou (Status: NS)
            const podeApostar = j.fixture.status.short === 'NS';

            return {
                id: j.fixture.id,
                liga: j.league.name,
                pais: j.league.country,
                bandeira: j.league.logo,
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: j.fixture.status.short,
                // Odds Principais
                odds: { 
                    casa: podeApostar ? (1.5 + Math.random()).toFixed(2) : "0.00", 
                    empate: podeApostar ? (3.1 + Math.random()).toFixed(2) : "0.00", 
                    fora: podeApostar ? (2.4 + Math.random() * 2).toFixed(2) : "0.00" 
                },
                // Novos Mercados para o botão "+"
                mercados_extras: podeApostar ? {
                    gols: { mais: (1.7 + Math.random()).toFixed(2), menos: (1.8 + Math.random()).toFixed(2) },
                    ambas: { sim: (1.6 + Math.random()).toFixed(2), nao: (1.9 + Math.random()).toFixed(2) }
                } : null
            };
        });

        res.json(formatados);
    } catch (e) {
        res.status(500).json([]);
    }
});

// --- SISTEMA DE USUÁRIOS E BILHETES (MANTIDO) ---
app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha } = req.body;
    const hash = crypto.createHash('sha256').update(senha).digest('hex');
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo',
            [nome, email, hash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já cadastrado." }); }
});

app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, palpite, times, odd } = req.body;
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, detalhes) VALUES ($1, $2, $3, $4, $5)',
            [usuario_id, codigo, valor, retorno, JSON.stringify({times, palpite, odd})]
        );
        res.json({ codigo, retorno });
    } catch (e) { res.status(500).json({ erro: "Erro ao gerar bilhete" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor Online na porta ${PORT}`));
