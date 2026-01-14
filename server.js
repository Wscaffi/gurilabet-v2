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

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const hoje = new Date().toISOString().split('T')[0];
        const resp = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${hoje}`, { headers, timeout: 15000 });

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

function formatar(data) {
    const agora = new Date();
    return data.map(j => {
        const dataJogo = new Date(j.fixture.date);
        const status = j.fixture.status.short;
        const statusOk = status === 'NS';
        const tempoOk = dataJogo > agora;
        const ativo = statusOk && tempoOk;

        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            ativo: ativo,
            odds: { 
                casa: ativo ? (1.5 + Math.random()).toFixed(2) : "Bloq", 
                empate: ativo ? (3.0 + Math.random()).toFixed(2) : "Bloq", 
                fora: ativo ? (2.2 + Math.random() * 2).toFixed(2) : "Bloq" 
            },
            mercados: ativo ? {
                dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
                ambas_marcam: { sim: "1.75", nao: "1.95" },
                total_gols: { mais_05: "1.05", menos_05: "8.00", mais_15: "1.30", menos_15: "3.20", mais_25: "1.80", menos_25: "1.90", mais_35: "3.00", menos_35: "1.30" },
                placar_exato: { "1-0": "6.00", "2-0": "9.00", "2-1": "9.50", "0-0": "8.00", "0-1": "7.50" },
                intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" },
                handicap: { "Casa -1": "2.80", "Empate -1": "3.40", "Fora +1": "1.45" },
                impar_par: { "Impar": "1.90", "Par": "1.90" },
                margem_vitoria: { "Casa por 1": "3.50", "Fora por 1": "4.00" },
                primeiro_gol: { "Casa": "1.70", "Fora": "2.20", "Sem Gols": "8.00" },
                escanteios: { mais_8: "1.50", mais_10: "2.10", menos_10: "1.65" }
            } : null
        };
    });
}

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

// --- ROTA DE FINALIZAÇÃO COM GESTÃO DE RISCO ---
app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    
    // 1. REGRA: MÁXIMO 10 JOGOS
    if (apostas.length > 10) {
        return res.status(400).json({ erro: "Limite de 10 jogos por bilhete excedido." });
    }

    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    
    // 2. REGRA: TETO DE R$ 2500,00
    let retornoCalculado = (valor * odd_total);
    if (retornoCalculado > 2500) {
        retornoCalculado = 2500.00; // Trava o valor no banco de dados
    }
    const retornoFinal = parseFloat(retornoCalculado).toFixed(2);
    
    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [usuario_id, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: retornoFinal });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ erro: "Erro ao processar aposta" }); 
    }
});

app.listen(process.env.PORT || 3000);
