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
                casa: ativo ? (1.5 + Math.random()).toFixed(2) : "0.00", 
                empate: ativo ? (3.0 + Math.random()).toFixed(2) : "0.00", 
                fora: ativo ? (2.2 + Math.random() * 2).toFixed(2) : "0.00" 
            },
            mercados: ativo ? {
                dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
                ambas_marcam: { sim: "1.75", nao: "1.95" },
                total_gols: { mais_25: "1.80", menos_25: "1.90", mais_15: "1.30", menos_15: "3.20" },
                placar_exato: { "1-0": "6.50", "2-0": "9.00", "0-0": "8.00" },
                escanteios: { mais_8: "1.60", mais_10: "2.20" }
            } : null
        };
    });
}

// Cadastro e Login
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

// Finalizar Aposta
app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    const retorno = (valor * odd_total).toFixed(2);
    
    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [usuario_id, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ erro: "Erro ao processar aposta" }); 
    }
});

app.listen(process.env.PORT || 3000, () => console.log("Motor Gurila Bet Rodando 🚀"));
