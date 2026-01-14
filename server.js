const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt'); // Para segurança das senhas

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicialização Profissional do Banco de Dados
async function initDb() {
    try {
        // Tabela de Clientes
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            senha TEXT NOT NULL,
            telefone TEXT,
            saldo NUMERIC DEFAULT 0.00,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Tabela de Bilhetes vinculada ao Usuário
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY,
            usuario_id INTEGER REFERENCES usuarios(id),
            codigo TEXT UNIQUE,
            valor NUMERIC,
            retorno NUMERIC,
            detalhes JSONB,
            status TEXT DEFAULT 'pendente',
            data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Banco de Dados Elite Pronto!");
    } catch (e) { console.error("❌ Erro ao iniciar banco:", e.message); }
}
initDb();

// --- SISTEMA DE CADASTRO ---
app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha, telefone } = req.body;
    try {
        const senhaHash = await bcrypt.hash(senha, 10);
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha, telefone) VALUES ($1, $2, $3, $4) RETURNING id, nome',
            [nome, email, senhaHash, telefone]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já cadastrado." }); }
});

// --- BUSCA DE TODOS OS CAMPEONATOS (API-SPORTS) ---
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            logo_liga: j.league.logo,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.4 + Math.random() * 2).toFixed(2), 
                empate: (3.1 + Math.random() * 1).toFixed(2), 
                fora: (2.2 + Math.random() * 4).toFixed(2) 
            }
        }));
        res.json(jogos);
    } catch (e) { res.json([]); }
});

// --- GERAR BILHETE REAL ---
app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, palpite, times, odd } = req.body;
    const codigo = "GB" + Math.random().toString(36).substring(2, 8).toUpperCase();
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, detalhes) VALUES ($1, $2, $3, $4, $5)',
            [usuario_id, codigo, valor, retorno, JSON.stringify({times, palpite, odd})]
        );
        res.json({ codigo, retorno });
    } catch (e) { res.status(500).json({ erro: "Erro ao gerar bilhete." }); }
});

app.listen(process.env.PORT || 3000);
