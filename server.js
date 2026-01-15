const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- ⚙️ CONFIGURAÇÕES DO DONO ---
const CONFIG = {
    LUCRO_CASA: 0.90, // Você fica com 10% de margem de segurança
    ODD_MAXIMA: 1000.00,
    PAGAMENTO_MAXIMO: 5000.00,
    SENHA_ADMIN: "admin_gurila_2026"
};

// --- 🦁 LISTA DOS GIGANTES (TIMES QUE SÃO FAVORITOS MESMO FORA) ---
const TIMES_FORTES = [
    "Flamengo", "Palmeiras", "Atlético Mineiro", "River Plate", "Boca Juniors",
    "Real Madrid", "Barcelona", "Atletico Madrid",
    "Manchester City", "Liverpool", "Arsenal", "Chelsea", "Manchester United",
    "Bayern Munich", "Dortmund", "Leverkusen",
    "PSG", "Monaco",
    "Inter", "Milan", "Juventus", "Napoli", "Roma",
    "Benfica", "Porto", "Sporting",
    "Al Hilal", "Al Nassr"
];

// --- LIGAS ONDE LIBERAMOS MAIS MERCADOS ---
const LIGAS_VIP = [
    "Serie A", "Serie B", "Premier League", "La Liga", "Bundesliga", 
    "Ligue 1", "Champions League", "Libertadores", "Sudamericana"
];

// --- ANTI-SPAM (SEGURANÇA) ---
const requestLog = new Map();
function rateLimiter(ip) {
    const now = Date.now();
    const lastRequest = requestLog.get(ip) || 0;
    if (now - lastRequest < 2000) return false; 
    requestLog.set(ip, now);
    return true;
}

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

let cacheJogos = { dados: null, ultimaAtualizacao: 0 };

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
        const userCheck = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(userCheck.rows.length === 0) {
            const hash = await bcrypt.hash('sistema123', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'sistema@gurila.com', $1)", [hash]);
        }
        console.log("✅ Servidor V9.0 (Lógica de Mercado) Online!");
    } catch (e) { console.error("⚠️ Erro Banco:", e.message); }
}
initDb();

// --- CACHE DINÂMICO (ECONOMIA DE API) ---
function getTempoCache() {
    const agora = new Date();
    const horaBrasilia = (agora.getUTCHours() - 3 + 24) % 24; 
    // Das 10h às 23h (Pico): Atualiza a cada 10 min
    // Das 00h às 09h (Madrugada): Atualiza a cada 60 min
    if (horaBrasilia >= 10 && horaBrasilia <= 23) return 10 * 60 * 1000; 
    return 60 * 60 * 1000; 
}

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const isAoVivo = req.query.aovivo === 'true';
    const agora = Date.now();
    const TEMPO_CACHE_ATUAL = getTempoCache();

    if (!isAoVivo && cacheJogos.dados && (agora - cacheJogos.ultimaAtualizacao < TEMPO_CACHE_ATUAL)) {
        console.log("♻️ Cache Inteligente Ativo");
        return res.json(cacheJogos.dados);
    }
    
    try {
        if (!process.env.API_FOOTBALL_KEY) throw new Error("Sem Chave API");

        const headers = { 
            'x-apisports-key': process.env.API_FOOTBALL_KEY.trim(),
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY.trim(),
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

        const resp = await axios.get(url, { headers, timeout: 6000 });
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) throw new Error("Erro API");
        let fixtures = resp.data.response;
        if (!fixtures || fixtures.length === 0) throw new Error("Lista Vazia");

        const jogosReais = formatar(fixtures);
        
        if (!isAoVivo) { cacheJogos = { dados: jogosReais, ultimaAtualizacao: agora }; }
        console.log(`✅ Jogos Atualizados: ${jogosReais.length}`);
        res.json(jogosReais);

    } catch (e) {
        console.log(`⚠️ Backup: ${e.message}`);
        if (cacheJogos.dados) return res.json(cacheJogos.dados);
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// --- ROTA DE APOSTA ---
app.post('/api/finalizar', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimiter(ip)) return res.status(429).json({ erro: "Aguarde um momento..." });

    let { usuario_id, valor, apostas, odd_total } = req.body;
    if (!Array.isArray(apostas) || apostas.length === 0) return res.status(400).json({ erro: "Aposta vazia." });
    
    valor = parseFloat(valor);
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido." });

    odd_total = parseFloat(odd_total);
    if (odd_total > CONFIG.ODD_MAXIMA) odd_total = CONFIG.ODD_MAXIMA;
    let retorno = valor * odd_total;
    if (retorno > CONFIG.PAGAMENTO_MAXIMO) retorno = CONFIG.PAGAMENTO_MAXIMO;

    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
        [usuario_id || 1, codigo, valor, retorno.toFixed(2), odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: retorno.toFixed(2) });
    } catch (e) { res.status(500).json({ erro: "Erro servidor" }); }
});

