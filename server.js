const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicialização das Tabelas (Clientes e Bilhetes)
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER REFERENCES usuarios(id),
            codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, detalhes JSONB,
            status TEXT DEFAULT 'pendente', data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Banco de Dados Gurila Bet Pronto!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// Rota de Cadastro
app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha } = req.body;
    try {
        const senhaHash = await bcrypt.hash(senha, 10);
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo',
            [nome, email, senhaHash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já cadastrado." }); }
});

// Busca de Jogos com Filtro de Ligas e Escudos
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=40', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.4 + Math.random() * 1.5).toFixed(2), 
                empate: (3.1 + Math.random() * 0.8).toFixed(2), 
                fora: (2.2 + Math.random() * 3).toFixed(2) 
            }
        }));
        res.json(jogos);
    } catch (e) { res.json([]); }
});

// Histórico de Bilhetes do Usuário
app.get('/api/meus-bilhetes/:usuario_id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bilhetes WHERE usuario_id = $1 ORDER BY data DESC', [req.params.usuario_id]);
        res.json(result.rows);
    } catch (e) { res.status(500).json([]); }
});

// Registrar Aposta
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
    } catch (e) { res.status(500).json({ erro: "Erro ao gerar aposta" }); }
});

app.listen(process.env.PORT || 3000);
