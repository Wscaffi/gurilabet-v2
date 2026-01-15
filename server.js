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
    TEMPO_CACHE: 10 * 60 * 1000, 
    SENHA_ADMIN: "admin_gurila_2026",
    MIN_VALOR_APOSTA: 2.00,   
    MAX_VALOR_APOSTA: 200.00, 
    MAX_PREMIO_PAGO: 5000.00, 
    MIN_JOGOS_BILHETE: 2, 
    MAX_JOGOS_BILHETE: 10     
};

const TIMES_FORTES = ["Flamengo", "Palmeiras", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Milan"];

const requestLog = new Map();
function rateLimiter(ip) {
    const now = Date.now();
    const last = requestLog.get(ip) || 0;
    if (now - last < 2000) return false; 
    requestLog.set(ip, now);
    return true;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let cacheJogos = { dataRef: null, dados: null, ultimaAtualizacao: 0 };

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        const u = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(u.rows.length === 0) await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Balcão', 'sistema@gurila.com', '123')");
        console.log("✅ Servidor V18 (Modo Guerra) Online!");
    } catch (e) { console.error(e.message); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const agora = Date.now();

    // Cache simples
    if (cacheJogos.dados && cacheJogos.dataRef === dataFiltro && (agora - cacheJogos.ultimaAtualizacao < CONFIG.TEMPO_CACHE)) {
        return res.json(cacheJogos.dados);
    }
    
    try {
        if (!process.env.API_FOOTBALL_KEY) throw new Error("Sem Key");
        
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;
        const resp = await axios.get(url, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY.trim() }, timeout: 6000 });
        
        if (!resp.data || !resp.data.response) throw new Error("API Vazia");

        const jogosReais = formatar(resp.data.response);
        
        // SE A API DEVOLVER LISTA VAZIA (Ex: só jogos obscuros que filtramos), USA O BACKUP
        if (jogosReais.length === 0) throw new Error("Nenhum jogo encontrado na API");

        cacheJogos = { dataRef: dataFiltro, dados: jogosReais, ultimaAtualizacao: agora };
        res.json(jogosReais);

    } catch (e) {
        console.log("⚠️ FALHA API - USANDO BACKUP:", e.message);
        // AQUI ESTÁ A SALVAÇÃO: Retorna jogos falsos se der erro
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// ... (Rotas de Finalizar, Admin, Login iguais) ...
app.post('/api/finalizar', async (req, res) => {
    let { usuario_id, valor, apostas, odd_total } = req.body;
    if (!Array.isArray(apostas)) return res.status(400).json({ erro: "Erro" });
    if (apostas.length < CONFIG.MIN_JOGOS_BILHETE) return res.status(400).json({ erro: `Mínimo ${CONFIG.MIN_JOGOS_BILHETE} jogos` });
    valor = parseFloat(valor);
    if (valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Mínimo R$ ${CONFIG.MIN_VALOR_APOSTA}` });
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
        [usuario_id || 1, codigo, valor, (valor * odd_total).toFixed(2), odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: (valor * odd_total).toFixed(2) });
    } catch (e) { res.status(500).json({ erro: "Erro" }); }
});
app.get('/api/admin/resumo', async (req, res) => {
    if (req.query.senha !== CONFIG.SENHA_ADMIN) return res.status(403).json({ erro: "Negado" });
    try {
        const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`);
        const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`);
        res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows });
    } catch (e) { res.status(500).json({ erro: "Erro" }); }
});
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.get('/api/bilhete/:codigo', async (req, res) => { try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); } });

// --- LÓGICA DE DADOS ---
function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function calcularOdds(fixture) {
    // Simulação Segura
    return { casa: "1.90", empate: "3.20", fora: "2.80" }; // Odd Padrão para não dar erro
}

function formatar(data) {
    return data.map(j => {
        // REMOVI O FILTRO DE 'FT' (ACABADO) PARA TESTE
        // Agora vai aparecer TUDO que a API mandar
        const odds = calcularOdds(j);
        return {
            id: j.fixture.id, liga: j.league.name, logo_liga: j.league.logo, pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo }, away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date, status: j.fixture.status.short, ativo: true, odds: odds,
            mercados: { total_gols: { mais_25: "1.85", menos_25: "1.85" }, dupla_chance: { casa_empate: "1.30", casa_fora: "1.30", empate_fora: "1.30" } }
        };
    }).filter(Boolean);
}

// --- FUNÇÃO DE EMERGÊNCIA (JOGOS FALSOS) ---
function gerarJogosFalsos(d) {
    // Se a API falhar, mostramos isso aqui
    const lista = [];
    const nomes = [
        ["Flamengo", "Vasco"], ["Real Madrid", "Barcelona"], 
        ["Manchester City", "Liverpool"], ["Palmeiras", "Corinthians"],
        ["PSG", "Bayern Munich"]
    ];
    
    for(let i=0; i<5; i++) {
        lista.push({
            id: 9990 + i, 
            liga: "Copa Backup (Sem API)", logo_liga: "https://media.api-sports.io/football/leagues/1.png", pais: "Mundo",
            home: { name: nomes[i][0], logo: "https://media.api-sports.io/football/teams/1.png" },
            away: { name: nomes[i][1], logo: "https://media.api-sports.io/football/teams/2.png" },
            data: new Date().toISOString(), status: "NS", ativo: true,
            odds: { casa: "2.10", empate: "3.10", fora: "2.90" },
            mercados: { total_gols: { mais_25: "1.90", menos_25: "1.80" }, dupla_chance: { casa_empate: "1.25", casa_fora: "1.25", empate_fora: "1.25" } }
        });
    }
    return lista;
}

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V18 (Guerra) On!"));
