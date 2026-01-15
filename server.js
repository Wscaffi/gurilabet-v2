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
    TEMPO_CACHE: 15 * 60 * 1000, // 15 min cache
    SENHA_ADMIN: "admin_gurila_2026",
    
    // Regras de Aposta
    MIN_VALOR_APOSTA: 2.00,   
    MAX_VALOR_APOSTA: 500.00, 
    MAX_PREMIO_PAGO: 5000.00, 
    MIN_JOGOS_BILHETE: 2, 
    MAX_JOGOS_BILHETE: 12     
};

// Times para Smart Odds
const TIMES_FORTES = [
    "Flamengo", "Palmeiras", "Atlético-MG", "River Plate", "Boca Juniors",
    "Real Madrid", "Barcelona", "Liverpool", "Man City", "Arsenal",
    "Bayern", "PSG", "Inter", "Milan", "Juventus", "Al Hilal"
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let cacheJogos = { dataRef: null, dados: null, ultimaAtualizacao: 0 };

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        const u = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(u.rows.length === 0) await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Admin', 'admin@gurila.com', '123')");
        console.log("✅ Servidor V20 (HACK ESPN) Online!");
    } catch (e) { console.error(e.message); }
}
initDb();

// --- ROTA DE JOGOS (HACK ESPN) ---
app.get('/api/jogos', async (req, res) => {
    // Data vem YYYY-MM-DD, a ESPN usa YYYYMMDD
    const dataFront = req.query.data || new Date().toISOString().split('T')[0];
    const dataESPN = dataFront.replace(/-/g, ''); 
    const agora = Date.now();

    // Cache
    if (cacheJogos.dados && cacheJogos.dataRef === dataFront && (agora - cacheJogos.ultimaAtualizacao < CONFIG.TEMPO_CACHE)) {
        return res.json(cacheJogos.dados);
    }
    
    try {
        // --- O PULO DO GATO: API SECRETA DA ESPN ---
        const url = `http://site.api.espn.com/apis/site/v2/sports/soccer/scoreboards?dates=${dataESPN}`;
        
        console.log(`📡 Roubando dados da ESPN: ${dataFront}`);
        const resp = await axios.get(url, { timeout: 8000 });
        
        if (!resp.data || !resp.data.events) throw new Error("ESPN mudou algo");

        const jogosReais = formatarESPN(resp.data.events);
        
        if(jogosReais.length === 0) throw new Error("Sem jogos na ESPN hoje");

        cacheJogos = { dataRef: dataFront, dados: jogosReais, ultimaAtualizacao: agora };
        res.json(jogosReais);

    } catch (e) {
        console.log("⚠️ Erro no Hack:", e.message);
        // Se der ruim na ESPN, usa o Backup Manual
        res.json(gerarJogosFalsos(dataFront));
    }
});

// --- FORMATADOR DO HACK ESPN ---
function formatarESPN(events) {
    return events.map(ev => {
        try {
            const competition = ev.season.slug || "Futebol"; // Ex: "eng.1"
            const statusFull = ev.status.type.state; // 'pre', 'in', 'post'
            
            // Filtro: Só jogos que não acabaram (post)
            // Se quiser mostrar tudo, comente a linha abaixo
            // if (statusFull === 'post') return null;

            const timeHome = ev.competitions[0].competitors.find(c => c.homeAway === 'home');
            const timeAway = ev.competitions[0].competitors.find(c => c.homeAway === 'away');

            // Gera ID único baseado na ESPN
            const gameId = parseInt(ev.id);

            // Simula Odds baseado nos times
            const odds = calcularOdds(timeHome.team.displayName, timeAway.team.displayName);

            return {
                id: gameId,
                liga: ev.season.slug.toUpperCase() || "MUNDO", 
                logo_liga: "https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/default-team-logo-500.png&w=50&h=50",
                pais: "Mundo",
                home: { name: timeHome.team.displayName, logo: timeHome.team.logo || "" },
                away: { name: timeAway.team.displayName, logo: timeAway.team.logo || "" },
                data: ev.date, // Formato ISO
                status: statusFull === 'pre' ? 'NS' : (statusFull === 'in' ? 'AO VIVO' : 'FT'),
                ativo: true,
                odds: odds,
                mercados: { 
                    total_gols: { mais_25: "1.85", menos_25: "1.85" }, 
                    dupla_chance: { casa_empate: "1.25", casa_fora: "1.25", empate_fora: "1.25" } 
                }
            };
        } catch (err) { return null; }
    }).filter(Boolean);
}

// --- SIMULADOR DE ODDS (COM OS TIMES REAIS DA ESPN) ---
function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function calcularOdds(homeName, awayName) {
    const hStrong = TIMES_FORTES.some(t => homeName.includes(t));
    const aStrong = TIMES_FORTES.some(t => awayName.includes(t));
    let oH, oD, oA;

    if (aStrong && !hStrong) { oA = 1.55; oH = 6.00; oD = 4.00; } // Visitante Gigante
    else if (hStrong && !aStrong) { oH = 1.30; oA = 9.00; oD = 5.00; } // Casa Gigante
    else { oH = 2.15; oA = 3.10; oD = 3.00; } // Equilibrado

    // Aleatoriedade pra não ficar sempre igual
    oH += Math.random()*0.3; oA += Math.random()*0.3; 
    
    return { casa: aplicarMargem(oH), empate: aplicarMargem(oD), fora: aplicarMargem(oA) };
}

// ... (Resto das rotas igual: Finalizar, Admin, Login, Cadastro) ...
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

// BACKUP MANUAL (Caso a ESPN falhe)
function gerarJogosFalsos(d) {
    return [
        { id: 901, liga: "BACKUP", logo_liga: "", pais: "BR", home: {name:"Flamengo",logo:""}, away: {name:"Vasco",logo:""}, data: new Date().toISOString(), status: "NS", ativo: true, odds: {casa:"1.90",empate:"3.20",fora:"3.50"}, mercados: { total_gols: { mais_25: "1.90", menos_25: "1.80" }, dupla_chance: { casa_empate: "1.25", casa_fora: "1.25", empate_fora: "1.25" } } },
        { id: 902, liga: "BACKUP", logo_liga: "", pais: "ES", home: {name:"Real Madrid",logo:""}, away: {name:"Barça",logo:""}, data: new Date().toISOString(), status: "NS", ativo: true, odds: {casa:"2.10",empate:"3.10",fora:"2.90"}, mercados: { total_gols: { mais_25: "1.90", menos_25: "1.80" }, dupla_chance: { casa_empate: "1.25", casa_fora: "1.25", empate_fora: "1.25" } } }
    ];
}

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V20 (HACK ESPN) On!"));
