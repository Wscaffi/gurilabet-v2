const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- ⚙️ CONFIGURAÇÕES ---
const CONFIG = {
    LUCRO_CASA: 0.92,       
    ODD_MAXIMA: 2000.00,    
    TEMPO_CACHE: 20 * 60 * 1000, // 20 Minutos (Atualiza mais rápido pra sumir com jogos velhos)
    SENHA_ADMIN: "admin_gurila_2026",
    
    // Regras (Valendo, mas invisíveis no topo)
    MIN_VALOR_APOSTA: 2.00,   
    MAX_VALOR_APOSTA: 200.00, 
    MAX_PREMIO_PAGO: 5000.00, 
    MIN_JOGOS_BILHETE: 2,     
    MAX_JOGOS_BILHETE: 10     
};

const TIMES_FORTES = [
    "Flamengo", "Palmeiras", "Atlético Mineiro", "River Plate", "Boca Juniors",
    "Real Madrid", "Barcelona", "Atletico Madrid", "Man City", "Liverpool", "Arsenal",
    "Bayern Munich", "PSG", "Inter", "Milan", "Juventus", "Al Hilal"
];

const requestLog = new Map();
function rateLimiter(ip) {
    const now = Date.now();
    const last = requestLog.get(ip) || 0;
    if (now - last < 2000) return false; 
    requestLog.set(ip, now);
    return true;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let cacheJogos = { dados: null, ultimaAtualizacao: 0 };

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        const u = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(u.rows.length === 0) await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Balcão', 'sistema@gurila.com', '123')");
        console.log("✅ Servidor V14 (Filtro Futuro) Online!");
    } catch (e) { console.error(e.message); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const agora = Date.now();

    if (cacheJogos.dados && (agora - cacheJogos.ultimaAtualizacao < CONFIG.TEMPO_CACHE)) {
        return res.json(cacheJogos.dados);
    }
    
    try {
        if (!process.env.API_FOOTBALL_KEY) throw new Error("Sem Key");
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;
        const resp = await axios.get(url, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY.trim() }, timeout: 6000 });
        const jogosReais = formatar(resp.data.response);
        cacheJogos = { dados: jogosReais, ultimaAtualizacao: agora };
        res.json(jogosReais);
    } catch (e) {
        if (cacheJogos.dados) return res.json(cacheJogos.dados);
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

app.post('/api/finalizar', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimiter(ip)) return res.status(429).json({ erro: "Aguarde..." });

    let { usuario_id, valor, apostas, odd_total } = req.body;
    
    if (!Array.isArray(apostas)) return res.status(400).json({ erro: "Erro dados" });
    if (apostas.length < CONFIG.MIN_JOGOS_BILHETE) return res.status(400).json({ erro: `Mínimo de ${CONFIG.MIN_JOGOS_BILHETE} jogos!` });
    if (apostas.length > CONFIG.MAX_JOGOS_BILHETE) return res.status(400).json({ erro: `Máximo de ${CONFIG.MAX_JOGOS_BILHETE} jogos!` });
    
    valor = parseFloat(valor);
    if (isNaN(valor) || valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Mínimo R$ ${CONFIG.MIN_VALOR_APOSTA}` });
    if (valor > CONFIG.MAX_VALOR_APOSTA) return res.status(400).json({ erro: `Máximo R$ ${CONFIG.MAX_VALOR_APOSTA}` });

    odd_total = parseFloat(odd_total);
    if (odd_total > CONFIG.ODD_MAXIMA) odd_total = CONFIG.ODD_MAXIMA;
    
    let retorno = valor * odd_total;
    if (retorno > CONFIG.MAX_PREMIO_PAGO) retorno = CONFIG.MAX_PREMIO_PAGO;

    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
        [usuario_id || 1, codigo, valor, retorno.toFixed(2), odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: retorno.toFixed(2) });
    } catch (e) { res.status(500).json({ erro: "Erro processar" }); }
});

app.get('/api/admin/resumo', async (req, res) => {
    if (req.query.senha !== CONFIG.SENHA_ADMIN) return res.status(403).json({ erro: "Negado" });
    try {
        const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`);
        const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`);
        res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows });
    } catch (e) { res.status(500).json({ erro: "Erro" }); }
});

function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function calcularOdds(fixture) {
    const home = fixture.teams.home.name, away = fixture.teams.away.name;
    const hStrong = TIMES_FORTES.some(t => home.includes(t)), aStrong = TIMES_FORTES.some(t => away.includes(t));
    let oH, oD, oA;

    if (aStrong && !hStrong) { oA = 1.60; oH = 5.50; oD = 3.80; } 
    else if (hStrong && !aStrong) { oH = 1.35; oA = 8.00; oD = 4.50; } 
    else { oH = 2.10; oA = 3.20; oD = 3.00; } 

    oH += Math.random()*0.3; oA += Math.random()*0.3; oD += Math.random()*0.2;
    return { casa: aplicarMargem(oH), empate: aplicarMargem(oD), fora: aplicarMargem(oA) };
}

function formatar(data) {
    return data.map(j => {
        const st = j.fixture.status.short;
        // --- O FILTRO MÁGICO ---
        // Se NÃO for 'NS' (Not Started) ou 'TBD' (A definir), joga fora.
        // Isso remove jogos ao vivo (1H, 2H) e finalizados (FT).
        if (!['NS', 'TBD'].includes(st)) return null;

        const odds = calcularOdds(j);
        return {
            id: j.fixture.id, liga: j.league.name, logo_liga: j.league.logo, pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo }, away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date, status: st, ativo: true, odds: odds,
            mercados: { total_gols: { mais_25: "1.85", menos_25: "1.85" }, dupla_chance: { casa_empate: "1.30", casa_fora: "1.30", empate_fora: "1.30" } }
        };
    }).filter(Boolean);
}

function gerarJogosFalsos(d) { return []; } 

// Rotas User
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.get('/api/bilhete/:codigo', async (req, res) => { try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); } });

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V14 (Filtro Futuro) On!"));
