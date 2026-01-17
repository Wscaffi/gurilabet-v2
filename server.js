const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.90, // Margem da Casa
    TEMPO_CACHE_MINUTOS: 30, 
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    LIGAS_VIP: ["Premier League", "La Liga", "Serie A", "Brasileirão", "Paulista", "Carioca", "Champions League", "Libertadores"]
};

// Times fortes (apenas para colorir a simulação se necessário)
const TIMES_FORTES = ["Palmeiras", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Milan", "Inter", "Arsenal"];
const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query("DELETE FROM jogos_cache"); // Limpa cache para forçar atualização
        console.log("✅ Servidor V55 (Matemática Corrigida) Online!");
    } catch (e) { console.error(e); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        // 1. Cache
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) {
            const diff = (new Date() - new Date(cache.rows[0].atualizado_em)) / 1000 / 60;
            if (diff < CONFIG.TEMPO_CACHE_MINUTOS) return res.json(cache.rows[0].json_dados);
        }
        
        console.log("🌍 Buscando API (V55)...");
        const headers = { 'x-apisports-key': CONFIG.API_KEY };

        // 2. Busca Fixtures (Jogos)
        const respJogos = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`, { headers });
        const listaBruta = respJogos.data.response || [];

        // 3. Busca Odds (Página 1 - Geral)
        // Removemos o filtro de Liga para tentar pegar tudo que estiver na capa
        let mapaOdds = {};
        try {
            const respOdds = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&bookmaker=6&timezone=America/Sao_Paulo`, { headers });
            if(respOdds.data.response) {
                respOdds.data.response.forEach(o => { mapaOdds[o.fixture.id] = o.bookmakers[0].bets; });
            }
        } catch (e) { console.log("⚠️ Erro API Odds."); }

        let jogosFinais = formatarV55(listaBruta, mapaOdds);
        
        if (jogosFinais.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
        }
        res.json(jogosFinais);
    } catch (e) { res.json([]); }
});

function formatarV55(listaJogos, mapaOdds) {
    return listaJogos.map(j => {
        try {
            const st = j.fixture.status.short;
            if (['FT', 'AET', 'PEN', '1H', '2H', 'HT'].includes(st)) return null;

            const oddsReais = mapaOdds[j.fixture.id]; 
            let oddsBase;

            if (oddsReais) {
                // Tenta pegar odd real
                const winner = oddsReais.find(b => b.id === 1);
                if (winner) {
                    oddsBase = {
                        casa: parseFloat(winner.values.find(v=>v.value==='Home').odd),
                        empate: parseFloat(winner.values.find(v=>v.value==='Draw').odd),
                        fora: parseFloat(winner.values.find(v=>v.value==='Away').odd)
                    };
                } else {
                    oddsBase = simularBase(j.teams.home.name, j.teams.away.name);
                }
            } else {
                oddsBase = simularBase(j.teams.home.name, j.teams.away.name);
            }

            // APLICA MARGEM E GERA MERCADOS (AGORA COM MATEMÁTICA REAL)
            const oddsFinais = {
                casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2),
                empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2),
                fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2)
            };
            
            const mercadosCalculados = gerarMercadosMatematicos(oddsBase);

            const ligaNome = `${traduzir(j.league.country)} - ${traduzir(j.league.name)}`.toUpperCase();
            return {
                id: j.fixture.id,
                liga: ligaNome,
                flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png",
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: "VS",
                odds: oddsFinais,
                mercados: mercadosCalculados
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function simularBase(home, away) {
    // Simulação baseada em força (Fallback)
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    if (hStrong && !aStrong) return { casa: 1.45, empate: 4.50, fora: 7.00 };
    if (aStrong && !hStrong) return { casa: 6.00, empate: 4.20, fora: 1.50 };
    return { casa: 2.40, empate: 3.20, fora: 2.80 }; // Jogo equilibrado
}

// --- MOTOR MATEMÁTICO V55 (FIM DAS ODDS DUPLICADAS) ---
function gerarMercadosMatematicos(base) {
    const C = base.casa;
    const E = base.empate;
    const F = base.fora;
    const margem = CONFIG.LUCRO_CASA;
    const fx = (v) => (v * margem).toFixed(2);

    // 1. Chance Dupla (Fórmula: 1 / (1/Odd1 + 1/Odd2))
    const dc1X = 1 / ((1/C) + (1/E));
    const dc12 = 1 / ((1/C) + (1/F));
    const dcX2 = 1 / ((1/E) + (1/F));

    // 2. Ambas Marcam (Estimativa baseada no Empate e Favoritismo)
    // Se o empate é provável (odd baixa), ambos marcam é mais provável.
    let bttsSim = 1.90; 
    if(E < 3.5) bttsSim = 1.75; // Jogo disputado
    if(C < 1.3 || F < 1.3) bttsSim = 2.10; // Jogo desequilibrado (um time só marca)
    const bttsNao = (1 / (1 - (1/bttsSim))) * 1.1; // Inverso proporcional + spread

    return [
        {
            grupo: "Total de Gols",
            itens: [
                { nome: "Mais 1.5", odd: fx(1.30) }, { nome: "Menos 1.5", odd: fx(3.20) },
                { nome: "Mais 2.5", odd: fx(1.95) }, { nome: "Menos 2.5", odd: fx(1.80) },
                { nome: "Mais 3.5", odd: fx(3.40) }, { nome: "Menos 3.5", odd: fx(1.28) }
            ]
        },
        {
            grupo: "Ambas Marcam",
            itens: [ 
                { nome: "Sim", odd: fx(bttsSim) }, 
                { nome: "Não", odd: fx(bttsNao) } 
            ]
        },
        {
            grupo: "Chance Dupla",
            itens: [ 
                { nome: "Casa/Empate", odd: fx(dc1X) }, 
                { nome: "Casa/Fora", odd: fx(dc12) }, 
                { nome: "Empate/Fora", odd: fx(dcX2) } 
            ]
        },
        {
            grupo: "Placar Exato",
            itens: [
                { nome: "1-0", odd: fx(C * 3.2) }, { nome: "2-0", odd: fx(C * 4.8) }, 
                { nome: "0-1", odd: fx(F * 3.2) }, { nome: "0-2", odd: fx(F * 4.8) },
                { nome: "1-1", odd: fx(E * 1.8) }
            ]
        }
    ];
}

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
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V55 On!"));
