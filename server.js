const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- CONFIGURAÇÕES GURILA ---
const CONFIG = {
    LUCRO_CASA: 0.90,       
    SENHA_ADMIN: "admin_gurila",
    MIN_VALOR_APOSTA: 2.00,   
    MAX_VALOR_APOSTA: 1000.00, 
    MAX_PREMIO_PAGO: 10000.00, 
    MIN_JOGOS_BILHETE: 1 
};

// Times Fortes (Para gerar odds coerentes)
const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Milan", "Juventus", "Arsenal", "São Paulo", "Corinthians", "Grêmio", "Internacional"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        // --- TABELA DE CACHE (O SEGREDO DO SB99) ---
        // Em vez de memória RAM, usamos o disco. Muito mais estável.
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (
            id SERIAL PRIMARY KEY, 
            data_ref TEXT, 
            json_dados JSONB, 
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        const u = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(u.rows.length === 0) {
            const hash = await bcrypt.hash('123456', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Admin', 'admin@gurila.com', $1)", [hash]);
        }
        console.log("✅ Servidor V26 (Estrutura SB99) Online!");
    } catch (e) { console.error("Erro DB:", e.message); }
}
initDb();

// --- ROTA INTELIGENTE (Lê do Banco, se não tiver, busca fora) ---
app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        // 1. Tenta ler do BANCO LOCAL (Muito rápido, zero bloqueio)
        const cache = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        
        if (cache.rows.length > 0) {
            console.log("📦 Entregando jogos do Banco de Dados");
            return res.json(cache.rows[0].json_dados);
        }

        // 2. Se não tem no banco, vai na ESPN (Semeador)
        console.log("📡 Buscando na ESPN para salvar no banco...");
        const dataESPN = dataHoje.replace(/-/g, '');
        const url = `http://site.api.espn.com/apis/site/v2/sports/soccer/scoreboards?dates=${dataESPN}`;
        
        const resp = await axios.get(url, { timeout: 8000 });
        let jogos = [];

        if (resp.data && resp.data.events) {
            jogos = formatarESPN(resp.data.events);
        }

        // 3. Se a ESPN falhar ou vier vazia, usa o Gerador de Emergência
        if (jogos.length === 0) {
            console.log("⚠️ ESPN vazia, gerando jogos simulados.");
            jogos = gerarJogosSimulados(dataHoje);
        }

        // 4. SALVA NO BANCO (Para as próximas 1000 pessoas lerem de lá)
        await pool.query("INSERT INTO jogos_cache (data_ref, json_dados) VALUES ($1, $2) ON CONFLICT DO NOTHING", [dataHoje, JSON.stringify(jogos)]);
        
        res.json(jogos);

    } catch (e) {
        console.error("Erro Geral:", e.message);
        // Último recurso: retorna simulado sem salvar
        res.json(gerarJogosSimulados(dataHoje));
    }
});

// --- ROTA DE ATUALIZAR (Botão pro Admin forçar atualização) ---
app.get('/api/admin/limpar-cache', async (req, res) => {
    if (req.query.senha !== CONFIG.SENHA_ADMIN) return res.status(403).json({erro: "Senha errada"});
    await pool.query("DELETE FROM jogos_cache");
    res.json({sucesso: true, msg: "Cache limpo! A próxima visita vai baixar jogos novos."});
});

// --- ROTA DE APOSTA ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, odd_total } = req.body;
        
        if (!apostas || !Array.isArray(apostas)) return res.status(400).json({ erro: "Aposta vazia" });
        if (apostas.length < CONFIG.MIN_JOGOS_BILHETE) return res.status(400).json({ erro: `Mínimo ${CONFIG.MIN_JOGOS_BILHETE} jogo` });
        
        valor = parseFloat(valor);
        if (valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Mínimo R$ ${CONFIG.MIN_VALOR_APOSTA}` });

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        const retorno = (valor * parseFloat(odd_total)).toFixed(2);
        
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]);
            
        res.json({ sucesso: true, codigo, retorno });
    } catch (e) {
        res.status(500).json({ erro: "Erro Banco de Dados" });
    }
});

// --- ENGINE DE ODDS (Coração do Sistema) ---
function calcularOdds(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    
    let casa, empate, fora;

    if (hStrong && !aStrong) { casa = 1.35; empate = 4.50; fora = 7.50; }
    else if (aStrong && !hStrong) { casa = 6.00; empate = 4.00; fora = 1.50; }
    else { casa = 2.30; empate = 3.20; fora = 2.90; }

    // Variação aleatória para não ficar robótico
    casa += (Math.random() * 0.3);
    fora += (Math.random() * 0.3);

    return { 
        casa: (casa * CONFIG.LUCRO_CASA).toFixed(2), 
        empate: (empate * CONFIG.LUCRO_CASA).toFixed(2), 
        fora: (fora * CONFIG.LUCRO_CASA).toFixed(2) 
    };
}

function formatarESPN(events) {
    return events.map(ev => {
        try {
            const h = ev.competitions[0].competitors.find(c => c.homeAway === 'home');
            const a = ev.competitions[0].competitors.find(c => c.homeAway === 'away');
            const status = ev.status.type.state; // pre, in, post
            
            // Remove jogos encerrados para limpar a tela
            if (status === 'post') return null;

            return {
                id: parseInt(ev.id),
                liga: (ev.season.slug || "Mundo").toUpperCase().replace("-", " "),
                logo_liga: "https://a.espncdn.com/combiner/i?img=/i/leaguelogos/soccer/500-dark/default.png&w=40&h=40",
                home: { name: h.team.displayName, logo: h.team.logo || "" },
                away: { name: a.team.displayName, logo: a.team.logo || "" },
                data: ev.date,
                status: status === 'in' ? 'AO VIVO' : 'VS',
                odds: calcularOdds(h.team.displayName, a.team.displayName)
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function gerarJogosSimulados(data) {
    // Lista de segurança para nunca ficar vazio
    const lista = [];
    const times = [
        ["Flamengo", "Vasco"], ["Palmeiras", "São Paulo"], ["Liverpool", "Arsenal"],
        ["Real Madrid", "Barcelona"], ["Boca Juniors", "River Plate"], ["Milan", "Inter"]
    ];
    
    let baseTime = new Date(data);
    baseTime.setHours(14, 0, 0); // Começa às 14h

    times.forEach((par, i) => {
        const horario = new Date(baseTime);
        horario.setHours(baseTime.getHours() + i);
        
        lista.push({
            id: 9000 + i,
            liga: "JOGOS EM DESTAQUE",
            logo_liga: "https://cdn-icons-png.flaticon.com/512/1165/1165187.png",
            home: { name: par[0], logo: "https://cdn-icons-png.flaticon.com/512/183/183345.png" },
            away: { name: par[1], logo: "https://cdn-icons-png.flaticon.com/512/183/183345.png" },
            data: horario.toISOString(),
            status: "VS",
            odds: calcularOdds(par[0], par[1])
        });
    });
    return lista;
}

// Rotas Padrão
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const hash = await bcrypt.hash(senha, 10); const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length && await bcrypt.compare(senha, r.rows[0].senha)) { const u = r.rows[0]; delete u.senha; res.json({sucesso:true, usuario:u}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.get('/api/bilhete/:codigo', async (req, res) => { try { const r = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]); res.json({sucesso: r.rows.length>0, bilhete: r.rows[0]}); } catch(e){ res.status(500).json({erro:"Erro"}); } });

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V26 (Espelho) On!"));
