const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- CONFIGURAÇÕES DE SOBREVIVÊNCIA ---
const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.90, // Sua margem sobre a Bet365
    
    // ⚠️ O SEGREDO ESTÁ AQUI: 45 MINUTOS DE CACHE
    // 24h / 45min = ~32 atualizações por dia.
    // 32 atualizações * 2 chamadas = 64 chamadas/dia. (Sobra margem das 100)
    TEMPO_CACHE_MINUTOS: 45, 
    
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    LIGAS_VIP: ["Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Brasileirão", "Paulista", "Carioca", "Champions League", "Libertadores"]
};

// Times para fallback (caso a API falhe ou acabe o limite)
const TIMES_FORTES = ["Flamengo", "Palmeiras", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Milan", "Inter", "Arsenal"];
const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Servidor V52 (Modo Econômico Seguro) Online!");
    } catch (e) { console.error(e); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        // 1. TENTA PEGAR DO BANCO DE DADOS (GRÁTIS)
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        
        if (cache.rows.length > 0) {
            const agora = new Date();
            const atualizado = new Date(cache.rows[0].atualizado_em);
            const diffMinutos = (agora - atualizado) / 1000 / 60;

            // Se o cache for recente (menos de 45 min), USA ELE e não gasta API
            if (diffMinutos < CONFIG.TEMPO_CACHE_MINUTOS) {
                console.log(`📦 Usando Cache (${diffMinutos.toFixed(0)}min). Economizando API.`);
                return res.json(cache.rows[0].json_dados);
            }
        }
        
        // 2. SE O CACHE ESTIVER VELHO, VAI NA API (GASTA CRÉDITO)
        console.log("🔄 Cache expirou. Buscando dados novos na API...");
        const headers = { 'x-apisports-key': CONFIG.API_KEY };

        // Chamada 1: Jogos
        const respJogos = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`, { headers });
        
        // Chamada 2: Odds (Só se a primeira funcionou)
        let mapaOdds = {};
        if (respJogos.data.response && respJogos.data.response.length > 0) {
            try {
                const respOdds = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&bookmaker=6&timezone=America/Sao_Paulo`, { headers });
                if(respOdds.data.response) {
                    respOdds.data.response.forEach(o => { mapaOdds[o.fixture.id] = o.bookmakers[0].bets; });
                }
            } catch (erroOdds) {
                console.log("⚠️ Falha ao pegar Odds (Limite ou Erro). Usando simulador.");
            }
        }

        let jogosFinais = [];
        if (respJogos.data.response) {
            jogosFinais = formatarHibrido(respJogos.data.response, mapaOdds);
            
            // Salva no Cache para usar pelos próximos 45 minutos
            if (jogosFinais.length > 0) {
                await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
            }
        }
        
        res.json(jogosFinais);

    } catch (e) { 
        console.error("❌ Erro Crítico ou Limite Estourado:", e.message);
        // SE DER ERRO (LIMITE ESTOUROU), TENTA DEVOLVER O CACHE VELHO PRA NÃO DERRUBAR O SITE
        const cacheVelho = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if(cacheVelho.rows.length > 0) {
            console.log("⚠️ Servindo cache antigo por emergência.");
            return res.json(cacheVelho.rows[0].json_dados);
        }
        res.json([]); 
    }
});

function formatarHibrido(listaJogos, mapaOdds) {
    return listaJogos.map(j => {
        try {
            const st = j.fixture.status.short;
            if (['FT', 'AET', 'PEN', '1H', '2H', 'HT'].includes(st)) return null; // Filtra jogos rolando/acabados

            const oddsReais = mapaOdds[j.fixture.id]; 
            let oddsBase, mercadosExtras;

            if (oddsReais) {
                const winner = oddsReais.find(b => b.id === 1);
                if (winner) {
                    oddsBase = {
                        casa: aplicarMargem(winner.values.find(v=>v.value==='Home').odd),
                        empate: aplicarMargem(winner.values.find(v=>v.value==='Draw').odd),
                        fora: aplicarMargem(winner.values.find(v=>v.value==='Away').odd)
                    };
                    mercadosExtras = gerarMercadosProporcionais(oddsBase, true); 
                } else {
                    oddsBase = calcularOddsSimuladas(j.teams.home.name, j.teams.away.name);
                    mercadosExtras = gerarMercadosProporcionais(oddsBase, false);
                }
            } else {
                oddsBase = calcularOddsSimuladas(j.teams.home.name, j.teams.away.name);
                mercadosExtras = gerarMercadosProporcionais(oddsBase, false);
            }

            const ligaNome = `${traduzir(j.league.country)} - ${traduzir(j.league.name)}`.toUpperCase();
            
            return {
                id: j.fixture.id,
                liga: ligaNome,
                flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png",
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: "VS",
                odds: oddsBase,
                mercados: mercadosExtras
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function calcularOddsSimuladas(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let c = 2.40, e = 3.20, f = 2.80;
    if (hStrong && !aStrong) { c = 1.45; e = 4.20; f = 6.50; } else if (aStrong && !hStrong) { c = 5.50; e = 3.90; f = 1.55; }
    return { casa: aplicarMargem(c), empate: aplicarMargem(e), fora: aplicarMargem(f) };
}

function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function gerarMercadosProporcionais(base, ehReal) {
    const C = parseFloat(base.casa); const E = parseFloat(base.empate); const F = parseFloat(base.fora);
    const k = 0.90; const fx = (v) => (v * k).toFixed(2);

    return [
        {
            grupo: "Total de Gols",
            itens: [
                { nome: "Mais 1.5", odd: fx(1.28) }, { nome: "Menos 1.5", odd: fx(3.30) },
                { nome: "Mais 2.5", odd: fx(1.90) }, { nome: "Menos 2.5", odd: fx(1.85) },
                { nome: "Mais 3.5", odd: fx(3.20) }, { nome: "Menos 3.5", odd: fx(1.25) },
                { nome: "Mais 4.5", odd: fx(5.80) }, { nome: "Menos 4.5", odd: fx(1.10) },
                { nome: "Mais 5.5", odd: fx(9.50) }, { nome: "Menos 5.5", odd: fx(1.03) }
            ]
        },
        {
            grupo: "Ambas Marcam",
            itens: [ { nome: "Sim", odd: fx(1.85) }, { nome: "Não", odd: fx(1.85) } ]
        },
        {
            grupo: "Chance Dupla",
            itens: [ { nome: "Casa/Empate", odd: fx(1.15) }, { nome: "Casa/Fora", odd: fx(1.25) }, { nome: "Empate/Fora", odd: fx(1.15) } ]
        },
        {
            grupo: "Placar Exato",
            itens: [
                { nome: "1-0", odd: fx(C*3.5) }, { nome: "2-0", odd: fx(C*4.5) }, 
                { nome: "0-1", odd: fx(F*3.5) }, { nome: "0-2", odd: fx(F*4.5) },
                { nome: "1-1", odd: "6.00" }
            ]
        }
    ];
}

// Rotas Padrão
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas } = req.body;
        if(!apostas || !apostas.length) return res.status(400).json({erro: "Vazio"});
        let oddTotal = 1.0; apostas.forEach(a => oddTotal *= parseFloat(a.odd));
        let retorno = parseFloat(valor) * oddTotal;
        if(retorno > CONFIG.MAX_PREMIO) retorno = CONFIG.MAX_PREMIO;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas)]);
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});
    } catch (e) { res.status(500).json({erro: "Erro"}); }
});
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { res.json({sucesso:false}); });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V52 (Modo Seguro) On!"));
