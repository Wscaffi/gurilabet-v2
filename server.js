const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- CONFIGURAÇÕES DO CHEFE ---
const CONFIG = {
    ODD_MAXIMA: 2000.00,
    PAGAMENTO_MAXIMO: 5000.00,
    TEMPO_CACHE: 15 * 60 * 1000, // 15 Minutos
    SENHA_ADMIN: "admin_gurila_2026"
};

// --- LISTA DE LIGAS VIP (Onde liberamos todos os mercados) ---
const LIGAS_VIP = [
    "Serie A", "Serie B", "Premier League", "La Liga", "Bundesliga", 
    "Ligue 1", "UEFA Champions League", "Copa Libertadores", "Copa Sudamericana"
];

// --- ANTI-SPAM ---
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
        console.log("✅ Servidor V5.0 (Smart Markets) Online!");
    } catch (e) { console.error("⚠️ Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const isAoVivo = req.query.aovivo === 'true';
    const agora = Date.now();

    if (!isAoVivo && cacheJogos.dados && (agora - cacheJogos.ultimaAtualizacao < CONFIG.TEMPO_CACHE)) {
        console.log("♻️ Cache Ativo");
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
        if (jogosReais.length === 0) throw new Error("Jogos Filtrados");

        if (!isAoVivo) { cacheJogos = { dados: jogosReais, ultimaAtualizacao: agora }; }

        console.log(`✅ ${jogosReais.length} jogos carregados.`);
        res.json(jogosReais);

    } catch (e) {
        console.log(`⚠️ Backup: ${e.message}`);
        if (cacheJogos.dados) return res.json(cacheJogos.dados);
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// --- FINALIZAR APOSTA ---
app.post('/api/finalizar', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimiter(ip)) return res.status(429).json({ erro: "Calma! Aguarde para apostar novamente." });

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
    } catch (e) { res.status(500).json({ erro: "Erro ao processar." }); }
});

// --- ADMIN ---
app.get('/api/admin/resumo', async (req, res) => {
    if (req.query.senha !== CONFIG.SENHA_ADMIN) return res.status(403).json({ erro: "Negado" });
    try {
        const fin = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`);
        const ult = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`);
        res.json({
            status: "Online 🟢",
            caixa: { total: fin.rows[0].t, entrada: `R$ ${parseFloat(fin.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(fin.rows[0].r||0).toFixed(2)}` },
            ultimos: ult.rows
        });
    } catch (e) { res.status(500).json({ erro: "Erro" }); }
});

// --- FUNÇÕES INTELIGENTES ---
function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        if (['FT', 'AET', 'PEN'].includes(status)) return null;

        // EXTRAI O PLACAR (Se existir)
        let placar = null;
        if (j.goals.home !== null && j.goals.away !== null) {
            placar = `${j.goals.home} - ${j.goals.away}`;
        }

        return {
            id: j.fixture.id, liga: j.league.name, logo_liga: j.league.logo, pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo }, 
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date, status: status, ativo: true,
            placar: placar, // ENVIA O PLACAR PRO FRONT
            odds: { 
                casa: (1.5 + (j.fixture.id % 10)/20).toFixed(2), 
                empate: (3.0 + (j.fixture.id % 5)/10).toFixed(2), 
                fora: (2.2 + (j.fixture.id % 8)/10).toFixed(2) 
            },
            mercados: gerarMercadosInteligentes(j.league.name) // CHAMA A NOVA FUNÇÃO
        };
    }).filter(Boolean);
}

// LÓGICA DE MERCADO INTELIGENTE (CASA DE APOSTA)
function gerarMercadosInteligentes(nomeLiga) {
    // Mercados Básicos (Todo jogo tem)
    let mercados = {
        dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
        total_gols: { mais_25: "1.90", menos_25: "1.80" }
    };

    // Verifica se é uma Liga VIP (Top Mundial)
    const ehLigaTop = LIGAS_VIP.some(vip => nomeLiga && nomeLiga.includes(vip));

    if (ehLigaTop) {
        // Se for Top, libera tudo (Alto volume, difícil manipulação)
        mercados.ambas_marcam = { sim: "1.75", nao: "1.95" };
        mercados.intervalo_final = { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" };
        mercados.total_gols_extra = { mais_15: "1.30", menos_15: "3.20" };
    } 
    // Se for liga pequena, não retorna os outros mercados (Proteção da Casa)

    return mercados;
}

function gerarJogosFalsos(dataBase) {
    const times = [{n:"Flamengo",l:"https://media.api-sports.io/football/teams/127.png"},{n:"Vasco",l:"https://media.api-sports.io/football/teams/133.png"},{n:"Real Madrid",l:"https://media.api-sports.io/football/teams/541.png"},{n:"Barcelona",l:"https://media.api-sports.io/football/teams/529.png"}];
    let lista = [];
    for(let i=0; i<10; i++) {
        let t1 = times[Math.floor(Math.random()*times.length)], t2 = times[Math.floor(Math.random()*times.length)];
        if(t1.n===t2.n) t2=times[(times.indexOf(t2)+1)%times.length];
        let d = new Date(dataBase); d.setHours(13+i,0,0); if(new Date()>d) d.setDate(d.getDate()+1);
        lista.push({ 
            id: 9000+i, liga: "Brasileirão", logo_liga: "https://media.api-sports.io/football/leagues/71.png", pais: "Brazil", 
            home: {name:t1.n,logo:t1.l}, away: {name:t2.n,logo:t2.l}, 
            data: d.toISOString(), status: "NS", ativo: true, placar: null,
            odds: {casa:"1.90",empate:"3.20",fora:"2.50"}, 
            mercados: gerarMercadosInteligentes("Serie A") 
        });
    }
    return lista;
}

// Rotas User
app.post('/api/cadastro', async (req, res) => {
    try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro cadastro" }); }
});
app.post('/api/login', async (req, res) => {
    try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Login falhou"}); } catch(e){ res.status(500).json({erro:"Erro"}); }
});
app.get('/api/bilhete/:codigo', async (req, res) => {
    try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); }
});

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V5 On!"));
