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
        
        // --- FILTRO DE DATA ---
        const hoje = new Date().toISOString().split('T')[0];
        const dataFiltro = req.query.data || hoje;

        const resp = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`, { headers, timeout: 15000 });

        let fixtures = resp.data.response;
        if (!fixtures) fixtures = [];

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
        
        // --- TRAVAS DE SEGURANÇA ---
        const statusOk = status === 'NS'; // Só aceita jogo Não Iniciado
        const tempoOk = dataJogo > agora; // Só aceita jogo Futuro
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

            // --- MERCADOS COMPLETOS E DINÂMICOS ---
            mercados: ativo ? {
                dupla_chance: {
                    casa_empate: (1.15 + Math.random() * 0.15).toFixed(2),
                    casa_fora: (1.20 + Math.random() * 0.15).toFixed(2),
                    empate_fora: (1.40 + Math.random() * 0.40).toFixed(2)
                },
                ambas_marcam: {
                    sim: (1.60 + Math.random() * 0.40).toFixed(2),
                    nao: (1.70 + Math.random() * 0.40).toFixed(2)
                },
                total_gols: {
                    mais_05: (1.05 + Math.random() * 0.05).toFixed(2),
                    menos_05: (7.00 + Math.random()).toFixed(2),
                    mais_15: (1.25 + Math.random() * 0.15).toFixed(2),
                    menos_15: (2.80 + Math.random()).toFixed(2),
                    mais_25: (1.70 + Math.random() * 0.50).toFixed(2),
                    menos_25: (1.80 + Math.random() * 0.40).toFixed(2),
                    mais_35: (2.90 + Math.random()).toFixed(2),
                    menos_35: (1.25 + Math.random() * 0.10).toFixed(2)
                },
                intervalo_final: { // HT/FT
                    "Casa/Casa": (2.40 + Math.random()).toFixed(2),
                    "Empate/Empate": (4.20 + Math.random()).toFixed(2),
                    "Fora/Fora": (3.50 + Math.random()).toFixed(2)
                },
                handicap: {
                    "Casa -1": (2.60 + Math.random()).toFixed(2),
                    "Empate -1": (3.20 + Math.random()).toFixed(2),
                    "Fora +1": (1.35 + Math.random()).toFixed(2)
                },
                impar_par: { "Impar": "1.90", "Par": "1.90" },
                margem_vitoria: { "Casa por 1": "3.50", "Fora por 1": "4.00" },
                primeiro_gol: { "Casa": "1.70", "Fora": "2.20", "Sem Gols": "8.50" },
                escanteios: {
                    mais_8: (1.45 + Math.random() * 0.2).toFixed(2),
                    mais_10: (2.00 + Math.random() * 0.5).toFixed(2),
                    menos_10: (1.60 + Math.random() * 0.2).toFixed(2)
                }
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

app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    if (apostas.length > 10) return res.status(400).json({ erro: "Limite de 10 jogos por bilhete excedido." });
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    let retornoCalculado = (valor * odd_total);
    if (retornoCalculado > 2500) retornoCalculado = 2500.00;
    const retornoFinal = parseFloat(retornoCalculado).toFixed(2);
    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [usuario_id, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: retornoFinal });
    } catch (e) { console.error(e); res.status(500).json({ erro: "Erro ao processar aposta" }); }
});

app.listen(process.env.PORT || 3000);
