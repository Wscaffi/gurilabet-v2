const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- CONFIGURAÇÕES ---
const CONFIG = {
    LUCRO_CASA: 0.90,       
    TEMPO_CACHE: 15 * 60 * 1000, 
    SENHA_ADMIN: "admin",
    MIN_VALOR_APOSTA: 1.00,   
    MAX_VALOR_APOSTA: 2000.00, 
    MAX_PREMIO_PAGO: 10000.00, 
    MIN_JOGOS_BILHETE: 1, 
    MAX_JOGOS_BILHETE: 20     
};

// --- LISTA DE TIMES FORTES (PARA ODDS) ---
const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Al Hilal"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let cacheJogos = { dataRef: null, dados: null, ultimaAtualizacao: 0 };

// --- INICIALIZAÇÃO DO BANCO (CORREÇÃO AUTOMÁTICA) ---
async function initDb() {
    try {
        console.log("🛠️ Verificando Banco de Dados...");
        // Cria tabela de usuários
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        
        // --- A MÁGICA: Se a tabela bilhetes estiver bugada, isso garante que ela funcione ---
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, 
            usuario_id INTEGER, 
            codigo TEXT UNIQUE, 
            valor NUMERIC, 
            retorno NUMERIC, 
            odds_total NUMERIC, 
            status TEXT DEFAULT 'pendente', 
            detalhes JSONB, 
            data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Cria Admin Padrão se não existir
        const u = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(u.rows.length === 0) {
            const hash = await bcrypt.hash('123456', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Admin', 'admin@gurila.com', $1)", [hash]);
        }
        console.log("✅ Banco de Dados V22 PRONTO!");
    } catch (e) { console.error("❌ ERRO NO BANCO:", e.message); }
}
initDb();

// --- ROTA HÍBRIDA (API ESPN + BACKUP) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const dataESPN = dataFiltro.replace(/-/g, ''); 
    const agora = Date.now();

    if (cacheJogos.dados && cacheJogos.dataRef === dataFiltro && (agora - cacheJogos.ultimaAtualizacao < CONFIG.TEMPO_CACHE)) {
        return res.json(cacheJogos.dados);
    }
    
    try {
        // Tenta pegar jogos REAIS da ESPN
        const url = `http://site.api.espn.com/apis/site/v2/sports/soccer/scoreboards?dates=${dataESPN}`;
        const resp = await axios.get(url, { timeout: 5000 });
        
        if (!resp.data || !resp.data.events) throw new Error("ESPN vazia");
        
        const jogosReais = formatarESPN(resp.data.events);
        if(jogosReais.length === 0) throw new Error("Sem jogos úteis");

        cacheJogos = { dataRef: dataFiltro, dados: jogosReais, ultimaAtualizacao: agora };
        res.json(jogosReais);

    } catch (e) {
        console.log("⚠️ Falha na ESPN, usando Backup:", e.message);
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// --- ROTA DE FINALIZAR (COM LOGS DE ERRO) ---
app.post('/api/finalizar', async (req, res) => {
    try {
        console.log("📩 Recebendo aposta...");
        let { usuario_id, valor, apostas, odd_total } = req.body;
        
        if (!apostas || !Array.isArray(apostas)) return res.status(400).json({ erro: "Carrinho vazio ou inválido." });
        if (apostas.length < CONFIG.MIN_JOGOS_BILHETE) return res.status(400).json({ erro: `Mínimo de ${CONFIG.MIN_JOGOS_BILHETE} jogo(s).` });
        
        valor = parseFloat(valor);
        if (isNaN(valor) || valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Valor Mínimo: R$ ${CONFIG.MIN_VALOR_APOSTA}` });

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        const retorno = (valor * parseFloat(odd_total)).toFixed(2);
        
        // Tenta salvar no banco
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]);
            
        console.log(`✅ Aposta ${codigo} Salva!`);
        res.json({ sucesso: true, codigo, retorno });

    } catch (e) {
        console.error("❌ ERRO AO SALVAR:", e); // Mostra o erro real no log do Railway
        res.status(500).json({ erro: "Erro Interno no Servidor. Tente novamente em 1 min." });
    }
});

// --- FORMATADORES ---
function calcularOdds(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let oH = 2.10, oD = 3.20, oA = 3.00;

    if(hStrong && !aStrong) { oH = 1.35; oD = 4.50; oA = 7.00; }
    else if(aStrong && !hStrong) { oH = 6.50; oD = 4.00; oA = 1.45; }
    
    // Pequena variação para não ficar estático
    oH = (parseFloat(oH) + (Math.random() * 0.2)).toFixed(2);
    oA = (parseFloat(oA) + (Math.random() * 0.2)).toFixed(2);
    
    return { casa: aplicarMargem(oH), empate: aplicarMargem(oD), fora: aplicarMargem(oA) };
}

function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function formatarESPN(events) {
    return events.map(ev => {
        try {
            const status = ev.status.type.state; // pre, in, post
            if (status === 'post') return null; // Remove jogos encerrados

            const h = ev.competitions[0].competitors.find(c => c.homeAway === 'home');
            const a = ev.competitions[0].competitors.find(c => c.homeAway === 'away');
            const odds = calcularOdds(h.team.displayName, a.team.displayName);

            return {
                id: parseInt(ev.id),
                liga: (ev.season.slug || "Mundo").toUpperCase(),
                logo_liga: "https://a.espncdn.com/combiner/i?img=/i/leaguelogos/soccer/500-dark/default.png&w=40&h=40", 
                pais: "Mundo",
                home: { name: h.team.displayName, logo: h.team.logo || "" },
                away: { name: a.team.displayName, logo: a.team.logo || "" },
                data: ev.date,
                status: status === 'pre' ? 'NS' : 'AO VIVO',
                ativo: true,
                odds: odds,
                mercados: { total_gols: { mais_25: "1.80", menos_25: "1.90" }, dupla_chance: { casa_empate: "1.25", casa_fora: "1.25", empate_fora: "1.25" } }
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function gerarJogosFalsos(d) {
    // Backup bonito caso ESPN falhe
    const t = new Date(); t.setHours(t.getHours()+2);
    return [
        { id: 901, liga: "AMISTOSO (Backup)", logo_liga: "", pais: "Mundo", home: {name:"Flamengo",logo:"https://upload.wikimedia.org/wikipedia/commons/2/2e/Flamengo_braz_logo.svg"}, away: {name:"Vasco",logo:"https://upload.wikimedia.org/wikipedia/commons/6/67/Vasco_da_Gama_2017.svg"}, data: t.toISOString(), status: "NS", ativo: true, odds: {casa:"1.90",empate:"3.20",fora:"3.50"}, mercados: { total_gols: { mais_25: "1.80", menos_25: "1.90" }, dupla_chance: { casa_empate: "1.20", casa_fora: "1.20", empate_fora: "1.20" } } }
    ];
}

// Rotas Básicas
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.get('/api/bilhete/:codigo', async (req, res) => { try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); } });

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V22 (Destravado) On!"));