// --- ADMIN ---
app.get('/api/admin/resumo', async (req, res) => {
    if (req.query.senha !== CONFIG.SENHA_ADMIN) return res.status(403).json({ erro: "Acesso Negado" });
    try {
        const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`);
        const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`);
        res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows });
    } catch (e) { res.status(500).json({ erro: "Erro Admin" }); }
});

// --- SIMULAÇÃO DE ODDS "TIPO BET365" (GRÁTIS) ---
function aplicarMargem(valorBase) {
    let odd = parseFloat(valorBase) * CONFIG.LUCRO_CASA;
    return odd < 1.01 ? "1.01" : odd.toFixed(2);
}

function calcularOdds(fixture) {
    const nomeCasa = fixture.teams.home.name;
    const nomeFora = fixture.teams.away.name;

    const casaEhForte = TIMES_FORTES.some(t => nomeCasa.includes(t));
    const foraEhForte = TIMES_FORTES.some(t => nomeFora.includes(t));

    let oddCasa, oddEmpate, oddFora;

    // --- LÓGICA DE MERCADO ---
    
    // 1. GIGANTE JOGANDO FORA (Ex: Como x Milan)
    if (foraEhForte && !casaEhForte) {
        oddFora = (1.55 + Math.random() * 0.20).toFixed(2); // Milan Favorito (1.55 ~ 1.75)
        oddCasa = (4.50 + Math.random() * 1.50).toFixed(2); // Como Zebra (4.50 ~ 6.00)
        oddEmpate = (3.50 + Math.random() * 0.50).toFixed(2);
    } 
    // 2. GIGANTE JOGANDO EM CASA (Ex: Flamengo x Bangu)
    else if (casaEhForte && !foraEhForte) {
        oddCasa = (1.30 + Math.random() * 0.15).toFixed(2); // Super Favorito (1.30 ~ 1.45)
        oddFora = (7.00 + Math.random() * 2.00).toFixed(2); // Zebra Total
        oddEmpate = (4.50 + Math.random() * 1.00).toFixed(2);
    }
    // 3. CLÁSSICO (Forte x Forte) ou JOGO COMUM
    else {
        // Padrão: Casa levemente favorita
        oddCasa = (2.10 + Math.random() * 0.40).toFixed(2); 
        oddFora = (3.10 + Math.random() * 0.60).toFixed(2);
        oddEmpate = (2.90 + Math.random() * 0.30).toFixed(2);
    }

    return { 
        casa: aplicarMargem(oddCasa), 
        empate: aplicarMargem(oddEmpate), 
        fora: aplicarMargem(oddFora) 
    };
}

function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        if (['FT', 'AET', 'PEN'].includes(status)) return null;
        let placar = (j.goals.home !== null && j.goals.away !== null) ? `${j.goals.home} - ${j.goals.away}` : null;
        
        // Gera as odds inteligentes
        const oddsCalc = calcularOdds(j);

        return {
            id: j.fixture.id, liga: j.league.name, logo_liga: j.league.logo, pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo }, 
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date, status: status, ativo: true, placar: placar,
            odds: oddsCalc,
            mercados: gerarMercadosInteligentes(j.league.name, oddsCalc)
        };
    }).filter(Boolean);
}

function gerarMercadosInteligentes(nomeLiga, odds) {
    // Cria mercados derivados das odds principais
    return {
        dupla_chance: { 
            casa_empate: (parseFloat(odds.casa)*0.7).toFixed(2), 
            casa_fora: "1.25", 
            empate_fora: (parseFloat(odds.fora)*0.7).toFixed(2) 
        },
        total_gols: { mais_25: "1.90", menos_25: "1.80" },
        ambas_marcam: LIGAS_VIP.some(v => nomeLiga.includes(v)) ? { sim: "1.80", nao: "1.90" } : null,
        intervalo_final: LIGAS_VIP.some(v => nomeLiga.includes(v)) ? { "Casa/Casa": (parseFloat(odds.casa)*1.5).toFixed(2), "Empate/Empate": "4.50", "Fora/Fora": (parseFloat(odds.fora)*1.5).toFixed(2) } : null
    };
}

function gerarJogosFalsos(dataBase) {
    let lista = []; const times = [{n:"Flamengo"},{n:"Vasco"},{n:"Real Madrid"},{n:"Barcelona"}];
    for(let i=0; i<5; i++) { lista.push({ id: 9000+i, liga: "Amistoso", logo_liga: "", pais: "Mundo", home: {name:times[0].n,logo:""}, away: {name:times[1].n,logo:""}, data: new Date().toISOString(), status: "NS", ativo: true, placar: null, odds: {casa:"1.80",empate:"3.20",fora:"2.50"}, mercados: null }); }
    return lista;
}

// Rotas User
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.get('/api/bilhete/:codigo', async (req, res) => { try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); } });

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V9.0 On!"));
