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
    TEMPO_CACHE: 10 * 60 * 1000, 
    SENHA_ADMIN: "admin_gurila_2026",
    MIN_VALOR_APOSTA: 1.00,   
    MAX_VALOR_APOSTA: 1000.00, 
    MAX_PREMIO_PAGO: 10000.00, 
    MIN_JOGOS_BILHETE: 1, // Liberado 1 jogo para facilitar teste
    MAX_JOGOS_BILHETE: 15     
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let cacheJogos = { dataRef: null, dados: null, ultimaAtualizacao: 0 };

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        const u = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(u.rows.length === 0) {
            const hash = await bcrypt.hash('123456', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Admin', 'admin@gurila.com', $1)", [hash]);
        }
        console.log("✅ Servidor V21 (Visual Blindado) Online!");
    } catch (e) { console.error("FATAL DB ERROR:", e.message); }
}
initDb();

// --- ROTA JOGOS (Tenta ESPN -> Se falhar -> Backup Bonito) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const dataESPN = dataFiltro.replace(/-/g, ''); 
    const agora = Date.now();

    if (cacheJogos.dados && cacheJogos.dataRef === dataFiltro && (agora - cacheJogos.ultimaAtualizacao < CONFIG.TEMPO_CACHE)) {
        return res.json(cacheJogos.dados);
    }
    
    try {
        // TENTA ESPN (GRÁTIS E SEM CHAVE)
        const url = `http://site.api.espn.com/apis/site/v2/sports/soccer/scoreboards?dates=${dataESPN}`;
        const resp = await axios.get(url, { timeout: 6000 });
        
        if (!resp.data || !resp.data.events) throw new Error("ESPN Off");
        const jogosReais = formatarESPN(resp.data.events);
        
        if(jogosReais.length === 0) throw new Error("Sem jogos na ESPN");

        cacheJogos = { dataRef: dataFiltro, dados: jogosReais, ultimaAtualizacao: agora };
        res.json(jogosReais);

    } catch (e) {
        console.log("⚠️ Usando Backup Manual (Motivo: " + e.message + ")");
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// --- ROTA FINALIZAR (Com Debug) ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, odd_total } = req.body;
        
        // Validações
        if (!apostas || !Array.isArray(apostas)) return res.status(400).json({ erro: "Erro nos dados do bilhete" });
        if (apostas.length < CONFIG.MIN_JOGOS_BILHETE) return res.status(400).json({ erro: `Selecione no mínimo ${CONFIG.MIN_JOGOS_BILHETE} jogos` });
        
        valor = parseFloat(valor);
        if (isNaN(valor) || valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Valor mínimo: R$ ${CONFIG.MIN_VALOR_APOSTA}` });

        // Cálculos
        odd_total = parseFloat(odd_total);
        let retorno = valor * odd_total;
        if (retorno > CONFIG.MAX_PREMIO_PAGO) retorno = CONFIG.MAX_PREMIO_PAGO;

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        
        // Gravação no Banco
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retorno.toFixed(2), odd_total, JSON.stringify(apostas)]);
            
        res.json({ sucesso: true, codigo, retorno: retorno.toFixed(2) });

    } catch (e) {
        console.error("ERRO AO FINALIZAR:", e.message); 
        // Retorna o erro exato para o frontend mostrar no alerta
        res.status(500).json({ erro: "Erro no Servidor: " + e.message });
    }
});

// --- FORMATADORES ---
function formatarESPN(events) {
    return events.map(ev => {
        try {
            const status = ev.status.type.state; 
            if (status === 'post') return null; // Remove jogos encerrados

            const home = ev.competitions[0].competitors.find(c => c.homeAway === 'home');
            const away = ev.competitions[0].competitors.find(c => c.homeAway === 'away');
            
            return {
                id: parseInt(ev.id),
                liga: (ev.season.slug || "Mundo").toUpperCase(),
                // LOGO DA LIGA PADRÃO DA ESPN
                logo_liga: "https://a.espncdn.com/combiner/i?img=/i/leaguelogos/soccer/500-dark/default.png", 
                pais: "Mundo",
                home: { name: home.team.displayName, logo: home.team.logo || "https://cdn-icons-png.flaticon.com/512/183/183345.png" },
                away: { name: away.team.displayName, logo: away.team.logo || "https://cdn-icons-png.flaticon.com/512/183/183345.png" },
                data: ev.date,
                status: status === 'pre' ? 'NS' : 'AO VIVO',
                ativo: true,
                odds: calcularOdds(home.team.displayName, away.team.displayName),
                mercados: { total_gols: { mais_25: "1.80", menos_25: "1.90" }, dupla_chance: { casa_empate: "1.25", casa_fora: "1.25", empate_fora: "1.25" } }
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function calcularOdds(h, a) {
    // Simula odds aleatórias mas realistas
    return { 
        casa: (1.5 + Math.random()).toFixed(2), 
        empate: (3.0 + Math.random()).toFixed(2), 
        fora: (2.5 + Math.random()).toFixed(2) 
    };
}

// --- JOGOS DE BACKUP (COM IMAGENS QUE FUNCIONAM) ---
function gerarJogosFalsos(d) {
    const agora = new Date();
    // Adiciona horários futuros para não parecer que o jogo já foi
    const t1 = new Date(agora); t1.setHours(agora.getHours() + 2);
    const t2 = new Date(agora); t2.setHours(agora.getHours() + 4);

    return [
        {
            id: 9001, liga: "BRASILEIRÃO (Backup)", logo_liga: "https://upload.wikimedia.org/wikipedia/commons/9/98/Brasileir%C3%A3o_Petrobras_S%C3%A9rie_A_2002.png", pais: "Brasil",
            home: { name: "Flamengo", logo: "https://upload.wikimedia.org/wikipedia/commons/2/2e/Flamengo_braz_logo.svg" },
            away: { name: "Vasco", logo: "https://upload.wikimedia.org/wikipedia/commons/6/67/Vasco_da_Gama_2017.svg" },
            data: t1.toISOString(), status: "NS", ativo: true,
            odds: { casa: "1.85", empate: "3.20", fora: "3.90" },
            mercados: { total_gols: { mais_25: "1.90", menos_25: "1.80" }, dupla_chance: { casa_empate: "1.20", casa_fora: "1.20", empate_fora: "1.20" } }
        },
        {
            id: 9002, liga: "CHAMPIONS (Backup)", logo_liga: "https://upload.wikimedia.org/wikipedia/commons/f/f3/Logo_UEFA_Champions_League.png", pais: "Europa",
            home: { name: "Real Madrid", logo: "https://upload.wikimedia.org/wikipedia/en/5/56/Real_Madrid_CF.svg" },
            away: { name: "Manchester City", logo: "https://upload.wikimedia.org/wikipedia/en/e/eb/Manchester_City_FC_badge.svg" },
            data: t2.toISOString(), status: "NS", ativo: true,
            odds: { casa: "2.50", empate: "3.10", fora: "2.60" },
            mercados: { total_gols: { mais_25: "1.70", menos_25: "2.10" }, dupla_chance: { casa_empate: "1.40", casa_fora: "1.40", empate_fora: "1.40" } }
        }
    ];
}

// Rotas Padrão
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.get('/api/bilhete/:codigo', async (req, res) => { try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); } });

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V21 On!"));
